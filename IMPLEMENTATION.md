# IMPLEMENTATION.md

Step-by-step build queue for `l2-escape-bench`.

**How to use this file with Claude Code:**

1. Put `CLAUDE.md`, this file, and `docs/BLUEPRINT.md` in the repo root (blueprint in
   `docs/`). Claude Code loads `CLAUDE.md` automatically each session.
2. Work **one task at a time**. Paste the task's "Prompt" block into Claude Code.
3. After each task, run `npm run typecheck` and check the acceptance criteria yourself.
4. Commit after each task with the message given. Small commits make it obvious when a
   measurement change altered results.

Do not skip ahead. Later tasks assume earlier invariants are in place.

---

## Progress tracker

- [ ] **T0** — Repo bootstrap
- [ ] **T1** — Chain registry with provenance
- [ ] **T2** — Live parameter snapshots
- [ ] **T3** — `verify` CLI *(← Day 1 exit criterion)*
- [ ] **T4** — Storage layer + schema
- [ ] **T5** — Core types + clock discipline
- [ ] **T6** — Logging + retry + idempotency
- [ ] **T7** — `ProtocolAdapter` interface
- [ ] **T8** — OP Stack adapter *(simpler — do this before Arbitrum)*
- [ ] **T9** — Lifecycle tracker
- [ ] **T10** — Arbitrum adapter
- [ ] **T11** — Experiment runner CLI *(← Day 7 exit: working pipeline)*
- [ ] **T12** — Export CLI
- [ ] **T13** — Mainnet indexer + classifier
- [ ] **T14** — Analysis handoff

**T0–T3 correspond to Day 1–2. T4–T11 are Days 3–7. T13–T14 are Week 7+.** Do not build
T13 before T11 works — mainnet indexing against an unproven measurement model wastes days.

---

## T0 — Repo bootstrap

**Goal.** A repository that installs and typechecks with nothing in it yet.

**Files to create**

| Path | Purpose |
|---|---|
| `package.json` | ESM, Node ≥20, scripts |
| `tsconfig.json` | strict + `noUncheckedIndexedAccess`, ES2022, bundler resolution |
| `.env.example` | RPC URLs, private key placeholder, DB path |
| `.gitignore` | `node_modules`, `.env`, `data/*.sqlite*`, `dist` |
| `README.md` | one paragraph + the four commands |
| directory skeleton | per `CLAUDE.md` §4, `.gitkeep` in empty dirs |

**Spec**

- `"type": "module"`. Dependencies: `viem`, `dotenv`. Dev: `typescript`, `tsx`,
  `@types/node`. Nothing else yet.
- Scripts: `verify`, `typecheck`, `build`, `run`, `export`.
- `.env.example` must contain: `RPC_ETH_SEPOLIA`, `RPC_ARB_SEPOLIA`, `RPC_OP_SEPOLIA`,
  `RPC_BASE_SEPOLIA`, `PRIVATE_KEY`, `DB_PATH`.

**Acceptance**

- `npm install` succeeds.
- `npm run typecheck` passes on an empty `src/`.
- `.env` is gitignored. `.env.example` is committed.

**Guardrails.** Do not add a linter, test framework, or CI config. Do not scaffold files
belonging to later tasks.

**Commit:** `chore: bootstrap repo`

> **Prompt**
> Read CLAUDE.md, then implement T0 from IMPLEMENTATION.md. Create only the files listed
> in that task. Run `npm install` and `npm run typecheck` and show me the output.

---

## T1 — Chain registry with provenance

**Goal.** A single source of truth for chain config where an unverified address cannot
silently become a published number.

**File:** `src/config/chains.ts`

**Spec**

```ts
type Verification = "verified" | "UNVERIFIED";

interface AddressRef {
  address: Address | null;
  source: string;       // where this came from, specifically
  checked: string;      // ISO date last confirmed
  verification: Verification;
}
```

Each L2 config carries: `key`, `family` (`arbitrum-nitro` | `op-stack` | `zk-stack`),
`chainId`, `rpcEnv`, `l1`, `blockTimeSec`, `l1Contracts: Record<string, AddressRef>`,
`statedForcedBoundSec: number | null`, `notes`.

**Verified values — use exactly these, do not alter them** (confirmed 2026-08-27):

*Arbitrum Sepolia (contracts on Ethereum Sepolia), chainId 421614:*
- SequencerInbox `0x6c97864CE4bEf387dE0b3310A44230f7E3F1be0D`
- Inbox `0xaAe29B0366299461418F5324a79Afc425BE5ae21`
- Bridge `0x38f918D0E9F1b721EDaA41302E399fa1B79333a9`
- Rollup `0xd80810638dbDF9081b72C1B33c65375e807281C8`
- Outbox `0x65f07C7D521164a4d5DaC6eB8Fac8DA067A3B78F`
- `statedForcedBoundSec: null` — **read at runtime, never hardcode 86400**

*OP Sepolia, chainId 11155420:*
- OptimismPortal2 `0xfcbb237388CaF5b08175C9927a37aB6450acd535`
- `statedForcedBoundSec: 3600 * 12` (sequencing window, from rollup config)

*Base Sepolia, chainId 84532:*
- OptimismPortal — `address: null`, `verification: "UNVERIFIED"`,
  source `"TODO: resolve from ethereum-optimism/superchain-registry"`

*Ethereum Sepolia:* chainId 11155111, `blockTimeSec: 12`

Also export `unverifiedRefs()` returning every `UNVERIFIED` or `null` address so "what do I
still not know" is a function call, not a memory exercise.

**Acceptance**

- Typechecks. `unverifiedRefs()` returns exactly one entry (Base Sepolia portal).
- No address appears anywhere outside this file.

**Guardrails.** Do not invent the Base Sepolia address. Do not default
`statedForcedBoundSec` for Arbitrum.

**Commit:** `feat(config): chain registry with address provenance`

---

## T2 — Live parameter snapshots

**Goal.** Capture the protocol parameters that could change mid-study, so an upgrade shows
up as a visible discontinuity rather than unexplained noise.

**File:** `src/core/params.ts`

**Spec**

- Minimal ABIs only — the functions actually called, not full contract ABIs.
  - SequencerInbox: `maxTimeVariation()` → `(delayBlocks, futureBlocks, delaySeconds, futureSeconds)`, and `totalDelayedMessagesRead()`.
  - OptimismPortal: `version()`.
- `snapshotParams(chainKey)` → `{ chainKey, family, takenAt, l1BlockNumber, values, errors }`.
- **A failed read populates `errors`, never a default value.** `maxTimeVariation()` may
  have changed signature post-BoLD; if it throws, record the error text.
- For OP Stack, `statedForcedBoundSec` is annotated
  `source: "rollup config (superchain-registry), not on-chain"` — it is genuinely not
  readable from the portal, and the export must say so.
- `l1Client()` and `l2Client(cfg)` helpers that throw a clear error when the env var is
  missing.

**Acceptance**

- With RPCs reachable, returns real `delaySeconds` for Arbitrum Sepolia.
- With RPCs unreachable, returns a snapshot with populated `errors` and **does not throw**.
- No numeric protocol constant appears in this file except the OP sequencing window, which
  is annotated with its source.

**Commit:** `feat(core): live protocol parameter snapshots`

---

## T3 — `verify` CLI  ← Day 1 exit criterion

**Goal.** One command that proves every RPC works, every address is readable, and names
everything still unverified.

**File:** `src/cli/verify.ts`

**Spec**

Checks each chain: expected vs actual `chainId`, latest block number and timestamp.
Then prints live parameters per L2, then the unverified list. Supports `--json` for machine
output. Exit code 0 only if every chain check passes.

Output sections, in order: `=== CHAIN CONNECTIVITY ===`,
`=== LIVE PROTOCOL PARAMETERS ===`, `=== UNVERIFIED - RESOLVE BEFORE EXPERIMENTS ===`,
then `Day-1 exit criterion: MET` or `NOT MET (n chain check(s) failing)`.

**Acceptance**

- `npm run verify` prints all three sections.
- Every RPC failure is reported per chain; the command does not crash.
- Base Sepolia appears under UNVERIFIED.

**Guardrails.** Read-only. No transactions, no private key usage.

**Commit:** `feat(cli): verify command for connectivity and parameters`

> **After T3, stop and do Day 2 manually.** Read `maxTimeVariation()` on Arbitrum Sepolia
> via Etherscan *and* via `npm run verify`, and confirm they agree. Resolve the Base Sepolia
> portal address from `ethereum-optimism/superchain-registry`. Update `chains.ts` with the
> real value, source URL, and date. **The `delaySeconds` result decides whether the Arbitrum
> force leg runs on public testnet or only on the devnet** — that branches the experiment
> plan, so settle it before writing more code.

---

## T4 — Storage layer + schema

**Goal.** A schema that enforces the measurement discipline structurally, so §11's clock
rules cannot be violated by forgetting.

**Files:** `src/storage/db.ts`, `src/storage/migrations/001_init.sql`

**Dependency:** add `better-sqlite3` and `@types/better-sqlite3`.

**Schema** — this is validated SQL; use it as given:

```sql
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
```

**`db.ts` spec.** Open at `DB_PATH`, enable `foreign_keys`, run numbered migrations in
order tracked in a `schema_migrations` table. Export typed insert/update helpers. All
`uint256` params typed `string`, never `number`.

**Acceptance**

- Fresh DB creates all six tables plus `schema_migrations`.
- Running migrations twice is a no-op.
- Inserting two `lifecycle_events` with the same `(run_id, stage)` throws.
- Inserting `chain_layer = 'L3'` throws.

**Commit:** `feat(storage): sqlite schema and migrations`

---

## T5 — Core types + clock discipline

**Goal.** Make the three-clock rule impossible to violate by accident.

**Files:** `src/core/types.ts`, `src/core/clock.ts`

**Spec**

`types.ts`: `LifecycleStage` (`'S1'..'S9'`), `ClockSource`, `Confidence`, `ChainLayer`,
`TxSpec`, `SubmissionRef`, `LifecycleEvent`, `RunRecord`, `CostRecord`. All chain numerics
`bigint` in memory, `string` at the storage boundary.

`clock.ts` — the important one:

```ts
interface Timestamped { clockSource: ClockSource; seconds: bigint; }

interface Duration {
  seconds: bigint;
  mixedClock: boolean;      // true when start and end clocks differ
  resolutionSeconds: number; // the COARSER of the two clocks
  fromStage: LifecycleStage;
  toStage: LifecycleStage;
}

function duration(from: Timestamped, to: Timestamped, ...): Duration;
```

`duration()` must set `mixedClock: true` whenever the two clock sources differ, and set
`resolutionSeconds` to the coarser clock (wall = 0.001, l2_block = 2, l1_block = 12).
Resolution constants live here and nowhere else.

**Acceptance**

- `duration()` across `l1_block` → `l2_block` returns `mixedClock: true`,
  `resolutionSeconds: 12`.
- No way to produce a `Duration` without a resolution.

**Guardrails.** Do not add unit conversion helpers or a date library. Seconds and bigints only.

**Commit:** `feat(core): types and three-clock duration discipline`

---

## T6 — Logging, retry, idempotency

**Files:** `src/core/logger.ts`, `src/core/retry.ts`
**Dependency:** add `pino`.

**Spec**

- `logger.ts`: pino, JSON, level from `LOG_LEVEL` (default `info`). `childLogger(runId)`
  binds `run_id` to every line.
- `retry.ts`: `withRetry(fn, opts)` — exponential backoff, max 5, jitter. Takes a
  `classify(err) => 'transport' | 'protocol'` function. **Retries transport errors only.**
  A protocol error rethrows immediately.
- `idempotencyKey(experimentId, index, path, chainKey)` → deterministic string.
- `hasAlreadySubmitted(db, key)` → boolean, checked before every L1 send.

**Acceptance**

- A simulated revert is not retried.
- A simulated connection reset is retried with increasing delays.
- Submitting the same idempotency key twice is prevented before the network call.

**Commit:** `feat(core): structured logging, typed retry, idempotency guard`

---

## T7 — `ProtocolAdapter` interface

**File:** `src/protocols/adapter.ts`

**Spec**

```ts
export interface ProtocolAdapter {
  readonly chainKey: string;
  readonly family: ProtocolFamily;

  submitNormal(tx: TxSpec, ctx: RunContext): Promise<SubmissionRef>;
  submitForced(tx: TxSpec, ctx: RunContext): Promise<SubmissionRef>;

  /**
   * Protocol-specific completion action.
   * Arbitrum: forceInclusion after the delay.
   * OP Stack: returns null — inclusion is automatic.
   * Returning null is MEANINGFUL DATA (metric M-U1), not an unimplemented stub.
   */
  completeForced(ref: SubmissionRef, ctx: RunContext): Promise<SubmissionRef | null>;

  track(ref: SubmissionRef, ctx: RunContext): AsyncIterable<LifecycleEvent>;
  snapshotParams(): Promise<ParamSnapshot>;

  /** Stages this protocol can actually produce. Never fake a stage. */
  readonly supportedStages: ReadonlySet<LifecycleStage>;
}
```

Stage map — encode this, do not invent stages a protocol lacks:

| Stage | Meaning | Arbitrum | OP Stack |
|---|---|---|---|
| S1 | generated | wall | wall |
| S2 | submitted to path | wall | wall |
| S3 | L1 inclusion of submission | l1_block | l1_block |
| S4 | protocol queue entry | `InboxMessageDelivered` | `TransactionDeposited` |
| S5 | force eligibility | computed (inferred) | **not supported** |
| S6 | force action | `forceInclusion` (l1_block) | **not supported** |
| S7 | L2 appearance | l2_block | l2_block |
| S8 | L2 execution | l2_block | l2_block |
| S9 | L1 finality | l1_block | l1_block |

**Acceptance.** Interface compiles; `supportedStages` for OP Stack excludes S5 and S6.

**Commit:** `feat(protocols): adapter interface and stage model`

---

## T8 — OP Stack adapter

**Do this before Arbitrum.** One L1 call, no waiting — fastest route to a complete working
forced-path measurement.

**Files:** `src/protocols/opstack/abi.ts`, `deposit.ts`, `adapter.ts`

**Spec**

- ABI: `depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data)` and event `TransactionDeposited(address indexed from, address indexed to, uint256 indexed version, bytes opaqueData)`.
- `submitNormal`: ordinary tx via the L2 sequencer RPC.
- `submitForced`: `depositTransaction` on the portal with `msg.value`. Emits S2 (wall), then
  S3 + S4 once the L1 receipt lands.
- `completeForced`: **returns `null`.** Add a comment explaining this is the asymmetry, not
  a gap.
- `track`: poll L2 for the resulting deposit transaction (type `0x7E`), emit S7 and S8; then
  S9 on L1 finality.
- Fail loudly if the portal address is `UNVERIFIED` (this is how Base Sepolia behaves until
  Day 2 is done).

**Address aliasing note.** Contract senders get alias
`address + 0x1111000000000000000000000000000000001111`; **EOA senders do not.** The
experiment wallet is an EOA, so no aliasing — but put this in a code comment, because a
reviewer will ask and future-you will not remember.

**Acceptance**

- One real deposit on OP Sepolia produces S2, S3, S4, S7, S8 with correct clock sources.
- `completeForced` returns `null` and logs why.
- `supportedStages` excludes S5, S6.

**Commit:** `feat(protocols): OP Stack deposit adapter`

---

## T9 — Lifecycle tracker

**File:** `src/measurement/tracker.ts`

**Spec**

Consumes `adapter.track()`, persists each event, computes durations via `clock.ts`, marks
`finalized` after L1 finality (2 epochs), handles reorgs by re-verifying before finalizing.
Per-stage timeouts; a timeout writes `outcome = 'timeout'` and stops — it does not retry.

**Acceptance**

- A full run persists one row per supported stage, no duplicates.
- Reorged block numbers are corrected before finalization.
- Timeouts are recorded, not thrown.

**Commit:** `feat(measurement): lifecycle tracker with finality handling`

---

## T10 — Arbitrum adapter

**Files:** `src/protocols/arbitrum/abi.ts`, `forceInclude.ts`, `adapter.ts`
**Dependency:** add `@arbitrum/sdk` (submission leg only).

**Spec**

- `submitForced`: sign the L2 tx for chain 421614, submit via `Inbox.sendL2Message` on
  Ethereum Sepolia. Emit S2, S3, S4 (`InboxMessageDelivered`).
- S5 (force eligibility) is **computed** from the live `delaySeconds` — mark
  `confidence: 'inferred'`, never `'observed'`.
- `completeForced`: call `SequencerInbox.forceInclusion(...)`. Emit S6. **If it reverts,
  record the revert reason as an outcome — this is potentially the paper's most valuable
  result. Never swallow it.**
- `track`: poll Arbitrum Sepolia for the L2 tx; emit S7, S8, then S9.
- **Label the auto-inclusion leg correctly.** On a healthy sequencer the delayed message is
  read voluntarily in ~10 minutes. That is *auto-inclusion*, not a force. Distinguish it in
  the data: reaching S7 without S6 means auto-inclusion.

**Acceptance**

- A delayed-inbox submission produces S2, S3, S4 on Arbitrum Sepolia.
- S5 is present and marked `inferred`.
- Auto-inclusion (S7 without S6) is distinguishable from forced inclusion (S6 then S7).
- `delaySeconds` is read live, never hardcoded.

**Commit:** `feat(protocols): Arbitrum delayed-inbox and forceInclusion adapter`

---

## T11 — Experiment runner CLI  ← Day 7 exit: working pipeline

**Files:** `src/config/experiments.ts`, `src/cli/run.ts`

**Spec**

`npm run run -- --experiment B --chain arb-sepolia --n 25 [--dry-run]`

Flow: create the `experiments` row (with `git_commit` from `git rev-parse HEAD`) → take a
param snapshot → for each i: build `TxSpec`, compute idempotency key, check for prior
submission, submit, track, persist costs → write `ended_at`.

Fixed per campaign: sender, tx kind, gas limit, chain, RPC endpoint. Randomised: nothing in
the pilot — hold everything constant until variance is understood.

`--dry-run` does everything except sending transactions.

**Acceptance**

- `--dry-run` completes with no network sends.
- A real n=2 campaign on OP Sepolia writes complete `experiments`, `param_snapshots`,
  `runs`, `lifecycle_events`, and `costs` rows.
- Re-running the same campaign id does not double-submit.
- **Day 7 target: `data/bench.sqlite` holds ≥4 complete runs across two protocols.**

**Commit:** `feat(cli): experiment campaign runner`

---

## T12 — Export CLI

**File:** `src/cli/export.ts`

**Spec.** `npm run export -- --out data/export.csv`. One row per run, joined with
lifecycle, costs, and param snapshot. Columns use the blueprint metric IDs (`M_L1`, `M_L2`,
`M_L3`, `M_C1`..`M_C4`, `M_U1`). Every duration column is accompanied by
`<metric>_mixed_clock` and `<metric>_resolution_sec`. Also emit `data/export_manifest.json`
with git commit, chain IDs, contract addresses used, block ranges, RPC hosts, and export
timestamp.

**Acceptance.** CSV opens in pandas; every latency column has its two companion columns;
manifest present.

**Commit:** `feat(cli): dataset export with provenance manifest`

---

## T13 — Mainnet indexer + classifier *(Week 7 — not before T11 works)*

**Files:** `src/measurement/indexer.ts`, `src/measurement/classify.ts`,
`src/cli/index-mainnet.ts`

**Spec**

- Index Arbitrum One SequencerInbox `forceInclusion` calls and `SequencerBatchDelivered`;
  Bridge `MessageDelivered`. Index OP Mainnet + Base OptimismPortal `TransactionDeposited`.
- Classification, strictly:
  - **Class A** — a *successful* `forceInclusion` call. Unambiguous.
  - **Class B** — a delayed message not read within the normal window, later batched.
  - **Class C** — OP `TransactionDeposited` from the standard bridge, and normal inclusions.
  - **Class D** — insufficient evidence.
- Every row stores its `evidence` string. **Never upgrade a class to make counts look
  better.**

**Acceptance.** Runs over a bounded block range; each row has evidence; OP deposits are
Class C by construction.

**Expected result — plan for it.** Class A counts on Arbitrum mainnet may be in the single
digits. That is a finding ("the escape hatch is documented, load-bearing in every security
argument, and essentially never used"), not a failure. Report with a binomial CI.

**Commit:** `feat(measurement): mainnet indexer and event classification`

---

## T14 — Analysis handoff

**Files:** `analysis/load.py`, `analysis/figures.py`, `analysis/README.md`

**Spec.** Python only from here — no statistics in TypeScript. Load the CSV; bootstrap CIs
on medians; Mann-Whitney U for normal-vs-forced and cross-protocol M-L2; Spearman +
quantile regression for M-L1 vs L1 base fee; binomial CI for Experiment C success. Figures:
latency ECDFs, cost comparison with CIs, base-fee scatter with quantile fit, devnet recovery
timeline.

**Acceptance.** Every figure regenerates from the CSV alone. No parametric t-tests. Any
mixed-clock metric is annotated as such in the figure caption.

**Commit:** `feat(analysis): statistical analysis and figure generation`

---

## Standing guardrails for every task

Repeat these to Claude Code if it drifts:

1. Never hardcode a protocol parameter — read it and record it.
2. Never invent a contract address — `UNVERIFIED` must fail loudly.
3. Never mix clocks silently — every duration declares `mixedClock` and resolution.
4. Never call public-testnet behaviour "censorship."
5. Never retry an L1 submission without checking the idempotency key.
6. A revert is data — record it, never swallow it.
7. No `any`, no `!` on chain data, `uint256` as `bigint`/`string`.
8. Do not add dependencies not named in the task.
9. Do not implement future tasks.
10. Run `npm run typecheck` before reporting a task complete.
