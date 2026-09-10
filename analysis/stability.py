"""Stress-test the sample-size conclusion.

    python analysis/stability.py --csv data/export.csv

THE PROBLEM THIS EXISTS TO EXPOSE. ``required_n`` resamples the pilot to
estimate what a larger sample would give. That is circular: it can only draw
values the pilot already contains, so a tail the pilot never sampled cannot
appear in any resample. On heavy-tailed latency data this systematically
UNDERSTATES the n required, and it does so silently - the answer looks like a
number rather than a lower bound.

Four diagnostics, none of which the point estimate provides on its own:

1. **Is the target even askable?** If 10% of the median is finer than the clock
   resolution, no sample size delivers it, and a reported half-width below one
   tick claims precision the instrument does not have (BLUEPRINT §11 / I3).
   Checked first, because it makes the other three moot.

2. **Does the estimate track its own input size?** Recompute required_n from the
   first 15, 20 and 25 observations. The circularity signature is the estimate
   being *pinned* at the size it was computed from. An estimate that rises and
   then plateaus below k is measuring something real.

3. **What is the half-width trend?** The observed half-width at n=15, 20, 25, so
   the direction is visible rather than a single number.

4. **How heavy is the tail, and is the sample exchangeable?** max/median and
   p90/median - but a ratio is only meaningful if the absolute spread exceeds a
   couple of clock ticks, since 1s versus 2s is quantisation, not a tail. Plus
   where the extreme values sit in collection order: the bootstrap assumes
   exchangeability, and extremes clustered at the start mean the pilot mixes two
   regimes and resampling treats a systematic difference as random spread.
"""

from __future__ import annotations

import argparse

import numpy as np
import pandas as pd

from load import cell_key, load_export
from stats import BOOTSTRAP_SEED, MIN_BOOTSTRAP_N, median_ci, required_n

#: Prefix sizes to re-estimate from. The point is the TREND across them.
SUBSET_SIZES = [15, 20, 25]

#: max/median at or above this MAY indicate a tail - but only if the absolute
#: spread is also material. A ratio of 2.0 between a 1s median and a 2s max is
#: quantisation.
TAIL_RATIO_WARN = 2.0

#: Absolute spread below this many clock ticks is quantisation, whatever the ratio.
TAIL_RESOLUTION_UNITS = 2.0

TARGET = 0.10


def _ordered_metric(grp: pd.DataFrame, metric: str) -> pd.Series:
    """Metric values in submission order.

    "First 15 runs" needs a defined order, and it must be the order they were
    collected in - taking the first 15 of an arbitrary sort would manufacture a
    subset that never existed.
    """
    return grp.sort_values("submitted_at")[metric].dropna()


def analyse_cell(cell: str, grp: pd.DataFrame, metric: str) -> dict:
    series = _ordered_metric(grp, metric)
    x = series.to_numpy(dtype=float)
    out: dict = {"cell": cell, "metric": metric, "n": int(x.size)}
    if x.size == 0:
        out["note"] = "no observations"
        return out

    med = float(np.median(x))
    out["median"] = med
    out["min"] = float(x.min())
    out["max"] = float(x.max())
    out["max_over_median"] = float(x.max() / med) if med else None
    out["p90_over_median"] = float(np.quantile(x, 0.90) / med) if med else None

    res_col = f"{metric}_resolution_sec"
    resolutions = sorted({float(r) for r in grp[res_col].dropna()}) if res_col in grp.columns else []
    out["resolution"] = max(resolutions) if resolutions else None

    if out["resolution"]:
        out["target_abs"] = TARGET * med
        out["target_below_resolution"] = out["target_abs"] < out["resolution"]

    rows = []
    for k in SUBSET_SIZES:
        if x.size < k:
            rows.append({"k": k, "available": False})
            continue
        prefix = pd.Series(x[:k])
        ci = median_ci(prefix)
        rn = required_n(prefix, target=TARGET)
        rows.append(
            {
                "k": k,
                "available": True,
                "half_width_frac": ci.half_width_frac,
                "median": ci.median,
                "required_n": rn.achieved,
            }
        )
    out["prefixes"] = rows

    half = x.size // 2
    out["first_half_median"] = float(np.median(x[:half]))
    out["second_half_median"] = float(np.median(x[half:]))
    out["first_half_iqr"] = float(np.subtract(*np.percentile(x[:half], [75, 25])))
    out["second_half_iqr"] = float(np.subtract(*np.percentile(x[half:], [75, 25])))
    k_extreme = min(4, max(1, x.size // 6))
    positions = [int(p) + 1 for p in np.argsort(x)[:k_extreme]]
    out["lowest_positions"] = sorted(positions)
    out["extremes_cluster_early"] = bool(max(positions) <= x.size * 0.4)

    if x.size > MIN_BOOTSTRAP_N:
        without_max = np.delete(x, int(np.argmax(x)))
        out["hw_full"] = median_ci(pd.Series(x)).half_width_frac
        out["hw_without_max"] = median_ci(pd.Series(without_max)).half_width_frac
        out["required_n_without_max"] = required_n(pd.Series(without_max), target=TARGET).achieved

    return out


def verdict(res: dict) -> tuple[str, str]:
    """Does the 'n=25 suffices' conclusion hold for this cell?"""
    prefixes = [p for p in res.get("prefixes", []) if p.get("available")]
    if len(prefixes) < 2:
        return "INSUFFICIENT", "not enough data to test stability"

    # Asked first: if the target is finer than the clock, no n answers it and
    # the remaining diagnostics are beside the point.
    if res.get("target_below_resolution"):
        return (
            "ILL-POSED",
            f"+/-10% of the median is {res['target_abs']:.1f}s, finer than the "
            f"{res['resolution']:g}s clock resolution - no n delivers it, and a half-width "
            f"below one tick would claim precision the clock does not have",
        )

    req = [p["required_n"] for p in prefixes if p["required_n"] is not None]
    ks = [p["k"] for p in prefixes if p["required_n"] is not None]
    if not req:
        return "FRAGILE", "required_n could not be estimated from any prefix"

    # True circularity is the estimate being PINNED at the size it came from.
    if req[-1] >= 0.9 * ks[-1] and len(set(req)) > 1:
        return "FRAGILE", f"required_n {req} is pinned at the subset sizes {ks} - returning its own input"

    if max(req) - min(req) > max(req) * 0.5:
        return "FRAGILE", f"required_n unstable across prefixes ({req})"

    tail = res.get("max_over_median") or 1.0
    resolution = res.get("resolution")
    spread_abs = (res.get("max") or 0.0) - (res.get("median") or 0.0)
    material = resolution is None or spread_abs >= TAIL_RESOLUTION_UNITS * resolution
    if tail >= TAIL_RATIO_WARN:
        if material:
            return "GUARDED", f"stable, but max/median = {tail:.2f} over {spread_abs:,.1f}s suggests an under-sampled tail"
        return "HOLDS", (
            f"required_n stable at {req}; max/median = {tail:.2f} is quantisation "
            f"({spread_abs:,.1f}s at {resolution:g}s resolution), not a tail"
        )
    if res.get("extremes_cluster_early"):
        return "GUARDED", (
            f"required_n stable at {req}, but the lowest values sit at positions "
            f"{res['lowest_positions']} of {res['n']} - the sample may not be exchangeable"
        )
    return "HOLDS", f"required_n stable at {req} across prefixes {ks}, and the tail is light"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default="data/export.csv")
    args = ap.parse_args()
    df = load_export(args.csv)
    df["cell"] = cell_key(df)

    print(f"\nSample-size stability check - {args.csv}")
    print(f"bootstrap seed {BOOTSTRAP_SEED}, target half-width +/-{TARGET:.0%} of median\n")

    verdicts = []
    for cell, grp in df.groupby("cell"):
        metric = "M_L2" if grp["path"].iloc[0] == "forced" else "M_L4"
        res = analyse_cell(cell, grp, metric)
        if "median" not in res:
            print(f"{cell}: {res.get('note')}")
            continue

        resn = res.get("resolution")
        spread_abs = res["max"] - res["median"]
        print("=" * 78)
        print(f"{cell}   metric {metric}   n={res['n']}")
        print("=" * 78)
        print(f"  median {res['median']:,.1f}s   min {res['min']:,.1f}s   max {res['max']:,.1f}s")
        print(f"  TAIL   max/median {res['max_over_median']:.2f}x   p90/median {res['p90_over_median']:.2f}x")
        if resn:
            print(f"         max - median = {spread_abs:,.1f}s = {spread_abs / resn:.1f} clock ticks ({resn:g}s resolution)")
            flag = "   <-- FINER THAN THE CLOCK" if res.get("target_below_resolution") else ""
            print(f"  TARGET +/-10% of median = {res['target_abs']:,.1f}s vs {resn:g}s resolution{flag}")
        print(
            f"  ORDER  first-half median {res['first_half_median']:,.1f} (IQR {res['first_half_iqr']:,.1f})"
            f"   second-half median {res['second_half_median']:,.1f} (IQR {res['second_half_iqr']:,.1f})"
        )
        early = "   <-- clustered early" if res.get("extremes_cluster_early") else ""
        print(f"         lowest values at positions {res['lowest_positions']} of {res['n']}{early}")

        print("\n  Half-width and required_n by prefix size:")
        print(f"    {'k':>4}  {'median':>10}  {'half-width':>11}  {'required_n':>11}")
        for p in res["prefixes"]:
            if not p["available"]:
                print(f"    {p['k']:>4}  {'-':>10}  {'-':>11}  {'-':>11}   (n < k)")
                continue
            hw = "n/a" if p["half_width_frac"] is None else f"{p['half_width_frac']:.2%}"
            rn = "not reached" if p["required_n"] is None else str(p["required_n"])
            print(f"    {p['k']:>4}  {p['median']:>10,.1f}  {hw:>11}  {rn:>11}")

        if "hw_without_max" in res:
            hwf = "n/a" if res["hw_full"] is None else f"{res['hw_full']:.2%}"
            hwd = "n/a" if res["hw_without_max"] is None else f"{res['hw_without_max']:.2%}"
            print(f"\n  Drop the single largest observation: half-width {hwf} -> {hwd}, required_n -> {res['required_n_without_max']}")

        v, why = verdict(res)
        verdicts.append((cell, v, why))
        print(f"\n  VERDICT: {v} - {why}\n")

    print("=" * 78)
    print("SUMMARY")
    print("=" * 78)
    for cell, v, why in verdicts:
        print(f"  {cell:<26} {v}")
        print(f"  {'':<26} {why}")


if __name__ == "__main__":
    main()
