"""Is each cell's sample exchangeable, or ordered?

    python analysis/drift.py --csv data/export.csv

WHY THIS EXISTS. The bootstrap CIs in this project resample observations as
though collection order carried no information. If a cell drifted during
collection - the sequencer warming up, an L1 fee regime changing, a provider
degrading - then order DOES carry information, the resamples are drawn from a
mixture of regimes, and the interval is estimating something other than what it
claims. The same assumption underpins the "n=25 suffices" sizing conclusion,
which resamples the pilot to predict a larger sample.

The suspicion came from one cell: the four lowest M-L2 values in
arb-sepolia/forced sit at collection positions 1, 2, 4 and 7 of 25, and its
first-half IQR is several times its second-half IQR. But testing only the cell
that looked wrong is how a fishing expedition works, so EVERY cell and EVERY
latency metric is tested here and all results are reported, including the
uninteresting ones.

TWO TESTS, BECAUSE THEY FAIL ON DIFFERENT SHAPES.
  Spearman rho of value against collection index catches a MONOTONE trend.
  Wald-Wolfowitz runs against the median catches REGIME CHANGE - an early fast
  phase and a later slow one - which can leave rho near zero while the sample
  is plainly not exchangeable.
A sample needs to pass both to be treated as exchangeable.

Stdlib only, like the other checks here: the estimators live in
nonparametric.py, Spearman's p-value is a seeded permutation test, and the runs
null is enumerated exactly rather than normal-approximated.
"""

from __future__ import annotations

import argparse
import csv
import statistics
from collections import defaultdict

from nonparametric import PERMUTATION_SEED, runs_test, spearman_rho

RULE = "=" * 78

#: Which metric each path's headline latency is. Others are reported too.
METRICS = ["M_L1", "M_L2", "M_L3", "M_L4"]

#: Below this, flag. Not a decision threshold - the numbers are reported either
#: way - but a reader needs a marker for where to look.
ALPHA = 0.05


def load(path: str) -> dict[tuple[str, str], list[dict[str, str]]]:
    with open(path, newline="") as fh:
        rows = list(csv.DictReader(fh))
    cells: dict[tuple[str, str], list[dict[str, str]]] = defaultdict(list)
    for r in rows:
        cells[(r["chain_key"], r["path"])].append(r)
    # Collection order, not an arbitrary sort: "position 1" must mean the run
    # that was submitted first, or the whole question is meaningless.
    for k in cells:
        cells[k].sort(key=lambda r: r["submitted_at"])
    return cells


def series(rows: list[dict[str, str]], metric: str) -> list[float]:
    out = []
    for r in rows:
        v = r.get(metric, "")
        if v:
            try:
                out.append(float(v))
            except ValueError:
                pass
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default="data/export.csv")
    args = ap.parse_args()
    cells = load(args.csv)

    print(f"\nExchangeability check - {args.csv}")
    print(f"Spearman p by permutation (seed {PERMUTATION_SEED}); runs null enumerated exactly.")
    print("Null in both: observations are exchangeable, i.e. collection order carries no information.\n")

    flagged: list[str] = []
    print(RULE)
    print(f"{'cell':<22} {'metric':<7} {'n':>3}  {'rho':>7} {'p_rho':>8}  {'runs':>5} {'exp':>6} {'p_runs':>8}  note")
    print(RULE)

    for cell in sorted(cells):
        for metric in METRICS:
            v = series(cells[cell], metric)
            if len(v) < 4:
                continue
            sp = spearman_rho(v)
            rt = runs_test(v)
            label = f"{cell[0]}/{cell[1]}"
            runs_s = "n/a" if rt.runs is None else str(rt.runs)
            exp_s = "n/a" if rt.expected is None else f"{rt.expected:.1f}"
            prun_s = "n/a" if rt.p is None else f"{rt.p:.4f}"
            note = "" if rt.note == "exact" else rt.note
            mark = ""
            if sp.p < ALPHA:
                mark += " <-DRIFT"
                flagged.append(f"{label} {metric}: Spearman rho={sp.rho:+.3f}, p={sp.p:.4f}")
            if rt.p is not None and rt.p < ALPHA:
                mark += " <-REGIME"
                flagged.append(f"{label} {metric}: runs={rt.runs} vs expected {rt.expected:.1f}, p={rt.p:.4f}")
            print(
                f"{label:<22} {metric:<7} {sp.n:>3}  {sp.rho:>+7.3f} {sp.p:>8.4f}  "
                f"{runs_s:>5} {exp_s:>6} {prun_s:>8}  {note}{mark}"
            )

    print(RULE)
    if flagged:
        print("\nNOT EXCHANGEABLE - these cells violate the assumption the bootstrap CIs rest on:")
        for f in flagged:
            print(f"  {f}")
        print("\n  For a flagged cell the bootstrap CI and the n=25 sizing conclusion both")
        print("  assume an exchangeability the data does not have. Neither is necessarily")
        print("  wrong, but neither is supported by the argument originally given for it.")
    else:
        print("\nNo cell shows drift or regime change at alpha=0.05.")
        print("This does not prove exchangeability - it fails to reject it at n=25, where")
        print("both tests have limited power - but the assumption survives the check.")

    print(f"\n{RULE}")
    print("DESCRIPTIVE CONTEXT (first half vs second half, by collection order)")
    print(RULE)
    for cell in sorted(cells):
        for metric in METRICS:
            v = series(cells[cell], metric)
            if len(v) < 8:
                continue
            h = len(v) // 2
            a, b = v[:h], v[h:]

            def iqr(x: list[float]) -> float:
                q = statistics.quantiles(x, n=4)
                return q[2] - q[0]

            lowest = sorted(range(len(v)), key=lambda i: v[i])[:4]
            print(
                f"  {cell[0]}/{cell[1]:<7} {metric:<6} "
                f"median {statistics.median(a):>8.1f} -> {statistics.median(b):<8.1f} "
                f"IQR {iqr(a):>7.1f} -> {iqr(b):<7.1f} "
                f"4 lowest at positions {sorted(i + 1 for i in lowest)}"
            )
    print()


if __name__ == "__main__":
    main()
