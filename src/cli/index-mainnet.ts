import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Database as DatabaseHandle } from "better-sqlite3";
import type { Address } from "viem";
import { MAINNET_RPC_ENV, OBSERVED_CHAINS, observedChain, targetAddress } from "../config/mainnet.js";
import { logger } from "../core/logger.js";
import {
  mainnetClient,
  readBufferThreshold,
  rpcHostOf,
  scanArbitrumBatches,
  scanDelayedMessages,
  scanOpDeposits,
  type ScanRange,
} from "../measurement/indexer.js";
import { initDb, insertMainnetEvent, type MainnetClass } from "../storage/db.js";

/**
 * Mainnet indexer CLI (T13 / BLUEPRINT section 12).
 *
 *   npm run index-mainnet -- --chain arbitrum-one --from 25900000 --to 25949000
 *   npm run index-mainnet -- --chain op-mainnet --last 50000
 *
 * READ-ONLY. No account is loaded, nothing is signed, no transaction is sent.
 *
 * CHOOSING AN RPC. This needs two things most free endpoints will not give at
 * once: archive logs, and a getLogs range wider than a handful of blocks. As
 * measured 2026-09-11 - publicnode serves wide ranges but refuses archive
 * depth; Alchemy's free tier serves archive but caps getLogs at 10 blocks;
 * drpc's free tier serves archive at up to 10,000 blocks (2,000 is comfortable,
 * 10,000 times out). Set RPC_ETH_MAINNET accordingly. The scan records the host
 * it used - never the URL, because that would put an API key in the dataset.
 *
 * WHY THE RANGE IS MANDATORY. A Class A count means nothing without the window
 * it was counted over, and section 12 asks for a binomial CI, which needs the
 * denominator to exist as data. Every scan writes a mainnet_scans row with its
 * exact [from, to], the host, whether it completed, and any coverage gaps.
 *
 * NO STATISTICS HERE. Per CLAUDE.md section 3 this prints counts and writes
 * rows; the binomial CI and the batch-size distribution are computed by
 * analysis/mainnet.py from the CSV this can emit.
 */

const CSV_DEFAULT = "data/mainnet_events.csv";

interface Args {
  chain: string;
  from: bigint | null;
  to: bigint | null;
  last: bigint | null;
  chunk: bigint;
  csv: string;
  throttleMs: number;
  attributionCap: number;
  /** Index every delayed message kind, not just the escape-hatch kind 3. */
  allKinds: boolean;
  /**
   * Skip the Bridge/MessageDelivered pass. Class A lives entirely in the
   * SequencerInbox logs, so a wide Class-A scan costs half as many requests
   * when the Class B/C population is not needed for that range.
   */
  skipMessages: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const chain = get("--chain");
  if (chain === undefined) {
    throw new Error(`--chain is required. Known: ${OBSERVED_CHAINS.map((c) => c.key).join(", ")}`);
  }
  const num = (f: string): bigint | null => {
    const v = get(f);
    return v === undefined ? null : BigInt(v);
  };
  return {
    chain,
    from: num("--from"),
    to: num("--to"),
    last: num("--last"),
    chunk: num("--chunk") ?? 1000n,
    csv: get("--csv") ?? CSV_DEFAULT,
    attributionCap: Number(get("--attribution-cap") ?? "500"),
    throttleMs: Number(get("--throttle-ms") ?? "300"),
    allKinds: argv.includes("--all-kinds"),
    skipMessages: argv.includes("--skip-messages"),
  };
}

/**
 * Claim a scan row, returning the id that rows should reference.
 *
 * Re-scanning a range is normal - a run gets interrupted, or a partial range is
 * repeated. The UNIQUE(chain_key, target, from_block, to_block) constraint makes
 * the INSERT a no-op in that case, so returning the freshly generated id would
 * leave every event pointing at a scan row that does not exist and leave
 * finishScan updating nothing. The EXISTING id is returned instead, so a re-scan
 * updates the row it is actually re-doing.
 */
function claimScan(db: DatabaseHandle, row: {
  scan_id: string; chain_key: string; target: string; target_label: string;
  from_block: number; to_block: number; rpc_host: string; started_at: string;
}): string {
  db.prepare(
    `INSERT OR IGNORE INTO mainnet_scans
       (scan_id, chain_key, target, target_label, from_block, to_block, rpc_host, started_at)
     VALUES (@scan_id, @chain_key, @target, @target_label, @from_block, @to_block, @rpc_host, @started_at)`,
  ).run(row);
  const existing = db
    .prepare(
      "SELECT scan_id FROM mainnet_scans WHERE chain_key = ? AND target = ? AND from_block = ? AND to_block = ?",
    )
    .get(row.chain_key, row.target, row.from_block, row.to_block) as { scan_id: string } | undefined;
  return existing?.scan_id ?? row.scan_id;
}

function finishScan(db: DatabaseHandle, scanId: string, logsSeen: number, complete: boolean, notes: string): void {
  db.prepare(
    "UPDATE mainnet_scans SET ended_at = ?, logs_seen = ?, complete = ?, notes = ? WHERE scan_id = ?",
  ).run(new Date().toISOString(), logsSeen, complete ? 1 : 0, notes, scanId);
}

interface OutRow {
  chain_key: string;
  class: MainnetClass;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_timestamp: number;
  evidence: string;
  scan_id: string;
  batch_size: number | null;
  swept_own: number | null;
  swept_other: number | null;
  swept_unknown: number | null;
  actor: string | null;
  delay_blocks: number | null;
}

function writeRow(db: DatabaseHandle, r: OutRow): void {
  // UNIQUE(chain_key, tx_hash, class) - a re-scan of the same range must not
  // duplicate. INSERT OR IGNORE via a try, since insertMainnetEvent is a plain
  // INSERT and re-running a scan is a normal thing to do.
  try {
    insertMainnetEvent(db, {
      event_id: randomUUID(),
      chain_key: r.chain_key,
      class: r.class,
      tx_hash: r.tx_hash,
      log_index: r.log_index,
      block_number: r.block_number,
      block_timestamp: r.block_timestamp,
      evidence: r.evidence,
    });
  } catch (err) {
    if (!String(err).includes("UNIQUE")) throw err;
    return;
  }
  db.prepare(
    `UPDATE mainnet_events
        SET scan_id = @scan_id, batch_size = @batch_size, swept_own = @swept_own,
            swept_other = @swept_other, swept_unknown = @swept_unknown,
            actor = @actor, delay_blocks = @delay_blocks
      WHERE chain_key = @chain_key AND tx_hash = @tx_hash AND log_index = @log_index AND class = @class`,
  ).run({
    scan_id: r.scan_id, batch_size: r.batch_size, swept_own: r.swept_own,
    swept_other: r.swept_other, swept_unknown: r.swept_unknown, actor: r.actor,
    delay_blocks: r.delay_blocks, chain_key: r.chain_key, tx_hash: r.tx_hash,
    log_index: r.log_index, class: r.class,
  });
}

const CSV_COLUMNS = [
  "chain_key", "class", "tx_hash", "log_index", "block_number", "block_timestamp",
  "batch_size", "swept_own", "swept_other", "swept_unknown", "actor",
  "delay_blocks", "scan_id", "scan_from_block", "scan_to_block", "evidence",
] as const;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const chain = observedChain(args.chain);

  const rpcUrl = process.env[MAINNET_RPC_ENV];
  if (rpcUrl === undefined || rpcUrl === "") {
    throw new Error(
      `${MAINNET_RPC_ENV} is not set. The indexer reads Ethereum MAINNET history; ` +
        `pointing it at a testnet endpoint would return an empty result set that looks exactly like the finding.`,
    );
  }
  const client = mainnetClient(rpcUrl);
  const host = rpcHostOf(rpcUrl);

  const chainId = await client.getChainId();
  if (chainId !== 1) {
    throw new Error(`${MAINNET_RPC_ENV} points at chainId ${chainId}, not Ethereum mainnet (1). Refusing to index.`);
  }

  const head = await client.getBlockNumber();
  const to = args.to ?? head;
  const from = args.from ?? (args.last !== null ? to - args.last : null);
  if (from === null) throw new Error("Specify --from/--to or --last N. The range must be explicit and is recorded with every row.");
  if (from > to) throw new Error(`--from ${from} is after --to ${to}`);
  const range: ScanRange = { fromBlock: from, toBlock: to };

  const log = logger.child({ cmd: "index-mainnet", chain: chain.key });
  log.info(
    { from: from.toString(), to: to.toString(), blocks: (to - from + 1n).toString(), head: head.toString(), rpc_host: host, chunk: args.chunk.toString() },
    "scan range - bounded and recorded",
  );

  const db = initDb();
  const rows: OutRow[] = [];
  const scans: Array<{ id: string; from: bigint; to: bigint }> = [];

  if (chain.family === "arbitrum-nitro") {
    const sequencerInbox = targetAddress(chain, "arbitrum-sequencer-inbox");
    const bridge = targetAddress(chain, "arbitrum-bridge");

    const threshold = await readBufferThreshold(client, sequencerInbox, log);
    log.info(
      { threshold_blocks: threshold === null ? null : threshold.toString() },
      threshold === null
        ? "no on-chain buffer threshold: no Class B judgement will be made (I1 - not substituted)"
        : "Class B boundary read from chain: buffer().threshold, the protocol's own 'expected delay' in L1 blocks",
    );

    const sbdScan = claimScan(db, {
      scan_id: randomUUID(), chain_key: chain.key, target: sequencerInbox, target_label: "SequencerInbox",
      from_block: Number(from), to_block: Number(to), rpc_host: host, started_at: new Date().toISOString(),
    });
    scans.push({ id: sbdScan, from, to });

    const batches = await scanArbitrumBatches({
      client, sequencerInbox, bridge, range, chunk: args.chunk, attributionCap: args.attributionCap,
      throttleMs: args.throttleMs, logger: log,
    });
    finishScan(db, sbdScan, batches.logsSeen, batches.gaps.length === 0,
      batches.gaps.length ? `${batches.gaps.length} coverage gap(s): ${batches.gaps.map((g) => `${g.from}-${g.to}`).join(",")}` : "");

    const forcedIndices = new Set<string>();
    for (const f of batches.forceRecords) {
      if (f.classified.class === "A" && f.sweptFrom !== null && f.sweptTo !== null) {
        for (let i = f.sweptFrom; i < f.sweptTo; i++) forcedIndices.add(i.toString());
      }
      rows.push({
        chain_key: chain.key, class: f.classified.class, tx_hash: f.txHash, log_index: f.logIndex,
        block_number: Number(f.blockNumber), block_timestamp: Number(f.blockTimestamp),
        evidence: f.classified.evidence, scan_id: sbdScan,
        batch_size: f.batchSize === null ? null : Number(f.batchSize),
        swept_own: f.sweptOwn, swept_other: f.sweptOther, swept_unknown: f.sweptUnknown,
        actor: f.actor, delay_blocks: null,
      });
    }

    if (args.skipMessages) {
      log.warn({}, "--skip-messages: Bridge not scanned, so this range yields NO Class B/C/D population. Coverage is recorded per target, so the SequencerInbox scan's claim stands on its own.");
    } else {
    const mdScan = claimScan(db, {
      scan_id: randomUUID(), chain_key: chain.key, target: bridge, target_label: "Bridge",
      from_block: Number(from), to_block: Number(to), rpc_host: host, started_at: new Date().toISOString(),
    });
    scans.push({ id: mdScan, from, to });

    const msgs = await scanDelayedMessages({
      client, bridge, range, chunk: args.chunk, reads: batches.reads,
      thresholdBlocks: threshold, forcedIndices, onlyL2Msg: !args.allKinds,
      throttleMs: args.throttleMs, logger: log,
    });
    // A scan is only "complete" if every examined event became a row. A
    // deficit means events were seen and lost, which must never be inferable
    // only by subtracting two numbers in a paper.
    finishScan(db, mdScan, msgs.logsSeen, msgs.gaps.length === 0 && msgs.dropped === 0,
      [
        msgs.gaps.length ? `${msgs.gaps.length} coverage gap(s)` : "",
        msgs.dropped ? `DROPPED ${msgs.dropped} examined events (not stored)` : "",
        args.allKinds ? "" : "filtered to kind 3 (L2_MSG)",
      ].filter(Boolean).join("; "));

    for (const m of msgs.records) {
      rows.push({
        chain_key: chain.key, class: m.classified.class, tx_hash: m.txHash, log_index: m.logIndex,
        block_number: Number(m.blockNumber), block_timestamp: Number(m.blockTimestamp),
        evidence: m.classified.evidence, scan_id: mdScan,
        batch_size: null, swept_own: null, swept_other: null, swept_unknown: null,
        actor: null, delay_blocks: m.delayBlocks === null ? null : Number(m.delayBlocks),
      });
    }
    }
  } else {
    const portal = targetAddress(chain, "optimism-portal");
    const scanId = claimScan(db, {
      scan_id: randomUUID(), chain_key: chain.key, target: portal, target_label: "OptimismPortal",
      from_block: Number(from), to_block: Number(to), rpc_host: host, started_at: new Date().toISOString(),
    });
    scans.push({ id: scanId, from, to });

    const deps = await scanOpDeposits({ client, portal, standardBridge: null, range, chunk: args.chunk, throttleMs: args.throttleMs, logger: log });
    finishScan(db, scanId, deps.logsSeen, deps.gaps.length === 0 && deps.dropped === 0,
      [
        deps.gaps.length ? `${deps.gaps.length} coverage gap(s)` : "",
        deps.dropped ? `DROPPED ${deps.dropped} examined events (not stored)` : "",
      ].filter(Boolean).join("; "));

    for (const d of deps.records) {
      rows.push({
        chain_key: chain.key, class: d.classified.class, tx_hash: d.txHash, log_index: d.logIndex,
        block_number: Number(d.blockNumber), block_timestamp: Number(d.blockTimestamp),
        evidence: d.classified.evidence, scan_id: scanId,
        batch_size: null, swept_own: null, swept_other: null, swept_unknown: null,
        actor: null, delay_blocks: null,
      });
    }
  }

  const insertAll = db.transaction((rs: OutRow[]) => { for (const r of rs) writeRow(db, r); });
  insertAll(rows);

  const scanBounds = new Map(scans.map((s) => [s.id, s]));
  mkdirSync(dirname(args.csv), { recursive: true });
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) {
    const b = scanBounds.get(r.scan_id);
    lines.push(CSV_COLUMNS.map((c) => {
      if (c === "scan_from_block") return csvEscape(b?.from.toString());
      if (c === "scan_to_block") return csvEscape(b?.to.toString());
      return csvEscape((r as unknown as Record<string, unknown>)[c]);
    }).join(","));
  }
  writeFileSync(args.csv, `${lines.join("\n")}\n`, "utf8");

  const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const r of rows) counts[r.class] = (counts[r.class] ?? 0) + 1;

  log.info({ counts, rows: rows.length, csv: args.csv }, "classification counts");
  console.error(
    `\nscanned ${chain.key} blocks ${from}..${to} (${to - from + 1n} blocks) via ${host}\n` +
      `  Class A ${counts.A}   Class B ${counts.B}   Class C ${counts.C}   Class D ${counts.D}\n` +
      `  rows -> ${args.csv} and mainnet_events\n` +
      `  Class A counts are NOT a rate without this range; run analysis/mainnet.py for the CI.\n`,
  );
  db.close();
}

main().catch((err: unknown) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "index-mainnet failed");
  process.exitCode = 1;
});
