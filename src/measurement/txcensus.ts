import type { Address, Hex } from "viem";
import type { Logger } from "pino";

/**
 * Full-history Class A census (T13 extension).
 *
 * WHY NOT A TRANSACTION LIST. Class A is "a transaction TO a known address WITH
 * a known selector", so a txlist looks like the obvious tool. It is not, for
 * this address specifically: an Arbitrum batch-posting transaction's calldata
 * IS the batch, and measurement on 2026-09-11 put the mean payload at ~199 KB
 * per transaction (50 rows = 9.96 MB; 200 rows = 39.8 MB). Enumerating the
 * SequencerInbox's 1,333,720 transactions would move roughly 266 GB whatever
 * the API key, and a 10,000-row page reliably times out the provider gateway
 * (HTTP 524). The request count is small; the bytes are not.
 *
 * WHAT WORKS INSTEAD. The same Etherscan-format API exposes `module=logs`, and
 * a SequencerBatchDelivered log is ~450 bytes of data rather than ~199 KB.
 * Every forceInclusion emits one, with dataLocation = NoData. So the census
 * walks logs, not transactions: ~1 MB per 1,000-log page against ~40 MB per
 * 200-transaction page.
 *
 * THE FILTER IS APPLIED LOCALLY, ALWAYS. Blockscout's provider-side `method=`
 * filter returns zero items for 0x3e5aa082 - a selector directly observed on
 * this same address moments earlier - and zero for the method name too. It
 * fails silently, in the direction that manufactures the "never used" finding
 * this study exists to test. dataLocation is therefore decoded here, from the
 * log's own data word, and never requested from a provider. The one
 * provider-side narrowing used is address + topic0 + block range, and
 * `verifyLogSource` checks it against independently confirmed facts before any
 * census result is trusted.
 */

/** topic0 of SequencerBatchDelivered(uint256,bytes32,bytes32,bytes32,uint256,(uint64,uint64,uint64,uint64),uint8). */
export const SBD_TOPIC0 = "0x7394f4a19a13c7b92b5bb71033245305946ef78452f7b4986ac1390b5df4ebd7";

/** IBridge.BatchDataLocation.NoData - what forceInclusion produces. */
export const NO_DATA = 2;

/**
 * SequencerBatchDelivered carries exactly seven 32-byte words of non-indexed
 * data: delayedAcc, afterDelayedMessagesRead, four TimeBounds fields, and
 * dataLocation. 7 x 64 hex chars + "0x" = 450. Any other length means the event
 * shape changed and the decode below would be silently wrong.
 */
export const SBD_DATA_LENGTH = 450;

export interface BatchLog {
  txHash: Hex;
  blockNumber: bigint;
  blockTimestamp: bigint;
  afterDelayedMessagesRead: bigint;
  dataLocation: number;
}

export interface LogSource {
  /** Host only, for the recorded scan. A URL with a key must never be stored. */
  host: string;
  /** One page of logs, ascending. Providers cap this (Etherscan/Blockscout: 1000). */
  fetchLogs(fromBlock: bigint, toBlock: bigint): Promise<{ raw: Record<string, unknown>[]; decoded: BatchLog[] }>;
}

function hexToBigInt(v: unknown): bigint {
  const s = String(v ?? "0x0");
  return s.startsWith("0x") ? BigInt(s) : BigInt(s);
}

/**
 * Decode one log. Returns null when the shape is not what we expect, so a
 * changed event never decodes into a confident wrong dataLocation.
 */
export function decodeBatchLog(r: Record<string, unknown>): BatchLog | null {
  const data = String(r.data ?? "");
  if (data.length !== SBD_DATA_LENGTH) return null;
  const word = (i: number): string => data.slice(2 + i * 64, 2 + (i + 1) * 64);
  return {
    txHash: String(r.transactionHash ?? "") as Hex,
    blockNumber: hexToBigInt(r.blockNumber),
    blockTimestamp: hexToBigInt(r.timeStamp ?? "0x0"),
    afterDelayedMessagesRead: BigInt(`0x${word(1)}`),
    dataLocation: Number(BigInt(`0x${word(6)}`)),
  };
}

export function makeLogSource(opts: {
  base: string;
  host: string;
  address: Address;
  apiKey?: string;
  chainId?: number;
}): LogSource {
  return {
    host: opts.host,
    async fetchLogs(fromBlock, toBlock) {
      const params = new URLSearchParams({
        module: "logs",
        action: "getLogs",
        address: opts.address,
        topic0: SBD_TOPIC0,
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
      });
      if (opts.chainId !== undefined) params.set("chainid", String(opts.chainId));
      if (opts.apiKey !== undefined && opts.apiKey !== "") params.set("apikey", opts.apiKey);

      const res = await fetch(`${opts.base}?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${opts.host}`);
      const body = (await res.json()) as { message?: string; result?: unknown };
      if (!Array.isArray(body.result)) {
        if (typeof body.message === "string" && /no records found|no logs found/i.test(body.message)) {
          return { raw: [], decoded: [] };
        }
        throw new Error(`${opts.host}: ${String(body.message ?? "unknown")} ${String(body.result ?? "")}`.slice(0, 200));
      }
      const raw = body.result as Record<string, unknown>[];
      const decoded: BatchLog[] = [];
      for (const r of raw) {
        const d = decodeBatchLog(r);
        if (d !== null) decoded.push(d);
      }
      return { raw, decoded };
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Positive control, run before the census and reported rather than assumed.
 *
 * Two independent checks on a window known to contain ordinary batches:
 * logs come back at all, and every one of them decodes to the expected shape.
 * A provider that silently returns nothing - as Blockscout's method filter
 * does - fails here instead of producing a zero Class A count that looks like
 * a finding.
 */
export async function verifyLogSource(
  source: LogSource,
  range: { from: bigint; to: bigint },
  logger: Logger,
  retries = 6,
): Promise<{ ok: boolean; logs: number; decoded: number; locations: Record<string, number> }> {
  // The control needs the same backoff the census pages get. Without it a
  // transient 429 - or a dropped connection - aborts the whole run before any
  // work starts, which reads as "the source is broken" when it is merely busy.
  let raw: Record<string, unknown>[] = [];
  let decoded: BatchLog[] = [];
  let lastReason = "";
  let got = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const page = await source.fetchLogs(range.from, range.to);
      raw = page.raw;
      decoded = page.decoded;
      got = true;
      break;
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
      if (attempt === retries) break;
      const wait = /429/.test(lastReason) ? 5_000 * (attempt + 1) : 1_000 * 2 ** attempt;
      logger.warn({ attempt: attempt + 1, wait_ms: wait, reason: lastReason }, "positive control refused - backing off");
      await sleep(wait);
    }
  }
  if (!got) {
    logger.error({ reason: lastReason }, "positive control could not be fetched at all");
    return { ok: false, logs: 0, decoded: 0, locations: {} };
  }
  const locations: Record<string, number> = {};
  for (const d of decoded) locations[String(d.dataLocation)] = (locations[String(d.dataLocation)] ?? 0) + 1;
  const ok = raw.length > 0 && decoded.length === raw.length;
  logger.info(
    { host: source.host, from: range.from.toString(), to: range.to.toString(), raw: raw.length, decoded: decoded.length, locations },
    ok
      ? "log source VERIFIED: logs returned and every one decoded to the expected 7-word shape"
      : "log source FAILED its positive control - a zero result from it would be meaningless",
  );
  return { ok, logs: raw.length, decoded: decoded.length, locations };
}

export interface CensusResult {
  scanned: { from: bigint; to: bigint };
  /** SequencerBatchDelivered events enumerated - the binomial denominator. */
  totalBatches: number;
  /** Logs whose shape did not decode. Never silently counted as anything. */
  undecodable: number;
  /** NoData batches: the Class A candidate set, before the four conditions. */
  candidates: BatchLog[];
  /** Observed dataLocation distribution, so the population is visible. */
  locations: Record<string, number>;
  reachedBlock: bigint;
  complete: boolean;
  note: string;
}

/**
 * Walk every SequencerBatchDelivered log in a range, filtering locally.
 *
 * Paged by BLOCK CURSOR rather than page number: these APIs cap a response at
 * 1,000 records and deep paging silently truncates. The cursor advances to the
 * last block seen and re-requests from it, de-duplicating by (txHash, block),
 * so a block split across a page boundary is not half-missed.
 */
export async function censusBatches(opts: {
  source: LogSource;
  range: { from: bigint; to: bigint };
  pageCap: number;
  throttleMs: number;
  maxRequests: number;
  /** Retries per page before giving up. A 429 is transient, not a coverage limit. */
  retries?: number;
  logger: Logger;
}): Promise<CensusResult> {
  const { source, range, throttleMs, logger } = opts;
  const seen = new Set<string>();
  const candidates: BatchLog[] = [];
  const locations: Record<string, number> = {};
  let cursor = range.from;
  let requests = 0;
  let total = 0;
  let undecodable = 0;
  let reached = range.from;

  const stop = (complete: boolean, note: string): CensusResult => ({
    scanned: { from: range.from, to: complete ? range.to : reached },
    totalBatches: total,
    undecodable,
    candidates,
    locations,
    reachedBlock: reached,
    complete,
    note,
  });

  for (;;) {
    if (requests >= opts.maxRequests) return stop(false, `stopped after ${requests} requests (maxRequests) at block ${reached}`);

    // A throttle is transient and says nothing about coverage, so the same page
    // is retried with escalating backoff before the census concedes. Giving up
    // on the first 429 would report a partial scan as if the data ran out.
    let page: { raw: Record<string, unknown>[]; decoded: BatchLog[] } | null = null;
    let lastReason = "";
    const retries = opts.retries ?? 6;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        page = await source.fetchLogs(cursor, range.to);
        requests += 1;
        break;
      } catch (err) {
        lastReason = err instanceof Error ? err.message : String(err);
        if (attempt === retries) break;
        const wait = /429/.test(lastReason) ? 5_000 * (attempt + 1) : throttleMs * 2 ** (attempt + 1);
        logger.warn({ cursor: cursor.toString(), attempt: attempt + 1, wait_ms: wait, reason: lastReason }, "census page refused - backing off");
        await sleep(wait);
      }
    }
    if (page === null) {
      logger.error({ cursor: cursor.toString(), reason: lastReason }, "census page failed after retries - stopping and reporting partial coverage");
      return stop(false, `page fetch failed at block ${cursor} after ${retries} retries: ${lastReason}`.slice(0, 400));
    }

    if (page.raw.length === 0) return stop(true, `exhausted at block ${cursor} after ${requests} requests`);

    undecodable += page.raw.length - page.decoded.length;
    let fresh = 0;
    for (const d of page.decoded) {
      const key = `${d.txHash}:${d.blockNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh += 1;
      total += 1;
      locations[String(d.dataLocation)] = (locations[String(d.dataLocation)] ?? 0) + 1;
      if (d.dataLocation === NO_DATA) candidates.push(d);
    }

    const last = page.decoded[page.decoded.length - 1];
    if (last === undefined) return stop(false, `page at block ${cursor} decoded nothing (${page.raw.length} raw logs) - event shape may have changed`);
    reached = last.blockNumber;

    if (last.blockNumber <= cursor && fresh === 0) {
      return stop(false, `cursor stalled at block ${cursor} (${page.raw.length} rows, 0 new)`);
    }
    if (page.raw.length < opts.pageCap) return stop(true, `final short page (${page.raw.length} < ${opts.pageCap}) after ${requests} requests`);

    cursor = last.blockNumber;
    if (requests % 20 === 0) {
      const span = range.to - range.from || 1n;
      const pct = Number(((reached - range.from) * 100n) / span);
      logger.info({ pct, block: reached.toString(), batches: total, candidates: candidates.length, requests }, "census progress");
    }
    if (throttleMs > 0) await sleep(throttleMs);
  }
}
