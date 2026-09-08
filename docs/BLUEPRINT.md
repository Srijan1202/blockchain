# Execution Blueprint — L2 Forced-Inclusion / Escape-Hatch Measurement

**Status:** topic locked, design locked. This document is for building, not deciding.

**Verification convention used throughout:** values marked **VERIFIED** were confirmed
against primary sources on 2026-08-27. Values marked **UNVERIFIED** must be resolved by
the day noted before they are used in an experiment. Nothing here is guessed silently.

---

## 1. FINAL RESEARCH DEFINITION

**Central question.** Do Ethereum L2 forced-inclusion and escape-hatch mechanisms deliver
the censorship resistance their protocol designs promise, and what are their real latency,
cost, reliability, and failure characteristics?

**What is actually being measured.** Not "is censorship resistance possible" — the specs
already answer that. The measurable object is the **gap between the nominal guarantee and
the user-experienced cost of invoking it**: how long it takes, what it costs, how many
manual actions it requires, and whether it works on the first try.

**Framing.** Structured per-protocol case studies sharing one common measurement template,
plus one narrow comparable sub-benchmark where the mechanisms genuinely permit comparison.
Not a universal "forced inclusion latency" leaderboard — see §4 for why that number would
be meaningless.

---

## 2. THREE-ENVIRONMENT MODEL

| | E1 Local devnet | E2 Public testnet | E3 Mainnet |
|---|---|---|---|
| **You control** | sequencer, L1, all params | nothing | nothing |
| **Purpose** | true censorship simulation | real forced-path measurement | observational analysis |
| **Can prove** | the escape hatch recovers a tx from a genuinely refusing sequencer; recovery time under controlled conditions | actual protocol code path works end-to-end; real latency/cost distributions on production-grade infrastructure | whether these mechanisms are used at all in production; real economic scale |
| **Cannot prove** | anything about real-world timing, fee markets, or operator behaviour | that anyone is being censored — **never call this a censorship experiment** | causation, intent, or that any given event was censorship-triggered |
| **Failure mode to avoid** | treating shortened devnet delays as real delays | claiming the testnet sequencer censored you | classifying ordinary bridge deposits as censorship events |

The three are complementary, not redundant. E1 supplies internal validity (you know the
sequencer refused, because you made it refuse). E2 supplies ecological validity (real
contracts, real L1, real fee market). E3 supplies relevance (does anyone ever do this).
A claim that needs all three is weaker than a claim scoped to one — scope every claim.

---

## 3. FINAL ROLLUP SELECTION

### CORE — must include

**1. Arbitrum (Nitro) — `arb-sepolia` + local `nitro-testnode`**
The only major stack with a genuine **user-invoked** force call. It is the only place where
"the sequencer refused and I forced my way in" is a real, observable user action. Without
this, the paper has no censorship-recovery experiment at all.

**2. OP Stack — `op-sepolia` (primary) + `base-sepolia` (replication)**
Structurally opposite: forced inclusion is **automatic** via the derivation pipeline, with
no user force call and no censorship precondition. This contrast is the paper's spine.
Base is the same stack, so it is not a third architecture — it is an intra-family
replication check that costs almost nothing once the OP adapter exists, and it guards
against "you measured one chain's quirks."

### OPTIONAL — include only if the adapter is cheap

**3. ZKsync Era — `zksync-sepolia`**
Priority-queue model: users can enqueue to L1 but **cannot force**; the sequencer can halt
the queue entirely but cannot selectively skip. Worth ~1 page as a documented contrast case
showing the design space has a third point. Do **not** build a full adapter or claim
comparable metrics. Budget: half a day, or drop it.

### EXCLUDE from experiments

**4. dYdX v3 / StarkEx — mainnet observation only**
Not experimentally exercisable (v3 is shut down; there is no testnet to force against). But
it is the **richest real escape-hatch dataset that exists** — the October 2025 shutdown
forced real users through a real escape hatch at scale. It belongs in §12, not §8.

**5. Starknet — exclude entirely.** No force-inclusion mechanism currently exists.
Nothing to measure.

**Final count: 2 core architectures, 3 experimental chains, 1 optional contrast, 1
observational case study.** That is the right scope for 10 weeks.

---

## 4. PROTOCOL TECHNICAL ANALYSIS

### 4.1 Arbitrum Nitro

**Normal path**
```
signed L2 tx
  -> sequencer RPC (sepolia-rollup.arbitrum.io/rpc)
  -> sequencer feed, soft confirmation (~250ms)
  -> batch posted to SequencerInbox on L1
  -> assertion posted to Rollup
  -> L1 finality
```

**Forced path**
```
construct + sign L2 tx (correct L2 chainId, nonce, gas)
  -> L1 tx: Inbox.sendL2Message(bytes)         [or sendL2MessageFromOrigin]
  -> emits InboxMessageDelivered(messageNum, data)   (Inbox)
  -> emits MessageDelivered(...)                     (Bridge)
  -> message sits in the DELAYED INBOX accumulator
  -> [healthy sequencer reads and includes it, typically ~10 min]
  -> [if not: wait delaySeconds / delayBlocks]
  -> L1 tx: SequencerInbox.forceInclude(...)   <-- USER ACTION, anyone may call
  -> emits SequencerBatchDelivered
  -> tx executes on L2
```

**L1 contracts — Arbitrum Sepolia (deployed on Ethereum Sepolia)** — all **VERIFIED**
2026-08-27 against Arbitrum Docs smart-contract-addresses page:

| Contract | Address |
|---|---|
| SequencerInbox | `0x6c97864CE4bEf387dE0b3310A44230f7E3F1be0D` |
| Inbox | `0xaAe29B0366299461418F5324a79Afc425BE5ae21` |
| Bridge | `0x38f918D0E9F1b721EDaA41302E399fa1B79333a9` |
| Rollup | `0xd80810638dbDF9081b72C1B33c65375e807281C8` |
| Outbox | `0x65f07C7D521164a4d5DaC6eB8Fac8DA067A3B78F` |

**Arbitrum One (for the mainnet observation pipeline)** — VERIFIED 2026-08-27:
SequencerInbox `0x1c479675ad559DC151F6Ec7ed3FbF8ceE79582B6`,
Delayed Inbox `0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f`,
Bridge `0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a`,
Rollup `0x4DCeB440657f21083db8aDd07665f8ddBe1DCfc0`,
Outbox `0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840`.

**Delay parameters.** Arbitrum One's base force-inclusion delay is 24 hours (86400s /
~5760 blocks) per Arbitrum Docs. The 2023 governance proposal to cut it to 4 hours was
**never implemented**. BoLD adds a state-dependent **Delay Buffer**: capped at 2 days,
replenishing 1 minute per 20 minutes, with a floor such that messages can still be delayed
up to 30 minutes even when the buffer is fully consumed; the trigger threshold is 150 L1
blocks (~30 min) on Arbitrum One.

> **UNVERIFIED — resolve Day 2:** the Arbitrum **Sepolia** `delaySeconds` value. Do not
> assume it equals Arbitrum One's 86400. Read `SequencerInbox.maxTimeVariation()` directly.
> The scaffold's `npm run verify` does this. If the signature has changed post-BoLD, record
> the failure and find the current getter rather than hardcoding a plausible number.

**Tooling.** `@arbitrum/sdk` `InboxTools` wraps this: `signChildTx` / `sendChildSignedTx`,
`getForceIncludableEvent`, `forceInclude`. Use it for the submission leg; do your own event
indexing so you control the timestamps.

### 4.2 OP Stack (OP Sepolia, Base Sepolia)

**Normal path**
```
signed L2 tx -> sequencer RPC -> L2 block (2s) -> batcher posts to L1 (blobs) -> derivation
```

**Forced path**
```
L1 tx: OptimismPortal.depositTransaction(
         address _to, uint256 _value, uint64 _gasLimit,
         bool _isCreation, bytes _data)         [msg.value carries ETH]
  -> emits TransactionDeposited(from, to, version, opaqueData)
  -> derivation pipeline reads deposits from that L1 block
  -> included as a deposit tx (type 0x7E) in the FIRST L2 block of the epoch
  -> executes
```

**Two properties that define the contrast with Arbitrum:**
1. **No user force call exists.** Derivation *must* include the deposit. The sequencer
   cannot skip it. There is nothing to invoke after the fact.
2. **No censorship precondition.** You do not wait for refusal. The path is always open.

**Address aliasing gotcha:** deposits from a *contract* sender get the alias
`address + 0x1111000000000000000000000000000000001111` applied. Deposits from an **EOA do
not**. Since your experiment wallet is an EOA, aliasing does not apply — but note it in the
paper, because a reviewer will ask.

**Bound.** Sequencing window = 3600 L1 blocks ≈ **12 hours** worst case; max sequencer
drift 600s. Normal-case inclusion is next-epoch (~minutes). L2BEAT lists "up to 12h delay"
for both OP Mainnet and Base.

**L1 contract — OP Sepolia:** OptimismPortal2 proxy
`0xfcbb237388CaF5b08175C9927a37aB6450acd535` — **VERIFIED** 2026-08-27 (Sepolia Etherscan).

> **UNVERIFIED — resolve Day 2:** Base Sepolia OptimismPortal address. Pull from
> `ethereum-optimism/superchain-registry` (the source of truth), not from a blog post.
> The scaffold flags this as UNVERIFIED and refuses to use it until set.

### 4.3 The asymmetry, stated precisely

| | Arbitrum Nitro | OP Stack |
|---|---|---|
| User force call | **yes** — `forceInclude` | **no** |
| Censorship precondition | yes — delay must elapse | no |
| L1 transactions required | **2** (enqueue, then force) | **1** (deposit) |
| Worst-case bound | 24h base, **30 min floor** under sustained censorship (BoLD) | 12h sequencing window |
| Who pays the force gas | the user (or any altruist) | nobody — it is automatic |

**This table is the paper.** Note the non-obvious consequence: under *sustained* censorship,
BoLD drives Arbitrum's effective window down toward 30 minutes, which is **shorter than OP
Stack's 12-hour worst case** — but only at the cost of a second L1 transaction the user must
know to send. A mechanism that is worse on paper (requires manual action) may be faster in
the adversarial case. That inversion is H5 below and is the most interesting thing here.

---

## 5. THREAT MODEL

**Censorship** = an L2 sequencer that intentionally and persistently refuses to include an
otherwise-valid transaction. Validity conditions held constant: sufficient balance, correct
nonce, adequate gas limit and price, well-formed signature, repeatedly submitted, sequencer
demonstrably live and producing blocks containing other transactions.

**This condition is only creatable in E1**, because it requires controlling the sequencer.

**Explicit non-claims — state these in the paper's threat model section:**
1. No claim that any production sequencer has censored anything, ever.
2. No mainnet deposit is classified as a censorship event.
3. No claim about operator intent or liveness commitments.
4. Testnet forced-path measurements describe a user who *chooses* not to rely on the
   sequencer, not a user who *cannot*.

---

## 6. RESEARCH QUESTIONS

- **RQ1** What is the real end-to-end latency of the forced path per protocol, decomposed
  into independently measurable stages?
- **RQ2** What is the cost of the forced path, and what premium does it carry over the
  normal path?
- **RQ3** Does forced-path performance degrade under L1 congestion, and does the protocol
  bound hold regardless?
- **RQ4** How do the delayed-inbox (Arbitrum), automatic-derivation (OP Stack), and
  priority-queue (ZKsync) families differ in latency, cost, and required user action?
- **RQ5** Under genuine sequencer censorship, does the escape path recover the transaction
  within the protocol-stated bound?

---

## 7. HYPOTHESES

Each is stated as null/alternative with a designated metric, experiment, test, and
falsification condition. **None is assumed true.** A negative result on any is publishable.

**H1 — Healthy-path forced latency differs by architecture.**
H₀: median `t(L1 inclusion → L2 appearance)` is equal for Arbitrum and OP Stack.
H₁: it differs. Metric: M-L2. Experiment: B (E2). Test: Mann-Whitney U + bootstrap CI on
the median difference. Falsified if p > 0.05 and the 95% CI on the difference is tight
enough to rule out a practically meaningful gap.

**H2 — The forced path carries a cost premium.**
H₀: forced-path total cost ratio to normal path = 1. H₁: > 1. Metric: M-C4. Experiment:
A vs B. Test: bootstrap CI on the ratio of medians. Falsified if the CI includes 1.

**H3 — L1 congestion affects forced-path entry, not the protocol bound.**
H₀: no monotonic relationship between L1 base fee and `t(submit → L1 inclusion)`.
Metric: M-L1. Experiment: D. Test: Spearman ρ + quantile regression at τ = 0.5, 0.9.
Falsified if |ρ| is small with a CI spanning 0.

**H4 — Required user action, not latency, is the dominant usability difference.**
H₀: the architectures differ mainly in latency. H₁: they differ mainly in the number of
required user-initiated L1 transactions and the knowledge burden, with latency secondary.
Metric: action count + M-L2. Experiment: B, C across families. Test: descriptive +
effect-size comparison. Falsified if latency differences dwarf the action-count difference
in practical terms.

**H5 — Worst-case inversion under sustained censorship.**
H₀: Arbitrum's effective censorship window ≥ OP Stack's. H₁: BoLD's buffer drives
Arbitrum's effective window *below* OP Stack's 12h worst case. Metric: M-L5 (recovery
latency). Experiment: C (E1), plus analytical derivation from live params. Test:
descriptive with parameter snapshots; binomial CI on recovery success. Falsified if
devnet recovery exceeds the derived bound, or if the buffer does not decrement as
documented.

---

## 8. EXPERIMENT MATRIX

| ID | Name | Env | Protocols | Measures | Pilot n | Final n |
|---|---|---|---|---|---|---|
| **A** | Normal inclusion baseline | E2 | Arb, OP, Base | latency, gas, success | 25/chain | 60–100/chain |
| **B** | Forced path, healthy sequencer | E2 | Arb, OP, Base | activation cost, L1 inc, L2 appearance, total, success | 25/chain | 60–100/chain |
| **C** | True censorship + recovery | E1 | **Arb only** | recovery latency, success, force gas | 10 | 30 |
| **C′** | Sequencer unavailable | E1 | OP Stack | deposit still lands, latency | 10 | 20 |
| **D** | L1 congestion sensitivity | E2 | Arb, OP | M-L1 vs base fee | — | reuse B, bucketed |
| **E** | Mainnet observation | E3 | Arb One, OP/Base, dYdX v3 | usage counts, Class A events | — | full history |

**Scope discipline.** Experiment C is Arbitrum-only by design. On OP Stack, "the sequencer
censors you" is not a meaningful scenario — derivation forces the deposit regardless — so
C′ tests the honest OP question instead: does the deposit land when the sequencer is down?
Do not build an OP censorship rig; it would be measuring a scenario the protocol does not
have.

D is not a separate submission campaign. It is a **re-analysis of B's data bucketed by the
L1 base fee at submission time**, which is why it costs zero extra transactions. Only run a
dedicated congestion campaign if B's natural fee variation turns out to be too narrow.

---

## 9. METRICS

**Latency** (all block-derived unless noted)
- `M-L1` submit → L1 inclusion *(wall-clock start, L1 block timestamp end — mixed clock, flag it)*
- `M-L2` L1 inclusion → L2 appearance *(block-to-block, the clean one)*
- `M-L3` total forced-path latency = M-L1 + M-L2
- `M-L4` normal-path latency (baseline)
- `M-L5` recovery latency: censorship onset → L2 appearance *(E1 only)*

**Cost**
- `M-C1` L1 gas used × effective gas price for the submission tx
- `M-C2` L1 gas for the `forceInclude` call *(Arbitrum only; structurally absent on OP)*
- `M-C3` **total cost of the L2 transaction, including its data-availability
  component.** Not "L2 execution gas" — that description was wrong for the OP Stack and
  understated it by ~45% on a measured transfer. The two protocols charge for data
  availability differently and the difference is structural, not incidental:
  - **OP Stack** — `gasUsed × effectiveGasPrice` covers execution **only**. The L1 data
    fee is charged separately and appears as `l1Fee` on the receipt, priced at the *L1*
    gas price. M-C3 = execution + `l1Fee`. Recorded in `costs.op_l1_data_fee_wei`.
  - **Arbitrum** — `gasUsed × effectiveGasPrice` is **already inclusive**. Nitro recoups
    the posting cost by charging extra L2 gas, reported as `gasUsedForL1`: a *subset* of
    `gasUsed`, in gas units, priced at the *L2* gas price. M-C3 = `gasUsed ×
    effectiveGasPrice`, unchanged. Recorded in `costs.arb_l1_gas_allocation`.

  `op_l1_data_fee_wei` and `arb_l1_gas_allocation` are **different quantities in different
  units** and must never be summed or compared with each other as "the L1 cost."
- `M-C4` forced-path premium = (M-C1 + M-C2 + M-C3) / normal-path total cost.

  Computed from `costs.total_fee_wei`, which means *everything the transaction cost the
  user* and nothing narrower. **Totals are comparable across protocols; decompositions are
  not.** On the OP Stack the total is execution plus a separately-sourced, L1-priced data
  fee; on Arbitrum it is a single inclusive figure with no separable component priced the
  same way. So `total_fee_wei − l2_fee_wei` compared across protocols is not a like-for-like
  quantity, even though it looks like one. Compare totals; use the per-protocol columns only
  to describe that protocol. This is restated in `migrations/003_l1_data_fee.sql`.

**Reliability**
- `M-R1` success rate, `M-R2` failure rate, `M-R3` timeout rate, `M-R4` retry count

**Usability** *(the underrated one — this is what H4 rests on)*
- `M-U1` number of user-initiated L1 transactions required
- `M-U2` whether a wait is required before the user can act, and how long

Dropped deliberately: throughput, queue depth, derivation-internal timings. Not reliably
observable from outside, and not needed for any RQ.

---

## 10. SAMPLE-SIZE METHODOLOGY

**Two-stage, variance-driven. No arbitrary round numbers.**

**Stage 1 — pilot (Week 3).** n = 25 per cell. Purpose: estimate the variance and shape of
each latency distribution. Expect heavy right tails — that is normal for inclusion latency
and is the reason for nonparametric methods throughout.

**Stage 2 — final n.** Set by simulation, not by formula: bootstrap-resample the pilot data
at increasing n and pick the smallest n where the 95% CI half-width on the median falls
below **±10% of the pilot median**. For typical L1/L2 inclusion variance this lands around
n = 60–100 per cell. If a cell needs more than 150 to hit the target, report the wider CI
instead of burning three weeks of faucet ETH chasing precision.

**Power.** Estimate by simulation from the pilot distribution, targeting 80% power at
α = 0.05 for the smallest practically meaningful effect — for M-L2, define that as a
difference large enough to matter to a user (e.g. 60 seconds), not the smallest
statistically detectable one.

**Practical ceilings.** Sepolia faucet throughput and Arbitrum's delay window bound how many
Experiment C runs are possible per day. n = 30 for C is realistic; state that it is a
small-sample descriptive result and use a binomial CI on the success rate rather than
pretending to distributional precision.

---

## 11. TIMESTAMP METHODOLOGY

**Three distinct clocks. Never mix them silently in one number.**

| Clock | Granularity | Trustworthy for |
|---|---|---|
| Local wall-clock (NTP-synced) | ms | client-side stages only: signing, RPC accept |
| L1 block timestamp | ~12s, proposer-set | L1 inclusion ordering |
| L2 block timestamp | 2s (OP), ~250ms (Arb), constrained by drift rules | L2 appearance ordering |

**Rules:**
1. **Report protocol-stage latencies in block-derived terms.** `M-L2` is
   `L2_block.timestamp − L1_block.timestamp`. Do not dress this up as network latency.
2. **Never claim precision finer than the coarsest clock in the calculation.** M-L2 spans an
   L1 boundary, so its resolution is ~12s. Report it as such.
3. `M-L1` mixes wall-clock start with block-timestamp end. Flag it in every table. It is
   the only mixed-clock metric and it exists because there is no other way to capture
   submission time.
4. **Block timestamps are proposer-set, not authoritative.** They can drift. Cross-check
   against block number deltas; report both.
5. **Reorgs.** Wait for L1 finality (2 epochs) before writing a record as final. Sepolia
   reorgs are real. Store a `finalized` boolean and re-verify before analysis.
6. **RPC contamination.** Measure and report RPC round-trip latency separately so a
   reviewer can see it is 2–3 orders of magnitude below the effects you are claiming.

---

## 12. MAINNET OBSERVATION

**Classification scheme — only Class A supports strong claims.**

**Class A — confirmed forced inclusion.** A successful `SequencerInbox.forceInclude()` call
on Arbitrum One. Unambiguous: the function exists for exactly one purpose and nobody calls
it by accident. Also Class A: dYdX v3 escape-hatch invocations (freeze → initialize →
finalize → withdraw with Merkle proof).

**Class B — probable forced-path event.** A delayed-inbox message that was *not* read by
the sequencer within the normal window and was later batched. Suggestive of the sequencer
lagging; not proof of censorship.

**Class C — ordinary inclusion.** OP Stack `TransactionDeposited` originating from the
standard bridge; normal sequenced transactions. **This is the population that dominates
`TransactionDeposited`** and it is exactly the confound that sank the naive version of this
study. Report OP deposits as *mechanism usage*, never as censorship.

**Class D — unknown.** Insufficient evidence. Report the count; do not force a label.

**Indexing targets:** Arbitrum One SequencerInbox — `forceInclude` calls and
`SequencerBatchDelivered`; Bridge — `MessageDelivered`. OP Mainnet/Base OptimismPortal —
`TransactionDeposited`. dYdX v3 — reconstruct from the open-source `l2beat/starkex-explorer`.

**Honesty gate.** Voluntary forced inclusion on Arbitrum mainnet is likely rare — possibly
single digits across all history. **If so, that is the finding**: "the escape hatch exists,
is documented, is load-bearing in every security argument for these systems, and is
essentially never used." Report the count with a binomial CI and lean the mainnet section on
dYdX. Do not manufacture volume by relaxing Class A.

---

## 13. DATA SCHEMA

SQLite (`better-sqlite3`) — single file, trivially shippable as an artifact.

```sql
-- One row per experiment campaign
CREATE TABLE experiments (
  experiment_id   TEXT PRIMARY KEY,
  protocol        TEXT NOT NULL,        -- arbitrum-nitro | op-stack | zk-stack
  chain_key       TEXT NOT NULL,        -- arb-sepolia | op-sepolia | ...
  environment     TEXT NOT NULL,        -- devnet | testnet | mainnet
  experiment_type TEXT NOT NULL,        -- A | B | C | C_prime | D | E
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  git_commit      TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  notes           TEXT
);

-- Parameter snapshot at campaign start. Guards against mid-study upgrades.
CREATE TABLE param_snapshots (
  snapshot_id   TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
  chain_key     TEXT NOT NULL,
  taken_at      TEXT NOT NULL,
  l1_block      INTEGER NOT NULL,
  key           TEXT NOT NULL,          -- delaySeconds | sequencingWindow | portalVersion
  value         TEXT NOT NULL,
  source        TEXT NOT NULL           -- on-chain | rollup-config | docs
);

-- One row per submitted transaction
CREATE TABLE runs (
  run_id         TEXT PRIMARY KEY,
  experiment_id  TEXT NOT NULL REFERENCES experiments(experiment_id),
  path           TEXT NOT NULL,         -- normal | forced
  tx_kind        TEXT NOT NULL,         -- eth_transfer | contract_call
  sender         TEXT NOT NULL,
  nonce          INTEGER,
  gas_limit      TEXT,
  calldata_bytes INTEGER,
  l1_tx_hash     TEXT,                  -- submission tx (forced path)
  l1_force_hash  TEXT,                  -- forceInclude tx (Arbitrum only)
  l2_tx_hash     TEXT,
  outcome        TEXT NOT NULL,         -- success | failed | timeout | pending
  retry_count    INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  submitted_at   TEXT NOT NULL          -- local wall-clock, ISO8601
);

-- Every observable lifecycle stage, with provenance and confidence
CREATE TABLE lifecycle_events (
  event_id        TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(run_id),
  stage           TEXT NOT NULL,        -- see the stage model in section 14
  chain_layer     TEXT NOT NULL,        -- L1 | L2
  block_number    INTEGER,
  block_timestamp INTEGER,              -- chain clock (seconds)
  observed_at     TEXT,                 -- local wall-clock when we saw it
  clock_source    TEXT NOT NULL,        -- wall | l1_block | l2_block
  confidence      TEXT NOT NULL,        -- observed | inferred
  finalized       INTEGER NOT NULL DEFAULT 0,
  raw_ref         TEXT                  -- event sig / log index
);

CREATE TABLE costs (
  run_id       TEXT PRIMARY KEY REFERENCES runs(run_id),
  l1_gas_used  TEXT,
  l1_gas_price TEXT,
  l1_fee_wei   TEXT,
  force_gas_used  TEXT,                 -- Arbitrum forceInclude leg
  force_fee_wei   TEXT,
  l2_gas_used  TEXT,
  l2_fee_wei   TEXT,
  total_fee_wei TEXT,
  l1_base_fee_at_submit TEXT            -- for the congestion analysis
);

-- Mainnet observation
CREATE TABLE mainnet_events (
  event_id     TEXT PRIMARY KEY,
  chain_key    TEXT NOT NULL,
  class        TEXT NOT NULL,           -- A | B | C | D
  tx_hash      TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_timestamp INTEGER NOT NULL,
  evidence     TEXT NOT NULL,           -- why this class
  value_wei    TEXT
);
```

Two schema choices worth defending to a reviewer: **`clock_source` and `confidence` on
every lifecycle event** (so §11's rules are enforced by the data model, not by discipline),
and **`param_snapshots` joined to every campaign** (so a mid-study BoLD parameter change
shows up as a discontinuity you can see, rather than noise you cannot explain).

All numeric chain values are `TEXT` — they are `uint256` and will not fit an INTEGER.

---

## 14. SOFTWARE ARCHITECTURE

```
l2-escape-bench/
  package.json
  tsconfig.json
  .env.example
  README.md
  REPRODUCE.md
  src/
    config/
      chains.ts            # registry: addresses + provenance + verification flags
      experiments.ts       # experiment definitions (YAML-loaded or typed consts)
    core/
      types.ts             # LifecycleStage, RunRecord, ParamSnapshot
      params.ts            # on-chain parameter snapshots
      clock.ts             # the three-clock discipline, enforced
      retry.ts             # exponential backoff + idempotency keys
      logger.ts            # structured JSON logs (pino)
    protocols/
      adapter.ts           # ProtocolAdapter interface  <-- the extension point
      arbitrum/
        adapter.ts
        abi.ts
        forceInclude.ts
      opstack/
        adapter.ts
        abi.ts
        deposit.ts
    measurement/
      tracker.ts           # lifecycle event capture, L1+L2 polling
      indexer.ts           # mainnet historical indexing
      classify.ts          # Class A/B/C/D rules
    storage/
      db.ts
      migrations/
    cli/
      verify.ts            # <-- Day 1: connectivity + params + UNVERIFIED report
      run.ts               # execute an experiment campaign
      index-mainnet.ts
      export.ts            # -> CSV/Parquet for analysis
  analysis/                # Python: pandas, scipy, matplotlib
    notebooks/
    figures/
  data/
```

**The extension point.** Adding a rollup means implementing one interface:

```ts
export interface ProtocolAdapter {
  readonly chainKey: string;
  readonly family: ProtocolFamily;

  /** Baseline: submit via the sequencer RPC. */
  submitNormal(tx: TxSpec): Promise<SubmissionRef>;

  /** Forced path: submit via the L1 mechanism. */
  submitForced(tx: TxSpec): Promise<SubmissionRef>;

  /**
   * Protocol-specific completion action.
   * Arbitrum: forceInclude after the delay. OP Stack: no-op (automatic).
   * Returning null is meaningful data, not a stub - it is M-U1.
   */
  completeForced(ref: SubmissionRef): Promise<SubmissionRef | null>;

  /** Emit lifecycle events as they become observable. */
  track(ref: SubmissionRef): AsyncIterable<LifecycleEvent>;

  /** Live protocol parameters, for the snapshot table. */
  snapshotParams(): Promise<ParamSnapshot>;
}
```

`completeForced` returning `null` for OP Stack is not an awkward stub — it is the encoded
form of the paper's central asymmetry, and it is directly the M-U1 metric.

**Common stage model** — mark each stage per protocol as directly measurable, inferred, or
unavailable. Never force a stage onto a protocol that lacks it:

| Stage | Arbitrum | OP Stack |
|---|---|---|
| S1 generated | wall | wall |
| S2 submitted to path | wall | wall |
| S3 L1 inclusion of submission | L1 block | L1 block |
| S4 protocol queue entry | L1 event (`InboxMessageDelivered`) | L1 event (`TransactionDeposited`) |
| S5 force eligibility | L1 block + delay *(computed)* | **n/a — no such stage** |
| S6 force action | L1 block (`forceInclude`) | **n/a** |
| S7 L2 appearance | L2 block | L2 block |
| S8 L2 execution | L2 receipt | L2 receipt |
| S9 L1 finality | L1 finalized | L1 finalized |

**Operational conventions.** Structured JSON logging with a `run_id` on every line. Retries:
exponential backoff, max 5, always with an idempotency key so a retry never
double-submits an L1 transaction. Errors: distinguish *transport* failures (retry) from
*protocol* failures (record as outcome, never retry — a revert is data).

---

## 15. LOCAL DEVNET DESIGN (E1)

**Framework: `OffchainLabs/nitro-testnode`.** Docker Compose based, officially maintained,
runs an L1 + Nitro sequencer + full contract deployment locally.

```bash
git clone https://github.com/OffchainLabs/nitro-testnode.git
cd nitro-testnode
git submodule update --init --recursive
./test-node.bash --init          # first run: deploys L1 + rollup contracts
```

**How censorship is implemented — the key design choice.** Do *not* patch the sequencer
binary. The clean, reproducible method is to disable the sequencer's delayed-message reader,
so that a transaction submitted **only** via the delayed inbox is genuinely never picked up:

1. Deploy the rollup with a **shortened `delaySeconds`** (e.g. 300s instead of 86400s) so
   the force window is reachable in a test run. This is a deployment parameter — record it
   in `param_snapshots` and never compare devnet absolute latencies to testnet ones.
2. Start the sequencer with the delayed-sequencer component disabled, so it produces blocks
   normally but never ingests delayed messages.
   > **UNVERIFIED — resolve Day 5:** the exact Nitro flag. It is in the
   > `--node.delayed-sequencer.*` family. Confirm against
   > `OffchainLabs/nitro` `cmd/nitro` flag definitions for the version you run, and record
   > the flag string in the README. Do not publish the flag name from memory.
3. Submit the target tx **only** through `Inbox.sendL2Message`. Confirm via the L2 RPC that
   it does not appear.
4. Wait out the shortened delay. Call `SequencerInbox.forceInclude`. Measure `M-L5`.
5. Success detection: the L2 receipt exists and the state transition matches expectation.

This satisfies the threat model precisely — the sequencer is live, producing blocks with
other transactions, and structurally refusing this one.

**OP Stack (Experiment C′): use Supersim**, not Kurtosis. Supersim is lightweight, listens
for `TransactionDeposited`, and forwards deposits. Kurtosis gives a fuller network but costs
days you do not have. The OP question is "does the deposit land with the sequencer
unavailable," which Supersim answers.

**Scope guard.** If the Arbitrum devnet is not producing a recovery by end of Day 6,
escalate — this is the highest-risk component and everything else has a fallback.

---

## 16. PUBLIC TESTNET DESIGN (E2)

| Chain | Chain ID | Role |
|---|---|---|
| Ethereum Sepolia | 11155111 | L1 for all three |
| Arbitrum Sepolia | 421614 | core — delayed inbox |
| OP Sepolia | 11155420 | core — portal deposits |
| Base Sepolia | 84532 | replication |

**Wallet.** One dedicated experiment EOA per chain family, funded from Sepolia faucets and
bridged. Fixed sender per cell (nonce ordering matters); never reuse a mainnet key.

**Which network needs funding depends on the path, not the chain** (traced from the
adapters in `src/core/preflight.ts`, and enforced before any submission):

| Campaign | Funds required |
|---|---|
| A on `op-sepolia` / `arb-sepolia` | that L2 only — no L1 transaction exists on the normal path |
| B on `op-sepolia` | Ethereum Sepolia only, **gas + `msg.value`** — the deposit's L2 gas is prepaid by burning L1 gas and its value is minted on L2 |
| B on `arb-sepolia` | **both** — Ethereum Sepolia for `sendL2Message` gas (no value on the L1 call), and Arbitrum Sepolia for `value + gas` when the signed L2 transaction executes |
| `base-sepolia` | none — the adapter refuses while its sequencing window is UNVERIFIED |

The Arbitrum forced case is a measurement hazard, not just an operational one. An empty
Arbitrum Sepolia balance produces a message that queues normally, reaches S4, and then
fails on execution — **indistinguishable at a glance from sequencer non-inclusion**. An
unfunded wallet would manufacture exactly the signal this study exists to measure, so the
runner refuses to submit until both balances are present.

**Procedure — Arbitrum Sepolia (Experiment B).**
1. Construct and sign the L2 tx for chain 421614.
2. `Inbox.sendL2Message` on Ethereum Sepolia at `0xaAe29B...5ae21`.
3. Record S3 (L1 inclusion) and S4 (`InboxMessageDelivered`).
4. Poll Arbitrum Sepolia for the L2 tx hash. On a healthy sequencer this lands in ~minutes
   via the delayed reader — **this is the auto-inclusion leg, not a force**. Label it
   correctly in the data.
5. The `forceInclude` leg on public testnet requires waiting the full configured delay.
   Measure it on testnet only if the Sepolia `delaySeconds` turns out to be short; otherwise
   the force leg lives in E1. Decide on Day 2 once `maxTimeVariation()` is read.

**Procedure — OP/Base Sepolia (Experiment B).**
1. `OptimismPortal.depositTransaction(to, value, gasLimit, false, data)` with `msg.value`.
2. Record S3 and S4 (`TransactionDeposited`).
3. Poll for the type-0x7E deposit tx on L2; record S7, S8.
4. There is no force leg. `completeForced` returns null. That is the measurement.

---

## 17. REVIEWER ATTACK / DEFENSE

**1. "Testnet behaviour doesn't represent mainnet."**
*Why it matters:* fee markets and sequencer load differ; latency could be systematically off.
*Defense:* the protocol code path is identical, and the claims are about *mechanism
structure and relative cost*, not absolute mainnet seconds. Triangulate with E3 usage data.
*Remaining limitation:* absolute latencies are not transferable to mainnet. Say so plainly.

**2. "You didn't actually demonstrate censorship."**
*Why it matters:* it is the paper's title claim.
*Defense:* E1 demonstrates exactly that, under a stated threat model, with the sequencer
provably live and provably refusing. E2 is never labelled a censorship experiment.
*Remaining limitation:* simulated censorship ≠ an economically motivated real adversary.

**3. "OP Stack and Arbitrum aren't comparable."**
*Why it matters:* if true, cross-protocol numbers are meaningless.
*Defense:* **agreed** — that is why the paper is case studies plus one narrow sub-benchmark
(`M-L2`, which both protocols genuinely have), and why the asymmetry table is a finding
rather than a limitation.
*Remaining limitation:* no single-number ranking is possible. That is correct, not a flaw.

**4. "Your latency measurement is inaccurate."**
*Defense:* §11's three-clock discipline is enforced in the schema; every metric declares
its clock source and resolution; no sub-block precision is claimed.
*Remaining limitation:* block timestamps are proposer-set and can drift; block-number
deltas are reported alongside.

**5. "Your sample size is insufficient."**
*Defense:* two-stage variance-driven sizing with pre-registered CI targets, not a round
number. Nonparametric tests appropriate to heavy-tailed data.
*Remaining limitation:* Experiment C is small-n by physical constraint; reported as
descriptive with binomial CIs, not as a distribution.

**6. "The forced path isn't equivalent to censorship recovery."**
*Defense:* on Arbitrum they are the same code path — `forceInclude` exists solely for this.
On OP Stack there is no separate recovery path, which is itself the finding.
*Remaining limitation:* E2's forced path is invoked without a censorship precondition.

**7. "RPC latency contaminates your results."**
*Defense:* RPC round-trip is measured and reported separately; it is 2–3 orders of magnitude
below the effects claimed. Protocol-stage metrics are block-derived and RPC-independent.
*Remaining limitation:* `M-L1` includes propagation; flagged as mixed-clock everywhere.

**8. "Protocol upgrades invalidate your measurements."**
*Defense:* every campaign is joined to a `param_snapshots` row; chain IDs, addresses,
implementation versions, block ranges, and git commit are recorded per run. An upgrade
appears as a visible discontinuity.
*Remaining limitation:* results are a versioned snapshot. State the version in the abstract.

**9. "Your mainnet dataset misclassifies deposits."**
*Defense:* Class A requires a successful `forceInclude` call — mechanically unambiguous. OP
deposits are Class C by construction and never support censorship claims.
*Remaining limitation:* Class A may be very small. Reported honestly, with the smallness as
a finding.

**10. "This is engineering benchmarking, not research."**
*Why it matters:* this is the one that actually rejects the paper.
*Defense:* the contribution is not the harness. It is the **empirical characterization of a
gap between a widely-cited security guarantee and its user-facing cost**, including the
worst-case inversion (H5), plus a reusable methodology for a property the literature
currently asserts from specifications rather than measurement. Prior work designs
(Zircuit), formally models (Alloy), flags the gap without filling it (Rennes/Inria — which
explicitly says the L2BEAT flag is a nominal indicator, not a usability proxy), or attacks
the path (CCS 2025 Denial-of-Sequencing). None measures usability.
*Remaining limitation:* if every result is "it works as specified," the contribution is a
verified negative result — still publishable, but at a lower tier. Plan for it (§19).

---

## 18. CONTRIBUTIONS

**Most defensible, in order:**

1. **Empirical characterization of the usability cost of L2 censorship resistance.** The
   headline. Not "how fast is it" but "what does a user actually have to know, do, wait,
   and pay to exercise a guarantee that every security argument for these systems depends
   on." No prior work measures this.
2. **The architectural asymmetry finding, including the worst-case inversion (H5).** A
   mechanism requiring manual action may recover *faster* under sustained censorship than
   one that is automatic. Non-obvious, quantifiable, and directly relevant to rollup design.
3. **A reproducible censorship-recovery benchmark methodology.** The devnet protocol in §15
   is reusable by others and fills the exact gap the Rennes/Inria paper names.
4. **Honest mainnet usage accounting**, including the possibility that the answer is "almost
   never used."
5. **Open dataset and harness.** Supporting, never the headline.

**Finding (measured 2026-09-07, feeds contributions 1 and 2) — the escape hatch is
conditionally reachable.** Arbitrum Sepolia's `delaySeconds` is 86400, and because
`forceInclude` only acts on delayed messages the sequencer has not yet read, a healthy
sequencer consumes the message hours before it becomes force-eligible. So: **Arbitrum's
escape hatch is only exercisable while the failure it protects against is actually
occurring, and in production it is therefore effectively never exercised.**

This sharpens the usability argument rather than weakening it. The mechanism cannot be
rehearsed, cannot be tested by a user in advance, and offers no way to build confidence in
it before the moment it is needed — a user's first ever use of the escape hatch is
necessarily under adversarial conditions. It also converts §12's expected near-zero Class A
count from an awkward null result into a *predicted* one with a mechanical explanation,
which is a stronger claim than "we looked and found nothing." Derivation of the bound from
live parameters (§20.1) supports this analytically; E1 supplies the only empirical
demonstration, which is why Experiment C is load-bearing.

**Supporting measurement (Arbitrum Sepolia delayed inbox, scanned 2026-09-07).** The
finding above predicts the escape hatch is essentially never used. A direct count of the
delayed inbox says so on testnet already.

*Range:* Ethereum Sepolia L1 blocks **≈11,536,664 – 11,656,664** (120,000 blocks, ≈17 days),
Bridge `0x38f918D0E9F1b721EDaA41302E399fa1B79333a9`.

| `MessageDelivered.kind` | Meaning | Count |
|---|---|---|
| 13 | `L1MessageType_batchPostingReport` (protocol-generated) | 19,251 |
| 12 | `L1MessageType_ethDeposit` (bridging) | 4,816 |
| 9 | `L1MessageType_submitRetryableTx` (bridging) | 1,550 |
| **3** | **`L2_MSG` — `sendL2Message`, the escape-hatch path** | **0** |

Every message in the delayed inbox over seventeen days was either protocol bookkeeping or
ordinary bridging. Not one was a user submitting a signed L2 transaction through the escape
hatch. This is the mechanism-usage claim of §18 measured directly rather than argued.

*Method, and a trap worth documenting.* Classify by **`MessageDelivered.kind` on the
Bridge**, not by the first byte of `InboxMessageDelivered.data`. The first attempt used the
data byte and produced a plausible-looking distribution (`0x00` ×14, `0x9c` ×3, `0x40`,
`0xda`, `0xb2`) with no `0x04` — which reads as "no signed-tx messages" but is an artifact:
only `kind = 3` messages carry an `L2MessageType` byte first, while retryables and deposits
begin with the high byte of a packed `uint256`, usually `0x00`. The byte-prefix method
cannot distinguish "no escape-hatch messages" from "these are not escape-hatch messages at
all", and would silently misclassify if any message happened to begin with `0x04`. `kind` is
the field the protocol itself dispatches on.

*Consequence for validation.* Because no `kind = 3` message exists on this testnet, the
signed-transaction submission path **cannot be validated against historical chain data** —
there is none to validate against. The two derivations it depends on were therefore
confirmed separately against real data: `messageDataHash == keccak256(messageData)` on five
live `MessageDelivered` events, and "an L2 transaction hash is `keccak256` of its signed
serialization" on three live Arbitrum Sepolia transactions. The end-to-end path itself is
first exercised by this harness's own submission.

**What this paper must not become:** "we built a tool that measures L2 transactions." If the
abstract's main verb is "we implemented," rewrite it.

---

## 19. SUCCESS CRITERIA

**Minimum viable paper.** Experiments A and B complete on Arbitrum Sepolia and OP Sepolia
with adequate n; one successful devnet censorship recovery (Experiment C); mainnet Class A
counts reported honestly. Yields: latency and cost distributions, the asymmetry table, one
demonstrated recovery. Publishable at a workshop or IEEE ICBC.

**Strong paper.** The above, plus Base replication, the congestion analysis (H3) with a
real effect, live BoLD buffer parameters captured across runs, and the dYdX v3
reconstruction from primary on-chain data.

**Exceptional paper.** Any *failure mode discovery*: `forceInclude` reverting under a
reachable condition; a stated bound not being met in practice; the H5 inversion confirmed
empirically; or a rollup whose advertised escape hatch does not function as documented. Do
not plan on this — but instrument for it, and record every anomaly rather than filtering it.

**Explicitly acceptable outcome:** everything works as specified. That is a verified
negative result about a property the field has only ever asserted from specifications. Write
it up as such rather than torturing the data.

---

## 20. RISKS + PIVOTS

| Risk | Prob | Impact | Mitigation | Pivot |
|---|---|---|---|---|
| ~~Arbitrum Sepolia `delaySeconds` is a full 24h~~ **RESOLVED 2026-09-07 — occurred, and is worse than "impractical": see below** | High | Med | Read Day 2 — done, live value 86400 | **Taken:** force leg lives entirely in devnet; testnet measures the auto-inclusion leg only |
| Nitro devnet censorship rig doesn't work | Med | **High** | Front-load to Days 5–6; the flag is the only unknown | Reduce C to a single documented case study; lean the paper on B + the asymmetry analysis |
| Base Sepolia portal address unresolvable | Low | Low | superchain-registry, Day 2 | Drop Base; it is replication, not core |
| Protocol upgrade mid-study | Med | Med | `param_snapshots` per campaign | Re-run affected cells; report the discontinuity as data |
| Sepolia instability / faucet drought | Med | Med | Batch faucet requests early; multiple faucets | Reduce n, widen CIs, report honestly |
| Class A mainnet events ≈ 0 | **High** | Low | Expected | Report as a finding; lean on dYdX |
| Cross-protocol comparison challenged | High | Low | Already resolved via case-study framing | None needed — this is pre-defended |
| Scope creep into ZKsync | Med | Med | Time-boxed to half a day | Drop it |

### 20.1 Resolved parameters

**Arbitrum Sepolia `delaySeconds` = 86400 (24h).** Read live 2026-09-07 from
`SequencerInbox.maxTimeVariation()` at `0x6c97864CE4bEf387dE0b3310A44230f7E3F1be0D`
(`delayBlocks = 7200`, `futureBlocks = 64`, `futureSeconds = 768`; 7200 × 12s = 86400s, so
the block and second bounds agree). The post-BoLD signature is intact — the read did not
fail, so no fallback was needed.

**This does not merely make the testnet force leg impractical. It makes it structurally
impossible, and no amount of waiting fixes it.** `forceInclude` can only act on delayed
messages the sequencer has *not yet read*. A healthy Arbitrum Sepolia sequencer reads the
delayed inbox voluntarily in roughly ten minutes, advancing `totalDelayedMessagesRead` past
our message long before the 24-hour window opens. By the time the message is force-eligible
it has already been included, and there is nothing left to force. The two conditions —
"delay elapsed" and "message still unread" — cannot both hold on a healthy public testnet.
Waiting longer makes this worse, not better.

The general statement, which belongs in the paper: **Arbitrum's escape hatch is only
exercisable while the failure it protects against is actually occurring.** Absent
censorship the mechanism is unreachable by construction, which is precisely why §12 should
expect Class A mainnet counts near zero — not as a sampling artifact, but as a structural
property of the mechanism.

Two consequences for the harness, both to be stated rather than discovered later:

1. **S5 and S6 will have zero testnet rows for Arbitrum, by construction.** This is not
   missing data and must not be imputed, back-filled, or treated as measurement failure.
   `supportedStages` may still list them — the devnet (E1) produces them — but any E2
   Arbitrum export will show them empty. The export should distinguish "stage not reached"
   from "stage not applicable in this environment."
2. **The Arbitrum public-testnet leg is auto-inclusion, not forced inclusion.** Per §16 that
   labelling was already required; it is now the *only* thing E2 can measure for Arbitrum.
   It is also the clean comparable against OP Stack's deposit path: both are "user submits
   via L1, protocol includes it without further user action," which is exactly the scope
   `M-L2` was defined for. The comparison gets stronger, not weaker — but it is a
   comparison of auto-inclusion paths, and calling it a forced-path comparison would be
   wrong (see I4).

**Hard stop conditions.** A protocol that cannot produce a reproducible forced-path
measurement after **5 working days** is removed, not debugged further. A mechanism that
cannot be meaningfully measured becomes a case study, not an experiment. If the devnet rig
is not working by end of Day 6, C drops to Arbitrum-only-single-case and the schedule holds.

---

## 21. 10-WEEK EXECUTION PLAN

| Wk | Objective | Deliverable | Exit criterion |
|---|---|---|---|
| 1 | Protocol verification + environment | Verified chain registry; both devnets booting; one manual forced tx per core chain | `npm run verify` green; one L2 tx confirmed via each forced path |
| 2 | Harness core | Adapter interface, tracker, SQLite, cost calc | One normal + one forced run fully recorded end-to-end |
| 3 | Arbitrum pilot | n=25 A and B on arb-sepolia | Variance estimate → final n computed |
| 4 | Measurement validation | Accuracy appendix; clock + reorg + cost reconciliation | Costs reconcile with Etherscan to rounding |
| 5 | Cross-protocol | OP Sepolia + Base Sepolia adapters; full A+B | All three chains at final n |
| 6 | Devnet censorship | Experiments C and C′ | ≥1 verified recovery under genuine refusal |
| 7 | Mainnet | Indexer; Class A/B/C/D; dYdX reconstruction | Classified dataset with evidence per row |
| 8 | Analysis | All figures, tables, statistical tests | Every hypothesis has a verdict |
| 9 | Writing | Full draft | All 14 sections drafted |
| 10 | Reproducibility + revision | REPRODUCE.md verified on a clean machine; public repo | A stranger can rerun Experiment B |

---

## 22. FIRST 7 DAYS

**Day 1 — Environment and connectivity.**
*Objective:* prove every RPC and every recorded address is real before writing any
experiment code.
*Do:* unzip the scaffold; `npm install`; `cp .env.example .env`; fill RPC URLs;
`npm run verify`.
*Expected output:* four chains reporting correct chain IDs and current blocks; a live
`delaySeconds` read from Arbitrum Sepolia; Base Sepolia flagged UNVERIFIED.
*Exit:* "Day-1 exit criterion: MET".

**Day 2 — Resolve every UNVERIFIED value.**
*Objective:* eliminate all guessed parameters.
*Do:* read `SequencerInbox.maxTimeVariation()` on Arbitrum Sepolia via Etherscan **and**
via the harness; confirm they agree. Pull the Base Sepolia OptimismPortal address from
`ethereum-optimism/superchain-registry`. Confirm the OP Sepolia sequencing window from the
rollup config, not from a blog post.
*Record:* every value with its source URL and date into `chains.ts`.
*Exit:* `npm run verify` reports zero UNVERIFIED. **Decision made:** does the Arbitrum
Sepolia force leg run on testnet or only on devnet?

**Day 3 — Fund wallets; first normal transaction.**
*Do:* generate a dedicated experiment EOA; fund from Sepolia faucets; bridge to Arbitrum
Sepolia, OP Sepolia, Base Sepolia. Send one plain ETH transfer on each via the sequencer RPC.
Capture the receipt, block number, block timestamp, gas used, effective gas price.
*Exit:* three confirmed L2 transactions with full receipts saved to `data/day3/`.

**Day 4 — First forced transaction, OP Stack.**
*Why OP first:* single L1 call, no waiting, fastest path to a working forced measurement.
*Do:* call `OptimismPortal.depositTransaction` on OP Sepolia with a small value and empty
calldata. Watch for `TransactionDeposited`. Poll OP Sepolia for the resulting type-0x7E
deposit transaction. Record S3, S4, S7, S8.
*Exit:* a complete forced-path lifecycle for one transaction, with all four timestamps and
their clock sources recorded. **This is POC-2 for OP Stack.**

**Day 5 — First forced transaction, Arbitrum + devnet boot.**
*Do:* using `@arbitrum/sdk` `InboxTools`, sign an L2 tx and submit via `Inbox.sendL2Message`
on Ethereum Sepolia. Record `InboxMessageDelivered`. Poll Arbitrum Sepolia for the auto-
inclusion. In parallel, clone and boot `nitro-testnode` (`./test-node.bash --init`).
*Exit:* Arbitrum delayed-inbox lifecycle captured; devnet producing blocks locally.

**Day 6 — Devnet censorship rig. Highest-risk day.**
*Do:* redeploy the local rollup with a shortened `delaySeconds` (~300s). Identify and
confirm the Nitro flag that disables the delayed-message reader. Submit a tx *only* via the
delayed inbox; verify via the L2 RPC that it does **not** appear. Wait out the delay. Call
`forceInclude`. Verify the tx now executes.
*Exit:* **one verified recovery from genuine refusal.** If this fails, escalate today — do
not roll it into Day 7.

**Day 7 — Wire the pipeline end to end.**
*Do:* implement the SQLite schema and migrations; write the `ProtocolAdapter` interface plus
the two concrete adapters, thin. Re-run one normal and one forced transaction per core chain
*through the harness*, writing to the database. Export to CSV.
*Exit:* a `bench.sqlite` containing complete `runs`, `lifecycle_events`, `costs`, and
`param_snapshots` rows for at least four transactions across two protocols. **This is the
minimal working measurement pipeline.**

---

## 23. FIRST CODE / FIRST COMMAND

The scaffold accompanying this document is already written, installs cleanly, and
typechecks with `strict` and `noUncheckedIndexedAccess` enabled.

**Contents:** `package.json`, `tsconfig.json`, `.env.example`,
`src/config/chains.ts` (registry with per-address provenance and verification flags),
`src/core/params.ts` (live on-chain parameter snapshots),
`src/cli/verify.ts` (the Day-1 command).

```bash
unzip l2-escape-bench-scaffold.zip
cd l2-escape-bench
npm install
cp .env.example .env      # fill in RPC URLs
npm run verify
```

**Expected output when the RPCs are reachable:**

```
=== CHAIN CONNECTIVITY ===
[OK  ] eth-sepolia    chainId=11155111 block=... ts=...
[OK  ] arb-sepolia    chainId=421614   block=... ts=...
[OK  ] op-sepolia     chainId=11155420 block=... ts=...
[OK  ] base-sepolia   chainId=84532    block=... ts=...

=== LIVE PROTOCOL PARAMETERS ===

arb-sepolia (arbitrum-nitro) @ L1 block ...
  delayBlocks = ...
  delaySeconds = ...          <-- the Day-2 answer
  totalDelayedMessagesRead = ...

op-sepolia (op-stack) @ L1 block ...
  portalVersion = ...
  statedForcedBoundSec = 43200
  statedForcedBoundSource = rollup config (superchain-registry), not on-chain

=== UNVERIFIED - RESOLVE BEFORE EXPERIMENTS ===
  base-sepolia.optimismPortal -> TODO: resolve from ethereum-optimism/superchain-registry

Day-1 exit criterion: MET
```

Three design decisions in the scaffold are deliberate and worth keeping. Addresses carry
`source`, `checked`, and `verification` fields, so an unverified value cannot silently
become a published number. `maxTimeVariation()` is **read**, never hardcoded — if the
signature changed post-BoLD, the tool reports the failure instead of returning a plausible
86400. And `unverifiedRefs()` makes "what do I still not know" a command rather than a
memory exercise.

Build order from here: `storage/db.ts` → `protocols/adapter.ts` → `arbitrum/adapter.ts` →
`opstack/adapter.ts` → `measurement/tracker.ts` → `cli/run.ts`. Storage first, because the
schema forces you to decide what a lifecycle event is before you start collecting them.

---

*Protocol values verified 2026-08-27. Anything marked UNVERIFIED is a Day-2 task, not a
suggestion. L2 protocols change; re-run `npm run verify` at the start of every campaign and
keep the snapshot.*
