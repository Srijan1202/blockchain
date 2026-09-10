"""Figures for the escape-hatch paper.

Every figure regenerates from export.csv alone - no intermediate state, no
manual steps. Run::

    python analysis/figures.py --csv data/export.csv --out analysis/figures

Two captioning rules are enforced in code rather than left to the writer:

* Any mixed-clock metric says so in its caption, together with its resolution.
  BLUEPRINT section 11 forbids claiming precision finer than the coarsest clock
  involved, and a figure without that note invites exactly that mistake.
* Any cross-protocol cost comparison states that it uses ``total_fee_wei`` and
  why nothing else would do.
"""

from __future__ import annotations

import argparse
from decimal import Decimal
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless: figures are artifacts, not an interactive session
import matplotlib.pyplot as plt
import numpy as np

from load import CROSS_PROTOCOL_COST_COLUMN, LATENCY_METRICS, cell_key, companions, load_export
from stats import median_ci, median_wei

WEI_PER_ETH = Decimal(10**18)


def _clock_note(df, metric: str) -> str:
    """Caption fragment recording the clock discipline for this metric."""
    mixed_col, res_col = companions(metric)
    if mixed_col not in df.columns or res_col not in df.columns:
        return ""
    sub = df[df[metric].notna()]
    if sub.empty:
        return ""
    mixed = bool(sub[mixed_col].max() == 1)
    res = sorted({float(v) for v in sub[res_col].dropna().tolist()})
    res_txt = "/".join(f"{r:g}" for r in res)
    if mixed:
        return f"MIXED-CLOCK metric; resolution {res_txt}s - do not read precision finer than this."
    return f"Single-clock; resolution {res_txt}s - do not read precision finer than this."


def ecdf_figure(df, metric: str, out_dir: Path) -> Path | None:
    """ECDF of a latency metric, one curve per cell.

    An ECDF rather than a histogram or a box plot: it shows the whole
    distribution including the tail, needs no bin choice, and does not imply
    symmetry the way a box plot's whiskers do.
    """
    sub = df[df[metric].notna()].copy()
    if sub.empty:
        return None
    sub["cell"] = cell_key(sub)

    fig, ax = plt.subplots(figsize=(7.5, 4.5))
    for cell, grp in sub.groupby("cell"):
        x = np.sort(grp[metric].astype(float).to_numpy())
        y = np.arange(1, x.size + 1) / x.size
        n_total = int((cell_key(df) == cell).sum())
        ax.step(x, y, where="post", label=f"{cell}  (n={x.size}/{n_total})")

    ax.set_xlabel(f"{metric} (seconds)")
    ax.set_ylabel("cumulative proportion")
    ax.set_ylim(0, 1.02)
    ax.grid(alpha=0.3)
    ax.legend(fontsize=8, loc="lower right")
    ax.set_title(f"{metric}: empirical CDF by cell")
    fig.text(
        0.01,
        -0.02,
        f"n shown as observed/total per cell - runs with incomplete lifecycles export a null "
        f"{metric} and are counted in the denominator. {_clock_note(df, metric)}",
        fontsize=7,
        wrap=True,
        va="top",
    )
    out = out_dir / f"ecdf_{metric}.png"
    fig.savefig(out, dpi=150, bbox_inches="tight")
    plt.close(fig)
    return out


def cost_comparison_figure(df, out_dir: Path) -> Path | None:
    """Cross-protocol cost comparison, with bootstrap CIs.

    Uses ``total_fee_wei`` and nothing else. The per-protocol cost columns
    measure different quantities in different units (see migration 003), so a
    figure that placed them side by side would be comparing a wei fee against a
    gas allocation.
    """
    sub = df[df[CROSS_PROTOCOL_COST_COLUMN].notna()].copy()
    if sub.empty:
        return None
    sub["cell"] = cell_key(sub)

    cells, meds, los, his, ns = [], [], [], [], []
    for cell, grp in sub.groupby("cell"):
        med = median_wei(grp[CROSS_PROTOCOL_COST_COLUMN])
        if med is None:
            continue
        # Bootstrap in ETH: the CI is a display quantity, and the exact integer
        # median is carried separately. Converting first keeps the resample
        # arithmetic in a range float64 represents faithfully.
        eth = grp[CROSS_PROTOCOL_COST_COLUMN].map(lambda v: float(Decimal(v) / WEI_PER_ETH))
        ci = median_ci(eth, n_total=int((cell_key(df) == cell).sum()))
        cells.append(cell)
        meds.append(float(Decimal(med) / WEI_PER_ETH))
        los.append(ci.lo if ci.lo is not None else float("nan"))
        his.append(ci.hi if ci.hi is not None else float("nan"))
        ns.append((ci.n_used, ci.n_total))

    if not cells:
        return None
    y = np.arange(len(cells))
    lo_err = [max(0.0, m - l) for m, l in zip(meds, los)]
    hi_err = [max(0.0, h - m) for m, h in zip(meds, his)]

    fig, ax = plt.subplots(figsize=(8, 0.7 * len(cells) + 2.6))
    ax.errorbar(meds, y, xerr=[lo_err, hi_err], fmt="o", capsize=4)
    ax.set_yticks(y)
    ax.set_yticklabels([f"{c}\n(n={a}/{b})" for c, (a, b) in zip(cells, ns)], fontsize=8)
    ax.set_xlabel("total_fee_wei (ETH)")
    ax.grid(alpha=0.3, axis="x")
    ax.set_title("Total cost per transaction, median with 95% bootstrap CI")
    fig.text(
        0.01,
        -0.02,
        "Uses total_fee_wei, the ONLY cross-protocol comparable cost figure: it is everything "
        "the transaction cost the user. The per-protocol columns are not comparable - OP Stack's "
        "l1Fee is a fee in wei at the L1 gas price, Arbitrum's gasUsedForL1 is an L2 gas "
        "allocation at the L2 gas price - so they are deliberately absent from this figure. "
        "Totals compare; decompositions do not.",
        fontsize=7,
        wrap=True,
        va="top",
    )
    out = out_dir / "cost_comparison.png"
    fig.savefig(out, dpi=150, bbox_inches="tight")
    plt.close(fig)
    return out


def cost_decomposition_figure(df, out_dir: Path) -> Path | None:
    """Where the cost goes, WITHIN each protocol.

    Stacked within a cell, never across protocols, because the components are
    not like-for-like between them. This is the figure that shows the forced
    path's premium is an L1 gas cost rather than an L2 one.
    """
    sub = df[(df["path"] == "forced") & (df["total_fee_wei"].notna())].copy()
    if sub.empty:
        return None
    sub["cell"] = cell_key(sub)

    cells, l1s, l2s = [], [], []
    for cell, grp in sub.groupby("cell"):
        m_c1 = median_wei(grp["M_C1"]) or 0
        m_c3 = median_wei(grp["M_C3"]) or 0
        cells.append(cell)
        l1s.append(float(Decimal(m_c1) / WEI_PER_ETH))
        l2s.append(float(Decimal(m_c3) / WEI_PER_ETH))

    y = np.arange(len(cells))
    fig, ax = plt.subplots(figsize=(8, 0.7 * len(cells) + 2.8))
    ax.barh(y, l1s, label="M_C1  L1 submission")
    ax.barh(y, l2s, left=l1s, label="M_C3  L2 transaction")
    ax.set_yticks(y)
    ax.set_yticklabels(cells, fontsize=8)
    ax.set_xlabel("median cost (ETH)")
    ax.legend(fontsize=8)
    ax.grid(alpha=0.3, axis="x")
    ax.set_title("Forced-path cost decomposition (within protocol only)")
    fig.text(
        0.01,
        -0.02,
        "Components are stacked WITHIN a protocol and must not be compared across them. "
        "On Arbitrum, M_C3 already contains its data-availability share (gasUsedForL1 is L2 gas "
        "inside l2_gas_used), so the L2 bar is not pure execution. On the OP Stack the data fee "
        "is charged separately at the L1 gas price and sits inside total_fee_wei. "
        "Only total_fee_wei is comparable between protocols.",
        fontsize=7,
        wrap=True,
        va="top",
    )
    out = out_dir / "cost_decomposition.png"
    fig.savefig(out, dpi=150, bbox_inches="tight")
    plt.close(fig)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Regenerate every figure from export.csv alone.")
    ap.add_argument("--csv", default="data/export.csv")
    ap.add_argument("--out", default="analysis/figures")
    args = ap.parse_args()

    df = load_export(args.csv)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    written: list[Path] = []
    for metric in LATENCY_METRICS:
        p = ecdf_figure(df, metric, out_dir)
        if p:
            written.append(p)
    for fn in (cost_comparison_figure, cost_decomposition_figure):
        p = fn(df, out_dir)
        if p:
            written.append(p)

    for p in written:
        print(f"wrote {p}")
    if not written:
        print("no figures written - the dataset has no rows with the required columns")


if __name__ == "__main__":
    main()
