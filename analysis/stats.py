"""Nonparametric statistics for the escape-hatch dataset.

No parametric t-tests anywhere. Inclusion latency is heavy-tailed and n is
small per cell, so a t-test would assume away exactly the shape the data has.
Everything here is a bootstrap, a rank test, or an exact binomial interval.

Every function returns ``n_total`` and ``n_used`` so a caller can always see how
much of the cell the statistic was computed over. See load.coverage for why.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

import numpy as np
import pandas as pd

# scipy.stats is unavailable in this environment (its compiled extension is
# blocked by a Windows Application Control policy), so the two functions the
# analysis needs live in nonparametric.py, self-tested against published
# reference values. Swap these two imports back to scipy if the policy lifts.
from nonparametric import clopper_pearson, mann_whitney_u

#: Fixed so a rerun reproduces the same intervals. Reproducibility is a
#: deliverable; a CI that moves between runs cannot be checked by a reviewer.
BOOTSTRAP_SEED = 20260827
BOOTSTRAP_RESAMPLES = 10_000


@dataclass
class MedianCI:
    """Bootstrap CI on a median."""

    median: float | None
    lo: float | None
    hi: float | None
    n_total: int
    n_used: int
    confidence: float = 0.95
    #: Half-width as a fraction of the median, the quantity BLUEPRINT section 10
    #: sizes n against (target: below 0.10).
    half_width_frac: float | None = None
    note: str = ""

    def _fmt(self, v: float) -> str:
        """Precision that adapts to magnitude.

        A fixed one-decimal format prints an ETH cost of 1e-4 as "0.0", which
        silently turns a real interval into three zeros.
        """
        a = abs(v)
        if a == 0:
            return "0"
        if a >= 100:
            return f"{v:,.1f}"
        if a >= 1:
            return f"{v:,.3f}"
        return f"{v:.3e}"

    def __str__(self) -> str:
        if self.median is None:
            return f"median n/a (n_used={self.n_used}/{self.n_total}) {self.note}".strip()
        hw = "" if self.half_width_frac is None else f", half-width {self.half_width_frac:.1%} of median"
        return (
            f"median {self._fmt(self.median)} [{self._fmt(self.lo)}, {self._fmt(self.hi)}] "
            f"({self.confidence:.0%} CI, n_used={self.n_used}/{self.n_total}{hw})"
        )


@dataclass
class RankTest:
    """Mann-Whitney U, with the effect size that makes it interpretable."""

    u: float | None
    p: float | None
    n_a: int
    n_b: int
    n_a_total: int
    n_b_total: int
    #: Common-language effect size: P(a random draw from A exceeds one from B).
    prob_superior: float | None
    median_a: float | None
    median_b: float | None
    note: str = ""

    def __str__(self) -> str:
        if self.p is None:
            return f"Mann-Whitney n/a ({self.note})"
        return (
            f"U={self.u:,.0f} p={self.p:.4g} "
            f"P(A>B)={self.prob_superior:.3f} "
            f"medians {self.median_a:,.1f} vs {self.median_b:,.1f} "
            f"(n={self.n_a}/{self.n_a_total} vs {self.n_b}/{self.n_b_total})"
        )


@dataclass
class BinomialCI:
    """Clopper-Pearson interval on a rate."""

    successes: int
    n: int
    rate: float | None
    lo: float
    hi: float
    confidence: float = 0.95

    def __str__(self) -> str:
        r = "n/a" if self.rate is None else f"{self.rate:.3f}"
        return f"{self.successes}/{self.n} = {r} [{self.lo:.3f}, {self.hi:.3f}] ({self.confidence:.0%} CI)"


@dataclass
class Decomposition:
    """Where the money actually went, per cell."""

    cell: str
    protocol: str
    n_total: int
    n_used: int
    median_total_wei: int | None
    components: dict[str, int | None] = field(default_factory=dict)
    shares: dict[str, float | None] = field(default_factory=dict)
    caveats: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------


def _clean(series: pd.Series) -> np.ndarray:
    """Drop nulls, return float64 for the *statistic only*.

    Safe here because latencies are small integers. Wei values are handled by
    median_wei below, which stays in exact integers.
    """
    return pd.to_numeric(series, errors="coerce").dropna().to_numpy(dtype=float)


def median_ci(
    series: pd.Series,
    n_total: int | None = None,
    confidence: float = 0.95,
    resamples: int = BOOTSTRAP_RESAMPLES,
) -> MedianCI:
    """Percentile bootstrap CI on the median."""
    total = len(series) if n_total is None else n_total
    x = _clean(series)
    if x.size == 0:
        return MedianCI(None, None, None, total, 0, confidence, None, "no observations")
    if x.size == 1:
        m = float(np.median(x))
        return MedianCI(m, m, m, total, 1, confidence, None, "n=1: interval is the point itself")

    rng = np.random.default_rng(BOOTSTRAP_SEED)
    idx = rng.integers(0, x.size, size=(resamples, x.size))
    meds = np.median(x[idx], axis=1)
    alpha = (1.0 - confidence) / 2.0
    lo, hi = np.quantile(meds, [alpha, 1.0 - alpha])
    m = float(np.median(x))
    hw = None if m == 0 else float((hi - lo) / 2.0 / abs(m))
    return MedianCI(m, float(lo), float(hi), total, int(x.size), confidence, hw)


def median_wei(series: pd.Series) -> int | None:
    """Median of a wei column, computed in exact integers.

    numpy would coerce to float64 and round anything above 2**53, so the median
    is taken by sorting Python ints. For an even count the lower of the two
    central values is returned rather than their mean, because averaging two
    wei values is what reintroduces a float.
    """
    vals = sorted(v for v in series.tolist() if v is not None and not pd.isna(v))
    if not vals:
        return None
    return int(vals[len(vals) // 2]) if len(vals) % 2 else int(vals[len(vals) // 2 - 1])


def mann_whitney(
    a: pd.Series,
    b: pd.Series,
    a_total: int | None = None,
    b_total: int | None = None,
) -> RankTest:
    """Two-sided Mann-Whitney U.

    Chosen over a t-test deliberately: it assumes nothing about the shape of the
    distributions, which matters because inclusion latency is right-skewed and
    the cells are small.
    """
    at = len(a) if a_total is None else a_total
    bt = len(b) if b_total is None else b_total
    xa, xb = _clean(a), _clean(b)
    if xa.size < 2 or xb.size < 2:
        return RankTest(None, None, xa.size, xb.size, at, bt, None, None, None, "need >=2 observations per group")
    res = mann_whitney_u(xa.tolist(), xb.tolist())
    # U / (n_a * n_b) is the common-language effect size.
    prob = float(res.u) / (xa.size * xb.size)
    return RankTest(
        float(res.u),
        float(res.p),
        int(xa.size),
        int(xb.size),
        at,
        bt,
        prob,
        float(np.median(xa)),
        float(np.median(xb)),
    )


def binomial_ci(successes: int, n: int, confidence: float = 0.95) -> BinomialCI:
    """Clopper-Pearson (exact) interval.

    Exact rather than normal-approximation because cells are small and rates sit
    near 1.0, where the normal approximation produces intervals that extend past
    100% - BLUEPRINT section 10 asks for a binomial CI precisely for this case.
    """
    if n == 0:
        return BinomialCI(0, 0, None, 0.0, 1.0, confidence)
    lo, hi = clopper_pearson(successes, n, confidence)
    return BinomialCI(successes, n, successes / n, lo, hi, confidence)


def decompose_costs(df: pd.DataFrame, cell: str, protocol: str) -> Decomposition:
    """Break the cost into its legs, per protocol.

    Comparing only totals hides *why* one protocol costs more, which is the
    interesting part: the forced path's premium is overwhelmingly an L1 gas
    cost, not an L2 execution cost.

    The decomposition is NOT symmetric between protocols, and the asymmetry is
    recorded in ``caveats`` rather than smoothed over:

    * Arbitrum's ``M_C3`` (the L2 fee) ALREADY CONTAINS its data-availability
      share. Nitro recoups the posting cost by charging extra L2 gas, reported
      as ``arb_l1_gas_allocation`` - a subset of ``l2_gas_used``, in gas units,
      priced at the L2 gas price. So "L1 leg + L2 leg" does not split into
      "posting + execution" on Arbitrum, and the L2 leg is not pure execution.
    * The OP Stack charges its data fee SEPARATELY, in wei, at the L1 gas price,
      as ``op_l1_data_fee_wei``.

    Those two quantities are therefore never added together or compared, and
    only ``total_fee_wei`` is used for anything cross-protocol.
    """
    n_total = len(df)
    used = df[df["total_fee_wei"].notna()]
    d = Decomposition(
        cell=cell,
        protocol=protocol,
        n_total=n_total,
        n_used=len(used),
        median_total_wei=median_wei(used["total_fee_wei"]) if len(used) else None,
    )

    for label, col in (("L1 submission (M_C1)", "M_C1"), ("forceInclude (M_C2)", "M_C2"), ("L2 transaction (M_C3)", "M_C3")):
        d.components[label] = median_wei(used[col]) if col in used.columns and len(used) else None

    if protocol == "op-stack":
        d.components["OP L1 data fee"] = (
            median_wei(used["M_C3_op_l1_data_fee_wei"]) if "M_C3_op_l1_data_fee_wei" in used.columns and len(used) else None
        )
        d.caveats.append(
            "OP Stack: the L1 data fee is charged separately, in wei at the L1 gas price, "
            "and is included in total_fee_wei on top of L2 execution."
        )
    elif protocol == "arbitrum-nitro":
        alloc = median_wei(used["M_C3_arb_l1_gas_allocation"]) if "M_C3_arb_l1_gas_allocation" in used.columns and len(used) else None
        d.components["Arbitrum L1 gas allocation (GAS, not wei)"] = alloc
        d.caveats.append(
            "Arbitrum: arb_l1_gas_allocation is an L2 GAS allocation already inside l2_gas_used, "
            "priced at the L2 gas price. It is NOT a wei fee and is NOT comparable with the OP "
            "Stack's l1Fee. M_C3 already contains this share, so the L2 leg is not pure execution."
        )

    total = d.median_total_wei
    if total:
        for label, val in d.components.items():
            # Shares are only meaningful for the wei components.
            if val is None or "GAS, not wei" in label:
                d.shares[label] = None
            else:
                d.shares[label] = float(Decimal(val) / Decimal(total))
    return d
