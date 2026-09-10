import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import type { Database as DatabaseHandle } from "better-sqlite3";
import { ETH_SEPOLIA, L2S } from "../config/chains.js";
import { clockFor, type Duration } from "../core/clock.js";
import { logger } from "../core/logger.js";
import type { ClockSource, LifecycleStage } from "../core/types.js";
import { openDbReadOnly } from "../storage/db.js";

/**
 * Dataset export (T12).
 *
 *   npm run export -- --out data/export.csv
 *
 * One row per run, joined with its lifecycle, costs and the campaign's
 * parameter snapshot. Columns carry the BLUEPRINT section 9 metric IDs so the
 * paper and the data share a vocabulary.
 *
 * Opens the database READ-ONLY. Export must be safe to run while a campaign is
 * still submitting.
 */

const CSV_DEFAULT = "data/export.csv";
const MANIFEST_DEFAULT = "data/export_manifest.json";

interface Args {
  out: string;
  manifest: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const out = get("--out") ?? CSV_DEFAULT;
  return { out, manifest: get("--manifest") ?? MANIFEST_DEFAULT };
}

function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "(unavailable)";
  }
}

/** Host only. RPC URLs carry API keys and must never reach the dataset. */
function rpcHost(envKey: string): string {
  const url = process.env[envKey];
  if (!url) return "(unset)";
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable)";
  }
}

// ---------------------------------------------------------------------------

interface RunRowJoined {
  run_id: string;
  experiment_id: string;
  protocol: string;
  chain_key: string;
  environment: string;
  experiment_type: string;
  git_commit: string;
  harness_version: string;
  path: string;
  tx_kind: string;
  sender: string;
  nonce: number | null;
  gas_limit: string | null;
  calldata_bytes: number;
  l1_tx_hash: string | null;
  l1_force_hash: string | null;
  l2_tx_hash: string | null;
  outcome: string;
  retry_count: number;
  error: string | null;
  submitted_at: string;
  l1_gas_used: string | null;
  l1_gas_price: string | null;
  l1_fee_wei: string | null;
  force_gas_used: string | null;
  force_fee_wei: string | null;
  l2_gas_used: string | null;
  l2_fee_wei: string | null;
  total_fee_wei: string | null;
  l1_base_fee_at_submit: string | null;
  op_l1_data_fee_wei: string | null;
  op_l1_gas_used: string | null;
  op_l1_gas_price: string | null;
  arb_l1_gas_allocation: string | null;
}

interface StageRow {
  run_id: string;
  stage: LifecycleStage;
  chain_layer: string;
  block_number: number | null;
  block_timestamp: number | null;
  observed_at: string | null;
  clock_source: ClockSource;
  confidence: string;
  finalized: number;
  raw_ref: string | null;
}

const STAGES: LifecycleStage[] = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"];

/** Metric -> the stage pair it spans. Every one is computed through clock.ts. */
const LATENCY_METRICS: Array<{
  id: string;
  from: LifecycleStage;
  to: LifecycleStage;
  /**
   * Which path the metric is DEFINED for, or null for both.
   *
   * M-L3 is "total forced-path latency" and M-L4 is the "normal-path
   * baseline" (BLUEPRINT section 9). Both stage pairs happen to exist on both
   * paths - a normal run has S1, S2, S7 and S8 too - so computing them
   * wherever the stages are present produced an M_L4 for forced runs and an
   * M_L3 for normal ones. Those columns are meaningless under their own
   * definitions, and pooling them would compare a forced-path latency against
   * a column labelled "normal-path baseline". Gated by path instead.
   */
  path: "normal" | "forced" | null;
  note: string;
}> = [
  { id: "M_L1", from: "S2", to: "S3", path: "forced", note: "submit -> L1 inclusion (mixed clock by construction)" },
  { id: "M_L2", from: "S3", to: "S7", path: "forced", note: "L1 inclusion -> L2 appearance (the cross-protocol comparable)" },
  { id: "M_L3", from: "S2", to: "S7", path: "forced", note: "total forced-path latency; equals M_L1 + M_L2" },
  { id: "M_L4", from: "S1", to: "S8", path: "normal", note: "normal-path baseline" },
];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "bigint" ? value.toString() : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(","));
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------

function buildRows(db: DatabaseHandle): {
  headers: string[];
  rows: Array<Record<string, unknown>>;
  paramKeys: string[];
  blockRanges: Record<string, { min: number; max: number }>;
  counts: Record<string, number>;
} {
  const runs = db
    .prepare(
      `SELECT r.*, e.protocol, e.chain_key, e.environment, e.experiment_type,
              e.git_commit, e.harness_version,
              c.l1_gas_used, c.l1_gas_price, c.l1_fee_wei, c.force_gas_used, c.force_fee_wei,
              c.l2_gas_used, c.l2_fee_wei, c.total_fee_wei, c.l1_base_fee_at_submit,
              c.op_l1_data_fee_wei, c.op_l1_gas_used, c.op_l1_gas_price, c.arb_l1_gas_allocation
       FROM runs r
       JOIN experiments e USING(experiment_id)
       LEFT JOIN costs c USING(run_id)
       ORDER BY e.experiment_id, r.idempotency_key`,
    )
    .all() as RunRowJoined[];

  const stageRows = db.prepare("SELECT * FROM lifecycle_events").all() as StageRow[];
  const byRun = new Map<string, Map<LifecycleStage, StageRow>>();
  for (const s of stageRows) {
    let m = byRun.get(s.run_id);
    if (!m) { m = new Map(); byRun.set(s.run_id, m); }
    m.set(s.stage, s);
  }

  // Parameter snapshots, pivoted per campaign.
  const params = db
    .prepare("SELECT experiment_id, key, value, source FROM param_snapshots")
    .all() as Array<{ experiment_id: string; key: string; value: string; source: string }>;
  const paramsByExp = new Map<string, Map<string, { value: string; source: string }>>();
  const paramKeySet = new Set<string>();
  for (const p of params) {
    paramKeySet.add(p.key);
    let m = paramsByExp.get(p.experiment_id);
    if (!m) { m = new Map(); paramsByExp.set(p.experiment_id, m); }
    m.set(p.key, { value: p.value, source: p.source });
  }
  const paramKeys = [...paramKeySet].sort();

  const blockRanges: Record<string, { min: number; max: number }> = {};
  const noteBlock = (layer: string, chain: string, block: number | null): void => {
    if (block === null) return;
    const key = layer === "L1" ? ETH_SEPOLIA.key : chain;
    const cur = blockRanges[key];
    blockRanges[key] = cur ? { min: Math.min(cur.min, block), max: Math.max(cur.max, block) } : { min: block, max: block };
  };

  const counts: Record<string, number> = { total: 0, success: 0, timeout: 0, pending: 0, failed: 0, incomplete: 0 };
  const rows: Array<Record<string, unknown>> = [];

  for (const run of runs) {
    const stages = byRun.get(run.run_id) ?? new Map<LifecycleStage, StageRow>();
    counts.total = (counts.total ?? 0) + 1;
    counts[run.outcome] = (counts[run.outcome] ?? 0) + 1;

    const row: Record<string, unknown> = {
      run_id: run.run_id,
      experiment_id: run.experiment_id,
      experiment_type: run.experiment_type,
      protocol: run.protocol,
      chain_key: run.chain_key,
      environment: run.environment,
      path: run.path,
      tx_kind: run.tx_kind,
      outcome: run.outcome,
      retry_count: run.retry_count,
      error: run.error,
      sender: run.sender,
      nonce: run.nonce,
      gas_limit: run.gas_limit,
      calldata_bytes: run.calldata_bytes,
      submitted_at: run.submitted_at,
      l1_tx_hash: run.l1_tx_hash,
      l1_force_hash: run.l1_force_hash,
      l2_tx_hash: run.l2_tx_hash,
      git_commit: run.git_commit,
      harness_version: run.harness_version,
    };

    // Raw stage observations, so every derived number can be re-derived.
    for (const st of STAGES) {
      const s = stages.get(st);
      row[`${st}_block_number`] = s?.block_number ?? null;
      row[`${st}_block_timestamp`] = s?.block_timestamp ?? null;
      row[`${st}_clock_source`] = s?.clock_source ?? null;
      row[`${st}_confidence`] = s?.confidence ?? null;
      row[`${st}_finalized`] = s ? s.finalized : null;
      // Only OBSERVED stages define the block range. S5's block number is
      // computed (l1Block + delayBlocks) and may not exist yet, so counting it
      // would report a range covering blocks nobody ever read.
      if (s && s.confidence === "observed") noteBlock(s.chain_layer, run.chain_key, s.block_number);
    }

    // Latency metrics, each with its two mandatory companion columns.
    const clock = clockFor(run.chain_key);
    let complete = true;
    for (const m of LATENCY_METRICS) {
      const a = stages.get(m.from);
      const b = stages.get(m.to);
      let d: Duration | null = null;
      const appliesToPath = m.path === null || m.path === run.path;
      if (appliesToPath && a && b && a.block_timestamp !== null && b.block_timestamp !== null) {
        d = clock.duration(
          { clockSource: a.clock_source, seconds: BigInt(a.block_timestamp) },
          { clockSource: b.clock_source, seconds: BigInt(b.block_timestamp) },
          m.from,
          m.to,
        );
      }
      row[m.id] = d ? d.seconds.toString() : null;
      row[`${m.id}_mixed_clock`] = d ? (d.mixedClock ? 1 : 0) : null;
      row[`${m.id}_resolution_sec`] = d ? d.resolutionSeconds : null;
    }
    // A run is complete when every stage its path can produce was observed.
    const expected = run.path === "normal" ? ["S1", "S2", "S7", "S8"] : ["S1", "S2", "S3", "S4", "S7", "S8", "S9"];
    complete = expected.every((st) => stages.has(st as LifecycleStage));
    row.is_complete = complete ? 1 : 0;
    if (!complete) counts.incomplete = (counts.incomplete ?? 0) + 1;

    // Cost metrics. Protocol-specific columns are kept SEPARATE - see manifest.
    row.M_C1 = run.l1_fee_wei;
    row.M_C2 = run.force_fee_wei;
    row.M_C3 = run.l2_fee_wei;
    row.M_C3_op_l1_data_fee_wei = run.op_l1_data_fee_wei;
    row.M_C3_arb_l1_gas_allocation = run.arb_l1_gas_allocation;
    row.total_fee_wei = run.total_fee_wei;
    // M_C4 is a RATIO against a normal-path baseline, and choosing that baseline
    // is an analysis decision (a median, a paired run, a per-campaign mean).
    // CLAUDE.md section 3 puts statistics in Python, so the numerator is
    // exported per row and the ratio is left for analysis. See the manifest.
    row.M_C4 = null;
    row.M_C4_numerator_wei = run.total_fee_wei;

    // M_U1: user-initiated L1 transactions. Counted from what was actually
    // sent, not assumed from the protocol - 2 for a forced Arbitrum run that
    // called forceInclude, 1 for one that was auto-included or for an OP
    // deposit, 0 on the normal path.
    row.M_U1 = (run.l1_tx_hash ? 1 : 0) + (run.l1_force_hash ? 1 : 0);
    const s7 = stages.get("S7");
    row.inclusion_path = s7?.raw_ref?.startsWith("inclusion=")
      ? (s7.raw_ref.split(";")[0]?.split("=")[1] ?? null)
      : null;

    row.l1_gas_used = run.l1_gas_used;
    row.l1_gas_price = run.l1_gas_price;
    row.l2_gas_used = run.l2_gas_used;
    row.force_gas_used = run.force_gas_used;
    row.l1_base_fee_at_submit = run.l1_base_fee_at_submit;

    const pm = paramsByExp.get(run.experiment_id);
    for (const k of paramKeys) {
      row[`param_${k}`] = pm?.get(k)?.value ?? null;
      row[`param_${k}_source`] = pm?.get(k)?.source ?? null;
    }

    rows.push(row);
  }

  const headers = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];
  return { headers, rows, paramKeys, blockRanges, counts };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = openDbReadOnly();

  const { headers, rows, paramKeys, blockRanges, counts } = buildRows(db);

  const contracts: Record<string, Record<string, string | null>> = {};
  const chainIds: Record<string, number> = { [ETH_SEPOLIA.key]: ETH_SEPOLIA.chainId };
  const usedChains = new Set(rows.map((r) => String(r.chain_key)));
  for (const [key, cfg] of Object.entries(L2S)) {
    if (!usedChains.has(key)) continue;
    chainIds[key] = cfg.chainId;
    contracts[key] = Object.fromEntries(
      Object.entries(cfg.l1Contracts).map(([name, ref]) => [name, ref.address]),
    );
  }

  const manifest = {
    export_timestamp: new Date().toISOString(),
    git_commit: gitCommit(),
    rows: rows.length,
    csv: args.out,
    chain_ids: chainIds,
    l1_contracts_used: contracts,
    block_ranges: blockRanges,
    block_ranges_note:
      "Range of blocks actually OBSERVED. Excludes S5, whose block number is computed " +
      "(l1Block + delayBlocks) and may lie in the future.",
    rpc_hosts: {
      // Hosts only. The configured URLs carry API keys.
      [ETH_SEPOLIA.rpcEnv]: rpcHost(ETH_SEPOLIA.rpcEnv),
      ...Object.fromEntries(
        [...usedChains].map((k) => {
          const cfg = L2S[k];
          return [cfg?.rpcEnv ?? k, cfg ? rpcHost(cfg.rpcEnv) : "(unknown)"];
        }),
      ),
    },
    outcome_counts: counts,
    parameter_keys: paramKeys,
    decisions: {
      incomplete_runs:
        "EXPORTED, not excluded. Runs with outcome 'timeout' (or otherwise missing stages) " +
        "appear as rows with null durations and is_complete=0. Dropping them would silently " +
        "change the denominator: M-R1/M-R2/M-R3 are success, failure and timeout RATES, and a " +
        "dataset that has already removed its timeouts cannot report them. Filter on " +
        "is_complete or outcome in analysis, deliberately.",
      cost_columns_are_protocol_specific:
        "M_C3_op_l1_data_fee_wei is populated ONLY on the OP Stack and is a FEE in wei priced " +
        "at the L1 gas price. M_C3_arb_l1_gas_allocation is populated ONLY on Arbitrum and is " +
        "an L2 GAS ALLOCATION, already inside l2_gas_used, priced at the L2 gas price. They are " +
        "different quantities in different units and are deliberately NOT pooled into one " +
        "column. Never sum or compare them across protocols. See migration 003.",
      cross_protocol_comparison:
        "total_fee_wei is the only cross-protocol comparable cost figure: it means everything " +
        "the transaction cost the user. Totals are comparable; decompositions are not. " +
        "total_fee_wei - M_C3 compared across protocols is not like-for-like, because only the " +
        "OP Stack has a separable, differently-priced data-availability component.",
      M_C4:
        "Left NULL on purpose. M-C4 is a ratio against a normal-path baseline, and choosing " +
        "that baseline (median, paired run, per-campaign mean) is an analysis decision. " +
        "CLAUDE.md section 3 keeps statistics in Python, so the per-run numerator is exported " +
        "as M_C4_numerator_wei and the ratio is computed there against experiment A on the " +
        "same chain.",
      mixed_clock:
        "Every latency metric carries <metric>_mixed_clock and <metric>_resolution_sec. " +
        "Never report precision finer than the resolution column, and annotate any " +
        "mixed-clock metric as such in figure captions (BLUEPRINT section 11).",
      S5_confidence:
        "S5 is the only inferred stage: force eligibility is computed from the live " +
        "delaySeconds, never witnessed. S5_confidence records this per row.",
    },
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, toCsv(headers, rows), "utf8");
  mkdirSync(dirname(args.manifest), { recursive: true });
  writeFileSync(args.manifest, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  logger.info(
    { csv: args.out, manifest: args.manifest, rows: rows.length, columns: headers.length, outcomes: counts },
    "export complete",
  );
  db.close();
}

main().catch((e) => {
  logger.error({ error: String(e) }, "export failed");
  console.error(e);
  process.exit(1);
});
