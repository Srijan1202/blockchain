import {
  createPublicClient,
  decodeFunctionData,
  http,
  padHex,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { Logger } from "pino";
import { SEQUENCER_INBOX_ABI, BRIDGE_ABI, MESSAGE_KIND } from "../protocols/arbitrum/abi.js";
import {
  BATCH_DATA_LOCATION,
  classifyDelayedMessage,
  classifyForceCandidate,
  classifyOpDeposit,
  type Classified,
} from "./classify.js";

/**
 * Mainnet indexer (T13 / BLUEPRINT section 12).
 *
 * Reads history. Never writes to a chain, never signs anything, and takes no
 * account or private key - there is no code path here that could send a
 * transaction.
 *
 * SCOPE IS BOUNDED AND RECORDED, ALWAYS. Every scan runs over an explicit
 * [fromBlock, toBlock] that is stored alongside the rows it produced. A count
 * of Class A events is not a finding on its own; "N events in M blocks" is.
 * Section 12's honesty gate asks for a binomial CI, and a CI without its
 * denominator is not a CI.
 */

// ---------------------------------------------------------------------------
// Event ABIs
// ---------------------------------------------------------------------------

const SBD_EVENT = SEQUENCER_INBOX_ABI.find(
  (e): e is Extract<typeof SEQUENCER_INBOX_ABI[number], { type: "event" }> =>
    e.type === "event" && e.name === "SequencerBatchDelivered",
);
if (SBD_EVENT === undefined) throw new Error("SequencerBatchDelivered missing from SEQUENCER_INBOX_ABI");

const MESSAGE_DELIVERED_EVENT = BRIDGE_ABI[0];

/**
 * OptimismPortal.TransactionDeposited.
 *
 * `opaqueData` is NOT indexed and carries the deposit payload; from/to/version
 * are indexed. Only the shape is needed here - the payload is never decoded,
 * because nothing inside it distinguishes routine bridging from censorship
 * circumvention (see classifyOpDeposit).
 */
const TRANSACTION_DEPOSITED_EVENT = parseAbiItem(
  "event TransactionDeposited(address indexed from, address indexed to, uint256 indexed version, bytes opaqueData)",
);

const SEQUENCER_INBOX_READ_ABI = parseAbi([
  "function totalDelayedMessagesRead() view returns (uint256)",
  "function buffer() view returns (uint64 bufferBlocks, uint64 max, uint64 threshold, uint64 prevBlockNumber, uint64 replenishRateInBasis, uint64 prevSequencedBlockNumber)",
  "function isDelayBufferable() view returns (bool)",
]);

/** Arbitrum's L1->L2 address alias offset, from AddressAliasHelper. */
const ALIAS_OFFSET = 0x1111000000000000000000000000000000001111n;
const ADDRESS_MODULUS = 1n << 160n;

/**
 * Apply the L1->L2 alias, exactly as AddressAliasHelper does.
 *
 * This is not incidental. Inbox.sendL2Message records the ALIASED sender in
 * MessageDelivered, so comparing a raw tx.from against it reports every message
 * as belonging to somebody else - which would turn the "own versus others'
 * messages" question into a constant. Confirmed on E1: an EOA
 * 0x5E1497dD...D927 appeared in the event as 0x6F2597DD...eA38.
 */
export function applyL1ToL2Alias(addr: Address): Address {
  const aliased = (BigInt(addr) + ALIAS_OFFSET) % ADDRESS_MODULUS;
  return `0x${aliased.toString(16).padStart(40, "0")}` as Address;
}

// ---------------------------------------------------------------------------
// Client + chunked log reads
// ---------------------------------------------------------------------------

export function mainnetClient(rpcUrl: string): PublicClient {
  return createPublicClient({ transport: http(rpcUrl, { timeout: 60_000, retryCount: 2, retryDelay: 1_000 }) });
}

/** Host only. An API key must never reach the dataset (same rule as export.ts). */
export function rpcHostOf(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return "unparsed";
  }
}

export interface ScanRange {
  fromBlock: bigint;
  toBlock: bigint;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * getLogs over a range, in chunks, tolerating both throttling and span limits.
 *
 * The two failure modes need opposite responses and must not be conflated.
 * A THROTTLE is transient and says nothing about the span, so the same chunk is
 * retried after a backoff; halving on a throttle would shrink the window for
 * the rest of the scan and turn a 20-minute job into hours. A SPAN LIMIT is
 * permanent for that provider, so the chunk is halved. Since providers rarely
 * distinguish the two in their error text, the rule is: retry the same span
 * first, and only halve once retries are exhausted.
 *
 * A chunk that fails even at one block is reported and SKIPPED RATHER THAN
 * SILENTLY DROPPED - the caller records it as a coverage gap so the scan's
 * claim about what it examined stays honest about its holes.
 */
export async function getLogsChunked<T>(
  client: PublicClient,
  params: { address: Address; event: T; range: ScanRange; chunk: bigint; throttleMs?: number; retries?: number },
  logger: Logger,
): Promise<{ logs: unknown[]; gaps: Array<{ from: bigint; to: bigint; reason: string }> }> {
  const out: unknown[] = [];
  const gaps: Array<{ from: bigint; to: bigint; reason: string }> = [];
  const throttleMs = params.throttleMs ?? 300;
  const retries = params.retries ?? 3;
  let cursor = params.range.fromBlock;
  // A wide scan is a long job. Without periodic progress a stalled run is
  // indistinguishable from a slow one, which is exactly the ambiguity that
  // wasted time on the devnet boot.
  const total = params.range.toBlock - params.range.fromBlock + 1n;
  const startedMs = Date.now();
  let nextReport = params.range.fromBlock + total / 20n;

  while (cursor <= params.range.toBlock) {
    let span = params.chunk;
    let attempt = 0;
    let done = false;
    while (!done) {
      const to = cursor + span - 1n > params.range.toBlock ? params.range.toBlock : cursor + span - 1n;
      try {
        const logs = await client.getLogs({
          address: params.address,
          // viem's event typing is generic over the ABI item; the caller supplies
          // a concrete one and the decoded shape is validated at the use site.
          event: params.event as never,
          fromBlock: cursor,
          toBlock: to,
        });
        out.push(...logs);
        cursor = to + 1n;
        done = true;
        if (cursor >= nextReport) {
          const scanned = cursor - params.range.fromBlock;
          const pct = Number((scanned * 100n) / total);
          const elapsed = (Date.now() - startedMs) / 1000;
          const eta = pct > 0 ? (elapsed / pct) * (100 - pct) : 0;
          logger.info(
            { pct, block: cursor.toString(), logs: out.length, elapsed_s: Math.round(elapsed), eta_s: Math.round(eta) },
            "scan progress",
          );
          nextReport = cursor + total / 20n;
        }
        if (throttleMs > 0) await sleep(throttleMs);
      } catch (err) {
        const reason = err instanceof Error ? err.message.split("\n")[0] ?? "unknown" : String(err);
        attempt += 1;
        if (attempt <= retries) {
          await sleep(throttleMs * 2 ** attempt);
          continue;
        }
        if (span > 1n) {
          span = span / 2n > 0n ? span / 2n : 1n;
          attempt = 0;
          logger.warn({ from: cursor.toString(), span: span.toString(), reason }, "retries exhausted, halving span");
          continue;
        }
        gaps.push({ from: cursor, to, reason });
        logger.error({ from: cursor.toString(), to: to.toString(), reason }, "single-block chunk failed - recorded as a GAP in coverage");
        cursor = to + 1n;
        done = true;
      }
    }
  }
  return { logs: out, gaps };
}


/**
 * Timestamps for a set of blocks, fetched with bounded concurrency.
 *
 * Fetching one block per event SERIALLY is what this replaces: a 2,646-message
 * range spent ~16 minutes in round trips against a rate-limited endpoint while
 * the log scan itself took 27 seconds. Distinct blocks are resolved once, in
 * parallel batches - concurrency stays low deliberately, because the same
 * endpoint is rate-limiting the log scan and a burst here just trades one
 * bottleneck for another.
 */
async function blockTimestamps(
  client: PublicClient,
  blockNumbers: Iterable<bigint>,
  concurrency: number,
  logger: Logger,
): Promise<Map<string, bigint>> {
  const distinct = [...new Set([...blockNumbers].map((b) => b.toString()))];
  const out = new Map<string, bigint>();
  for (let i = 0; i < distinct.length; i += concurrency) {
    const slice = distinct.slice(i, i + concurrency);
    const blocks = await Promise.all(
      slice.map((n) =>
        client.getBlock({ blockNumber: BigInt(n) }).then(
          (b) => ({ n, ts: b.timestamp }),
          () => ({ n, ts: null }),
        ),
      ),
    );
    for (const b of blocks) if (b.ts !== null) out.set(b.n, b.ts);
  }
  if (out.size !== distinct.length) {
    logger.warn({ wanted: distinct.length, got: out.size }, "some block timestamps could not be fetched");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Arbitrum: SequencerBatchDelivered -> Class A candidates
// ---------------------------------------------------------------------------

export interface ForceInclusionRecord {
  classified: Classified;
  txHash: Hex;
  blockNumber: bigint;
  blockTimestamp: bigint;
  actor: Address | null;
  /** How far totalDelayedMessagesRead advanced: the number of messages swept. */
  batchSize: bigint | null;
  /** Half-open index range [prevTotal, newTotal) that this call swept in. */
  sweptFrom: bigint | null;
  sweptTo: bigint | null;
  sweptOwn: number | null;
  sweptOther: number | null;
  sweptUnknown: number | null;
}

/**
 * Read totalDelayedMessagesRead as it stood one block BEFORE the call.
 *
 * This is what makes the batch size exact and independent of the scan window.
 * The alternative - differencing consecutive SequencerBatchDelivered events -
 * breaks at the range boundary, where the previous event lies outside what was
 * scanned, and would quietly report the first Class A of every scan as having
 * swept an enormous batch. Requires an archive endpoint; returns null if the
 * provider will not serve historical state, and the batch size is then recorded
 * as unknown rather than guessed.
 */
async function totalReadBefore(
  client: PublicClient,
  sequencerInbox: Address,
  blockNumber: bigint,
  logger: Logger,
): Promise<bigint | null> {
  try {
    return await client.readContract({
      address: sequencerInbox,
      abi: SEQUENCER_INBOX_READ_ABI,
      functionName: "totalDelayedMessagesRead",
      blockNumber: blockNumber - 1n,
    });
  } catch (err) {
    logger.warn(
      { block: (blockNumber - 1n).toString(), err: err instanceof Error ? err.message.split("\n")[0] : String(err) },
      "archive read of totalDelayedMessagesRead failed - batch size will be recorded as unknown",
    );
    return null;
  }
}

/**
 * Read the inbox's own buffer threshold: the protocol's definition of how long
 * a delayed message is EXPECTED to wait. Used as the Class B boundary so no
 * constant is invented here (I1). Null when the inbox is not delay-bufferable
 * or the read fails, in which case no Class B judgement is made at all.
 */
export async function readBufferThreshold(
  client: PublicClient,
  sequencerInbox: Address,
  logger: Logger,
): Promise<bigint | null> {
  try {
    const bufferable = await client.readContract({
      address: sequencerInbox,
      abi: SEQUENCER_INBOX_READ_ABI,
      functionName: "isDelayBufferable",
    });
    if (!bufferable) {
      logger.warn({ sequencerInbox }, "inbox is not delay-bufferable - no on-chain 'normal window' exists to compare against");
      return null;
    }
    const buf = await client.readContract({
      address: sequencerInbox,
      abi: SEQUENCER_INBOX_READ_ABI,
      functionName: "buffer",
    });
    return buf[2];
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message.split("\n")[0] : String(err) }, "buffer() read failed");
    return null;
  }
}

/**
 * Who sent each message the forcer swept in?
 *
 * messageIndex is an indexed topic, so each message is fetched by exact topic
 * match over the whole chain rather than by guessing a block range backwards
 * from the call - a message can sit in the delayed inbox for a long time, which
 * is the entire point of the mechanism.
 *
 * Capped: a pathological batch would otherwise issue unbounded requests. Beyond
 * the cap the remainder is counted as unknown, never as other.
 */
async function attributeSweptMessages(
  client: PublicClient,
  bridge: Address,
  range: { from: bigint; to: bigint },
  forcer: Address,
  upToBlock: bigint,
  cap: number,
  logger: Logger,
): Promise<{ own: number; other: number; unknown: number }> {
  const forcerRaw = forcer.toLowerCase();
  const forcerAliased = applyL1ToL2Alias(forcer).toLowerCase();
  let own = 0;
  let other = 0;
  let unknown = 0;

  for (let i = range.from; i < range.to; i++) {
    if (own + other + unknown >= cap) {
      unknown += Number(range.to - i);
      logger.warn({ cap, remaining: (range.to - i).toString() }, "swept-message attribution capped; remainder counted as unknown");
      break;
    }
    try {
      const logs = await client.getLogs({
        address: bridge,
        event: MESSAGE_DELIVERED_EVENT,
        args: { messageIndex: i },
        fromBlock: 0n,
        toBlock: upToBlock,
      });
      const first = logs[0];
      if (first === undefined) {
        unknown += 1;
        continue;
      }
      const sender = String(first.args.sender ?? "").toLowerCase();
      // Both forms are accepted: sendL2Message aliases the sender, while
      // sendL2MessageFromOrigin does not.
      if (sender === forcerRaw || sender === forcerAliased) own += 1;
      else other += 1;
    } catch {
      unknown += 1;
    }
  }
  return { own, other, unknown };
}

export interface ArbitrumScanOptions {
  client: PublicClient;
  sequencerInbox: Address;
  bridge: Address;
  range: ScanRange;
  chunk: bigint;
  /** Max messages to attribute per Class A call. */
  attributionCap: number;
  /** Delay between log requests. A throttle is cheaper than a retry storm. */
  throttleMs?: number;
  logger: Logger;
}

export interface ArbitrumScanResult {
  logsSeen: number;
  gaps: Array<{ from: bigint; to: bigint; reason: string }>;
  /** Every NoData batch, classified. Class A only where all conditions hold. */
  forceRecords: ForceInclusionRecord[];
  /** afterDelayedMessagesRead per batch, ascending: used to date message reads. */
  reads: Array<{ blockNumber: bigint; afterDelayedMessagesRead: bigint }>;
}

export async function scanArbitrumBatches(opts: ArbitrumScanOptions): Promise<ArbitrumScanResult> {
  const { client, sequencerInbox, bridge, range, chunk, logger } = opts;

  const { logs, gaps } = await getLogsChunked(
    client,
    { address: sequencerInbox, event: SBD_EVENT, range, chunk, throttleMs: opts.throttleMs, retries: 3 },
    logger,
  );

  const decoded = logs as Array<{
    transactionHash: Hex;
    blockNumber: bigint;
    args: { afterDelayedMessagesRead?: bigint; dataLocation?: number };
  }>;

  const reads = decoded
    .filter((l) => l.args.afterDelayedMessagesRead !== undefined)
    .map((l) => ({ blockNumber: l.blockNumber, afterDelayedMessagesRead: l.args.afterDelayedMessagesRead as bigint }))
    .sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));

  const candidates = decoded.filter((l) => l.args.dataLocation === BATCH_DATA_LOCATION.NoData);
  logger.info(
    { total: decoded.length, noData: candidates.length, gaps: gaps.length },
    "SequencerBatchDelivered scanned; NoData batches are the Class A candidate set",
  );

  const forceRecords: ForceInclusionRecord[] = [];
  for (const c of candidates) {
    let inputSelector: string | null = null;
    let receiptStatus: "success" | "reverted" | null = null;
    let actor: Address | null = null;
    let toIsSequencerInbox: boolean | null = null;
    let declaredTotal: bigint | null = null;

    try {
      const tx = await client.getTransaction({ hash: c.transactionHash });
      inputSelector = tx.input.slice(0, 10);
      actor = tx.from;
      toIsSequencerInbox = (tx.to ?? "").toLowerCase() === sequencerInbox.toLowerCase();
      if (inputSelector.toLowerCase() === "0xf1981578") {
        try {
          const args = decodeFunctionData({ abi: SEQUENCER_INBOX_ABI, data: tx.input });
          if (args.functionName === "forceInclusion") declaredTotal = args.args[0] as bigint;
        } catch {
          declaredTotal = null;
        }
      }
    } catch (err) {
      logger.warn({ tx: c.transactionHash, err: String(err).slice(0, 120) }, "could not fetch transaction for NoData batch");
    }

    try {
      const rcpt = await client.getTransactionReceipt({ hash: c.transactionHash });
      receiptStatus = rcpt.status;
    } catch {
      receiptStatus = null;
    }

    const classified = classifyForceCandidate({
      txHash: c.transactionHash,
      dataLocation: c.args.dataLocation ?? -1,
      inputSelector,
      receiptStatus,
      toIsSequencerInbox,
    });

    let batchSize: bigint | null = null;
    let sweptFrom: bigint | null = null;
    let sweptTo: bigint | null = null;
    let sweptOwn: number | null = null;
    let sweptOther: number | null = null;
    let sweptUnknown: number | null = null;

    if (classified.class === "A") {
      const before = await totalReadBefore(client, sequencerInbox, c.blockNumber, logger);
      const after = declaredTotal ?? c.args.afterDelayedMessagesRead ?? null;
      if (before !== null && after !== null && after >= before) {
        batchSize = after - before;
        sweptFrom = before;
        sweptTo = after;
        if (actor !== null && batchSize > 0n) {
          const attr = await attributeSweptMessages(
            client, bridge, { from: before, to: after }, actor, c.blockNumber, opts.attributionCap, logger,
          );
          sweptOwn = attr.own;
          sweptOther = attr.other;
          sweptUnknown = attr.unknown;
        }
      }
    }

    const block = await client.getBlock({ blockNumber: c.blockNumber });
    forceRecords.push({
      classified,
      txHash: c.transactionHash,
      blockNumber: c.blockNumber,
      blockTimestamp: block.timestamp,
      actor,
      batchSize,
      sweptFrom,
      sweptTo,
      sweptOwn,
      sweptOther,
      sweptUnknown,
    });
  }

  return { logsSeen: decoded.length, gaps, forceRecords, reads };
}

// ---------------------------------------------------------------------------
// Arbitrum: MessageDelivered -> Class B / C / D
// ---------------------------------------------------------------------------

export interface DelayedMessageRecord {
  classified: Classified;
  txHash: Hex;
  blockNumber: bigint;
  blockTimestamp: bigint;
  messageIndex: bigint;
  kind: number;
  delayBlocks: bigint | null;
}

export async function scanDelayedMessages(opts: {
  client: PublicClient;
  bridge: Address;
  range: ScanRange;
  chunk: bigint;
  reads: Array<{ blockNumber: bigint; afterDelayedMessagesRead: bigint }>;
  thresholdBlocks: bigint | null;
  forcedIndices: Set<string>;
  throttleMs?: number;
  /** Restrict to escape-hatch messages. Everything else is sequencer bookkeeping. */
  onlyL2Msg: boolean;
  logger: Logger;
}): Promise<{ logsSeen: number; gaps: Array<{ from: bigint; to: bigint; reason: string }>; records: DelayedMessageRecord[] }> {
  const { logs, gaps } = await getLogsChunked(
    opts.client,
    { address: opts.bridge, event: MESSAGE_DELIVERED_EVENT, range: opts.range, chunk: opts.chunk, throttleMs: opts.throttleMs, retries: 3 },
    opts.logger,
  );

  const decoded = logs as Array<{
    transactionHash: Hex;
    blockNumber: bigint;
    args: { messageIndex?: bigint; kind?: number };
  }>;

  const relevant = opts.onlyL2Msg ? decoded.filter((l) => l.args.kind === MESSAGE_KIND.L2_MSG) : decoded;
  opts.logger.info(
    { total: decoded.length, kept: relevant.length, onlyL2Msg: opts.onlyL2Msg },
    "MessageDelivered scanned",
  );

  const records: DelayedMessageRecord[] = [];
  const blockCache = await blockTimestamps(opts.client, relevant.map((m) => m.blockNumber), 8, opts.logger);

  for (const m of relevant) {
    const index = m.args.messageIndex;
    if (index === undefined) continue;

    // First batch whose read count passed this index.
    const read = opts.reads.find((r) => r.afterDelayedMessagesRead > index);

    const classified = classifyDelayedMessage({
      messageIndex: index,
      kind: m.args.kind ?? -1,
      deliveredBlock: m.blockNumber,
      readBlock: read?.blockNumber ?? null,
      thresholdBlocks: opts.thresholdBlocks,
      forcedIn: opts.forcedIndices.has(index.toString()),
    });

    const ts = blockCache.get(m.blockNumber.toString());
    if (ts === undefined) continue;

    records.push({
      classified,
      txHash: m.transactionHash,
      blockNumber: m.blockNumber,
      blockTimestamp: ts,
      messageIndex: index,
      kind: m.args.kind ?? -1,
      delayBlocks: read === undefined ? null : read.blockNumber - m.blockNumber,
    });
  }

  return { logsSeen: decoded.length, gaps, records };
}

// ---------------------------------------------------------------------------
// OP Stack: TransactionDeposited -> Class C by construction
// ---------------------------------------------------------------------------

export interface DepositRecord {
  classified: Classified;
  txHash: Hex;
  blockNumber: bigint;
  blockTimestamp: bigint;
  from: Address;
  to: Address;
}

export async function scanOpDeposits(opts: {
  client: PublicClient;
  portal: Address;
  standardBridge: Address | null;
  range: ScanRange;
  chunk: bigint;
  throttleMs?: number;
  logger: Logger;
}): Promise<{ logsSeen: number; gaps: Array<{ from: bigint; to: bigint; reason: string }>; records: DepositRecord[] }> {
  const { logs, gaps } = await getLogsChunked(
    opts.client,
    { address: opts.portal, event: TRANSACTION_DEPOSITED_EVENT, range: opts.range, chunk: opts.chunk, throttleMs: opts.throttleMs, retries: 3 },
    opts.logger,
  );

  const decoded = logs as Array<{
    transactionHash: Hex;
    blockNumber: bigint;
    args: { from?: Address; to?: Address; opaqueData?: Hex };
  }>;

  const records: DepositRecord[] = [];
  const blockCache = await blockTimestamps(opts.client, decoded.map((d) => d.blockNumber), 8, opts.logger);
  for (const d of decoded) {
    const from = d.args.from ?? ("0x" as Address);
    const to = d.args.to ?? ("0x" as Address);
    const ts = blockCache.get(d.blockNumber.toString());
    if (ts === undefined) continue;
    records.push({
      classified: classifyOpDeposit({
        from,
        to,
        isFromStandardBridge:
          opts.standardBridge !== null && from.toLowerCase() === opts.standardBridge.toLowerCase(),
        opaqueDataBytes: ((d.args.opaqueData?.length ?? 2) - 2) / 2,
      }),
      txHash: d.transactionHash,
      blockNumber: d.blockNumber,
      blockTimestamp: ts,
      from,
      to,
    });
  }

  opts.logger.info({ total: decoded.length }, "TransactionDeposited scanned - all Class C by construction");
  return { logsSeen: decoded.length, gaps, records };
}
