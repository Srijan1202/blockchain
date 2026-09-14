import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseAbi, type Address } from "viem";
import { MAINNET_RPC_ENV, observedChain, targetAddress } from "../config/mainnet.js";
import { logger } from "../core/logger.js";
import { mainnetClient } from "../measurement/indexer.js";
import {
  MD_TOPIC0,
  SBD_TOPIC0,
  decodeBatch,
  decodeMessage,
  lastBlockIn,
  makeRawLogSource,
  truncatePartialLastLine,
  walkToCsv,
  type RawLogSource,
} from "../measurement/readdelay.js";

/**
 * Full-history read-delay census (see measurement/readdelay.ts for why).
 *
 *   npm run census-read-delay -- --from 15411056 --to latest
 *
 * READ-ONLY. Writes three files under data/:
 *   read_delay_batches.csv   block,seq,afterDelayedMessagesRead,dataLocation,txHash,logIndex
 *   read_delay_messages.csv  index,block,kind,txHash,logIndex
 *   read_delay_params.csv    block,delayBlocks,futureBlocks,delaySeconds,futureSeconds,impl
 *                            delayBlocks in force at each sampled height - NOT assumed constant
 * and analysis/read_delay.py merges them.
 *
 * WHY delayBlocks IS SAMPLED RATHER THAN ASSUMED. Six implementations have sat
 * behind the SequencerInbox proxy, and maxTimeVariation is owner-settable. The
 * question "did any message ever exceed delayBlocks" has to be asked against the
 * value in force WHEN that message was waiting, so the parameter is read via
 * archive eth_call at every implementation boundary and on a grid between them.
 * If it turns out constant, that is a measured fact rather than an assumption.
 */

const NITRO_FLOOR = 15_411_056n;
const OUT_DIR = "data";
const BATCHES_CSV = `${OUT_DIR}/read_delay_batches.csv`;
const MESSAGES_CSV = `${OUT_DIR}/read_delay_messages.csv`;
const PARAMS_CSV = `${OUT_DIR}/read_delay_params.csv`;

interface Args {
  from: bigint;
  to: bigint | null;
  throttleMs: number;
  retries: number;
  only: "batches" | "messages" | "params" | "all" | "fill-batches" | "fill-messages";
  paramGrid: bigint;
}

function parseArgs(argv: string[]): Args {
  const get = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const only = (get("--only") ?? "all") as Args["only"];
  const toRaw = get("--to");
  return {
    from: BigInt(get("--from") ?? NITRO_FLOOR.toString()),
    to: toRaw === undefined || toRaw === "latest" ? null : BigInt(toRaw),
    // Etherscan free tier: 3 calls/sec. 400 ms keeps a margin.
    throttleMs: Number(get("--throttle-ms") ?? "400"),
    retries: Number(get("--retries") ?? "6"),
    only,
    paramGrid: BigInt(get("--param-grid") ?? "250000"),
  };
}

function source(): RawLogSource {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) throw new Error("ETHERSCAN_API_KEY is required for the full-history walk (free tier suffices: ~4,000 calls at 3 calls/sec).");
  return makeRawLogSource({ base: "https://api.etherscan.io/v2/api", host: "api.etherscan.io", apiKey: key, chainId: 1 });
}

const SEQ_ABI = parseAbi([
  "function maxTimeVariation() view returns (uint256,uint256,uint256,uint256)",
]);
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

/**
 * delayBlocks in force across the era, sampled at implementation boundaries
 * and on a grid. Implementation boundaries are found by reading the EIP-1967
 * slot on the same grid and bisecting wherever it changes.
 */
async function sampleParams(sequencerInbox: Address, from: bigint, to: bigint, grid: bigint, log: typeof logger): Promise<void> {
  const rpc = process.env[MAINNET_RPC_ENV];
  if (!rpc) throw new Error(`${MAINNET_RPC_ENV} is required for archive eth_call`);
  const client = mainnetClient(rpc);

  const implAt = async (b: bigint): Promise<string> => {
    const slot = await client.getStorageAt({ address: sequencerInbox, slot: IMPL_SLOT, blockNumber: b });
    return slot ? `0x${slot.slice(-40)}` : "0x";
  };
  const paramsAt = async (b: bigint): Promise<readonly [bigint, bigint, bigint, bigint] | null> =>
    client.readContract({ address: sequencerInbox, abi: SEQ_ABI, functionName: "maxTimeVariation", blockNumber: b }).catch(() => null);

  // Grid, then bisect every implementation change to its exact block.
  const points: bigint[] = [];
  for (let b = from; b <= to; b += grid) points.push(b);
  if (points[points.length - 1] !== to) points.push(to);

  const impls = new Map<string, string>();
  for (const b of points) impls.set(b.toString(), await implAt(b));

  const boundaries: bigint[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as bigint;
    const b = points[i] as bigint;
    if (impls.get(a.toString()) !== impls.get(b.toString())) {
      let lo = a, hi = b;
      const target = impls.get(b.toString());
      while (lo < hi) {
        const mid = (lo + hi) / 2n;
        if ((await implAt(mid)) === target) hi = mid; else lo = mid + 1n;
      }
      boundaries.push(lo);
      log.info({ boundary: lo.toString(), impl: target }, "implementation change located");
    }
  }

  const sample = [...new Set([...points, ...boundaries, ...boundaries.map((b) => b - 1n)])].sort((x, y) => (x < y ? -1 : 1));
  const lines = ["block,delayBlocks,futureBlocks,delaySeconds,futureSeconds,impl"];
  for (const b of sample) {
    if (b < from) continue;
    const p = await paramsAt(b);
    const impl = await implAt(b);
    lines.push(p === null ? `${b},,,,,${impl}` : `${b},${p[0]},${p[1]},${p[2]},${p[3]},${impl}`);
  }
  writeFileSync(PARAMS_CSV, `${lines.join("\n")}\n`, "utf8");
  log.info({ samples: sample.length, boundaries: boundaries.length, out: PARAMS_CSV }, "delayBlocks history sampled");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const chain = observedChain("arbitrum-one");
  const sequencerInbox = targetAddress(chain, "arbitrum-sequencer-inbox");
  const bridge = targetAddress(chain, "arbitrum-bridge");
  const log = logger.child({ cmd: "census-read-delay" });

  const rpc = process.env[MAINNET_RPC_ENV];
  if (!rpc) throw new Error(`${MAINNET_RPC_ENV} is required`);
  const client = mainnetClient(rpc);
  if ((await client.getChainId()) !== 1) throw new Error("not Ethereum mainnet");
  const to = args.to ?? (await client.getBlockNumber());
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  if (args.only === "all" || args.only === "params") {
    await sampleParams(sequencerInbox, args.from, to, args.paramGrid, log);
  }

  if (args.only === "all" || args.only === "batches" || args.only === "messages") {
    const src = source();

    // Positive control on both streams before trusting either: a recent window
    // must return logs and every one must decode.
    // Etherscan's free tier is 3 calls/sec (its error text says so). The
    // control gets the same backoff as the walk, or a single rate-limit
    // response aborts the run before it starts.
    const controls: Array<readonly [string, Address, string, (r: Record<string, unknown>) => unknown]> = [
      ["batches", sequencerInbox, SBD_TOPIC0, decodeBatch],
      ["messages", bridge, MD_TOPIC0, decodeMessage],
    ];
    for (const [label, addr, topic, decode] of controls) {
      if (args.only !== "all" && args.only !== label) continue;
      let raw: Record<string, unknown>[] | null = null;
      for (let attempt = 0; attempt <= args.retries && raw === null; attempt++) {
        try {
          raw = await src.fetch(addr, topic, to - 2000n, to);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          log.warn({ label, attempt: attempt + 1, reason }, "positive control refused - backing off");
          await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
        }
      }
      const ok = raw !== null && raw.length > 0 && raw.every((r) => decode(r) !== null);
      log.info({ label, raw: raw?.length ?? 0, ok }, ok ? "positive control PASSED" : "positive control FAILED");
      if (!ok) throw new Error(`positive control failed for ${label}; refusing to run`);
      await new Promise((r) => setTimeout(r, 400));
    }

    if (args.only === "all" || args.only === "batches") {
      if (truncatePartialLastLine(BATCHES_CSV, 6)) log.warn({}, "dropped a truncated final line in batches CSV");
      const resume = lastBlockIn(BATCHES_CSV, 0, 6);
      const from = resume === null ? args.from : resume + 1n;
      log.info({ from: from.toString(), to: to.toString(), resumed: resume !== null }, "walking SequencerBatchDelivered");
      const r = await walkToCsv({
        source: src, address: sequencerInbox, topic0: SBD_TOPIC0, from, to,
        csvPath: BATCHES_CSV, header: "block,seq,afterDelayedMessagesRead,dataLocation,txHash,logIndex",
        decode: decodeBatch, toRow: (b) => `${b.block},${b.seq},${b.afterDelayedMessagesRead},${b.dataLocation},${b.txHash},${b.logIndex}`,
        pageCap: 1000, throttleMs: args.throttleMs, retries: args.retries, logger: log, label: "batches",
      });
      log.info({ ...r, reached: r.reached.toString() }, "batches walk finished");
    }

    if (args.only === "all" || args.only === "messages") {
      if (truncatePartialLastLine(MESSAGES_CSV, 5)) log.warn({}, "dropped a truncated final line in messages CSV");
      const resume = lastBlockIn(MESSAGES_CSV, 1, 5);
      const from = resume === null ? args.from : resume + 1n;
      log.info({ from: from.toString(), to: to.toString(), resumed: resume !== null }, "walking MessageDelivered");
      const r = await walkToCsv({
        source: src, address: bridge, topic0: MD_TOPIC0, from, to,
        csvPath: MESSAGES_CSV, header: "index,block,kind,txHash,logIndex",
        decode: decodeMessage, toRow: (m) => `${m.index},${m.block},${m.kind},${m.txHash},${m.logIndex}`,
        pageCap: 1000, throttleMs: args.throttleMs, retries: args.retries, logger: log, label: "messages",
      });
      log.info({ ...r, reached: r.reached.toString() }, "messages walk finished");
    }
  }

  // Contiguity repair. A provider can return FEWER logs than its cap for a
  // window and still be incomplete - a truncated response under load looks
  // exactly like a small window. Both streams carry a dense sequence
  // (batch seq, message index), so a gap is detectable after the fact and the
  // missing span can be re-walked with a small window. Run this after any walk.
  if (args.only === "fill-batches" || args.only === "fill-messages") {
    const isBatches = args.only === "fill-batches";
    const csvPath = isBatches ? BATCHES_CSV : MESSAGES_CSV;
    const seqCol = isBatches ? 1 : 0;
    const blockCol = isBatches ? 0 : 1;
    const text = readFileSync(csvPath, "utf8").trimEnd().split("\n").slice(1);
    const rows: Array<[bigint, bigint]> = [];
    for (const line of text) {
      const c = line.split(",");
      const sq = c[seqCol];
      const bl = c[blockCol];
      if (sq === undefined || bl === undefined || sq === "" || bl === "") continue;
      rows.push([BigInt(sq), BigInt(bl)]);
    }
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const gaps: Array<{ afterSeq: bigint; nextSeq: bigint; from: bigint; to: bigint }> = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      if (prev === undefined || cur === undefined) continue;
      if (cur[0] - prev[0] > 1n) gaps.push({ afterSeq: prev[0], nextSeq: cur[0], from: prev[1], to: cur[1] });
    }
    log.info({ stream: isBatches ? "batches" : "messages", rows: rows.length, gaps: gaps.length }, "contiguity scan");
    const src = source();
    for (const g of gaps) {
      log.warn({ afterSeq: g.afterSeq.toString(), nextSeq: g.nextSeq.toString(), missing: (g.nextSeq - g.afterSeq - 1n).toString(), from: g.from.toString(), to: g.to.toString() }, "gap - re-walking span with a small window");
      const r = await walkToCsv({
        source: src,
        address: isBatches ? sequencerInbox : bridge,
        topic0: isBatches ? SBD_TOPIC0 : MD_TOPIC0,
        from: g.from, to: g.to, csvPath,
        header: isBatches ? "block,seq,afterDelayedMessagesRead,dataLocation,txHash,logIndex" : "index,block,kind,txHash,logIndex",
        decode: (isBatches ? decodeBatch : decodeMessage) as (r: Record<string, unknown>) => { block: bigint; txHash: `0x${string}`; logIndex: number } | null,
        toRow: (isBatches
          ? ((b: ReturnType<typeof decodeBatch>) => b === null ? "" : `${b.block},${b.seq},${b.afterDelayedMessagesRead},${b.dataLocation},${b.txHash},${b.logIndex}`)
          : ((m: ReturnType<typeof decodeMessage>) => m === null ? "" : `${m.index},${m.block},${m.kind},${m.txHash},${m.logIndex}`)) as (t: { block: bigint; txHash: `0x${string}`; logIndex: number }) => string,
        pageCap: 1000, throttleMs: args.throttleMs, retries: args.retries, logger: log,
        label: `fill-${isBatches ? "batches" : "messages"}`, window: 500n,
      });
      log.info({ ...r, reached: r.reached.toString() }, "gap re-walk finished");
    }
    console.error(`\nfilled ${gaps.length} gap(s); rows appended may duplicate boundary events - the analysis de-duplicates by ${isBatches ? "seq" : "index"}.\n`);
    return;
  }

  console.error(`\ndone. analyse with: python analysis/read_delay.py\n`);
}

main().catch((err: unknown) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "census-read-delay failed");
  process.exitCode = 1;
});
