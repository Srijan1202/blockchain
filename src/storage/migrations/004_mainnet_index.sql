-- T13: mainnet indexing + event classification (BLUEPRINT section 12).
--
-- Two additions to what 001 already provides.
--
-- 1. mainnet_scans. A classification count is meaningless without the window it
--    was counted over. "Six Class A events" is a rate only if the denominator -
--    the exact block range scanned - travels with it, and the honesty gate in
--    section 12 asks for a binomial CI, which needs that denominator to exist as
--    data rather than as a sentence in a commit message. Every event row points
--    at the scan that produced it.
--
-- 2. Columns for the Class A batch-size extraction. E1 measured
--    totalDelayedMessagesRead advancing 102 -> 107: one forcing user paid to
--    include five messages. Whether that generalises decides between the two
--    readings recorded in BLUEPRINT 20.1 - a griefing surface where queue depth
--    inflates the forcer's bill, or a public good where marginal cost per
--    message falls. Only mainnet can answer it, and only if the numbers are
--    stored per call rather than aggregated at read time.
--
-- Every added column is nullable and no existing column changes, so this
-- migration cannot invalidate rows written by 001-003.

-- Which block range was actually covered, and by which endpoint.
CREATE TABLE IF NOT EXISTS mainnet_scans (
  scan_id      TEXT PRIMARY KEY,
  chain_key    TEXT NOT NULL,
  -- The contract whose logs were read. One scan row per (chain, contract, range)
  -- so a partial re-scan of one target cannot silently claim the others' coverage.
  target       TEXT NOT NULL,
  target_label TEXT NOT NULL,
  from_block   INTEGER NOT NULL,
  to_block     INTEGER NOT NULL,
  -- Host only, never the full URL: an API key must never reach the dataset.
  -- Same rule export.ts applies to rpc_hosts.
  rpc_host     TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  -- Raw logs matched before classification. Lets a reader distinguish "scanned
  -- and found nothing" from "scan died early", which a row count cannot.
  logs_seen    INTEGER NOT NULL DEFAULT 0,
  complete     INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
  notes        TEXT,
  UNIQUE (chain_key, target, from_block, to_block)
);

CREATE INDEX IF NOT EXISTS idx_mainnet_scans_chain ON mainnet_scans(chain_key, target);

-- The scan that produced this row. Nullable: 001 predates scans.
ALTER TABLE mainnet_events ADD COLUMN scan_id TEXT REFERENCES mainnet_scans(scan_id);

-- Class A only. How far totalDelayedMessagesRead advanced across the call, i.e.
-- how many delayed messages this single forceInclusion swept in. NOT a
-- per-message cost: see BLUEPRINT 20.1, "Forcing is a batch operation".
ALTER TABLE mainnet_events ADD COLUMN batch_size INTEGER;

-- Of batch_size, how many messages were sent by the forcer versus other
-- parties. The sharpest form of the griefing-vs-public-good question: a forcer
-- who sweeps only their own messages pays for themselves, one who sweeps
-- strangers' messages is subsidising them. Aliasing is resolved before
-- comparing - Inbox.sendL2Message records the L1->L2 ALIASED sender, so a raw
-- tx.from comparison would report every message as somebody else's.
ALTER TABLE mainnet_events ADD COLUMN swept_own INTEGER;
ALTER TABLE mainnet_events ADD COLUMN swept_other INTEGER;
-- Messages inside the swept index range whose MessageDelivered event could not
-- be located. Counted separately and never folded into swept_other, because
-- "not found" is not evidence of "someone else's".
ALTER TABLE mainnet_events ADD COLUMN swept_unknown INTEGER;

-- Class A: the EOA/contract that sent the forceInclusion transaction.
ALTER TABLE mainnet_events ADD COLUMN actor TEXT;

-- Class B/C: observed delay in L1 blocks between MessageDelivered and the
-- SequencerBatchDelivered that first read it. The Class B boundary is the
-- inbox's own on-chain buffer threshold, never a constant chosen here (I1).
ALTER TABLE mainnet_events ADD COLUMN delay_blocks INTEGER;

CREATE INDEX IF NOT EXISTS idx_mainnet_events_scan ON mainnet_events(scan_id);
