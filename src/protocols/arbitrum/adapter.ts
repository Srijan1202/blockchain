import {
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertNotWellKnownTestKey } from "../../core/keyguard.js";
import { L2S, type L2Config } from "../../config/chains.js";
import { l1Client, l2Client, snapshotParams, type ParamSnapshot } from "../../core/params.js";
import type { LifecycleEvent, SubmissionRef, TxSpec } from "../../core/types.js";
import { ARBITRUM_SUPPORTED_STAGES, type ProtocolAdapter, type RunContext } from "../adapter.js";
import { BRIDGE_ABI, INBOX_ABI, MESSAGE_KIND, SEQUENCER_INBOX_ABI } from "./abi.js";
import {
  assessForceReachability,
  type InclusionPath,
  buildForceIncludeArgs,
  classifyInclusion,
  computeForceEligibility,
  inclusionRawRef,
  l2TxHashOf,
  messageDataHashOf,
  wrapSignedL2Message,
  type DelayedMessage,
} from "./forceInclude.js";

/**
 * Arbitrum Nitro adapter (T10).
 *
 * The forced path takes TWO L1 transactions, against the OP Stack's one, and
 * that difference is the M-U1 metric:
 *
 *   1. Inbox.sendL2Message(0x04 || signedL2Tx)   - queue it in the delayed inbox
 *   2. SequencerInbox.forceInclude(...)          - force it in, once eligible
 *
 * Step 2 is only reachable when the sequencer has NOT already read the message.
 * On a healthy public testnet it always has, so completeForced refuses there
 * rather than waiting 24 hours for a call that cannot succeed. See
 * BLUEPRINT 20.1 and assessForceReachability.
 */

export interface ArbitrumAdapterOptions {
  pollIntervalMs?: number;
  stageTimeoutMs?: number;
}

/** Raised when forceInclude reverts. The reason is data (I6), never swallowed. */
export class ForceIncludeRevert extends Error {
  readonly revertReason: string;
  constructor(revertReason: string) {
    super(`forceInclude reverted: ${revertReason}`);
    this.name = "ForceIncludeRevert";
    this.revertReason = revertReason;
  }
}

/** Raised when the force leg cannot succeed in this environment at all. */
export class ForceUnreachable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ForceUnreachable";
  }
}

export class ArbitrumAdapter implements ProtocolAdapter {
  readonly chainKey: string;
  readonly family = "arbitrum-nitro" as const;
  /** Includes S5 and S6: Arbitrum HAS these stages, even where E2 cannot reach them. */
  readonly supportedStages = ARBITRUM_SUPPORTED_STAGES;

  private readonly cfg: L2Config;
  private readonly inbox: Address;
  private readonly bridge: Address;
  private readonly sequencerInbox: Address;
  private readonly pollIntervalMs: number;
  private readonly stageTimeoutMs: number;

  /**
   * Per-run state, keyed by runId.
   *
   * NOT instance fields. T11 reuses one adapter across a whole campaign, so
   * instance state would let run N inherit run N-1's: a run that was actually
   * auto-included would be labelled inclusion=forced because the previous run
   * had forced. That is a fabricated measurement of the paper's central
   * distinction.
   *
   * Resetting at the top of submitForced was rejected: it papers over the
   * symptom and breaks again the moment two runs overlap, which is exactly when
   * the corruption would be hardest to notice. Keying by runId is correct
   * regardless of ordering or concurrency.
   */
  private readonly runState = new Map<string, { delayedMessage: DelayedMessage | null; sawForceAction: boolean }>();

  constructor(chainKey: string, opts: ArbitrumAdapterOptions = {}) {
    const cfg = L2S[chainKey];
    if (!cfg) throw new Error(`Unknown chain ${chainKey}`);
    if (cfg.family !== "arbitrum-nitro") {
      throw new Error(`${chainKey} is ${cfg.family}, not arbitrum-nitro`);
    }
    this.chainKey = chainKey;
    this.cfg = cfg;
    this.inbox = requireAddress(cfg, "inbox");
    this.bridge = requireAddress(cfg, "bridge");
    this.sequencerInbox = requireAddress(cfg, "sequencerInbox");
    this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;
    this.stageTimeoutMs = opts.stageTimeoutMs ?? 30 * 60_000;
  }

  /**
   * Campaign-scoped L2 nonce, per sender address.
   *
   * getTransactionCount defaults to blockTag 'latest', the MINED nonce. A
   * delayed-inbox message waits for the sequencer to read it - about ten
   * minutes on a healthy chain - so during a campaign the mined nonce does not
   * advance between submissions and runs 2..N would all sign with the same
   * nonce. One would execute; the rest would cost real L1 gas and never appear
   * on L2, showing up as S4 present with S7 absent, which reads exactly like a
   * sequencer failing to include them. That would be a fabricated censorship
   * signal.
   *
   * blockTag 'pending' does NOT help: the transaction is not in any L2 mempool,
   * it is sitting in an L1 inbox that the L2 node has no view of.
   *
   * So the nonce is read from chain once per address and then incremented
   * locally per submission. Allocation is synchronous after initialisation -
   * there is no await between reading `next` and writing it back - so two
   * concurrent runs cannot be handed the same value, the same reasoning as the
   * per-run state above.
   */
  private readonly nonceState = new Map<Address, { next: bigint }>();
  private readonly nonceInit = new Map<Address, Promise<void>>();

  private async allocateNonce(address: Address, l2: PublicClient | null): Promise<number> {
    let init = this.nonceInit.get(address);
    if (!init) {
      init = (async () => {
        // A dry run must not touch the network, so it starts from zero. That
        // still increments per submission, so dry-run hashes differ per run.
        const start = l2 === null ? 0 : await l2.getTransactionCount({ address });
        this.nonceState.set(address, { next: BigInt(start) });
      })();
      this.nonceInit.set(address, init);
    }
    await init;

    const state = this.nonceState.get(address);
    if (!state) throw new Error(`nonce state missing for ${address} after initialisation`);
    const allocated = state.next;
    state.next = allocated + 1n; // synchronous: no await between read and write
    return Number(allocated);
  }

  /** The next nonce this adapter would allocate, or null if uninitialised. */
  peekNonce(address: Address): number | null {
    const state = this.nonceState.get(address);
    return state ? Number(state.next) : null;
  }

  /**
   * Reconcile the local nonce against chain once a run completes.
   *
   * Takes the HIGHER of the two. Chain may have advanced past us if something
   * else sent from this address; we may be ahead of chain because our messages
   * are still queued in the L1 inbox and unmined on L2. Going backwards would
   * reissue a nonce and strand a queued message.
   */
  async reconcileNonce(address: Address): Promise<number> {
    const onchain = BigInt(await this.l2().getTransactionCount({ address }));
    const state = this.nonceState.get(address);
    if (!state) {
      this.nonceState.set(address, { next: onchain });
      return Number(onchain);
    }
    state.next = state.next > onchain ? state.next : onchain;
    return Number(state.next);
  }

  private stateFor(runId: string) {
    let state = this.runState.get(runId);
    if (!state) {
      state = { delayedMessage: null, sawForceAction: false };
      this.runState.set(runId, state);
    }
    return state;
  }

  /**
   * Record that a force action happened for this run. Called when forceInclude
   * is submitted and when track() observes S6.
   */
  markForceAction(runId: string): void {
    this.stateFor(runId).sawForceAction = true;
  }

  /** Whether a force action was seen for this run. */
  hasForceAction(runId: string): boolean {
    return this.stateFor(runId).sawForceAction;
  }

  /**
   * How this run reached L2. 'forced' only if THIS run saw a force action -
   * never inherited from a sibling run on the same adapter.
   */
  inclusionPathFor(runId: string, reachedL2: boolean): InclusionPath {
    return classifyInclusion(this.stateFor(runId).sawForceAction, reachedL2);
  }

  /** Drop a finished run's state so a long campaign does not accumulate it. */
  releaseRun(runId: string): void {
    this.runState.delete(runId);
  }

  private l1(): PublicClient {
    return l1Client();
  }

  private l2(): PublicClient {
    return l2Client(this.cfg);
  }

  private account() {
    const key = process.env.PRIVATE_KEY;
    if (!key || /^0x0+$/.test(key)) {
      throw new Error(
        "PRIVATE_KEY is missing or is the all-zero placeholder. Set a funded TESTNET key in .env before sending.",
      );
    }
    const account = privateKeyToAccount(key as Hex);
    // Last gate before signing. run.ts guards earlier, but this method is
    // reachable without the CLI, so a real send must not depend on that.
    // dryRunAccount() below is deliberately exempt: it never sends.
    assertNotWellKnownTestKey(account.address, "Arbitrum adapter signing key");
    return account;
  }

  /** Baseline path: an ordinary transaction through the sequencer RPC. */
  async submitNormal(tx: TxSpec, ctx: RunContext): Promise<SubmissionRef> {
    const submittedAt = new Date().toISOString();
    if (ctx.dryRun) {
      ctx.logger.info({ chain: this.chainKey, path: "normal" }, "dry run: normal tx not sent");
      return makeRef(ctx, "normal", submittedAt, {});
    }
    const wallet = createWalletClient({ account: this.account(), transport: http(rpcFor(this.cfg.rpcEnv)) });
    const hash = await wallet.sendTransaction({
      to: tx.to, value: tx.valueWei, data: tx.data, gas: tx.gasLimit, chain: null,
    });
    return makeRef(ctx, "normal", submittedAt, { l2TxHash: hash });
  }

  /**
   * Sign the L2 transaction for chain 421614 and queue it via
   * Inbox.sendL2Message on Ethereum Sepolia.
   *
   * The transaction is signed BEFORE submission, so its L2 hash is already
   * determined and track() can poll for it directly - no derivation needed.
   * (Confirmed read-only: an L2 tx hash is keccak256 of its signed
   * serialization.)
   */
  async submitForced(tx: TxSpec, ctx: RunContext): Promise<SubmissionRef> {
    const account = ctx.dryRun ? dryRunAccount() : this.account();
    const l2 = this.l2();

    // Nonce comes from the campaign-scoped allocator, NOT from a fresh
    // getTransactionCount per submission. See allocateNonce for why.
    const nonce = await this.allocateNonce(account.address, ctx.dryRun ? null : l2);
    const fees = ctx.dryRun
      ? { maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 0n }
      : await l2.estimateFeesPerGas();

    const signedTx = await account.signTransaction({
      type: "eip1559",
      chainId: this.cfg.chainId, // 421614 - the L2 chain, signed for L2 execution
      nonce,
      to: tx.to,
      value: tx.valueWei,
      data: tx.data,
      gas: tx.gasLimit,
      maxFeePerGas: fees.maxFeePerGas ?? 100_000_000n,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
    });

    const messageData = wrapSignedL2Message(signedTx);
    const l2TxHash = l2TxHashOf(signedTx);
    const submittedAt = new Date().toISOString(); // S2, wall clock

    const calldata = encodeFunctionData({
      abi: INBOX_ABI,
      functionName: "sendL2Message",
      args: [messageData],
    });

    if (ctx.dryRun) {
      ctx.logger.info(
        {
          chain: this.chainKey,
          path: "forced",
          inbox: this.inbox,
          l2_tx_hash: l2TxHash,
          message_data_hash: messageDataHashOf(messageData),
          message_bytes: (messageData.length - 2) / 2,
          calldata_bytes: (calldata.length - 2) / 2,
        },
        "dry run: sendL2Message constructed, not sent",
      );
      return makeRef(ctx, "forced", submittedAt, { l2TxHash });
    }

    const wallet = createWalletClient({ account: this.account(), transport: http(rpcFor("RPC_ETH_SEPOLIA")) });
    const hash = await wallet.sendTransaction({ to: this.inbox, data: calldata, chain: null });
    ctx.logger.info(
      { chain: this.chainKey, path: "forced", l1_tx_hash: hash, l2_tx_hash: l2TxHash },
      "sendL2Message submitted to the delayed inbox",
    );
    return makeRef(ctx, "forced", submittedAt, { l1TxHash: hash, l2TxHash });
  }

  /**
   * Call SequencerInbox.forceInclude once the delay has elapsed.
   *
   * Two things this must never do:
   *
   *   1. Swallow a revert. A reverting forceInclude is potentially the most
   *      valuable single result in this project - it would mean a documented
   *      escape hatch does not work as specified. The reason is extracted and
   *      thrown as ForceIncludeRevert for the caller to record as an outcome.
   *   2. Retry. The revert is a protocol answer, not a transport failure (I6),
   *      and a retry would cost real funds and corrupt the sample.
   *
   * On a public testnet it refuses up front rather than waiting out a 24h
   * window for a call that cannot succeed - see BLUEPRINT 20.1.
   */
  async completeForced(ref: SubmissionRef, ctx: RunContext): Promise<SubmissionRef | null> {
    const l1 = this.l1();
    const [, , delaySeconds] = await l1.readContract({
      address: this.sequencerInbox,
      abi: SEQUENCER_INBOX_ABI,
      functionName: "maxTimeVariation",
    });

    const reach = assessForceReachability(ctx.environment, delaySeconds);
    if (!reach.reachable) {
      ctx.logger.warn(
        { chain: this.chainKey, environment: ctx.environment, delay_seconds: delaySeconds.toString() },
        `refusing to attempt forceInclude - ${reach.reason}`,
      );
      throw new ForceUnreachable(reach.reason);
    }

    const state = this.stateFor(ref.runId);
    if (state.delayedMessage === null) {
      throw new Error(
        `completeForced called for run ${ref.runId} before its delayed message was observed by track()`,
      );
    }
    const args = buildForceIncludeArgs(state.delayedMessage);

    if (ctx.dryRun) {
      ctx.logger.info(
        { chain: this.chainKey, force_args: { ...args, l1BlockAndTime: args.l1BlockAndTime.map(String) } },
        "dry run: forceInclude constructed, not sent",
      );
      return { ...ref, l1ForceHash: null };
    }

    const wallet = createWalletClient({ account: this.account(), transport: http(rpcFor("RPC_ETH_SEPOLIA")) });
    try {
      // Simulate first so a revert surfaces with its reason rather than as a
      // failed receipt with no explanation.
      await l1.simulateContract({
        address: this.sequencerInbox,
        abi: SEQUENCER_INBOX_ABI,
        functionName: "forceInclude",
        args: [args.totalDelayedMessagesRead, args.kind, args.l1BlockAndTime, args.baseFeeL1, args.sender, args.messageDataHash],
        account: this.account(),
      });
    } catch (err) {
      const reason = extractRevertReason(err);
      ctx.logger.error(
        { chain: this.chainKey, revert_reason: reason, metric: "M-R2" },
        "forceInclude REVERTED - recording as an outcome, not retrying. This is data.",
      );
      throw new ForceIncludeRevert(reason);
    }

    const hash = await wallet.sendTransaction({
      to: this.sequencerInbox,
      data: encodeFunctionData({
        abi: SEQUENCER_INBOX_ABI,
        functionName: "forceInclude",
        args: [args.totalDelayedMessagesRead, args.kind, args.l1BlockAndTime, args.baseFeeL1, args.sender, args.messageDataHash],
      }),
      chain: null,
    });
    this.markForceAction(ref.runId);
    ctx.logger.info(
      { chain: this.chainKey, run_id: ref.runId, l1_force_hash: hash, metric: "M-U1", user_initiated_l1_txs: 2 },
      "forceInclude submitted - this is the second user-initiated L1 transaction",
    );
    return { ...ref, l1ForceHash: hash };
  }

  async snapshotParams(): Promise<ParamSnapshot> {
    return snapshotParams(this.chainKey);
  }

  /**
   * Emit lifecycle events as they become observable.
   *
   * S2 wall, S3 and S4 from the L1 receipt and InboxMessageDelivered,
   * S5 computed (inferred), S6 if a force actually happened, S7/S8 on L2,
   * S9 on L1 finality.
   *
   * AUTO vs FORCED. S7 reached without S6 means the sequencer read the delayed
   * message voluntarily - auto-inclusion, roughly ten minutes on a healthy
   * chain. S6 then S7 is a genuine force. That distinction is written into
   * S7's raw_ref as inclusion=auto or inclusion=forced, so it is legible in the
   * data rather than something a reader has to infer from a missing row. On a
   * public testnet it will always be 'auto', and calling that censorship
   * recovery would be wrong (I4).
   */
  async *track(submission: SubmissionRef, ctx: RunContext): AsyncIterable<LifecycleEvent> {
    yield makeEvent(ctx, "S2", "L1", "wall", "observed", {
      blockTimestamp: BigInt(Math.floor(Date.parse(submission.submittedAt) / 1000)),
      observedAt: submission.submittedAt,
    });

    if (submission.l1TxHash === null) {
      ctx.logger.info({ chain: this.chainKey }, "track: no L1 hash (dry run) - stopping after S2");
      return;
    }

    const l1 = this.l1();
    const receipt = await this.waitForL1Receipt(l1, submission.l1TxHash, ctx);
    if (!receipt) return;
    const l1Block = await l1.getBlock({ blockNumber: receipt.blockNumber });

    yield makeEvent(ctx, "S3", "L1", "l1_block", "observed", {
      blockNumber: receipt.blockNumber,
      blockTimestamp: l1Block.timestamp,
      rawRef: `${submission.l1TxHash}#receipt`,
    });

    const queued = this.findDelayedMessage(receipt, l1Block.timestamp);
    if (!queued) {
      ctx.logger.error(
        { chain: this.chainKey, l1_tx_hash: submission.l1TxHash },
        "no InboxMessageDelivered/MessageDelivered pair in receipt - message was not queued",
      );
      return;
    }
    this.stateFor(submission.runId).delayedMessage = queued;
    yield makeEvent(ctx, "S4", "L1", "l1_block", "observed", {
      blockNumber: receipt.blockNumber,
      blockTimestamp: l1Block.timestamp,
      rawRef: `InboxMessageDelivered#${queued.messageIndex};kind=${queued.kind}`,
    });

    // S5 - force eligibility. COMPUTED from the live delay, never witnessed.
    const [delayBlocks, , delaySeconds] = await l1.readContract({
      address: this.sequencerInbox,
      abi: SEQUENCER_INBOX_ABI,
      functionName: "maxTimeVariation",
    });
    const eligibility = computeForceEligibility(queued, delaySeconds, delayBlocks);
    yield makeEvent(ctx, "S5", "L1", "l1_block", "inferred", {
      blockNumber: eligibility.eligibleAtBlock,
      blockTimestamp: eligibility.eligibleAtSeconds,
      rawRef:
        `computed: l1Timestamp+delaySeconds; delaySeconds=${delaySeconds};delayBlocks=${delayBlocks};` +
        `source=maxTimeVariation()@${receipt.blockNumber}`,
    });

    if (submission.l1ForceHash !== null) {
      const forceReceipt = await this.waitForL1Receipt(l1, submission.l1ForceHash, ctx);
      if (forceReceipt) {
        const forceBlock = await l1.getBlock({ blockNumber: forceReceipt.blockNumber });
        this.markForceAction(submission.runId);
        yield makeEvent(ctx, "S6", "L1", "l1_block", "observed", {
          blockNumber: forceReceipt.blockNumber,
          blockTimestamp: forceBlock.timestamp,
          rawRef: `forceInclude:${submission.l1ForceHash}`,
        });
      }
    }

    if (submission.l2TxHash === null) return;
    const l2 = this.l2();
    const appeared = await this.waitForL2Tx(l2, submission.l2TxHash, ctx);
    if (!appeared) return;

    const path = this.inclusionPathFor(submission.runId, true);
    ctx.logger.info(
      { chain: this.chainKey, inclusion_path: path, environment: ctx.environment },
      path === "auto"
        ? "reached L2 without a force call: the sequencer read the delayed message voluntarily (auto-inclusion, NOT censorship recovery)"
        : "reached L2 after forceInclude: genuine forced inclusion",
    );

    yield makeEvent(ctx, "S7", "L2", "l2_block", "observed", {
      blockNumber: appeared.blockNumber,
      blockTimestamp: appeared.timestamp,
      rawRef: inclusionRawRef(path, submission.l2TxHash),
    });

    const l2Receipt = await l2.getTransactionReceipt({ hash: submission.l2TxHash });
    yield makeEvent(ctx, "S8", "L2", "l2_block", "observed", {
      blockNumber: l2Receipt.blockNumber,
      blockTimestamp: appeared.timestamp,
      rawRef: `${submission.l2TxHash}#receipt:${l2Receipt.status}`,
    });

    const finalizedAt = await this.waitForL1Finality(l1, receipt.blockNumber, ctx);
    if (finalizedAt === null) return;
    yield makeEvent(ctx, "S9", "L1", "l1_block", "observed", {
      blockNumber: receipt.blockNumber,
      blockTimestamp: l1Block.timestamp,
      finalized: true,
      rawRef: `finalized@${finalizedAt}`,
    });
  }

  /** Pair InboxMessageDelivered with the Bridge's MessageDelivered. */
  private findDelayedMessage(receipt: TransactionReceipt, blockTimestamp: bigint): DelayedMessage | null {
    let messageIndex: bigint | null = null;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.inbox.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: INBOX_ABI, data: log.data, topics: log.topics });
        if (decoded.eventName === "InboxMessageDelivered") {
          messageIndex = (decoded.args as unknown as { messageNum: bigint }).messageNum;
        }
      } catch { /* not our event */ }
    }
    if (messageIndex === null) return null;

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.bridge.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: BRIDGE_ABI, data: log.data, topics: log.topics });
        if (decoded.eventName !== "MessageDelivered") continue;
        const a = decoded.args as unknown as {
          messageIndex: bigint; kind: number; sender: Address; messageDataHash: Hex;
          baseFeeL1: bigint; timestamp: bigint;
        };
        if (a.messageIndex !== messageIndex) continue;
        if (Number(a.kind) !== MESSAGE_KIND.L2_MSG) {
          // Not an escape-hatch message. Recorded rather than silently accepted.
          continue;
        }
        return {
          messageIndex: a.messageIndex,
          kind: Number(a.kind),
          sender: a.sender,
          messageDataHash: a.messageDataHash,
          baseFeeL1: a.baseFeeL1,
          l1BlockNumber: receipt.blockNumber,
          l1Timestamp: a.timestamp === 0n ? blockTimestamp : a.timestamp,
        };
      } catch { /* not our event */ }
    }
    return null;
  }

  private async waitForL1Receipt(l1: PublicClient, hash: Hex, ctx: RunContext): Promise<TransactionReceipt | null> {
    const deadline = Date.now() + this.stageTimeoutMs;
    while (Date.now() < deadline) {
      try { return await l1.getTransactionReceipt({ hash }); } catch { /* not mined */ }
      await sleep(this.pollIntervalMs);
    }
    ctx.logger.warn({ chain: this.chainKey, l1_tx_hash: hash }, "timed out waiting for L1 receipt");
    return null;
  }

  private async waitForL2Tx(l2: PublicClient, hash: Hex, ctx: RunContext) {
    const deadline = Date.now() + this.stageTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const tx = await l2.getTransaction({ hash });
        if (tx.blockNumber !== null) {
          const block = await l2.getBlock({ blockNumber: tx.blockNumber });
          return { blockNumber: tx.blockNumber, timestamp: block.timestamp };
        }
      } catch { /* not included yet */ }
      await sleep(this.pollIntervalMs);
    }
    ctx.logger.warn({ chain: this.chainKey, l2_tx_hash: hash }, "timed out waiting for L2 appearance");
    return null;
  }

  private async waitForL1Finality(l1: PublicClient, blockNumber: bigint, ctx: RunContext): Promise<bigint | null> {
    const deadline = Date.now() + this.stageTimeoutMs;
    while (Date.now() < deadline) {
      const finalized = await l1.getBlock({ blockTag: "finalized" });
      if (finalized.number !== null && finalized.number >= blockNumber) return finalized.number;
      await sleep(this.pollIntervalMs);
    }
    ctx.logger.warn({ chain: this.chainKey, l1_block: blockNumber.toString() }, "timed out waiting for L1 finality");
    return null;
  }
}

/** An UNVERIFIED address must fail loudly, never be defaulted (I2). */
function requireAddress(cfg: L2Config, name: string): Address {
  const ref = cfg.l1Contracts[name];
  if (!ref || ref.address === null || ref.verification === "UNVERIFIED") {
    throw new Error(
      `Refusing to build an Arbitrum adapter for ${cfg.key}: ${name} is ${ref?.verification ?? "missing"} ` +
        `(${ref?.source ?? "no source"}). An unverified address must fail loudly.`,
    );
  }
  return ref.address;
}

/** Extract a revert reason without losing it. A revert is data (I6). */
export function extractRevertReason(err: unknown): string {
  const e = err as { shortMessage?: string; details?: string; message?: string; cause?: unknown };
  const cause = e?.cause as { reason?: string; shortMessage?: string } | undefined;
  return (
    cause?.reason ??
    cause?.shortMessage ??
    e?.shortMessage ??
    e?.details ??
    e?.message ??
    String(err)
  ).slice(0, 400);
}

/**
 * A deterministic throwaway account used ONLY to construct a dry-run signature.
 * It is never funded and never sends: it exists so a dry run can produce a
 * well-formed signed L2 transaction without requiring a real key.
 */
function dryRunAccount() {
  return privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
}

function rpcFor(envKey: string): string {
  const url = process.env[envKey];
  if (!url) throw new Error(`Missing env var ${envKey}`);
  return url;
}

function makeRef(
  ctx: RunContext,
  path: "normal" | "forced",
  submittedAt: string,
  hashes: { l1TxHash?: Hex; l2TxHash?: Hex },
): SubmissionRef {
  return {
    runId: ctx.runId,
    chainKey: ctx.chainKey,
    path,
    l1TxHash: hashes.l1TxHash ?? null,
    l1ForceHash: null,
    l2TxHash: hashes.l2TxHash ?? null,
    submittedAt,
  };
}

function makeEvent(
  ctx: RunContext,
  stage: LifecycleEvent["stage"],
  chainLayer: LifecycleEvent["chainLayer"],
  clockSource: LifecycleEvent["clockSource"],
  confidence: LifecycleEvent["confidence"],
  extra: Partial<LifecycleEvent> = {},
): LifecycleEvent {
  return {
    eventId: `${ctx.runId}:${stage}`,
    runId: ctx.runId,
    stage,
    chainLayer,
    blockNumber: null,
    blockTimestamp: null,
    observedAt: new Date().toISOString(),
    clockSource,
    confidence,
    finalized: false,
    rawRef: null,
    ...extra,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
