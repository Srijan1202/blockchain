-- 001_init.sql
--
-- Schema per IMPLEMENTATION.md T4. The SQL there is validated and is used as
-- given: every CHECK and UNIQUE constraint is reproduced verbatim.
--
-- Two constraints carry the measurement discipline structurally rather than by
-- convention (BLUEPRINT section 13):
--   * lifecycle_events.clock_source + confidence make section 11's three-clock
--     rule impossible to forget at write time.
--   * runs.idempotency_key UNIQUE makes I5 a database invariant, so a retry
--     cannot double-submit an L1 transaction even if the guard above it is
--     bypassed.
--
-- Every DDL statement is IF NOT EXISTS, so re-running a migration is a no-op.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS experiments (
  experiment_id   TEXT PRIMARY KEY,
  protocol        TEXT NOT NULL,
  chain_key       TEXT NOT NULL,
  environment     TEXT NOT NULL CHECK (environment IN ('devnet','testnet','mainnet')),
  experiment_type TEXT NOT NULL CHECK (experiment_type IN ('A','B','C','C_prime','D','E')),
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  git_commit      TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS param_snapshots (
  snapshot_id   TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id) ON DELETE CASCADE,
  chain_key     TEXT NOT NULL,
  taken_at      TEXT NOT NULL,
  l1_block      INTEGER NOT NULL,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('on-chain','rollup-config','docs'))
);
CREATE INDEX IF NOT EXISTS idx_param_exp ON param_snapshots(experiment_id);

CREATE TABLE IF NOT EXISTS runs (
  run_id          TEXT PRIMARY KEY,
  experiment_id   TEXT NOT NULL REFERENCES experiments(experiment_id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  path            TEXT NOT NULL CHECK (path IN ('normal','forced')),
  tx_kind         TEXT NOT NULL CHECK (tx_kind IN ('eth_transfer','contract_call')),
  sender          TEXT NOT NULL,
  nonce           INTEGER,
  gas_limit       TEXT,
  calldata_bytes  INTEGER NOT NULL DEFAULT 0,
  l1_tx_hash      TEXT,
  l1_force_hash   TEXT,
  l2_tx_hash      TEXT,
  outcome         TEXT NOT NULL CHECK (outcome IN ('pending','success','failed','timeout')),
  retry_count     INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  submitted_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_exp ON runs(experiment_id);

CREATE TABLE IF NOT EXISTS lifecycle_events (
  event_id        TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  stage           TEXT NOT NULL CHECK (stage IN ('S1','S2','S3','S4','S5','S6','S7','S8','S9')),
  chain_layer     TEXT NOT NULL CHECK (chain_layer IN ('L1','L2')),
  block_number    INTEGER,
  block_timestamp INTEGER,
  observed_at     TEXT,
  clock_source    TEXT NOT NULL CHECK (clock_source IN ('wall','l1_block','l2_block')),
  confidence      TEXT NOT NULL CHECK (confidence IN ('observed','inferred')),
  finalized       INTEGER NOT NULL DEFAULT 0,
  raw_ref         TEXT,
  UNIQUE (run_id, stage)
);
CREATE INDEX IF NOT EXISTS idx_life_run ON lifecycle_events(run_id);

CREATE TABLE IF NOT EXISTS costs (
  run_id                TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  l1_gas_used           TEXT,
  l1_gas_price          TEXT,
  l1_fee_wei            TEXT,
  force_gas_used        TEXT,
  force_fee_wei         TEXT,
  l2_gas_used           TEXT,
  l2_fee_wei            TEXT,
  total_fee_wei         TEXT,
  l1_base_fee_at_submit TEXT
);

CREATE TABLE IF NOT EXISTS mainnet_events (
  event_id        TEXT PRIMARY KEY,
  chain_key       TEXT NOT NULL,
  class           TEXT NOT NULL CHECK (class IN ('A','B','C','D')),
  tx_hash         TEXT NOT NULL,
  block_number    INTEGER NOT NULL,
  block_timestamp INTEGER NOT NULL,
  evidence        TEXT NOT NULL,
  value_wei       TEXT,
  UNIQUE (chain_key, tx_hash, class)
);
CREATE INDEX IF NOT EXISTS idx_mainnet_class ON mainnet_events(chain_key, class);
