-- Fix the mainnet_events uniqueness key so one row means one EVENT.
--
-- THE DEFECT. 001 keyed the table UNIQUE(chain_key, tx_hash, class). One L1
-- transaction can emit several events of the same class - a batched bridge
-- deposit emits several TransactionDeposited, and a single transaction can
-- deliver several MessageDelivered - and every one after the first was silently
-- rejected. Measured across three scans: 18 of 362 OP Mainnet deposits, 28 of
-- 1,095 Base deposits, and 11 of 2,646 Arbitrum messages never became rows. The
-- row counts equalled the DISTINCT-TRANSACTION counts exactly, which is the
-- signature of the collision.
--
-- Why this needed fixing rather than documenting. The paper can qualify its own
-- tables, but the dataset is a release artifact: anyone reusing it would read a
-- row count as an event count, and nothing in the schema would tell them
-- otherwise. A count that is silently a different count is the kind of defect
-- that survives into other people's results.
--
-- NOT AFFECTED: the Class A result. Its denominator is mainnet_scans.logs_seen,
-- counted off the raw log stream before any row is written, and the NoData
-- candidate count is likewise taken from the stream. Both are independent of
-- this table's uniqueness key.
--
-- log_index is the log's position within its block, which together with the
-- transaction hash identifies an event uniquely. SQLite cannot alter a UNIQUE
-- constraint in place, so the table is rebuilt; existing rows are carried over
-- with log_index -1, meaning "recorded before this column existed". Scans
-- re-run after this migration replace those rows with correctly-keyed ones.

ALTER TABLE mainnet_events RENAME TO mainnet_events_pre005;

CREATE TABLE mainnet_events (
  event_id        TEXT PRIMARY KEY,
  chain_key       TEXT NOT NULL,
  class           TEXT NOT NULL CHECK (class IN ('A','B','C','D')),
  tx_hash         TEXT NOT NULL,
  -- Position of the log within its block. -1 marks a row written before this
  -- column existed, so a legacy row cannot be mistaken for log 0.
  log_index       INTEGER NOT NULL DEFAULT -1,
  block_number    INTEGER NOT NULL,
  block_timestamp INTEGER NOT NULL,
  evidence        TEXT NOT NULL,
  value_wei       TEXT,
  scan_id         TEXT REFERENCES mainnet_scans(scan_id),
  batch_size      INTEGER,
  swept_own       INTEGER,
  swept_other     INTEGER,
  swept_unknown   INTEGER,
  actor           TEXT,
  delay_blocks    INTEGER,
  UNIQUE (chain_key, tx_hash, log_index, class)
);

INSERT INTO mainnet_events
  (event_id, chain_key, class, tx_hash, log_index, block_number, block_timestamp,
   evidence, value_wei, scan_id, batch_size, swept_own, swept_other, swept_unknown,
   actor, delay_blocks)
SELECT
  event_id, chain_key, class, tx_hash, -1, block_number, block_timestamp,
  evidence, value_wei, scan_id, batch_size, swept_own, swept_other, swept_unknown,
  actor, delay_blocks
FROM mainnet_events_pre005;

DROP TABLE mainnet_events_pre005;

CREATE INDEX IF NOT EXISTS idx_mainnet_class ON mainnet_events(chain_key, class);
CREATE INDEX IF NOT EXISTS idx_mainnet_events_scan ON mainnet_events(scan_id);
