"""Every statistic the paper needs, printed with its denominator.

    python analysis/report.py --csv data/export.csv

Produces per-cell bootstrap CIs on medians, Mann-Whitney comparisons, binomial
CIs on success rates, and a within-protocol cost decomposition.

The invariant this file exists to protect: **n_total and n_used are always
printed together**. A run whose tracking was interrupted exports a null
latency, so the number of rows in a cell and the number contributing to a given
statistic are different numbers. An analysis that quietly reports only the
second has changed its denominator without saying so, and success/failure rates
computed that way are wrong in the flattering direction.
"""

from __future__ import annotations

import argparse
from decimal import Decimal

import pandas as pd

from load import (
    CROSS_PROTOCOL_COST_COLUMN,
    LATENCY_METRICS,
    PROTOCOL_SPECIFIC_COST_COLUMNS,
    cell_key,
    check_companions,
    companions,
    load_export,
)
from stats import binomial_ci, decompose_costs, mann_whitney, median_ci, median_wei

WEI_PER_ETH = Decimal(10**18)
RULE = "=" * 78


def _eth(wei: int | None) -> str:
    return "n/a" if wei is None else f"{Decimal(wei) / WEI_PER_ETH:.12f} ETH ({wei} wei)"


def section(title: str) -> None:
    print(f"\n{RULE}\n{title}\n{RULE}")


def report_coverage(df: pd.DataFrame) -> None:
    section("COVERAGE - read this before any number below")
    print(f"  rows in export            : {len(df)}")
    by_outcome = df["outcome"].value_counts().to_dict()
    print(f"  by outcome                : {by_outcome}")
    if "is_complete" in df.columns:
        incomplete = int((df["is_complete"] == 0).sum())
        print(f"  incomplete lifecycles     : {incomplete}")
        if incomplete:
            print("    -> these rows have NULL latencies and are counted in n_total, never dropped")
    for metric in LATENCY_METRICS:
        if metric in df.columns:
            print(f"  {metric:<6} observed            : {int(df[metric].notna().sum())}/{len(df)}")

    problems = check_companions(df)
    if problems:
        print("\n  !! MALFORMED EXPORT - missing clock companion columns:")
        for p in problems:
            print(f"     {p}")
    else:
        print("  clock companions          : present for every latency metric")


def report_latencies(df: pd.DataFrame) -> None:
    section("LATENCY - bootstrap CI on the median, per cell")
    print("  BLUEPRINT section 10 targets a half-width below 10% of the median.\n")
    df = df.copy()
    df["cell"] = cell_key(df)
    for metric in LATENCY_METRICS:
        if metric not in df.columns or df[metric].notna().sum() == 0:
            continue
        mixed_col, res_col = companions(metric)
        print(f"  {metric}")
        for cell, grp in df.groupby("cell"):
            ci = median_ci(grp[metric], n_total=len(grp))
            if ci.n_used == 0:
                print(f"    {cell:<28} no observations (n_total={ci.n_total})")
                continue
            obs = grp[grp[metric].notna()]
            mixed = "MIXED-CLOCK" if bool(obs[mixed_col].max() == 1) else "single-clock"
            res = sorted({float(v) for v in obs[res_col].dropna().tolist()})
            print(f"    {cell:<28} {ci}")
            print(f"    {'':<28} {mixed}, resolution {'/'.join(f'{r:g}' for r in res)}s")
        print()


def report_costs(df: pd.DataFrame) -> None:
    section("COST - bootstrap CI on median total_fee_wei, per cell")
    print("  total_fee_wei is the ONLY cross-protocol comparable cost figure.")
    print("  Totals are comparable; decompositions are not.\n")
    df = df.copy()
    df["cell"] = cell_key(df)
    for cell, grp in df.groupby("cell"):
        n_total = len(grp)
        used = grp[grp[CROSS_PROTOCOL_COST_COLUMN].notna()]
        med = median_wei(used[CROSS_PROTOCOL_COST_COLUMN]) if len(used) else None
        print(f"  {cell:<28} n_used={len(used)}/{n_total}  median {_eth(med)}")
        if len(used) >= 2:
            eth = used[CROSS_PROTOCOL_COST_COLUMN].map(lambda v: float(Decimal(v) / WEI_PER_ETH))
            print(f"  {'':<28} {median_ci(eth, n_total=n_total)}  (ETH)")


def report_decomposition(df: pd.DataFrame) -> None:
    section("COST DECOMPOSITION - within protocol only")
    print("  Comparing only totals hides WHY a path costs what it does.")
    print("  The components are NOT like-for-like across protocols - see caveats.\n")
    df = df.copy()
    df["cell"] = cell_key(df)
    for (cell, protocol), grp in df.groupby(["cell", "protocol"]):
        if grp["path"].iloc[0] != "forced":
            continue
        d = decompose_costs(grp, cell, protocol)
        print(f"  {cell}  ({protocol})   n_used={d.n_used}/{d.n_total}")
        print(f"    median total : {_eth(d.median_total_wei)}")
        for label, val in d.components.items():
            share = d.shares.get(label)
            pct = "" if share is None else f"   {share:6.1%} of total"
            print(f"    {label:<44} {'n/a' if val is None else f'{val:>22,}'}{pct}")
        for c in d.caveats:
            print(f"    CAVEAT: {c}")
        print()


def report_reliability(df: pd.DataFrame) -> None:
    section("RELIABILITY - success rate with exact binomial CI, per cell")
    print("  Denominator is EVERY run in the cell, including timeouts and")
    print("  incomplete lifecycles. That is the point of M-R1..M-R3.\n")
    df = df.copy()
    df["cell"] = cell_key(df)
    for cell, grp in df.groupby("cell"):
        n = len(grp)
        succ = int((grp["outcome"] == "success").sum())
        print(f"  {cell:<28} success {binomial_ci(succ, n)}")
        other = grp[grp["outcome"] != "success"]["outcome"].value_counts().to_dict()
        if other:
            print(f"  {'':<28} non-success: {other}")


def report_tests(df: pd.DataFrame) -> None:
    section("HYPOTHESIS TESTS - Mann-Whitney U, two-sided")
    print("  Nonparametric throughout: latency is heavy-tailed and n is small,")
    print("  so a t-test would assume away the shape the data actually has.\n")

    print("  Normal vs forced, within each chain (M_L4 vs M_L3):")
    for chain, grp in df.groupby("chain_key"):
        normal = grp[grp["path"] == "normal"]
        forced = grp[grp["path"] == "forced"]
        if normal.empty or forced.empty:
            print(f"    {chain:<16} needs both paths present")
            continue
        rt = mann_whitney(normal["M_L4"], forced["M_L3"], len(normal), len(forced))
        print(f"    {chain:<16} {rt}")

    print("\n  Cross-protocol M_L2 (L1 inclusion -> L2 appearance):")
    print("    The one metric both protocols genuinely have - BLUEPRINT section 17.3.")
    forced = df[df["path"] == "forced"]
    chains = sorted(forced["chain_key"].unique())
    for i in range(len(chains)):
        for j in range(i + 1, len(chains)):
            a = forced[forced["chain_key"] == chains[i]]
            b = forced[forced["chain_key"] == chains[j]]
            rt = mann_whitney(a["M_L2"], b["M_L2"], len(a), len(b))
            print(f"    {chains[i]} vs {chains[j]}: {rt}")


def report_usability(df: pd.DataFrame) -> None:
    section("M-U1 - user-initiated L1 transactions")
    print("  Counted from what was actually sent, not from protocol design.\n")
    df = df.copy()
    df["cell"] = cell_key(df)
    for cell, grp in df.groupby("cell"):
        # int() so numpy scalars do not leak their repr into the report.
        counts = {int(k): int(v) for k, v in grp["M_U1"].value_counts().sort_index().to_dict().items()}
        print(f"  {cell:<28} {counts}  (n={len(grp)})")
    if "inclusion_path" in df.columns:
        ip = df[df["inclusion_path"].notna()]
        if not ip.empty:
            print("\n  Arbitrum inclusion path (auto = sequencer read it voluntarily):")
            for cell, grp in ip.groupby("cell"):
                print(f"    {cell:<26} {grp['inclusion_path'].value_counts().to_dict()}")
            print("    NOTE: 'auto' is NOT censorship recovery. On a healthy public testnet")
            print("    the force leg is unreachable (BLUEPRINT 20.1), so E2 measures the")
            print("    auto-inclusion leg only.")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default="data/export.csv")
    args = ap.parse_args()
    df = load_export(args.csv)

    print(f"\nEscape-hatch dataset analysis - {args.csv}")
    report_coverage(df)
    report_latencies(df)
    report_costs(df)
    report_decomposition(df)
    report_reliability(df)
    report_tests(df)
    report_usability(df)
    print()


if __name__ == "__main__":
    main()
