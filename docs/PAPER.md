# Escape Hatches in the Wild: Measuring the Real Censorship-Resistance of Ethereum Layer-2 Rollups

**Draft — sections 1-6 and 9-10.** Discussion and Related Work are not drafted yet (citations pending verification).

> **Provenance rule for this document.** Every quantitative claim carries a bracketed source:
> `[E2]` the 100-run public-testnet dataset (`data/export.csv`); `[E1]` the controlled devnet
> censorship experiment; `[M]` the mainnet census (`mainnet_events` / `mainnet_scans`);
> `[P]` a live on-chain parameter read; `[S]` source code of a deployed contract, read from
> the implementation actually deployed; `[C]` a rollup configuration file, which is **not**
> an on-chain read and is labelled separately for that reason. A claim resting on a **single observation is marked
> `n=1` in the sentence that makes it**, not in a footnote. No number in this draft was
> written from memory.

---

## 1. Abstract

Every security argument for an optimistic rollup terminates in the same claim: if the
sequencer censors you, you can force your transaction in through Ethereum. This escape hatch
is load-bearing — it is what allows a centralised sequencer to be described as trust-minimised
— and it is almost always asserted from specifications rather than measured. We ask a
different question from "does the mechanism exist": *what does invoking it actually cost a
user, in latency, fees, waiting, and manual steps?*

We answer it with three complementary measurements. First, a 100-run controlled comparison on
public testnets across Arbitrum Nitro and the OP Stack [E2]. Second, a devnet experiment in
which we operate the sequencer ourselves and censor a specific transaction — the only setting
in which the word *censorship* is licensed at all [E1]. Third, a census of mainnet history
that asks how often the hatch has ever been used [M].

Four findings stand out. **(i) The architectures are asymmetric in required user action, not
merely in speed.** Arbitrum's forced path needs two user-initiated L1 transactions, the OP
Stack needs one; the OP Stack has no force call to make, and its absence is the finding rather
than a gap in our implementation. Measured L1-inclusion-to-L2-appearance latency differs by an
order of magnitude — median 766 s on Arbitrum Sepolia versus 76 s on OP Sepolia, Mann–Whitney
U = 625, p = 1.29 × 10⁻⁹, n = 25 per cell [E2]. **(ii) On a healthy chain, Arbitrum's escape
hatch is structurally unreachable.** `forceInclusion` acts only on delayed messages the
sequencer has not yet read, and a healthy sequencer reads them within minutes, hours before
the 24-hour window opens [P, E2]. The mechanism cannot be rehearsed: a user's first invocation
is necessarily under adversarial conditions. **(iii) It has never been invoked.** Across the *complete* history of the mechanism —
1,332,810 batches over a contiguous 10,540,270 L1 blocks, from the SequencerInbox's deployment
to chain head at block 25,951,325 — there is **not one successful `forceInclusion` call**, an exact binomial
95% CI on the rate of [0, 2.77 × 10⁻⁶]; nor one user-submitted escape-hatch message among the
delayed-inbox messages we sampled [M]. **(iv) Two structural properties of Arbitrum's
delay buffer, established from the deployed source and confirmed on our devnet:** buffer
depletion is *retroactive*, so BoLD's protection cannot engage during a first censorship
incident, only a sustained one; and forcing is a *batch* operation whose price is set by how
many messages are queued ahead of the user — a quantity they can neither observe in advance
nor control.

We release the harness, the dataset, and a reproducible devnet censorship protocol. Prior work
designs these mechanisms, formally models them, flags the usability gap, or attacks the path.
To our knowledge this is the first work to measure what using it costs.

---

## 2. Introduction

### 2.1 A guarantee that is asserted more often than it is exercised

An optimistic rollup executes transactions off-chain and publishes data to Ethereum. A single
sequencer typically decides ordering, which is a centralisation that rollup designers
acknowledge and then defuse with one argument: the sequencer cannot *permanently* exclude you,
because you may submit your transaction through an L1 contract that the rollup is obliged to
honour. Arbitrum calls this the delayed inbox and `forceInclusion`; the OP Stack calls it a
deposit, and its derivation pipeline is required to include it.

This argument does a great deal of work. It appears in security documentation, in third-party
risk assessments, and in the informal reasoning by which users accept a centralised sequencer.
It is also, in practice, an argument about a mechanism that is rarely exercised and — as we
show — is *structurally difficult* to exercise while the system is behaving normally.

The literature reflects this asymmetry. Mechanisms are designed and specified; some are
formally modelled; the usability gap has been explicitly flagged. But the question a user
would ask — *if I need this, what happens to me?* — is answered by specification rather than
by measurement.

### 2.2 The gap we address

"Censorship resistance" is usually reported as a binary property: the escape hatch exists, or
it does not. That framing hides everything a user experiences. A mechanism that requires two
separate L1 transactions, a 24-hour wait, correct reconstruction of six event fields, and
knowledge that the function even exists is not equivalent to one that happens automatically,
even though both are marked present.

We therefore treat censorship resistance as a *cost*, and measure it along four dimensions:
**latency** (how long), **fees** (how much), **waiting** (how much of the latency is a
protocol-mandated delay rather than work), and **manual steps** (how many user-initiated L1
transactions, and what the user must know). These map onto the metric families used
throughout: M-L\* latency, M-C\* cost, M-R\* reliability, M-U\* user action.

### 2.3 Why this is hard to measure honestly

Three difficulties shape our design, and each is a place where a careless measurement produces
a confident wrong number.

**Censorship cannot be observed on a public network.** We do not control any production
sequencer and make no claim about any operator's behaviour. A forced-path measurement on a
public testnet describes a user who *chooses* not to rely on the sequencer, not one who
*cannot* — and conflating the two would be the central error of the field. We enforce this
distinction in the metric names and the exported column names, not only in prose.

**The clocks disagree.** A forced-path latency spans an L1 block timestamp and an L2 block
timestamp. These are different clocks with different resolutions and different failure modes.
In our devnet run, computing latency naively across them yielded 73 s against an L1-only lower
bound of 93 s — an *impossible* result, since a transaction cannot appear on L2 before the L1
block that forced it in [E1]. The cause was sequencer backlog under load: the L2 clock trailed
real time, and six consecutive L2 blocks shared one timestamp. We therefore record a clock
source with every observation, flag mixed-clock metrics, never report precision finer than the
coarsest clock involved, and ship a validity check that tests the whole dataset for exactly
this impossibility.

**The interesting population is tiny, and the confounding population is enormous.** OP Stack
deposits are dominated by routine bridging, and nothing on the event distinguishes a routine
deposit from a user routing around a sequencer. Treating deposit volume as censorship-hatch
usage would produce a large, meaningless number. We classify it as ordinary inclusion *by
construction* and say so.

### 2.4 Contributions

1. **An empirical characterisation of what invoking L2 censorship resistance costs**, across
   two protocol families, on public testnets [E2] and under real, operator-induced censorship
   on a controlled devnet [E1].
2. **The architectural asymmetry, quantified**: required user action differs structurally (two
   L1 transactions versus one), and latency differs by an order of magnitude [E2].
3. **A structural reachability result**: on a healthy chain Arbitrum's hatch cannot be
   exercised at all, because the two conditions it requires — delay elapsed, and message still
   unread — cannot hold simultaneously [P, E2].
4. **Two previously unstated properties of Arbitrum's delay buffer** — retroactive depletion,
   and batch-priced forcing — derived from the deployed contract source and confirmed on the
   devnet [S, E1].
5. **An honest mainnet usage census** [M], including the possibility, which we find, that the
   answer is "never observed".
6. **A reproducible harness, dataset, and devnet censorship protocol**, so the measurement can
   be repeated on other rollups rather than re-argued.

---

## 3. Background

### 3.1 Rollups, sequencers, and the L1 fallback

A rollup executes transactions off-chain and posts data to Ethereum sufficient to reconstruct
its state. Users normally submit to a sequencer, which orders transactions and produces L2
blocks quickly. The sequencer's ordering power is the centralisation in question. Every design
in scope answers it the same way: provide an L1 route by which a transaction enters the rollup
without the sequencer's cooperation.

The two families in this study take structurally different routes, and the difference is the
paper's spine.

### 3.2 Arbitrum Nitro: the delayed inbox and `forceInclusion`

A user calls `Inbox.sendL2Message` on Ethereum with a fully signed L2 transaction, wrapped
with a leading type byte (`0x04`, "a complete signed transaction, execute as-is"). This
enqueues a *delayed message*; the `Bridge` emits `MessageDelivered` recording the message's
index, kind, sender, data hash, L1 base fee and timestamp.

Normally the sequencer reads delayed messages voluntarily and includes them within minutes. If
it does not, the user may — after a delay — call `SequencerInbox.forceInclusion` on L1, which
forces the messages in.

Three details matter and are easy to get wrong; each was verified against the deployed source
rather than documentation [S].

**The gate is `delayBlocks`, not `delaySeconds`.** The only guard in `forceInclusion` is
`l1BlockAndTime[0] + delayBlocks_ >= block.number`; `delaySeconds` is never read on this path,
and no time-based revert exists in the current implementation. On Arbitrum One these agree
(`delayBlocks = 7200` at ~12 s ≈ `delaySeconds = 86400`) [P], so the published 24-hour figure
is correct — but the parameter a researcher must manipulate is the block count.

**The sender is aliased.** `sendL2Message` records the L1→L2 *aliased* address in
`MessageDelivered`, not the caller. Reconstructing `forceInclusion`'s arguments with the raw
caller address fails the accumulator preimage check [E1].

**Forcing is a batch operation.** `forceInclusion` takes `_totalDelayedMessagesRead` — a count
to read *up to*, not a message identifier — and includes every message queued ahead of the
caller's own. There is no variant that includes one message selectively [S].

### 3.3 The delay buffer (BoLD)

Recent Arbitrum deployments make the force window shrink under sustained delay. The effective
gate is `min(bufferBlocks, delayBlocks)`, and depletion saturates at a configured `threshold`,
so `threshold` is the floor — **denominated in L1 blocks, not in time**. Arbitrum One reports
`threshold = 150` [P], which is ~30 minutes at 12-second blocks; our devnet's deployment
reports `threshold = 600` [P], ~10 minutes at its measured ~1 s blocks. Both are real values
from different configurations, and quoting the duration without naming the configuration is an
error we make explicit because we made it ourselves before checking.

### 3.4 OP Stack: deposits and derivation

A user calls `OptimismPortal.depositTransaction` on Ethereum. The portal emits
`TransactionDeposited`, and the rollup's derivation pipeline is *required* to include the
resulting L2 transaction (type `0x7E`) within a **sequencing window of 3600 L1 blocks**,
≈12 h at 12-second blocks [C]. This bound is declared in the rollup configuration
(superchain-registry, `seq_window_size`), not read from a contract, and the value we verified
is OP Sepolia's; unlike Arbitrum's `delayBlocks`, it is not queryable on-chain, which is
itself a small asymmetry in how checkable the two guarantees are.

There is no force call, and no eligibility condition to wait for. This is not an omission in
our harness: our protocol adapter's `completeForced()` returns `null` for the OP Stack, and
that null *is* the M-U1 measurement — the count of user-initiated L1 transactions.

### 3.5 Why the same event cannot answer the usage question on the OP Stack

`TransactionDeposited` is emitted identically whether it carries a routine bridge deposit or a
user bypassing a stalled sequencer. No field distinguishes them. Any measurement of "escape
hatch usage" on the OP Stack that counts deposits is therefore measuring bridging volume. We
report OP deposits as *mechanism usage* and never as evidence of censorship.

---

## 4. Problem Definition

### 4.1 From a binary property to a cost vector

We define the object of study as the **cost of exercising forced inclusion**, for a user who
has decided not to rely on the sequencer. Formally, for a transaction *t* on rollup *R*:

- **Latency** — elapsed time from the user's first action to *t* executing on L2, decomposed
  into independently observable stages so that protocol-mandated waiting is separable from
  work.
- **Fees** — total wei spent across every leg, on L1 and L2.
- **Manual steps** — the number of user-initiated L1 transactions (M-U1), plus the knowledge
  required to construct them.
- **Reliability** — the fraction of attempts that succeed, with failures and timeouts retained
  in the denominator.

### 4.2 The stage model

A run is decomposed into stages S1–S9, each recorded with a block number, a timestamp, a clock
source, and a confidence:

| Stage | Meaning | Clock |
|---|---|---|
| S1 | transaction generated (signed) | wall |
| S2 | submitted to path | wall |
| S3 | L1 inclusion of submission | l1_block |
| S4 | protocol queue entry (`MessageDelivered` / `TransactionDeposited`) | l1_block |
| S5 | force eligibility | l1_block, **inferred** |
| S6 | force action (`forceInclusion`) | l1_block |
| S7 | L2 appearance | l2_block |
| S8 | L2 execution | l2_block |
| S9 | L1 finality | l1_block |

S5 is the only inferred stage: it is a *computed* eligibility time, not an observation of a
block that carried anything. S6 exists only for Arbitrum. On the OP Stack S5 and S6 are absent
by construction, and their absence is data.

The headline latency metrics are **M-L2** (S3 → S7, L1 inclusion to L2 appearance — the one
metric both families genuinely share), **M-L3** (S2 → S7, forced path end-to-end), **M-L4**
(S1 → S8, normal path), and **M-L5** (censorship onset → L2 appearance, definable only in E1).

### 4.3 The three-clock discipline

There are exactly three clocks, and mixing them silently is the failure mode that produces
confidently wrong latencies:

| Clock | Resolution | Valid for |
|---|---|---|
| `wall` | ms | client-side stages only |
| `l1_block` | ~12 s, proposer-set | L1 inclusion ordering |
| `l2_block` | 2 s (OP) / ~250 ms (Arbitrum) | L2 appearance ordering |

Every recorded observation stores its clock source. Any metric spanning two clocks is exported
with a mixed-clock flag and a resolution column, and precision is never reported finer than
the coarsest clock involved. We validate the whole dataset against the one relation that
admits no argument — a transaction cannot appear on L2 before the L1 block that carried it —
and report the result as a validity check rather than assuming it.

### 4.4 Environments, and what each can support

| | E1 devnet | E2 public testnet | E3 mainnet |
|---|---|---|---|
| Sequencer under our control | yes | no | no |
| Genuine censorship creatable | **yes** | no | no |
| Real fee market | no | approximate | yes |
| Supports M-L5 | yes | no | no |
| Supports usage census | no | no | yes |

Only E1 can demonstrate censorship. Only E3 can say how often the mechanism is used. E2
supplies the controlled cross-protocol comparison. No single environment answers the question,
which is why all three are present.

### 4.5 Mainnet event classification

Historical mainnet events are classified strictly, and a class is never upgraded to improve a
count:

- **Class A** — a *successful* `forceInclusion` call. Unambiguous.
- **Class B** — a delayed message not read within the window the protocol itself calls
  expected, later batched. Suggestive of a lagging sequencer; not proof of censorship.
- **Class C** — ordinary inclusion, including *all* OP Stack deposits, by construction.
- **Class D** — insufficient evidence.

Class D is not failure; it is the honest label for an event whose evidence ran out, typically
at a scan boundary. Every classified row stores the evidence string that justifies its label.

---

## 5. Threat Model

### 5.1 Definition

**Censorship** is an L2 sequencer that intentionally and persistently refuses to include an
otherwise-valid transaction, while remaining live and producing blocks containing other
transactions.

Validity is held constant and verified rather than assumed: sufficient balance, correct nonce,
adequate gas limit and price, well-formed signature, and repeated submission. Liveness is
verified *concurrently* — the sequencer must be demonstrably producing blocks containing other
users' transactions throughout the censorship window. Without that concurrent check, "my
transaction did not appear" is indistinguishable from "the chain halted", and only the first
is censorship.

This condition is creatable **only in E1**, because it requires operating the sequencer.

### 5.2 What the adversary can and cannot do

The adversary is the sequencer operator. It may reorder, delay, or indefinitely exclude any
transaction from L2 blocks, and may do so selectively. It may not forge signatures, alter L1
state, prevent the user from transacting on L1, or stop the L1 chain. Ethereum itself is
assumed live and censorship-resistant; the rollup's escape hatch is only as strong as that
assumption, which we inherit rather than test.

We also consider a weaker, non-operator adversary in one specific place. Because forcing is a
batch operation (§3.2), any party may enqueue delayed messages at ordinary L1 cost, and each
one is prepended to the bill of the next user who forces. This is an availability-of-recourse
concern rather than an inclusion concern, and we treat it as such.

### 5.3 Explicit non-claims

These are stated as prominently as the findings, because the difference between them is the
integrity of the work.

1. **We do not claim that any production sequencer has ever censored anything.** We did not
   observe censorship on any public network and did not attempt to induce it on one.
2. **No mainnet event in our dataset is classified as censorship.** The classification has no
   category that would permit it: Class A records that the escape hatch was *used*, which is
   not the same as establishing that it was *needed*.
3. **We make no claim about operator intent, liveness commitments, or governance.**
4. **Public-testnet forced-path measurements describe a user who chooses not to rely on the
   sequencer, not one who cannot.** They measure the forced *path*, not censorship. Where the
   sequencer voluntarily consumed our message before it became force-eligible, we label the
   run auto-inclusion and report it as such [E2].
5. **The devnet is not a production system.** Its parameters, block times, and fee market are
   ours. E1 establishes that a mechanism works and what it costs under conditions we control;
   it does not establish production timings.

### 5.4 Scope

In scope: Arbitrum Nitro and the OP Stack (OP Mainnet, Base), on Ethereum. Out of scope:
validity-proof rollups with priority-queue designs, alternative-DA systems where the fallback
depends on a non-Ethereum availability assumption, and any claim requiring knowledge of
operator intent.

---

## 6. Research Questions and Hypotheses

### 6.1 Research questions

- **RQ1** What is the real end-to-end latency of the forced path per protocol, decomposed into
  independently measurable stages?
- **RQ2** What is the cost of the forced path, and what premium does it carry over the normal
  path?
- **RQ3** Does forced-path performance degrade under L1 congestion, and does the protocol
  bound hold regardless?
- **RQ4** How do the delayed-inbox and automatic-derivation families differ in latency, cost,
  and required user action?
- **RQ5** Under genuine sequencer censorship, does the escape path recover the transaction
  within the protocol-stated bound?

RQ5 is answerable only in E1, and this is a property of the world rather than a limitation of
our design: no experiment on a network we do not operate can create the antecedent.

### 6.2 Hypotheses

Each is stated with a null, a designated metric, an environment, and a falsification
condition. **None is assumed true, and a negative result on any is reported as a result.**

**H1 — Healthy-path forced latency differs by architecture.**
H₀: median M-L2 is equal for Arbitrum and the OP Stack. H₁: it differs.
Test: Mann–Whitney U with a bootstrap CI on the median difference. Environment: E2.
Falsified if p > 0.05 with a CI tight enough to exclude a practically meaningful gap.

**H2 — The forced path carries a cost premium.**
H₀: the ratio of forced-path to normal-path total cost is 1. H₁: it exceeds 1.
Metric: M-C4. Environment: E2 (A versus B). Test: bootstrap CI on the ratio of medians.
Falsified if the CI includes 1.

**H3 — L1 congestion affects forced-path entry, not the protocol bound.**
H₀: no monotonic relationship between L1 base fee and M-L1 (submit → L1 inclusion).
Test: Spearman ρ with quantile regression at τ = 0.5 and 0.9.
Falsified if |ρ| is small with a CI spanning 0.

**H4 — Required user action, not latency, is the dominant usability difference.**
H₀: the architectures differ mainly in latency. H₁: they differ mainly in the number of
required user-initiated L1 transactions and the accompanying knowledge burden.
Metrics: M-U1 plus M-L2. Test: descriptive with effect sizes.
Falsified if the latency difference dwarfs the action-count difference in practical terms.

**H5 — Worst-case inversion under sustained censorship.**
H₀: Arbitrum's effective censorship window is at least the OP Stack's. H₁: the delay buffer
drives it *below* the OP Stack's ~12-hour configured worst case [C]. Metric: M-L5. Environment: E1 plus
analytical derivation from live parameters.
Falsified if devnet recovery exceeds the derived bound, or if the buffer does not decrement as
documented.

**A note on H5's status, stated here rather than deferred to Results.** Our reading of the
deployed source, confirmed on the devnet, shows that buffer depletion is *retroactive*: the
buffer is written only when a batch reading new delayed messages is posted, or by
`forceInclusion` itself, so a censorship round depletes the buffer for the *next* round rather
than its own [S, E1]. H5 as originally posed is therefore not testable with a single
censorship incident, and our E1 run is a single incident (**n=1**). We report the structural
result — that BoLD cannot engage during a first incident — as a finding in its own right,
because it follows from control flow alone and holds whether or not the inversion is ever
demonstrated empirically. Testing H5 as stated requires a multi-round depletion curve, which
we identify as future work rather than claim.

### 6.3 What would falsify the paper's framing

If forced inclusion turned out to be cheap, fast, single-step, and routinely exercised on
mainnet, the framing would be wrong and the contribution would reduce to a verified negative
result. We state the condition in advance so that the finding is not unfalsifiable by
construction.

---

## 9. Results

All E2 figures below are computed from `data/export.csv` (100 runs, four cells of n = 25). All
E1 figures come from a single controlled censorship run and are marked accordingly. Where a
statistic is a median of per-run values rather than a ratio of medians, the text says which.

### 9.1 Coverage and reliability

Every cell is complete: 25 runs, 25 successes, no timeouts and no incomplete lifecycles, so
`n_used = n_total` throughout and no denominator silently shrinks [E2].

| Cell | n | success | exact binomial 95% CI |
|---|---|---|---|
| arb-sepolia / forced | 25 | 25 | [0.863, 1.000] |
| arb-sepolia / normal | 25 | 25 | [0.863, 1.000] |
| op-sepolia / forced | 25 | 25 | [0.863, 1.000] |
| op-sepolia / normal | 25 | 25 | [0.863, 1.000] |

The lower bound of 0.863 at 25/25 is worth stating plainly: a perfect success rate over 25
attempts is consistent with a true success rate as low as 86%. M-R1 is *not* "100% reliable".

### 9.2 RQ1 / H1 — latency differs by an order of magnitude

**M-L2** (S3 to S7, L1 inclusion to L2 appearance) is the one metric both families genuinely
share, and it is the basis of the cross-protocol comparison [E2]:

| Cell | median | min | max |
|---|---|---|---|
| arb-sepolia / forced | **766 s** | 411 s | 786 s |
| op-sepolia / forced | **76 s** | 70 s | 90 s |

Mann-Whitney U = 625, z = 6.069, **p = 1.29 x 10^-9**, two-sided, n = 25 per group. U = 625 is
the maximum possible for 25 x 25: *every* Arbitrum observation exceeds *every* OP Stack
observation, so the common-language effect size P(A > B) = 1.000. **H1's null is rejected.**

End-to-end (**M-L3**, S2 to S7) the ordering is unchanged: 775 s median on Arbitrum (426-795)
versus 87 s on the OP Stack (80-105). The entry leg is not the differentiator — **M-L1**
(S2 to S3, submission to L1 inclusion) is 8 s median on Arbitrum and 11 s on the OP Stack, so
both are simply waiting for an L1 block.

The normal path inverts the ranking and compresses the scale: **M-L4** medians are 1 s on
Arbitrum (min 1, max 2) and 3 s on the OP Stack (min 2, max 4) — Arbitrum's ~250 ms blocks
against the OP Stack's 2 s. At these magnitudes the values sit at or below the `l2_block`
resolution, and we do not read a difference into them.

### 9.3 RQ2 / H2 — cost, and why the totals must not be compared naively

Median `total_fee_wei`, the only cross-protocol comparable cost figure [E2]:

| Cell | median total_fee_wei | forced / normal |
|---|---|---|
| arb-sepolia / forced | 105,448,477,855,536 | **19.2x** |
| arb-sepolia / normal | 5,490,673,566,000 | — |
| op-sepolia / forced | 130,740,305,035,700 | **3,351.8x** |
| op-sepolia / normal | 39,006,186,877 | — |

**H2's null is rejected on both chains**, and the magnitude of the OP Stack's premium deserves
attention: the forced path costs over three thousand times the normal path, not because
forcing is expensive in absolute terms — it is within 25% of Arbitrum's — but because the OP
Stack's *normal* path is extraordinarily cheap. A premium is a ratio, and a large ratio here
is a statement about the denominator.

**The decomposition is the centrepiece, because the two totals are composed incomparably.**
Per-run component shares of `total_fee_wei`, medians with ranges [E2]:

| | L1 submission (M-C1) | L2 execution (M-C3) |
|---|---|---|
| arb-sepolia / forced | **94.8%** (94.1-95.9) | 5.2% (4.1-5.9) |
| op-sepolia / forced | **100%** — all 25 runs | **none — no L2 leg exists** |

On the OP Stack's forced path `M_C1` equals `total_fee_wei` exactly, in all 25 runs. This is
not a gap in instrumentation: a deposit's L2 execution is prepaid on L1 as part of the deposit
itself, so there is no separate L2 fee to charge. Arbitrum's forced path, by contrast, has a
genuine two-leg structure — the L1 `sendL2Message` call dominates at 94.8%, and the L2
transaction it carries is charged separately.

So the headline totals (105.4 versus 130.7 trillion wei) look like a modest 24% difference
between comparable quantities, and they are not comparable quantities: one is a single L1
payment, the other is an L1 payment plus a separately charged L2 execution. Reporting the
totals without the decomposition would invite exactly the wrong inference.

A third asymmetry compounds this. On the OP Stack's **normal** path the L1 data fee is
**46.1%** of the total (44.5-46.9, per-run medians, n = 25) — nearly half the cost of an
ordinary L2 transaction is an L1-priced data charge. On Arbitrum the equivalent
data-availability cost is not a separable fee at all: it is recouped as extra L2 *gas* inside
`l2_gas_used`. The two are different units at different prices, and `total_fee_wei` is the
only figure that survives the comparison. Carrying the OP data fee explicitly also matters
practically: omitting it understates the true OP normal-path cost by about 46%.

### 9.4 RQ4 / H4 — required user action is structural, not incidental

**M-U1**, counted from what was actually sent rather than from protocol design [E2]:

| Cell | M-U1 observed |
|---|---|
| arb-sepolia / forced | 1, in all 25 runs |
| op-sepolia / forced | 1, in all 25 runs |
| both normal cells | 0, in all 25 runs |

Arbitrum's forced path *requires* two user-initiated L1 transactions, yet we measured one in
every run. The reason is §9.5: the sequencer voluntarily consumed every message, so the second
transaction was never needed and never sent. The protocol's requirement of two was exercised
exactly once, on the devnet, where M-U1 = 2 (**n = 1**) [E1].

This is why H4 cannot be settled on E2 alone, and we do not claim it is. What E2 establishes is
the weaker, cleaner statement: on a healthy chain the *observable* action counts converge to
one, and the architectural difference is invisible in the telemetry precisely when the system
is behaving. The difference appears only under the conditions the mechanism exists for.

### 9.5 RQ5 — on a healthy chain, Arbitrum's forced path is unreachable

Every one of the 25 Arbitrum forced runs was auto-included: `inclusion_path = auto`, 25/25,
and **S6 (force action) has zero rows**, 0/25 [E2]. S3, S4, S5 and S7 are populated in all 25.

The quantity that explains it: the message appeared on L2 a **median of 23.79 hours before it
became force-eligible** (min 23.78, max 23.89; S5 minus S7, n = 25) [E2]. S5 is the only
inferred stage — a computed eligibility time, not an observation — and the sign of this
difference is the point. The two conditions `forceInclusion` requires, *delay elapsed* and
*message still unread*, cannot hold simultaneously while the sequencer is healthy.

**This is a structural result, not a sampling artifact, and waiting longer makes it worse
rather than better.** Its consequences run through the rest of the paper: Arbitrum's escape
hatch is only exercisable while the failure it protects against is actually occurring; it
cannot be rehearsed; and a user's first invocation is necessarily under adversarial
conditions, with no prior opportunity to build confidence in it.

### 9.6 E1 — censorship, and the only M-L5 we have

We operated the sequencer, shortened `delayBlocks` to 60 via the UpgradeExecutor, disabled the
delayed-message reader, and submitted a transaction through `Inbox.sendL2Message` only. **All
figures in this subsection rest on a single run (n = 1).**

Censorship was demonstrated rather than assumed: across the full 60-block window the
transaction was absent from every poll while the sequencer produced **47 L2 blocks of other
traffic** and `totalDelayedMessagesRead` stayed frozen. Liveness and exclusion were observed
concurrently, which is what distinguishes censorship from a halt.

| Quantity | Value (n = 1) |
|---|---|
| **M-L5** (onset to forced inclusion) | **92 L1 blocks = 93 s**, single-clock `l1_block`, resolution 1.011 s/block |
| M-U1 | 2 |
| M-C1 `sendL2Message` | 87,282 gas, 130,923,000,610,974 wei |
| M-C2 `forceInclusion` | 117,759 gas, 176,638,500,824,313 wei |
| M-C3 L2 execution | 21,000 gas, 2,100,000,000,000 wei |
| total | 309,661,501,435,287 wei |

After `forceInclusion` the transaction executed and the recipient's balance moved by exactly
the signed amount.

Two structural properties were confirmed here, and both generalise beyond n = 1 because they
follow from the deployed contract's control flow rather than from the measurement [S]:

**Buffer depletion is retroactive.** `DelayBuffer.update()` is called only from a batch post
that reads new delayed messages, or from `forceInclusion` itself. During a censorship window
neither runs, so the stored buffer does not move — and the live view actually *replenishes*,
because the delay term it derives describes the *previous* message while elapsed time grows.
Our run confirms it: `bufferBlocks` stayed at 14,400 throughout. **A censorship round depletes
the buffer for the next round, never its own, so BoLD cannot engage during a first incident.**
This is why H5 as posed is untestable with one incident, and we report the structural result
instead of the inversion.

**Forcing is a batch operation.** The call moved `totalDelayedMessagesRead` from 102 to 107:
**one forcing user, five messages included** (n = 1). `forceInclusion` takes a count to read
*up to*, not a message identifier, so the caller pays for every message queued ahead of them.
M-C2 above is therefore the cost of five messages, not one, and must never be pooled across
runs without its batch size. The price of the escape hatch is set by queue depth the user can
neither observe in advance nor control — and any party can enqueue delayed messages at
ordinary L1 cost.

### 9.7 Validity checks

These bear directly on whether the latency numbers above can be believed, so we report them as
results rather than as an appendix.

**The L2 clock trails real time under load, badly enough to produce an impossible latency.**
In the E1 run, M-L5 computed naively across clocks gives 1789059984 − 1789059911 = **73 s**,
against an L1-only lower bound of **93 s**. A transaction cannot appear on L2 before the L1
block that forced it in, so 73 s is not merely imprecise, it is impossible. The L2 block
carrying the forced transaction is stamped **20 s earlier** than the L1 block that forced it,
and six consecutive L2 blocks share one timestamp. Cause: sequencer backlog under the load
generator. A calibration on the same, unloaded sequencer — three normal L2 transactions —
showed a **0 s** offset, so this is load-induced lag rather than a configuration skew. M-L5 is
therefore reported single-clock on `l1_block`, and no mixed-clock latency is reported anywhere
without its flag and resolution.

**The same failure does not appear in the E2 dataset.** We tested every run for it: each
observed L1-anchored stage (S3, S4) against each L2-anchored stage (S7, S8). **Zero violations
across 200 compared pairs.** S5 is excluded because it is inferred and, per §9.5, legitimately
falls *after* L2 appearance; S9 is excluded because L1 finality legitimately follows it.
Including either would have manufactured false positives.

What the check bounds, stated precisely: the `l2_block` clock never trailed by more than the
observed margin, and the smallest margin is **70 s** (op-sepolia/forced, median 76 s; the
Arbitrum minimum is 411 s). So the E1 failure mode is absent here — but the honest statement is
"lag under 70 s at every observation", not "no lag". The E1 lag was ~113 s of a 93 s quantity,
large enough that it *would* have flipped a 70 s margin negative.

**No timestamp clustering.** Every cell has 25 distinct S7 timestamps across 25 runs, and no
two runs share an L2 block. The backlog signature that produced the E1 anomaly — many blocks
sharing one timestamp — is absent.

---

## 10. Mainnet Observations

Read-only classification of mainnet history per §4.5. Every range is recorded with its scan,
every row carries its evidence string, and no class is ever upgraded to improve a count.

### 10.1 The candidate set was empty before any condition was applied

A null result produced by a four-condition classifier invites one obvious objection: *the
filter was too strict*. We answer it by reporting the stage before the filter.

`forceInclusion` is the only operation that produces a batch with
`dataLocation = NoData` — the classifier's first condition, and the one that selects the
candidate set the other three conditions then test. Across the **1,231,699** batches
enumerated by the log census, the complete `dataLocation` population is [M]:

| `dataLocation` | meaning | count |
|---|---|---|
| 0 | `TxInput` — batch data in calldata | 592,318 |
| 3 | `Blob` — batch data in 4844 blobs | 639,380 |
| 1 | `SeparateBatchEvent` | 1 |
| **2** | **`NoData` — what `forceInclusion` emits** | **0** |

Every batch is accounted for; the counts sum to the total. **The Class A candidate set was
empty**, so the remaining three conditions — selector, receipt status, direct call — were never
reached and could not have excluded anything. The zero is a property of the chain, not of our
classifier's strictness.

Three things together make it defensible rather than merely reported.

**Coverage is contiguous, not sampled.** The census spans blocks 15,411,056 to 25,951,325 —
from the SequencerInbox proxy's first block with code through to the chain head at census time
— with **no unexamined gaps**. This is stronger than disjointness, which a set of ranges can
satisfy while still leaving blocks between them for an event to hide in, and
`analysis/mainnet.py` prints the contiguity check explicitly rather than leaving it implied.

**Two independent data sources agree.** 1,231,699 batches come from an explorer's indexed log
API and 101,111 from direct RPC `eth_getLogs` against an archive node, over different block
ranges and through entirely different infrastructure. Both report zero NoData. A silent
failure in one would have to be matched by a silent failure in the other to produce this.

**The target and the selector were verified across every version, not assumed.** The proxy
address is stable across all of Nitro history — `bridge.sequencerInbox()` returns
`0x1c4796…82B6` at all ten blocks sampled from 15,411,100 to 25,949,044 — whereas the *Rollup*
address is **not**, `0x4DCeB4…Cfc0` having code only from block 21,830,860, so resolving the
inbox through `rollup()` would have silently missed everything before the BoLD upgrade. Five
distinct implementations have sat behind the proxy, and **all five** contain `0xf1981578`;
none contains any alternative spelling [S]. A census pointed at the wrong address, or matching
a selector that only the current implementation uses, would return zero for reasons that have
nothing to do with user behaviour.

### 10.2 Class A: zero, and the bound it supports

**`forceInclusion` has never been successfully called on Arbitrum One.** Zero confirmed forced
inclusions in **1,332,810 batches** across the contiguous span above. Exact Clopper–Pearson
95% CI on the rate: **[0, 2.77 × 10⁻⁶]** [M].

The denominator is batches rather than blocks or elapsed time, because every
`SequencerBatchDelivered` either was a forced inclusion or was not — which is what makes the
interval binomial. Stated as a reader should quote it: *in the entire operational lifetime of
Arbitrum One's escape hatch, no user has ever successfully invoked it, and the data bounds the
rate at no more than about one per 361,300 batches.*

Zero observed is still not zero possible — a first use tomorrow would not contradict this —
but the observation window is no longer the limitation, and the bound is now a statement about
the mechanism rather than about our sampling.

### 10.3 What was examined

| Chain | Target | Blocks | Events examined | A | B | C | D |
|---|---|---|---|---|---|---|---|
| Arbitrum One | SequencerInbox | **15,411,056–25,951,325 (10,540,270, contiguous)** | **1,332,810 batches** | **0** | — | — | — |
| Arbitrum One | Bridge | 25,929,045–25,949,044 (20,000) | 2,646 messages | 0 | **0** | 2,626 | 9 |
| OP Mainnet | OptimismPortal | 25,939,045–25,949,044 (10,000) | 362 deposits | 0 | 0 | **362** | 0 |
| Base | OptimismPortal | 25,939,045–25,949,044 (10,000) | 1,095 deposits | 0 | 0 | **1,095** | 0 |

Only the Arbitrum One SequencerInbox scan is full-history; the other three are bounded windows
and are reported as such. Ranges are disjoint per target, so the counts sum to valid
denominators [M].

### 10.4 Class B: zero, and the delay data says why

No message exceeded the window the protocol itself calls expected. Observed read delays were
**min 34, median 56, max 94 L1 blocks** against the inbox's own on-chain `buffer().threshold`
of **150** [M, P]. Every message was read well inside the expected window, so nothing was
lagging and nothing qualifies. The boundary is read from chain, never chosen.

**Class D = 9**, all boundary effects: messages at the very end of the range whose covering
batch lies past `toBlock`. They are held at D rather than assumed ordinary, which is what the
class is for.

### 10.5 The sharpest form of the result: zero escape-hatch messages

Of 2,646 `MessageDelivered` events on Arbitrum One, **not one was kind 3 (`L2_MSG`)** — the
delayed-inbox path a user takes to submit a signed transaction bypassing the sequencer [M]:

| kind | meaning | count |
|---|---|---|
| 13 | batch-posting report (protocol bookkeeping) | 2,066 |
| 9 | retryable ticket (bridging) | 515 |
| 12 | ETH deposit (bridging) | 45 |
| **3** | **`L2_MSG` — the escape hatch** | **0** |

This reproduces on mainnet what we measured on Arbitrum Sepolia: 0 of 25,617 delayed messages
over about 17 days (120,000 L1 blocks) were kind 3, the remainder being 19,251 batch-posting
reports, 4,816 ETH deposits and 1,550 retryables [M].

A method note, because the obvious approach is wrong: classify on `MessageDelivered.kind`, the
field the protocol dispatches on, **not** on the first byte of the message data. Only kind-3
messages carry a leading `L2MessageType` byte; retryables and deposits begin with the high byte
of a packed `uint256`, usually `0x00`. A byte-prefix classifier cannot distinguish "no
escape-hatch messages" from "these are not escape-hatch messages at all".

### 10.6 OP Stack deposits: 1,457 events, all Class C by construction

362 deposits on OP Mainnet and 1,095 on Base, every one Class C [M]. This is a statement about
what the data can support, not a finding about usage: `TransactionDeposited` is emitted
identically whether it carries routine bridging or a user routing around a stalled sequencer,
and no field distinguishes them. We therefore report OP deposits as **mechanism usage** and
never as evidence of censorship. Counting deposit volume as escape-hatch usage would produce a
large number that means nothing — the confound this classification exists to prevent.

### 10.7 What the mainnet data cannot settle

**The batch-size distribution.** With zero Class A events there is no mainnet distribution, so
the griefing-versus-public-good reading of batch-priced forcing (§9.6) is **not decided**. E1's
single observation — five messages for one forcer (**n = 1**), on a devnet we controlled —
remains the only measurement, and it supports no generalisation. The one thing the mainnet data
does say is that queue depth was consistently shallow in the observed window: the unread
backlog sat at 1-2 messages [M]. That is a statement about quiet conditions, and the mechanism
only matters in unquiet ones.

**Whether the hatch was ever *needed*.** Class A records that the mechanism was *used*. Our
classification has no category that would license the inference that it was necessary, and we
do not draw it.

### 10.8 Verifying the instrument, and why these checks exist

A null result is unfalsifiable by construction unless the instrument's failure modes are
enumerated in advance. "We looked and found nothing" and "our tooling silently returned
nothing" produce identical output, and no amount of inspecting the *result* distinguishes
them — a broken census and a true zero look the same. The checks below were therefore built as
positive controls and reconciliations, not as sanity-checks on an answer that looked wrong.

That is not a hypothetical concern. **Three separate errors arose in this project, and each
would have produced a plausible result biased toward this paper's conclusion.** None was
caught by the output looking suspicious; each was caught by a check that existed to catch it.

**1. A provider-side filter that returned zero for a selector known to be present.**
Blockscout's `method=` parameter returns zero items for `0x3e5aa082` — a selector we had
observed on that exact address moments earlier — and zero for the method *name* as well. It
fails silently rather than erroring. Used naively it would have reported "zero forced
inclusions across all history" in one request, with no symptom of malfunction.
*Check:* a **positive control** runs before every census and tests the source against
independently confirmed facts — that logs come back at all, and that every one decodes to the
expected seven-word shape. The census refuses to run if the control fails, and the control's
result is printed with the census output rather than assumed. Consequently no provider-side
method filter is used anywhere in this work: `dataLocation` is decoded locally from each log's
own data word.

**2. An analysis that silently dropped every census row from the binomial denominator.**
`analysis/mainnet.py` selected scans with `target_label == "SequencerInbox"`, while the census
writes `SequencerInbox:logcensus`. The Class A numerator was unaffected — it was zero either
way — so the reported interval was computed over only the RPC-scanned batches. The error was
invisible in the output: a valid-looking CI over a smaller *n*, biasing toward a *wider*
interval here, but the same class of error over a larger *n* would have narrowed it.
*Check:* a **denominator reconciliation** — the coverage table prints `logs_seen` per scan and
the rate is computed from their sum, so numerator and denominator are visible together and can
be added up by hand. Both scan routes now contribute to the same population.

**3. Overlapping scan ranges double-counting the denominator.** Two census windows overlapped
(one was fully contained in the other), and a third overlapped an earlier RPC scan. Summing
their `logs_seen` would have inflated *n* and **narrowed the confidence interval** — failing in
precisely the direction that flatters a "never used" conclusion, and producing a more
impressive-looking bound from less evidence.
*Check:* **overlap detection plus a contiguity check**. Overlaps are reported before any rate
is quoted; contiguity is reported separately, because disjointness alone still permits
unexamined blocks *between* ranges where an event could sit. The phrase "across all of
Nitro-era history" is licensed by the printed contiguity line, not by the author's arithmetic.

Two further checks belong to the same family and are reported with the results they guard.
The **clock-ordering check** (§9.7) tests the whole E2 dataset against a relation that admits
no argument — a transaction cannot appear on L2 before the L1 block that carried it — after
the E1 run produced exactly that impossibility. And the census records **which source produced
each range**, so the agreement between two independent infrastructures (§10.1) is a property
of the data rather than a claim about it.

The common shape is worth stating for anyone reproducing this. Every one of these failures is
*silent*, *plausible*, and *directionally favourable* to the hypothesis. Measurement code for
a rare-event study should therefore be instrumented to fail loudly on a known positive, rather
than trusted to fail visibly on a true negative — because on a true negative there is nothing
to see.
