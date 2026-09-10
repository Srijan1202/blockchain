# analysis

Statistics and figures for *Escape Hatches in the Wild*. Python only — TypeScript
produces data, Python produces results (CLAUDE.md §3).

Everything regenerates from `export.csv` alone. No intermediate state, no manual steps.

## Setup

```bash
pip install -r analysis/requirements.txt
```

## Run

```bash
npm run export -- --out data/export.csv     # produces the dataset (TypeScript)

python analysis/report.py  --csv data/export.csv                      # every statistic
python analysis/figures.py --csv data/export.csv --out analysis/figures  # every figure
python analysis/nonparametric.py                                      # self-test the estimators
```

## Files

| File | Purpose |
|---|---|
| `load.py` | Read `export.csv` with correct types. **Wei columns become Python `int`, never `float`.** |
| `stats.py` | Bootstrap CIs, Mann-Whitney, binomial CIs, cost decomposition. |
| `nonparametric.py` | Mann-Whitney U and Clopper-Pearson, self-tested against published values. |
| `report.py` | Prints every statistic the paper needs, each with its denominator. |
| `figures.py` | ECDFs per cell, cost comparison with CIs, cost decomposition. |

## Four things that will bite you if you skip them

### 1. A wei value is not a float

`total_fee_wei` exceeds 2⁵³. float64 has a 53-bit mantissa, so `pd.read_csv` inferring
float64 for a cost column **silently rounds every value in it** — the numbers still look
like numbers, and the error lands straight in the cost figures.

`load_export()` reads every column as `str` and converts wei columns to Python `int`
(arbitrary precision) explicitly. `stats.median_wei()` computes medians by sorting ints
rather than via numpy, and returns the lower of the two central values on an even count,
because *averaging two wei values reintroduces a float*.

If you add a cost column to the export, add it to `WEI_COLUMNS` in `load.py`. It is a
deliberate list, not an inferred one, so a new column cannot slip through as a float.

### 2. Report `n_total` and `n_with_metric` separately, always

Runs with incomplete lifecycles — interrupted tracking, timeouts — export **null**
latencies. They are exported rather than dropped precisely so the denominator stays
visible.

Every statistic here prints `n_used/n_total`. An analysis whose denominator silently
shrinks is the failure mode: M-R1/M-R2/M-R3 are success, failure and timeout *rates*, and
a dataset that has already discarded its timeouts cannot report them. Filter on
`is_complete` or `outcome` **deliberately**, and say so.

### 3. Cost columns are protocol-specific and are not interchangeable

| Column | Protocol | What it is |
|---|---|---|
| `M_C3_op_l1_data_fee_wei` | OP Stack only | A **fee in wei**, priced at the **L1** gas price, charged on top of L2 execution |
| `M_C3_arb_l1_gas_allocation` | Arbitrum only | An **L2 gas allocation**, priced at the **L2** gas price, already *inside* `l2_gas_used` |

Different quantities, different units. Never sum them, never compare them, never plot them
side by side as "the L1 cost".

**`total_fee_wei` is the only cross-protocol comparable cost figure.** Any figure comparing
cost across protocols must use it and say so in the caption — `figures.py` writes that
caption automatically.

Totals compare. Decompositions do not: `total_fee_wei − M_C3` is not like-for-like across
protocols, because only the OP Stack has a separable, differently-priced DA component.

### 4. Decompose within a protocol, not across

Comparing only totals hides *why* a path costs what it does. `report.py` breaks the forced
path into M_C1 (L1 submission), M_C2 (`forceInclusion`, Arbitrum only) and M_C3 (the L2
transaction), with each component's share of the total.

Read the caveats it prints. On **Arbitrum**, `M_C3` already contains its data-availability
share — Nitro recoups the posting cost by charging extra L2 gas — so the "L2 leg" is *not*
pure execution and an "L1 vs L2" split does not mean "posting vs execution" there. On the
**OP Stack** the data fee is a separate wei charge at the L1 gas price.

## Methods

- **Bootstrap CIs on medians.** 10,000 percentile resamples, fixed seed (`BOOTSTRAP_SEED`)
  so a rerun reproduces the same interval — a CI that moves between runs cannot be checked
  by a reviewer. Half-width as a fraction of the median is reported, the quantity §10 sizes
  *n* against.
- **Mann-Whitney U**, two-sided, with average ranks for ties and a tie-corrected normal
  approximation. Reported with the common-language effect size P(A > B), because a p-value
  alone does not say how large the difference is.
- **Clopper-Pearson** exact binomial intervals. Exact rather than normal-approximation
  because cells are small and observed rates sit at 1.0, where the normal interval runs
  past 100%.
- **No parametric t-tests, anywhere.** Latency is heavy-tailed and *n* is small per cell; a
  t-test would assume away the shape the data actually has.

### Why `nonparametric.py` exists instead of scipy

`scipy.stats` could not be imported in the environment this was written in — its compiled
extension is blocked by a Windows Application Control policy. Rather than ship statistics
that cannot be executed, Mann-Whitney U and Clopper-Pearson are implemented directly and
self-tested against published reference values (`python analysis/nonparametric.py`).

Clopper-Pearson is computed by bisecting the **exact** binomial CDF via `math.comb`, so
there is no numerical approximation in the tail probability. If the policy is lifted,
swapping back to scipy is a two-line change in `stats.py` — but the self-tested local
implementation is arguably preferable for a research artifact, since a reviewer can read it.

## Figure captions

`figures.py` writes the following into every caption automatically, because they are the
things a reader will otherwise get wrong:

- whether the metric is **mixed-clock**, and its **resolution in seconds** — never report
  precision finer than that (§11);
- `n` as **observed/total** per cell;
- for cross-protocol cost figures, that `total_fee_wei` is used and why nothing else would do.
