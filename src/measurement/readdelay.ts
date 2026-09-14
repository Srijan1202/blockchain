import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import type { Logger } from "pino";

/**
 * Full-history read-delay census (T13 extension, prompted by review).
 *
 * THE QUESTION THIS SETTLES. The Class A census found zero forceInclusion
 * calls across all of Nitro-era history. A referee's strongest objection: if
 * no delayed message ever went unread past delayBlocks, forceInclusion was
 * never REACHABLE, and zero calls is arithmetically guaranteed - the census
 * would say nothing about behaviour. Whether the mechanism's precondition has
 * ever held is therefore what decides what the headline means, and the Class B
 * scan that could have told us covered 20,000 blocks of a 10.5M-block history.
 *
 * WHAT IS MEASURED. For every delayed message i: the block it was delivered
 * in (MessageDelivered, topic1 = i), and the block of the first
 * SequencerBatchDelivered whose afterDelayedMessagesRead exceeds i - the batch
 * that read it. Their difference is the read delay in L1 blocks. Compared
 * against the delayBlocks in force at that height, it says how close the
 * message came to force-eligibility. The maximum over all messages is the
 * closest the precondition ever came to holding.
 *
 * TWO STREAMS, WRITTEN TO DISK AS THEY ARRIVE. ~1.3M batch events and ~2.6M
 * message events do not need to be in memory at once; each is appended to a
 * compact CSV as its page arrives, and the merge is done afterwards in Python
 * with a two-pointer sweep. Both walks are resumable: on start, the last block
 * already written is read back and the walk continues from there, so a dropped
 * connection costs one page rather than the run.
 *
 * SAME DISCIPLINE AS THE CLASS A CENSUS. Local decoding only; no provider-side
 * filter; a positive control before either walk; block-cursor paging with
 * de-duplication by (txHash, logIndex) so a page boundary inside a block loses
 * nothing.
 */

/** keccak of MessageDelivered(uint256,bytes32,address,uint8,address,bytes32,uint256,uint64). */
export const MD_TOPIC0 = "0x5e3c1311ea442664e8b1611bfabef659120ea7a0a2cfc0667700bebc69cbffe1";
/** keccak of SequencerBatchDelivered(uint256,bytes32,bytes32,bytes32,uint256,(uint64,uint64,uint64,uint64),uint8). */
export const SBD_TOPIC0 = "0x7394f4a19a13c7b92b5bb71033245305946ef78452f7b4986ac1390b5df4ebd7";

/** MessageDelivered has six 32-byte data words: inbox, kind, sender, dataHash, baseFeeL1, timestamp. */
const MD_DATA_LENGTH = 2 + 6 * 64;
/** SequencerBatchDelivered has seven: delayedAcc, afterDelayedMessagesRead, 4x TimeBounds, dataLocation. */
const SBD_DATA_LENGTH = 2 + 7 * 64;

function hex(v: unknown): bigint {
  // Etherscan returns "0x" (no digits) for zero-valued fields such as
  // logIndex 0 and transactionIndex 0. BigInt("0x") throws; treat it as 0.
  const s = String(v ?? "0x0");
  return s === "0x" || s === "" ? 0n : BigInt(s);
}

export interface MessageRow {
  index: bigint;
  block: bigint;
  kind: number;
  txHash: Hex;
  logIndex: number;
}

export interface BatchRow {
  block: bigint;
  /** topic1 - the batch's own sequence number; a per-event unique key. */
  seq: bigint;
  afterDelayedMessagesRead: bigint;
  dataLocation: number;
  txHash: Hex;
  logIndex: number;
}

export function decodeMessage(r: Record<string, unknown>): MessageRow | null {
  const data = String(r.data ?? "");
  const topics = r.topics as string[] | undefined;
  if (data.length !== MD_DATA_LENGTH || !topics || topics.length < 2) return null;
  const word = (i: number): string => data.slice(2 + i * 64, 2 + (i + 1) * 64);
  return {
    index: BigInt(topics[1] as string),
    block: hex(r.blockNumber),
    kind: Number(BigInt(`0x${word(1)}`)),
    txHash: String(r.transactionHash ?? "") as Hex,
    logIndex: Number(hex(r.logIndex ?? "0x0")),
  };
}

export function decodeBatch(r: Record<string, unknown>): BatchRow | null {
  const data = String(r.data ?? "");
  const topics = r.topics as string[] | undefined;
  if (data.length !== SBD_DATA_LENGTH || !topics || topics.length < 2) return null;
  const word = (i: number): string => data.slice(2 + i * 64, 2 + (i + 1) * 64);
  return {
    block: hex(r.blockNumber),
    seq: BigInt(topics[1] as string),
    afterDelayedMessagesRead: BigInt(`0x${word(1)}`),
    dataLocation: Number(BigInt(`0x${word(6)}`)),
    txHash: String(r.transactionHash ?? "") as Hex,
    logIndex: Number(hex(r.logIndex ?? "0x0")),
  };
}

export interface RawLogSource {
  host: string;
  fetch(address: Address, topic0: string, fromBlock: bigint, toBlock: bigint): Promise<Record<string, unknown>[]>;
}

/** Etherscan-format `module=logs&action=getLogs`. Blockscout implements the same shape. */
export function makeRawLogSource(opts: { base: string; host: string; apiKey?: string; chainId?: number }): RawLogSource {
  return {
    host: opts.host,
    async fetch(address, topic0, fromBlock, toBlock) {
      const params = new URLSearchParams({
        module: "logs", action: "getLogs", address, topic0,
        fromBlock: fromBlock.toString(), toBlock: toBlock.toString(),
      });
      if (opts.chainId !== undefined) params.set("chainid", String(opts.chainId));
      if (opts.apiKey) params.set("apikey", opts.apiKey);
      const res = await fetch(`${opts.base}?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${opts.host}`);
      const body = (await res.json()) as { message?: string; result?: unknown };
      if (Array.isArray(body.result)) return body.result as Record<string, unknown>[];
      if (typeof body.message === "string" && /no records found|no logs found/i.test(body.message)) return [];
      throw new Error(`${opts.host}: ${String(body.message ?? "unknown")} ${String(body.result ?? "")}`.slice(0, 200));
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Where a previous run stopped, read back from the file itself.
 *
 * The CSV is the checkpoint. Only COMPLETE windows are ever appended (a window
 * is fetched in full before any of it is written), and the last row's block is
 * the end of the last complete window, so resuming from lastBlock + 1 is exact.
 * A truncated final line - a killed process mid-write - is detected by field
 * count and skipped rather than parsed into a wrong block.
 */
export function lastBlockIn(path: string, blockColumn: number, expectedFields: number): bigint | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i];
    if (line === undefined || line === "") continue;
    const cells = line.split(",");
    if (cells.length !== expectedFields) continue;
    const cell = cells[blockColumn];
    if (cell === undefined || cell === "" || !/^\d+$/.test(cell)) continue;
    return BigInt(cell);
  }
  return null;
}

/** Drop a trailing partial line left by an abrupt kill. Returns true if it did. */
export function truncatePartialLastLine(path: string, expectedFields: number): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  // A clean file ends with "\n", so the final split element is "".
  const lastIdx = text.endsWith("\n") ? lines.length - 2 : lines.length - 1;
  const last = lines[lastIdx];
  if (last === undefined || lastIdx < 1) return false;
  if (last.split(",").length === expectedFields && text.endsWith("\n")) return false;
  writeFileSync(path, lines.slice(0, lastIdx).join("\n") + "\n", "utf8");
  return true;
}

export interface WalkResult {
  written: number;
  undecodable: number;
  reached: bigint;
  requests: number;
  complete: boolean;
  note: string;
}

/**
 * Walk one event stream over a block range, appending decoded rows to a CSV.
 *
 * WINDOWED, NOT CURSOR-PAGED. An earlier version fetched [cursor, to] and
 * trusted the provider's 1,000-log cap to return the earliest 1,000, advancing
 * the cursor to the last block seen. Under abrupt restarts that produced
 * leapfrogging pages and 20% duplicate rows. This version asks for an explicit
 * [lo, hi]; if the response hits the cap the window is halved and asked again,
 * so every window written is known to be complete; otherwise the rows are
 * written and lo advances to hi + 1. Windows never overlap, so no duplicate is
 * possible within a run, and every row carries (txHash, logIndex) so a
 * downstream dedup across runs is exact rather than heuristic.
 *
 * `decode` returns null for a log whose shape is not the expected one; those
 * are counted, never silently skipped.
 */
export async function walkToCsv<T extends { block: bigint; txHash: Hex; logIndex: number }>(opts: {
  source: RawLogSource;
  address: Address;
  topic0: string;
  from: bigint;
  to: bigint;
  csvPath: string;
  header: string;
  decode: (r: Record<string, unknown>) => T | null;
  toRow: (t: T) => string;
  pageCap: number;
  throttleMs: number;
  retries: number;
  logger: Logger;
  label: string;
  window?: bigint;
}): Promise<WalkResult> {
  const { source, address, topic0, to, csvPath, decode, toRow, pageCap, throttleMs, retries, logger, label } = opts;

  if (!existsSync(csvPath)) writeFileSync(csvPath, `${opts.header}\n`, "utf8");

  let lo = opts.from;
  let window = opts.window ?? 5_000n;
  let written = 0;
  let undecodable = 0;
  let requests = 0;
  const startedMs = Date.now();
  const span = to - opts.from || 1n;
  let lastProgress = -5;

  while (lo <= to) {
    const hi = lo + window - 1n > to ? to : lo + window - 1n;

    let raw: Record<string, unknown>[] | null = null;
    let lastReason = "";
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        raw = await source.fetch(address, topic0, lo, hi);
        requests += 1;
        break;
      } catch (err) {
        lastReason = err instanceof Error ? err.message : String(err);
        if (attempt === retries) break;
        const wait = /429|rate limit/i.test(lastReason) ? 3_000 * (attempt + 1) : throttleMs * 2 ** (attempt + 1);
        logger.warn({ label, lo: lo.toString(), hi: hi.toString(), attempt: attempt + 1, wait_ms: wait, reason: lastReason }, "window refused - backing off");
        await sleep(wait);
      }
    }
    if (raw === null) {
      return { written, undecodable, reached: lo - 1n, requests, complete: false, note: `stopped at ${lo}: ${lastReason}`.slice(0, 300) };
    }

    // Cap hit: this window is NOT known complete. Halve and retry the same lo.
    if (raw.length >= pageCap) {
      if (window <= 1n) {
        return { written, undecodable, reached: lo - 1n, requests, complete: false, note: `block ${lo} alone exceeds the ${pageCap}-log cap` };
      }
      window = window / 2n;
      if (throttleMs > 0) await sleep(throttleMs);
      continue;
    }

    const lines: string[] = [];
    for (const r of raw) {
      const d = decode(r);
      if (d === null) {
        undecodable += 1;
        continue;
      }
      lines.push(toRow(d));
    }
    if (lines.length) appendFileSync(csvPath, `${lines.join("\n")}\n`, "utf8");
    written += lines.length;
    lo = hi + 1n;

    // Sparse era: widen (bounded) so a few events do not cost one request each.
    if (raw.length < pageCap / 4 && window < 200_000n) window = window * 2n;

    const pct = Number(((lo - opts.from) * 100n) / span);
    if (pct >= lastProgress + 5) {
      lastProgress = pct;
      const el = (Date.now() - startedMs) / 1000;
      logger.info({ label, pct, block: lo.toString(), window: window.toString(), written, requests, elapsed_s: Math.round(el), eta_s: pct ? Math.round((el / pct) * (100 - pct)) : null }, "walk progress");
    }
    if (throttleMs > 0) await sleep(throttleMs);
  }
  return { written, undecodable, reached: to, requests, complete: true, note: `complete after ${requests} requests` };
}
