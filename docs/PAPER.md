# Escape Hatches in the Wild: Measuring the Real Censorship-Resistance of Ethereum Layer-2 Rollups

**Draft — sections 1–6.** Results, Discussion and Related Work in full are not drafted yet.

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
is necessarily under adversarial conditions. **(iii) In the history we could examine, it is never invoked.** We find no confirmed forced
inclusion in 101,111 consecutive batches spanning 1,000,000 L1 blocks (~139 days), an exact
binomial 95% CI on the rate of [0, 3.65 × 10⁻⁵], and not one user-submitted escape-hatch
message among 2,646 delayed-inbox messages [M]. That window is **9.5% of Nitro-era history**;
we report the bound it supports and do not extrapolate to "never". **(iv) Two structural properties of Arbitrum's
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
