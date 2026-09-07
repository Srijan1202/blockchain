import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Database as DatabaseHandle } from "better-sqlite3";

/**
 * Storage layer (T4).
 *
 * Numeric discipline (CLAUDE.md I8): every uint256 - gas, wei, fees - is typed
 * `string` here and stored as TEXT. It is never `number`, because wei values
 * exceed Number.MAX_SAFE_INTEGER and would round silently. Block numbers are
 * the deliberate exception: the validated schema types them INTEGER, SQLite
 * INTEGER is 64-bit, and no chain's block height comes close to 2^53.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

export const DEFAULT_DB_PATH = "./data/bench.sqlite";

export function openDb(dbPath: string = process.env.DB_PATH ?? DEFAULT_DB_PATH): DatabaseHandle {
  const dir = dirname(dbPath);
  if (dbPath !== ":memory:" && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  // foreign_keys is per-connection in SQLite, so it must be set here as well as
  // in the migration - a migration-only PRAGMA would not apply to later opens.
  db.pragma("foreign_keys = ON");
  if (dbPath !== ":memory:") db.pragma("journal_mode = WAL");
  return db;
}

/**
 * Apply numbered migrations in filename order, recording each in
 * schema_migrations. Every statement in the migrations is IF NOT EXISTS, so a
 * second run is a no-op both because the file is already recorded and because
 * the DDL itself is idempotent. Returns the migrations applied by THIS call.
 */
export function runMigrations(db: DatabaseHandle): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);

  const applied = new Set(
    db.prepare("SELECT name FROM schema_migrations").all().map((r) => (r as { name: string }).name),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const justApplied: string[] = [];
  const record = db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)");
  for (const file of files) {
    if (applied.has(file)) continue;
    db.exec(readFileSync(MIGRATIONS_DIR + file, "utf8"));
    record.run(file, new Date().toISOString());
    justApplied.push(file);
  }
  return justApplied;
}

/** Open and migrate in one step. */
export function initDb(dbPath?: string): DatabaseHandle {
  const db = openDb(dbPath);
  runMigrations(db);
  return db;
}

// ---------------------------------------------------------------------------
// Row types. Domain types (LifecycleStage, RunRecord, ...) belong to T5 in
// core/types.ts; these are the storage-boundary shapes only, deliberately kept
// local so T4 does not pre-empt T5.
// ---------------------------------------------------------------------------

export type Environment = "devnet" | "testnet" | "mainnet";
export type ExperimentType = "A" | "B" | "C" | "C_prime" | "D" | "E";
export type RunPath = "normal" | "forced";
export type TxKind = "eth_transfer" | "contract_call";
export type Outcome = "pending" | "success" | "failed" | "timeout";
export type Stage = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8" | "S9";
export type ChainLayer = "L1" | "L2";
export type ClockSource = "wall" | "l1_block" | "l2_block";
export type Confidence = "observed" | "inferred";
export type MainnetClass = "A" | "B" | "C" | "D";

/**
 * Permitted provenance for a recorded parameter. Matches the schema CHECK
 * exactly and is NOT widened.
 *
 * DECISION - Base Sepolia's sequencing window. Its value is null and no
 * first-party rollup config could be located, so it has no member of this union
 * and NO ROW IS WRITTEN for it. The CHECK is left as the validated schema
 * specifies, for two reasons. First, 'unverified' is not a source: it is the
 * absence of one, and putting it in a `source` column is a category error that
 * would let `SELECT ... WHERE source = 'rollup-config'` and its complement both
 * look well-formed while one of them is a fiction. Second, param_snapshots
 * exists to record values WITH provenance; a row with no value and no source
 * carries nothing to analyse.
 *
 * The omission is not silent: insertParamSnapshot rejects an unknown source
 * rather than skipping, so a caller must handle the case explicitly at the call
 * site; snapshotParams() already records the reason in its `errors`; and the
 * verify gate now exits non-zero while the parameter is unverified, so a
 * campaign cannot quietly be run against it in the first place.
 */
export type ParamSource = "on-chain" | "rollup-config" | "docs";
const PARAM_SOURCES: readonly ParamSource[] = ["on-chain", "rollup-config", "docs"];

export interface ExperimentRow {
  experiment_id: string;
  protocol: string;
  chain_key: string;
  environment: Environment;
  experiment_type: ExperimentType;
  started_at: string;
  ended_at?: string | null;
  git_commit: string;
  harness_version: string;
  notes?: string | null;
}

export interface ParamSnapshotRow {
  snapshot_id: string;
  experiment_id: string;
  chain_key: string;
  taken_at: string;
  l1_block: number;
  key: string;
  /** Always TEXT - may be a uint256. */
  value: string;
  source: ParamSource;
}

export interface RunRow {
  run_id: string;
  experiment_id: string;
  idempotency_key: string;
  path: RunPath;
  tx_kind: TxKind;
  sender: string;
  nonce?: number | null;
  /** uint256 as string. */
  gas_limit?: string | null;
  calldata_bytes: number;
  l1_tx_hash?: string | null;
  l1_force_hash?: string | null;
  l2_tx_hash?: string | null;
  outcome: Outcome;
  retry_count: number;
  error?: string | null;
  submitted_at: string;
}

export interface LifecycleEventRow {
  event_id: string;
  run_id: string;
  stage: Stage;
  chain_layer: ChainLayer;
  block_number?: number | null;
  block_timestamp?: number | null;
  observed_at?: string | null;
  clock_source: ClockSource;
  confidence: Confidence;
  finalized?: 0 | 1;
  raw_ref?: string | null;
}

/** Every field is a uint256 and therefore a string. */
export interface CostRow {
  run_id: string;
  l1_gas_used?: string | null;
  l1_gas_price?: string | null;
  l1_fee_wei?: string | null;
  force_gas_used?: string | null;
  force_fee_wei?: string | null;
  l2_gas_used?: string | null;
  l2_fee_wei?: string | null;
  total_fee_wei?: string | null;
  l1_base_fee_at_submit?: string | null;
}

export interface MainnetEventRow {
  event_id: string;
  chain_key: string;
  class: MainnetClass;
  tx_hash: string;
  block_number: number;
  block_timestamp: number;
  evidence: string;
  value_wei?: string | null;
}

// ---------------------------------------------------------------------------
// Insert / update helpers
// ---------------------------------------------------------------------------

export function insertExperiment(db: DatabaseHandle, row: ExperimentRow): void {
  db.prepare(
    `INSERT INTO experiments
       (experiment_id, protocol, chain_key, environment, experiment_type,
        started_at, ended_at, git_commit, harness_version, notes)
     VALUES
       (@experiment_id, @protocol, @chain_key, @environment, @experiment_type,
        @started_at, @ended_at, @git_commit, @harness_version, @notes)`,
  ).run({ ended_at: null, notes: null, ...row });
}

export function setExperimentEnded(db: DatabaseHandle, experimentId: string, endedAt: string): void {
  db.prepare("UPDATE experiments SET ended_at = ? WHERE experiment_id = ?").run(endedAt, experimentId);
}

export function insertParamSnapshot(db: DatabaseHandle, row: ParamSnapshotRow): void {
  // Reject rather than coerce. A parameter with no locatable provenance must
  // not acquire one on the way into the database - see the ParamSource note.
  if (!PARAM_SOURCES.includes(row.source)) {
    throw new Error(
      `Refusing to record ${row.chain_key}.${row.key}: source ${JSON.stringify(row.source)} is not one of ` +
        `${PARAM_SOURCES.join(", ")}. A value with no located source is not written at all.`,
    );
  }
  db.prepare(
    `INSERT INTO param_snapshots
       (snapshot_id, experiment_id, chain_key, taken_at, l1_block, key, value, source)
     VALUES
       (@snapshot_id, @experiment_id, @chain_key, @taken_at, @l1_block, @key, @value, @source)`,
  ).run(row);
}

export function insertRun(db: DatabaseHandle, row: RunRow): void {
  db.prepare(
    `INSERT INTO runs
       (run_id, experiment_id, idempotency_key, path, tx_kind, sender, nonce,
        gas_limit, calldata_bytes, l1_tx_hash, l1_force_hash, l2_tx_hash,
        outcome, retry_count, error, submitted_at)
     VALUES
       (@run_id, @experiment_id, @idempotency_key, @path, @tx_kind, @sender, @nonce,
        @gas_limit, @calldata_bytes, @l1_tx_hash, @l1_force_hash, @l2_tx_hash,
        @outcome, @retry_count, @error, @submitted_at)`,
  ).run({
    nonce: null,
    gas_limit: null,
    l1_tx_hash: null,
    l1_force_hash: null,
    l2_tx_hash: null,
    error: null,
    ...row,
  });
}

export function setRunOutcome(
  db: DatabaseHandle,
  runId: string,
  outcome: Outcome,
  error: string | null = null,
): void {
  db.prepare("UPDATE runs SET outcome = ?, error = ? WHERE run_id = ?").run(outcome, error, runId);
}

/**
 * Insert one observed lifecycle stage.
 *
 * A run legitimately produces only the stages its protocol and environment can
 * produce: per BLUEPRINT section 20.1, Arbitrum on public testnet yields ZERO
 * S5 and S6 rows, because a healthy sequencer reads the delayed message long
 * before the 24h force window opens. That is expected data, not missing data.
 * Nothing here requires a complete stage set, no stage is defaulted, and no
 * absent stage is treated as an error - absence must be read from the data at
 * analysis time, never manufactured at write time.
 */
export function insertLifecycleEvent(db: DatabaseHandle, row: LifecycleEventRow): void {
  db.prepare(
    `INSERT INTO lifecycle_events
       (event_id, run_id, stage, chain_layer, block_number, block_timestamp,
        observed_at, clock_source, confidence, finalized, raw_ref)
     VALUES
       (@event_id, @run_id, @stage, @chain_layer, @block_number, @block_timestamp,
        @observed_at, @clock_source, @confidence, @finalized, @raw_ref)`,
  ).run({
    block_number: null,
    block_timestamp: null,
    observed_at: null,
    finalized: 0,
    raw_ref: null,
    ...row,
  });
}

export function setLifecycleFinalized(db: DatabaseHandle, eventId: string, finalized: boolean): void {
  db.prepare("UPDATE lifecycle_events SET finalized = ? WHERE event_id = ?").run(finalized ? 1 : 0, eventId);
}

export function upsertCosts(db: DatabaseHandle, row: CostRow): void {
  db.prepare(
    `INSERT INTO costs
       (run_id, l1_gas_used, l1_gas_price, l1_fee_wei, force_gas_used, force_fee_wei,
        l2_gas_used, l2_fee_wei, total_fee_wei, l1_base_fee_at_submit)
     VALUES
       (@run_id, @l1_gas_used, @l1_gas_price, @l1_fee_wei, @force_gas_used, @force_fee_wei,
        @l2_gas_used, @l2_fee_wei, @total_fee_wei, @l1_base_fee_at_submit)
     ON CONFLICT(run_id) DO UPDATE SET
       l1_gas_used = excluded.l1_gas_used,
       l1_gas_price = excluded.l1_gas_price,
       l1_fee_wei = excluded.l1_fee_wei,
       force_gas_used = excluded.force_gas_used,
       force_fee_wei = excluded.force_fee_wei,
       l2_gas_used = excluded.l2_gas_used,
       l2_fee_wei = excluded.l2_fee_wei,
       total_fee_wei = excluded.total_fee_wei,
       l1_base_fee_at_submit = excluded.l1_base_fee_at_submit`,
  ).run({
    l1_gas_used: null,
    l1_gas_price: null,
    l1_fee_wei: null,
    force_gas_used: null,
    force_fee_wei: null,
    l2_gas_used: null,
    l2_fee_wei: null,
    total_fee_wei: null,
    l1_base_fee_at_submit: null,
    ...row,
  });
}

export function insertMainnetEvent(db: DatabaseHandle, row: MainnetEventRow): void {
  db.prepare(
    `INSERT INTO mainnet_events
       (event_id, chain_key, class, tx_hash, block_number, block_timestamp, evidence, value_wei)
     VALUES
       (@event_id, @chain_key, @class, @tx_hash, @block_number, @block_timestamp, @evidence, @value_wei)`,
  ).run({ value_wei: null, ...row });
}

/** Has an L1 submission with this idempotency key already been recorded? (I5) */
export function hasAlreadySubmitted(db: DatabaseHandle, idempotencyKey: string): boolean {
  const row = db.prepare("SELECT 1 AS hit FROM runs WHERE idempotency_key = ?").get(idempotencyKey);
  return row !== undefined;
}
