# CLAUDE.md

Project context for Claude Code. This file is loaded automatically at the start of every
session. Read it fully before writing any code.

---

## 1. What this project is

`l2-escape-bench` is the measurement harness for an academic research paper:

> **"Escape Hatches in the Wild: Measuring the Real Censorship-Resistance of Ethereum
> Layer-2 Rollups"**

The paper measures the gap between what L2 rollups *promise* about censorship resistance
and what invoking that promise *actually costs a user* in latency, fees, waiting, and
manual steps.

**This is research code, not product code.** That changes the priorities:

- **Measurement integrity outranks everything.** A number that is wrong in a subtle way is
  worse than no number, because it ends up in a paper.
- **Provenance is mandatory.** Every protocol parameter and contract address must carry a
  source. Anything unverified must be visibly flagged, never silently defaulted.
- **Reproducibility is a deliverable.** A stranger with the repo must be able to rerun an
  experiment and get comparable results.
- Performance, scalability, and polish are irrelevant. Do not optimise anything.

The full research design lives at `docs/BLUEPRINT.md`. Read it when a task references a
section number like §11 or §14. Do not re-derive design decisions that are already made
there — implement them.

---

## 2. Non-negotiable invariants

Violating any of these silently corrupts the research. If a task seems to require breaking
one, **stop and ask** rather than proceeding.

### I1 — Never hardcode a protocol parameter

Delays, sequencing windows, and buffer values are read from chain or from the rollup config
at runtime, then recorded. If a read fails, **record the failure**. Never substitute a
plausible-looking constant.

```ts
// WRONG - this number will end up in a paper
const delaySeconds = 86400;

// RIGHT
const { delaySeconds } = await readMaxTimeVariation(client, sequencerInbox);
```

### I2 — Never invent a contract address

Every address comes from an official source and carries `source`, `checked`, and
`verification` fields in `src/config/chains.ts`. An address marked `UNVERIFIED` must cause
code that depends on it to **fail loudly**, not fall back to a default or skip silently.

### I3 — Never mix clocks silently

There are exactly three clocks (§11 of the blueprint):

| Clock | Resolution | Valid for |
|---|---|---|
| `wall` — local NTP time | ms | client-side stages only (signing, RPC accept) |
| `l1_block` — L1 block timestamp | ~12s, proposer-set | L1 inclusion ordering |
| `l2_block` — L2 block timestamp | 2s (OP) / ~250ms (Arbitrum) | L2 appearance ordering |

Every `lifecycle_events` row stores its `clock_source`. Any latency computed across two
different clocks must be flagged as mixed-clock in the exported data. Never report
precision finer than the coarsest clock involved in the calculation.

### I4 — Never call testnet behaviour "censorship"

Only the local devnet (E1) can demonstrate censorship, because only there do we control the
sequencer. Public testnet runs measure the forced *path*, not censorship. This distinction
must hold in variable names, log messages, comments, and exported column names.

Acceptable: `forcedPathLatency`, `depositInclusionLatency`.
Not acceptable: `censorshipRecoveryTime` for anything measured on a public testnet.

### I5 — Never retry an L1 submission without an idempotency key

A retry that double-submits an L1 transaction costs real testnet funds and corrupts the
sample. Every run carries a unique `idempotency_key` with a UNIQUE constraint in the
database. Check before submitting, always.

### I6 — A revert is data, not an error

Distinguish **transport failures** (RPC timeout, connection reset → retry with backoff)
from **protocol failures** (revert, out-of-gas, rejected → record as `outcome`, never
retry). A reverting `forceInclusion` is potentially the most interesting result in the entire
project. Never swallow it.

### I7 — No `any`, no non-null assertions on external data

`strict` and `noUncheckedIndexedAccess` are on. Chain data is untrusted input — validate it.
`as any` and `!` on RPC responses are forbidden.

### I8 — All `uint256` values are stored as `TEXT`

Gas values, wei amounts, and block numbers from chain exceed `Number.MAX_SAFE_INTEGER`. Use
`bigint` in TypeScript, store as strings in SQLite. Never `Number(someWeiValue)`.

---

## 3. Stack

- **Runtime:** Node.js ≥ 20, ESM (`"type": "module"`)
- **Language:** TypeScript 5.6+, `strict`, `noUncheckedIndexedAccess`
- **Chain client:** `viem` (primary). `@arbitrum/sdk` only for the Arbitrum delayed-inbox
  submission leg where `InboxTools` genuinely helps.
- **Storage:** SQLite via `better-sqlite3` (synchronous, single file, ships as an artifact)
- **Logging:** `pino`, structured JSON, `run_id` on every line
- **Analysis:** Python (pandas, scipy, matplotlib) in `analysis/` — TypeScript produces
  data, Python produces figures. Do not do statistics in TypeScript.

**Do not add dependencies** beyond those listed in a task without asking. No ORM, no
framework, no test-runner beyond `node:test` unless a task specifies one.

---

## 4. Repository layout

```
src/
  config/chains.ts          # chain registry: addresses + provenance + verification flags
  config/experiments.ts     # experiment campaign definitions
  core/types.ts             # LifecycleStage, RunRecord, ParamSnapshot, TxSpec
  core/clock.ts             # the three-clock discipline, enforced in code
  core/params.ts            # live on-chain parameter snapshots
  core/retry.ts             # backoff + idempotency
  core/logger.ts            # pino setup
  protocols/adapter.ts      # ProtocolAdapter interface — THE extension point
  protocols/arbitrum/       # delayed inbox + forceInclusion
  protocols/opstack/        # portal deposits
  measurement/tracker.ts    # lifecycle event capture
  measurement/indexer.ts    # mainnet historical indexing
  measurement/classify.ts   # Class A/B/C/D rules
  storage/db.ts             # connection + migrations
  storage/migrations/       # numbered .sql files
  cli/verify.ts             # connectivity + params + unverified report
  cli/run.ts                # execute an experiment campaign
  cli/index-mainnet.ts
  cli/export.ts             # -> CSV for analysis
analysis/                   # Python notebooks + figures
data/                       # bench.sqlite, exports (gitignored except .gitkeep)
docs/BLUEPRINT.md           # full research design
```

**Adding a new rollup means implementing one `ProtocolAdapter`.** If a change requires
touching more than the adapter directory plus one line of the chain registry, the
abstraction is wrong — say so instead of working around it.

---

## 5. The two protocols, and why they are not symmetric

This asymmetry is the paper's central finding. Do not paper over it in the abstraction.

| | Arbitrum Nitro | OP Stack |
|---|---|---|
| Forced path | `Inbox.sendL2Message` → wait delay → `SequencerInbox.forceInclusion` | `OptimismPortal.depositTransaction` |
| User force call | **yes** | **no** — derivation includes it automatically |
| L1 txs required | **2** | **1** |
| Censorship precondition | yes, delay must elapse | none |
| Worst case | 24h base; floor under *sustained* censorship = the buffer `threshold`, **in L1 blocks** (see below) | 12h sequencing window |

`ProtocolAdapter.completeForced()` returns `null` for OP Stack. **This is not a stub.** It
is the encoded form of the asymmetry and is directly the `M-U1` metric (number of
user-initiated L1 transactions). Never "fix" it by inventing an OP Stack force call.

### Two verified facts about the Arbitrum force path

Both were wrong here until 2026-09-10, and both are latent — they only bite in E1.

**1. `forceInclusion` gates on `delayBlocks`, not `delaySeconds`.** In nitro-contracts
v3.1.0 the sole guard is
`if (l1BlockAndTime[0] + delayBlocks_ >= block.number) revert ForceIncludeBlockTooSoon();`.
`delaySeconds` is never read by the force path, and `ForceIncludeTimeTooSoon` does not exist
in this version. To shorten the window, change **`delayBlocks`** via
`SequencerInbox.setMaxTimeVariation`. On Arbitrum Sepolia the two agree (7200 blocks × 12s =
86400s); on a devnet with ~1s blocks they differ by two orders of magnitude.

**2. The "~30 minute floor" is a block count, and belongs to one specific deployment.** The
effective gate is `min(bufferBlocks, delayBlocks)` and depletion saturates at the buffer's
`threshold`, which is denominated in **L1 blocks**. Arbitrum One's documented threshold of
150 blocks is ~30 min at 12s; the nitro-testnode devnet's measured threshold is 600 blocks,
~10 min at its measured 1.003 s/block. Both are real. **Never state the floor as a duration
without naming the configuration and the block time it assumes.**

A corollary worth knowing before designing any E1 run: buffer depletion is **retroactive**.
`DelayBuffer.update()` is called only from `delayProofImpl` and `forceInclusion`, so a
censorship round depletes the buffer for the *next* round, never its own. BoLD cannot engage
during a first incident. See BLUEPRINT §20.1.

---

## 6. Commands

```bash
npm run verify      # connectivity + live params + unverified report
npm run typecheck   # tsc --noEmit  (run after EVERY task)
npm run build
npm run run -- --experiment B --chain arb-sepolia --n 25
npm run export -- --out data/export.csv
```

---

## 7. How to work

1. **One task at a time.** Tasks are defined in `IMPLEMENTATION.md`. Do the task that is
   asked for and stop. Do not implement future tasks because they seem obvious.
2. **Run `npm run typecheck` after every task.** Do not report a task complete until it
   passes.
3. **Meet the acceptance criteria literally.** Each task states them. If one cannot be met,
   say so explicitly rather than declaring partial success.
4. **Ask when a protocol detail is uncertain.** The user has verified addresses and can
   check documentation. Guessing is worse than asking — see I1 and I2.
5. **Keep diffs small.** Do not refactor unrelated files while implementing a task.

---

## 8. Glossary

- **Forced inclusion** — getting a transaction into the L2 via L1, bypassing the sequencer.
- **Delayed inbox** (Arbitrum) — L1 queue the sequencer normally reads voluntarily.
- **`forceInclusion`** (Arbitrum) — the L1 call that forces delayed messages in after the
  delay elapses. Callable by anyone.
- **Deposit transaction** (OP Stack) — an L1-originated transaction, type `0x7E`, that the
  derivation pipeline must include.
- **Derivation** — how an OP Stack node computes L2 state from L1 data.
- **Sequencing window** — 3600 L1 blocks (~12h); the OP Stack bound on forced inclusion.
- **BoLD delay buffer** — Arbitrum mechanism that shortens the effective force window under
  sustained censorship. Effective gate is `min(bufferBlocks, delayBlocks)`; the floor is the
  buffer `threshold`, **in L1 blocks** (Arbitrum One 150 ≈ 30 min at 12s; devnet 600 ≈ 10
  min at ~1s). Depletion is retroactive — see §5.
- **E1 / E2 / E3** — local devnet / public testnet / mainnet. See §2 of the blueprint.
- **Class A/B/C/D** — mainnet event classification. Only Class A supports strong claims.
- **M-L1..M-L5, M-C1..M-C4, M-R1..M-R4, M-U1..M-U2** — the metric IDs from §9 of the
  blueprint. Use these IDs in code and exports so the paper and the data share a vocabulary.
