-- 002_lifecycle_revisions.sql
--
-- REORG DECISION, recorded here and in tracker.ts.
--
-- lifecycle_events carries UNIQUE (run_id, stage), so a corrected observation
-- cannot simply be appended. Three options were available:
--
--   (a) update the row in place            - REJECTED. The original observation
--       is lost, and a reorg that moved a measurement is itself data. Silently
--       keeping only the corrected value is exactly the outcome to avoid.
--   (b) drop UNIQUE and append revisions   - REJECTED. It would break the
--       validated T4 schema and its acceptance test, and every reader would
--       then have to know to select the newest row or risk double-counting a
--       run. The constraint is load-bearing: it is what makes "one row per
--       stage per run" true by construction.
--   (c) supersede into a history table     - CHOSEN.
--
-- lifecycle_events remains the CURRENT best observation, one row per stage, so
-- analysis queries stay simple and cannot double-count. Before any correction
-- overwrites a row, the prior version is copied here verbatim with the reason.
-- Nothing is lost, the constraint is preserved, and "was this measurement ever
-- moved by a reorg?" is answerable by joining this table.
--
-- A run whose revisions table is non-empty had a measurement change underneath
-- it and should be inspected before its latencies are trusted.

CREATE TABLE IF NOT EXISTS lifecycle_event_revisions (
  revision_id     TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL,
  run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  stage           TEXT NOT NULL CHECK (stage IN ('S1','S2','S3','S4','S5','S6','S7','S8','S9')),
  -- The superseded observation, exactly as it was recorded.
  chain_layer     TEXT NOT NULL CHECK (chain_layer IN ('L1','L2')),
  block_number    INTEGER,
  block_timestamp INTEGER,
  observed_at     TEXT,
  clock_source    TEXT NOT NULL CHECK (clock_source IN ('wall','l1_block','l2_block')),
  confidence      TEXT NOT NULL CHECK (confidence IN ('observed','inferred')),
  finalized       INTEGER NOT NULL DEFAULT 0,
  raw_ref         TEXT,
  -- Why it was superseded, and when we noticed.
  reason          TEXT NOT NULL CHECK (reason IN ('reorg','recheck')),
  superseded_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_run ON lifecycle_event_revisions(run_id, stage);
