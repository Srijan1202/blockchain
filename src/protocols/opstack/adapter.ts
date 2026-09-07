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
import { L2S, type L2Config } from "../../config/chains.js";
import { l1Client, l2Client, snapshotParams, type ParamSnapshot } from "../../core/params.js";
import type { LifecycleEvent, SubmissionRef, TxSpec } from "../../core/types.js";
import { OPSTACK_SUPPORTED_STAGES, type ProtocolAdapter, type RunContext } from "../adapter.js";
import { OPTIMISM_PORTAL_DEPOSIT_ABI } from "./abi.js";
import { depositFromLog } from "./deposit.js";

/**
 * OP Stack adapter (T8).
 *
 * The forced path is a single L1 call: OptimismPortal.depositTransaction. The
 * derivation pipeline is then obliged to include the resulting deposit as a
 * type-0x7E transaction. There is no user force call and no censorship
 * precondition - see completeForced below.
 */

export interface DepositCall {
  to: Address;
  data: Hex;
  /** msg.value, which becomes `mint` on L2. */
  value: bigint;
}

/** Build the depositTransaction call without sending it. */
export function buildDepositCall(portal: Address, tx: TxSpec): DepositCall {
  return {
    to: portal,
    data: encodeFunctionData({
      abi: OPTIMISM_PORTAL_DEPOSIT_ABI,
      functionName: "depositTransaction",
      args: [tx.to, tx.valueWei, tx.gasLimit, false, tx.data],
    }),
    value: tx.valueWei,
  };
}

export interface OpStackAdapterOptions {
  pollIntervalMs?: number;
  /** Give up waiting for a stage after this long. A timeout is recorded, not thrown. */
  stageTimeoutMs?: number;
}

export class OpStackAdapter implements ProtocolAdapter {
  readonly chainKey: string;
  readonly family = "op-stack" as const;
  /** Excludes S5 and S6: the OP Stack has no such stages. See protocols/adapter.ts. */
  readonly supportedStages = OPSTACK_SUPPORTED_STAGES;

  private readonly cfg: L2Config;
  private readonly portal: Address;
  private readonly pollIntervalMs: number;
  private readonly stageTimeoutMs: number;

  constructor(chainKey: string, opts: OpStackAdapterOptions = {}) {
    const cfg = L2S[chainKey];
    if (!cfg) throw new Error(`Unknown chain ${chainKey}`);
    if (cfg.family !== "op-stack") {
      throw new Error(`${chainKey} is ${cfg.family}, not op-stack`);
    }
    this.chainKey = chainKey;
    this.cfg = cfg;
    this.portal = requirePortal(cfg);
    requireVerifiedBound(cfg);
    this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;
    this.stageTimeoutMs = opts.stageTimeoutMs ?? 30 * 60_000;
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
    return privateKeyToAccount(key as Hex);
  }

  /** Baseline path: an ordinary transaction through the L2 sequencer RPC. */
  async submitNormal(tx: TxSpec, ctx: RunContext): Promise<SubmissionRef> {
    const submittedAt = new Date().toISOString();
    if (ctx.dryRun) {
      ctx.logger.info({ chain: this.chainKey, path: "normal", to: tx.to }, "dry run: normal tx not sent");
      return makeRef(ctx, "normal", submittedAt, {});
    }
    const wallet = createWalletClient({ account: this.account(), transport: http(rpcFor(this.cfg.rpcEnv)) });
    const hash = await wallet.sendTransaction({
      to: tx.to,
      value: tx.valueWei,
      data: tx.data,
      gas: tx.gasLimit,
      chain: null,
    });
    ctx.logger.info({ chain: this.chainKey, path: "normal", l2_tx_hash: hash }, "normal tx submitted");
    return makeRef(ctx, "normal", submittedAt, { l2TxHash: hash });
  }

  /**
   * Forced path: one L1 call to the portal, carrying msg.value.
   *
   * ADDRESS ALIASING - read this before asking. A deposit from a CONTRACT
   * sender is credited on L2 to address + 0x1111000000000000000000000000000000001111.
   * A deposit from an EOA is NOT aliased. The experiment wallet is an EOA, so
   * `from` on L2 equals this sender unchanged; that was confirmed empirically
   * against historical OP Sepolia deposits, where the L1 and L2 `from` matched
   * exactly. Written down because a reviewer will ask, the code otherwise looks
   * silent on it, and future-you will not remember.
   */
  async submitForced(tx: TxSpec, ctx: RunContext): Promise<SubmissionRef> {
    const call = buildDepositCall(this.portal, tx);
    const submittedAt = new Date().toISOString(); // S2, wall clock

    if (ctx.dryRun) {
      ctx.logger.info(
        {
          chain: this.chainKey,
          path: "forced",
          portal: this.portal,
          value_wei: call.value.toString(),
          calldata_bytes: (call.data.length - 2) / 2,
        },
        "dry run: depositTransaction constructed, not sent",
      );
      return makeRef(ctx, "forced", submittedAt, {});
    }

    const wallet = createWalletClient({
      account: this.account(),
      transport: http(rpcFor("RPC_ETH_SEPOLIA")),
    });
    const hash = await wallet.sendTransaction({
      to: call.to,
      data: call.data,
      value: call.value,
      chain: null,
    });
    ctx.logger.info(
      { chain: this.chainKey, path: "forced", l1_tx_hash: hash, portal: this.portal },
      "depositTransaction submitted",
    );
    return makeRef(ctx, "forced", submittedAt, { l1TxHash: hash });
  }

  /**
   * OP Stack has no completion action. Returns null, always.
   *
   * THIS IS NOT A STUB - DO NOT IMPLEMENT IT. The derivation pipeline is
   * obliged to include the deposit, the sequencer cannot skip it, and there is
   * nothing for the user to invoke afterwards. The null IS the measurement: it
   * is M-U1, the count of user-initiated L1 transactions, which is 1 here
   * against Arbitrum's 2. Inventing a force call would fabricate a mechanism
   * the protocol does not have and destroy the comparison.
   */
  async completeForced(_ref: SubmissionRef, ctx: RunContext): Promise<null> {
    ctx.logger.info(
      { chain: this.chainKey, family: this.family, metric: "M-U1", user_initiated_l1_txs: 1 },
      "completeForced returns null: OP Stack inclusion is automatic via derivation and there is no user force call. This is the measurement, not a gap.",
    );
    return null;
  }

  async snapshotParams(): Promise<ParamSnapshot> {
    return snapshotParams(this.chainKey);
  }

  /**
   * Emit lifecycle events as they become observable.
   *
   * S2 from the SubmissionRef wall clock; S3 and S4 from the L1 receipt and its
   * TransactionDeposited log; S7 and S8 from the derived type-0x7E deposit on
   * L2; S9 once the L1 block finalises.
   *
   * A stage that times out stops the iteration. It is not thrown and never
   * faked - the tracker records the timeout as an outcome (T9).
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

    const deposited = this.findDepositLog(receipt);
    if (!deposited) {
      ctx.logger.error(
        { chain: this.chainKey, l1_tx_hash: submission.l1TxHash },
        "no TransactionDeposited log in receipt - cannot derive the L2 transaction",
      );
      return;
    }
    yield makeEvent(ctx, "S4", "L1", "l1_block", "observed", {
      blockNumber: receipt.blockNumber,
      blockTimestamp: l1Block.timestamp,
      rawRef: `TransactionDeposited#${deposited.logIndex}`,
    });

    const { l2TxHash } = depositFromLog(deposited.decoded);
    ctx.logger.info({ chain: this.chainKey, l2_tx_hash: l2TxHash }, "derived L2 deposit tx hash");

    const l2 = this.l2();
    const appeared = await this.waitForL2Deposit(l2, l2TxHash, ctx);
    if (!appeared) return;
    yield makeEvent(ctx, "S7", "L2", "l2_block", "observed", {
      blockNumber: appeared.blockNumber,
      blockTimestamp: appeared.timestamp,
      rawRef: l2TxHash,
    });

    const l2Receipt = await l2.getTransactionReceipt({ hash: l2TxHash });
    yield makeEvent(ctx, "S8", "L2", "l2_block", "observed", {
      blockNumber: l2Receipt.blockNumber,
      blockTimestamp: appeared.timestamp,
      rawRef: `${l2TxHash}#receipt:${l2Receipt.status}`,
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

  private async waitForL1Receipt(
    l1: PublicClient,
    hash: Hex,
    ctx: RunContext,
  ): Promise<TransactionReceipt | null> {
    const deadline = Date.now() + this.stageTimeoutMs;
    while (Date.now() < deadline) {
      try {
        return await l1.getTransactionReceipt({ hash });
      } catch {
        /* not mined yet */
      }
      await sleep(this.pollIntervalMs);
    }
    ctx.logger.warn({ chain: this.chainKey, l1_tx_hash: hash }, "timed out waiting for L1 receipt");
    return null;
  }

  private findDepositLog(receipt: TransactionReceipt) {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.portal.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: OPTIMISM_PORTAL_DEPOSIT_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName !== "TransactionDeposited") continue;
        return {
          logIndex: log.logIndex,
          decoded: {
            blockHash: log.blockHash,
            logIndex: log.logIndex,
            args: decoded.args as unknown as { from: Address; to: Address; opaqueData: Hex },
          },
        };
      } catch {
        /* not our event */
      }
    }
    return null;
  }

  private async waitForL2Deposit(l2: PublicClient, hash: Hex, ctx: RunContext) {
    const deadline = Date.now() + this.stageTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const tx = await l2.getTransaction({ hash });
        if (tx.blockNumber !== null) {
          const block = await l2.getBlock({ blockNumber: tx.blockNumber });
          return { blockNumber: tx.blockNumber, timestamp: block.timestamp };
        }
      } catch {
        /* not derived yet */
      }
      await sleep(this.pollIntervalMs);
    }
    ctx.logger.warn({ chain: this.chainKey, l2_tx_hash: hash }, "timed out waiting for L2 deposit appearance");
    return null;
  }

  /** BLUEPRINT section 11 rule 5: wait for L1 finality before a row is treated as final. */
  private async waitForL1Finality(
    l1: PublicClient,
    blockNumber: bigint,
    ctx: RunContext,
  ): Promise<bigint | null> {
    const deadline = Date.now() + this.stageTimeoutMs;
    while (Date.now() < deadline) {
      const finalized = await l1.getBlock({ blockTag: "finalized" });
      if (finalized.number !== null && finalized.number >= blockNumber) return finalized.number;
      await sleep(this.pollIntervalMs);
    }
    ctx.logger.warn(
      { chain: this.chainKey, l1_block: blockNumber.toString() },
      "timed out waiting for L1 finality",
    );
    return null;
  }
}

/** Fail loudly on an UNVERIFIED portal - this is how Base Sepolia must behave (I2). */
function requirePortal(cfg: L2Config): Address {
  const ref = cfg.l1Contracts.optimismPortal;
  if (!ref || ref.address === null || ref.verification === "UNVERIFIED") {
    throw new Error(
      `Refusing to build an OP Stack adapter for ${cfg.key}: optimismPortal is ` +
        `${ref?.verification ?? "missing"} (${ref?.source ?? "no source"}). An unverified ` +
        `address must fail loudly, never be defaulted or silently skipped.`,
    );
  }
  return ref.address;
}

/**
 * Fail loudly on an UNVERIFIED protocol parameter.
 *
 * Separate from the address check on purpose, because they fail for different
 * reasons and the message should say which. As of 2026-09-07 Base Sepolia's
 * PORTAL is verified - resolved from Base's first-party docs and bound on-chain
 * via systemConfig().l2ChainId() == 84532 - but its SEQUENCING WINDOW is not:
 * Base is absent from superchain-registry and ships no rollup.json, so no
 * first-party value could be cited.
 *
 * The adapter does not need the bound in order to deposit. It refuses anyway:
 * a run on this chain would produce param_snapshots with no bound to record,
 * and every claim about "the protocol-stated bound" would then rest on a value
 * inherited from a different chain. I1/I2 say an unverified value must fail
 * loudly rather than be quietly worked around.
 */
function requireVerifiedBound(cfg: L2Config): void {
  if (cfg.statedForcedBoundVerification === "UNVERIFIED") {
    throw new Error(
      `Refusing to build an OP Stack adapter for ${cfg.key}: statedForcedBoundSec is UNVERIFIED ` +
        `(no first-party rollup config located). The portal address is fine; the sequencing window ` +
        `is not. Resolve it before running experiments on this chain.`,
    );
  }
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
    // Always null on the OP Stack: there is no force leg. That is M-U1.
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
