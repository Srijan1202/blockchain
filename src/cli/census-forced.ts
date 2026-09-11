import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { Database as DatabaseHandle } from "better-sqlite3";
import type { Address } from "viem";
import { MAINNET_RPC_ENV, observedChain, targetAddress } from "../config/mainnet.js";
import { logger } from "../core/logger.js";
import { BATCH_DATA_LOCATION, classifyForceCandidate, FORCE_INCLUSION_SELECTOR } from "../measurement/classify.js";
import { mainnetClient } from "../measurement/indexer.js";
import {
  censusBatches,
  makeLogSource,
  verifyLogSource,
  type BatchLog,
  type LogSource,
} from "../measurement/txcensus.js";
import { initDb, insertMainnetEvent } from "../storage/db.js";

/**
 * Full-history Class A census (T13 extension).
 *
 *   npm run census -- --from 15411056 --to latest
 *
 * READ-ONLY. Enumerates every SequencerBatchDelivered event on the Arbitrum One
 * SequencerInbox and filters LOCALLY on dataLocation == NoData, which is what a
 * forceInclusion call produces. No provider-side method filter is used
 * anywhere: Blockscout's returns zero for a selector observed on that same
 * address moments earlier, and a silent filter failure here would manufacture
 * exactly the "never used" finding the study exists to test. The provider-side
 * narrowing that IS used - address, topic0, block range - is checked by a
 * positive control before the census runs, and the census refuses to run if the
 * control fails.
 *
 * WHY LOGS AND NOT A TRANSACTION LIST. A txlist looks like the natural tool for
 * "transaction to a known address with a known selector", but this address's
 * transactions carry the batch itself as calldata: ~199 KB each, measured
 * 2026-09-11. Enumerating its 1,333,720 transactions would move roughly 266 GB
 * whatever the API key, and a 10,000-row page times out the gateway (HTTP 524).
 * A SequencerBatchDelivered log is ~450 bytes, so the same coverage costs about
 * 1 MB per 1,000-event page.
 *
 * WHY THIS COMPLEMENTS index-mainnet. Both find Class A. index-mainnet uses an
 * RPC endpoint and needs archive depth over 10.5M blocks, which free providers
 * throttle before finishing; this uses an indexed explorer API. Where the two
 * overlap they must agree, and disagreement is a finding about the tooling.
 */

const SEQUENCER_INBOX_ADDRESS = "0x1c479675ad559DC151F6Ec7ed3FbF8ceE79582B6";

/** Proxy first has code here (2026-09-11 bisection); the correct Nitro-era floor. */
const NITRO_FLOOR = 15_411_056n;

interface Args {
  from: bigint;
  to: bigint | null;
  offset: number;
  throttleMs: number;
  maxRequests: number;
  api: "etherscan" | "blockscout";
  verifyWindow: bigint;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const toRaw = get("--to");
  const api = (get("--api") ?? "etherscan") as Args["api"];
  if (api !== "etherscan" && api !== "blockscout") throw new Error(`--api must be etherscan or blockscout`);
  return {
    from: BigInt(get("--from") ?? NITRO_FLOOR.toString()),
    to: toRaw === undefined || toRaw === "latest" ? null : BigInt(toRaw),
    offset: Number(get("--offset") ?? "10000"),
    // Etherscan free tier is 5 calls/sec; 220ms keeps a margin.
    throttleMs: Number(get("--throttle-ms") ?? "220"),
    maxRequests: Number(get("--max-requests") ?? "2000"),
    api,
    verifyWindow: BigInt(get("--verify-window") ?? "2000"),
    dryRun: argv.includes("--dry-run"),
  };
}

function buildSource(api: Args["api"], address: Address): LogSource {
  if (api === "blockscout") {
    return makeLogSource({ base: "https://eth.blockscout.com/api", host: "eth.blockscout.com", address });
  }
  const key = process.env.ETHERSCAN_API_KEY;
  if (key === undefined || key === "") {
    throw new Error(
      "ETHERSCAN_API_KEY is not set. A free key from etherscan.io/apis (5 calls/sec, 100k/day) " +
        "covers this census in ~134 requests. Alternatively pass --api blockscout, which needs no " +
        "key but rate-limits aggressively under sustained use.",
    );
  }
  return makeLogSource({
    base: "https://api.etherscan.io/v2/api",
    host: "api.etherscan.io",
    address,
    apiKey: key,
    chainId: 1,
  });
}

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
    .prepare("SELECT scan_id FROM mainnet_scans WHERE chain_key = ? AND target = ? AND from_block = ? AND to_block = ?")
    .get(row.chain_key, row.target, row.from_block, row.to_block) as { scan_id: string } | undefined;
  return existing?.scan_id ?? row.scan_id;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const chain = observedChain("arbitrum-one");
  const inbox = targetAddress(chain, "arbitrum-sequencer-inbox");
  if (inbox.toLowerCase() !== SEQUENCER_INBOX_ADDRESS.toLowerCase()) {
    throw new Error(`registry inbox ${inbox} does not match the census target ${SEQUENCER_INBOX_ADDRESS}`);
  }

  const rpcUrl = process.env[MAINNET_RPC_ENV];
  if (rpcUrl === undefined || rpcUrl === "") throw new Error(`${MAINNET_RPC_ENV} is required (used to confirm receipts and the head block)`);
  const client = mainnetClient(rpcUrl);
  const chainId = await client.getChainId();
  if (chainId !== 1) throw new Error(`${MAINNET_RPC_ENV} points at chainId ${chainId}, not Ethereum mainnet`);

  const head = await client.getBlockNumber();
  const to = args.to ?? head;
  const log = logger.child({ cmd: "census-forced" });
  const source = buildSource(args.api, inbox);

  log.info(
    { from: args.from.toString(), to: to.toString(), blocks: (to - args.from + 1n).toString(), host: source.host, offset: args.offset },
    "Class A census - full transaction enumeration, selector filtered LOCALLY",
  );

  // Positive control BEFORE trusting anything. A source that silently returns
  // nothing must fail here, not by producing a zero Class A count.
  const control = await verifyLogSource(source, { from: to - args.verifyWindow, to }, log);
  if (!control.ok) {
    throw new Error(
      `Positive control FAILED on ${source.host}: a window that certainly contains batch-posting ` +
        `events returned ${control.logs} logs of which ${control.decoded} decoded to the expected shape. ` +
        `Refusing to run - a zero Class A result from this source would be meaningless.`,
    );
  }
  console.error(
    `positive control PASSED on ${source.host}: ${control.logs} logs in the last ${args.verifyWindow} blocks, ` +
      `all ${control.decoded} decoded, dataLocation distribution ${JSON.stringify(control.locations)}\n`,
  );
  if (args.dryRun) {
    console.error("--dry-run: control verified, census not run.\n");
    return;
  }

  const result = await censusBatches({
    source,
    range: { from: args.from, to },
    pageCap: args.offset,
    throttleMs: args.throttleMs,
    maxRequests: args.maxRequests,
    logger: log,
  });

  log.info(
    {
      batches: result.totalBatches, candidates: result.candidates.length, undecodable: result.undecodable,
      locations: result.locations, complete: result.complete, reached: result.reachedBlock.toString(), note: result.note,
    },
    "census walk finished",
  );

  // Apply the SAME four conditions the getLogs route applies. A selector match
  // alone is a candidate, never a Class A.
  const db = initDb();
  const scanId = claimScan(db, {
    scan_id: randomUUID(),
    chain_key: chain.key,
    target: inbox,
    target_label: "SequencerInbox:logcensus",
    from_block: Number(result.scanned.from),
    to_block: Number(result.scanned.to),
    rpc_host: source.host,
    started_at: new Date().toISOString(),
  });

  let classA = 0;
  let other = 0;
  for (const t of result.candidates) {
    // The log says NoData. The remaining three conditions need the transaction
    // itself, so each candidate costs two RPC calls - affordable precisely
    // because candidates are rare.
    const tx = await client.getTransaction({ hash: t.txHash }).catch(() => null);
    const rcpt = await client.getTransactionReceipt({ hash: t.txHash }).catch(() => null);
    const classified = classifyForceCandidate({
      txHash: t.txHash,
      dataLocation: BATCH_DATA_LOCATION.NoData,
      inputSelector: tx === null ? null : tx.input.slice(0, 10),
      receiptStatus: rcpt === null ? null : rcpt.status,
      toIsSequencerInbox: tx === null ? null : (tx.to ?? "").toLowerCase() === inbox.toLowerCase(),
    });
    if (classified.class === "A") classA += 1;
    else other += 1;

    // I6: a reverted forceInclusion is data. It is not Class A - nothing was
    // included - but it is recorded loudly rather than discarded.
    if (classified.class !== "A") {
      log.warn({ tx: t.txHash, block: t.blockNumber.toString(), evidence: classified.evidence }, "NoData batch NOT confirmed as Class A");
    }

    try {
      insertMainnetEvent(db, {
        event_id: randomUUID(),
        chain_key: chain.key,
        class: classified.class,
        tx_hash: t.txHash,
        block_number: Number(t.blockNumber),
        block_timestamp: Number(t.blockTimestamp),
        evidence: `${classified.evidence}; source=logcensus/${source.host}; actor=${tx === null ? "unknown" : tx.from}`,
      });
      db.prepare("UPDATE mainnet_events SET scan_id = ?, actor = ? WHERE chain_key = ? AND tx_hash = ? AND class = ?")
        .run(scanId, tx === null ? null : tx.from, chain.key, t.txHash, classified.class);
    } catch (err) {
      if (!String(err).includes("UNIQUE")) throw err;
    }
  }

  db.prepare("UPDATE mainnet_scans SET ended_at = ?, logs_seen = ?, complete = ?, notes = ? WHERE scan_id = ?").run(
    new Date().toISOString(),
    result.totalBatches,
    result.complete ? 1 : 0,
    `${result.note}; dataLocation filtered locally; control passed on ${source.host}; undecodable=${result.undecodable}; locations=${JSON.stringify(result.locations)}`,
    scanId,
  );

  const pct = Number(((result.scanned.to - result.scanned.from) * 100n) / (to - args.from || 1n));
  console.error(
    `\nClass A census via ${source.host}\n` +
      `  requested range   ${args.from}..${to}\n` +
      `  covered           ${result.scanned.from}..${result.scanned.to}  (${pct}% of requested)  complete=${result.complete}\n` +
      `  batches examined  ${result.totalBatches.toLocaleString()}   (the binomial denominator)\n` +
      `  dataLocation dist ${JSON.stringify(result.locations)}\n` +
      `  undecodable logs  ${result.undecodable}\n` +
      `  NoData candidates ${result.candidates.length}\n` +
      `  Class A confirmed ${classA}\n` +
      `  candidates not confirmed (recorded as D, incl. reverts) ${other}\n` +
      `  note: ${result.note}\n\n` +
      `  run: python analysis/mainnet.py --db data/bench.sqlite\n`,
  );
  db.close();
}

main().catch((err: unknown) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "census-forced failed");
  process.exitCode = 1;
});
