# Data dictionary

Dataset for *Escape Hatches in the Wild: Measuring the Real Censorship-Resistance of Ethereum
Layer-2 Rollups*. Three files, one source of truth:

| File | What it is |
|---|---|
| `bench.sqlite` | The measurement database. Everything else is derived from it. |
| `export.csv` | One row per E2 run, 100 rows × 108 columns, produced by `npm run export`. **Every analysis and figure regenerates from this file alone.** |
| `export_manifest.json` | Provenance for `export.csv`: git commit, chain IDs, contract addresses used, block ranges observed, RPC hosts (host only, never a key), and the analysis decisions the columns encode. |

`SHA256SUMS` lists the digests of all three at release. Verify with `sha256sum -c SHA256SUMS`.

Read the three warnings first. Each describes a way to get a wrong number from correct data.

---

## Three things that will produce a wrong number if skipped

### 1. `total_fee_wei` is the only cross-protocol comparable cost figure

`total_fee_wei` is everything the transaction cost the user, in wei, across every leg on every
chain. It is the **only** cost column that may be compared between Arbitrum and the OP Stack.

Everything else in the cost family is protocol-specific, and two columns in particular are not
what their position suggests:

| Column | Populated on | What it is | Unit |
|---|---|---|---|
| `M_C3_op_l1_data_fee_wei` | OP Stack only | A **fee**, charged on top of L2 execution, priced at the **L1** gas price | wei |
| `M_C3_arb_l1_gas_allocation` | Arbitrum only | An **L2 gas allocation** — extra gas Nitro charges to recoup data posting, already *inside* `l2_gas_used` | L2 gas units |

These are different quantities in different units at different prices. Do not sum them, do
not compare them, do not plot them side by side as "the L1 cost". They are deliberately kept
in separate columns rather than pooled into one so that this mistake requires effort.

Consequently **totals compare; decompositions do not.** `total_fee_wei − M_C3` is not
like-for-like across protocols, because only the OP Stack has a separable, differently-priced
data-availability component. And on the OP Stack's *forced* path there is no `M_C3` at all: a
deposit's L2 execution is prepaid on L1, so `M_C1 == total_fee_wei` for every OP forced run.
That is the protocol, not missing data.

### 2. Wei columns are integers that exceed 2⁵³ — never read them as float

`total_fee_wei` and every other `*_wei` column exceed `Number.MAX_SAFE_INTEGER` and float64's
53-bit mantissa. A CSV reader that infers float64 will **silently round every value** and the
numbers will still look like numbers. Read every column as string, then convert wei columns to
arbitrary-precision integers (`int` in Python, `bigint` in TypeScript). `analysis/load.py` does
this and keeps an explicit `WEI_COLUMNS` list; if you add a cost column, add it there.

### 3. Latency columns carry a clock, and mixing clocks silently produces impossible values

There are three clocks: `wall` (host, ms), `l1_block` (L1 block timestamp, ~12 s), `l2_block`
(L2 block timestamp, 2 s OP / ~0.25 s Arbitrum). Every stage records `S<n>_clock_source`.
Every latency metric carries two companions:

- `<metric>_mixed_clock` — 1 if the two stages it spans are on different clocks
- `<metric>_resolution_sec` — the coarsest clock involved; **never report precision finer
  than this**

`l2_block` timestamps trail real time under sequencer load. On the devnet this produced a
latency 20 s *shorter* than its L1-only lower bound — impossible, and detectable only because
the clock source was recorded. `analysis/clockcheck.py` tests the whole dataset for that
impossibility; run it before trusting any latency.

---

## `export.csv` — column reference

### Identity and provenance (columns 1–21)

| Column | Type | Meaning |
|---|---|---|
| `run_id` | uuid | One row per run |
| `experiment_id` | text | Campaign this run belongs to |
| `experiment_type` | `A` / `B` | A = normal path (submit to sequencer). B = forced path (submit via L1) |
| `protocol` | text | `arbitrum-nitro` or `op-stack` |
| `chain_key` | text | `arb-sepolia` or `op-sepolia` |
| `environment` | text | Always `testnet` in this release (E2). Devnet (E1) runs are not in this table |
| `path` | `normal` / `forced` | Which path the transaction took |
| `tx_kind` | text | Transaction shape; all rows here are simple value transfers |
| `outcome` | text | `success`, `failed`, `timeout`, `pending`. **All 100 rows are `success`.** Non-success rows would still be exported with null latencies — the denominator is never silently shrunk |
| `retry_count` | int | Transport-level retries. Protocol reverts are never retried (they are data) |
| `error` | text | Populated only on non-success |
| `sender` | address | Testnet wallet |
| `nonce`, `gas_limit`, `calldata_bytes` | | As submitted |
| `submitted_at` | ISO 8601 | Wall-clock submission time. **Collection order** — used by `drift.py` |
| `l1_tx_hash` | hash | L1 submission (forced path only) |
| `l1_force_hash` | hash | Arbitrum `forceInclusion` transaction. **Null in every row** — see `inclusion_path` |
| `l2_tx_hash` | hash | The L2 transaction |
| `git_commit`, `harness_version` | | Code that produced the row |

### Lifecycle stages (columns 22–66)

Nine stages, five columns each: `S<n>_block_number`, `S<n>_block_timestamp`,
`S<n>_clock_source`, `S<n>_confidence`, `S<n>_finalized`.

| Stage | Meaning | Clock | Present on |
|---|---|---|---|
| S1 | transaction generated (signed) | wall | all |
| S2 | submitted to path | wall | all |
| S3 | L1 inclusion of submission | l1_block | forced |
| S4 | protocol queue entry (`MessageDelivered` / `TransactionDeposited`) | l1_block | forced |
| S5 | force eligibility | l1_block | Arbitrum forced, **inferred** |
| S6 | force action (`forceInclusion`) | l1_block | **none** — see below |
| S7 | L2 appearance | l2_block | all |
| S8 | L2 execution | l2_block | all |
| S9 | L1 finality | l1_block | forced |

**S5 is the only inferred stage** (`S5_confidence = inferred`): a computed eligibility time,
not an observation. It lies ~23.8 h *after* S7 in every Arbitrum forced run — the message was
included long before it became force-eligible. Do not treat S7 < S5 as a clock error.

**S6 is empty in all 100 rows.** Arbitrum's `forceInclusion` acts only on messages the
sequencer has not yet read, and a healthy sequencer reads them within minutes. The force leg is
therefore unreachable on a healthy testnet, and every Arbitrum forced run was auto-included.
This is the finding, not missing data. S6 is populated only on the E1 devnet, which is not in
this table.

### Latency metrics (columns 67–79)

| Column | Span | Populated on | Note |
|---|---|---|---|
| `M_L1` | S2 → S3 | forced | submission to L1 inclusion; single clock is not possible (wall → l1_block) |
| `M_L2` | S3 → S7 | forced | **L1 inclusion to L2 appearance — the one metric both protocols share.** Mixed clock |
| `M_L3` | S2 → S7 | forced | forced path end to end |
| `M_L4` | S1 → S8 | normal | normal path end to end |
| `is_complete` | 0/1 | all | 1 if every stage the path defines was observed |

Each metric has `_mixed_clock` and `_resolution_sec` companions. Seconds, integer-valued.
There is no `M_L5` here: M-L5 (censorship onset → recovery) is definable only on the devnet.

### Cost metrics (columns 80–94)

| Column | Meaning | Comparable across protocols? |
|---|---|---|
| `M_C1` | L1 submission fee, wei (forced only) | within protocol only |
| `M_C2` | `forceInclusion` fee, wei | **null in all rows** (never executed on testnet) |
| `M_C3` | L2 transaction fee, wei | within protocol only; **null on OP forced** (prepaid on L1) |
| `M_C3_op_l1_data_fee_wei` | see warning 1 | **no** |
| `M_C3_arb_l1_gas_allocation` | see warning 1 — this is gas, not wei | **no** |
| `total_fee_wei` | everything, wei | **yes — the only one** |
| `M_C4` | forced-path premium ratio | **null on purpose.** The baseline choice is an analysis decision; compute it in Python from `M_C4_numerator_wei` against experiment A on the same chain |
| `M_C4_numerator_wei` | = `total_fee_wei`, exported for that computation | |
| `M_U1` | user-initiated L1 transactions | 0 normal, 1 forced. Arbitrum's protocol requires 2; the second was never needed because of auto-inclusion |
| `inclusion_path` | `auto` on every Arbitrum forced run | the message was consumed voluntarily before force-eligibility |
| `l1_gas_used`, `l1_gas_price`, `l2_gas_used`, `force_gas_used`, `l1_base_fee_at_submit` | raw components | |

### Live parameter snapshot (columns 95–108)

Every protocol parameter the run depended on, read from chain (or rollup config) at campaign
start, with its `_source`. Nothing here was hardcoded.

| Column | Arbitrum Sepolia | OP Sepolia | Source |
|---|---|---|---|
| `param_delayBlocks` | 7200 | — | on-chain `maxTimeVariation()` |
| `param_delaySeconds` | 86400 | — | on-chain |
| `param_futureBlocks` / `param_futureSeconds` | 64 / 768 | — | on-chain |
| `param_totalDelayedMessagesRead` | 2163032 | — | on-chain, at snapshot |
| `param_portalVersion` | — | 5.6.1 | on-chain `version()` |
| `param_statedForcedBoundSec` | 86400 | 43200 | Arbitrum: on-chain. **OP: `rollup-config`** — the 3600-block sequencing window is declared in the superchain registry, not readable from a contract |

Note the OP bound's source is `rollup-config`, not `on-chain`. That is a small asymmetry in
how checkable the two guarantees are, and the column says so.

---

## `bench.sqlite` — tables

The database is the authority; `export.csv` is a join over it. Two tables are not in the CSV
and matter for the mainnet result:

**`mainnet_scans`** (11 rows) — one row per (chain, contract, block range) examined. Carries the
exact `from_block`/`to_block`, `logs_seen` (events examined off the raw stream — **this is the
Class A denominator**), `complete`, `rpc_host` (host only), and `notes` including the
`dataLocation` distribution per range. `analysis/mainnet.py` checks that ranges are disjoint
and contiguous before quoting any rate.

**`mainnet_events`** (4,103 rows) — one row per classified event. Keyed
`UNIQUE(chain_key, tx_hash, log_index, class)`; the `log_index` is what makes it one row per
*event* rather than per transaction. `class` ∈ {A, B, C, D}; `evidence` is the string that
justifies the label, on every row. Class A rows (a confirmed `forceInclusion`) would carry
`batch_size`, `swept_own`, `swept_other`, `swept_unknown`, `actor`. **There are none.**

Other tables: `runs`, `lifecycle_events`, `lifecycle_event_revisions` (superseded observations
after a reorg or recheck — never overwritten in place), `costs`, `param_snapshots`,
`experiments`, `schema_migrations`.

All `uint256` values are stored as `TEXT` (see warning 2). Block numbers are `INTEGER`.

---

## What is not in this dataset

- **E1 (devnet) runs.** The single censorship run and its M-L5 measurement are reported in the
  paper from the run's recorded state, not from this database. n = 1.
- **Any mainnet Class A event.** Because there are none.
- **API keys or full RPC URLs.** Only hosts are stored, anywhere.
- **Any transaction after Sepolia's expected end of life, 30 September 2026** (EF blog, *Holesky and
  Hoodi Testnet Updates*, 18 March 2025). E2 cannot be recollected; see `REPRODUCE.md` §9.
