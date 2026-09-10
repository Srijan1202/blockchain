"""Mann-Whitney U and Clopper-Pearson intervals, without scipy.

WHY THIS FILE EXISTS. scipy.stats cannot be imported in this environment -
``scipy.special._ufuncs`` is blocked by a Windows Application Control policy -
so the two scipy functions the analysis needs are implemented here instead.
Both are short, standard, and self-tested against published reference values at
the bottom of this file, which for a research artifact is arguably better than
an opaque dependency: a reviewer can read the test.

If the policy is lifted, swapping back is a two-line change in stats.py.

Neither implementation is novel:

* ``mann_whitney_u`` - rank-sum with average ranks for ties, normal
  approximation with continuity and tie correction. This is what scipy itself
  uses for samples this size (method='asymptotic'), and is the standard choice
  above roughly n=20 per group where exact enumeration is infeasible.
* ``clopper_pearson`` - the EXACT interval, obtained by bisecting the binomial
  CDF rather than by calling an incomplete-beta routine. n here is at most a few
  hundred, so the CDF is summed exactly with ``math.comb`` and there is no
  numerical approximation in the tail probability at all.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


# ---------------------------------------------------------------------------
# Mann-Whitney U
# ---------------------------------------------------------------------------


def _average_ranks(values: list[float]) -> list[float]:
    """Ranks, with ties receiving the average of the positions they span."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        avg = (i + j + 2) / 2.0  # positions are 1-based
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def _normal_sf(z: float) -> float:
    """Upper-tail probability of the standard normal."""
    return 0.5 * math.erfc(z / math.sqrt(2.0))


@dataclass
class UResult:
    u: float
    p: float
    z: float


def mann_whitney_u(a: list[float], b: list[float]) -> UResult:
    """Two-sided Mann-Whitney U.

    Returns U for sample ``a``. ``U_a + U_b == n_a * n_b`` always holds, which
    the self-test checks.
    """
    n_a, n_b = len(a), len(b)
    if n_a == 0 or n_b == 0:
        raise ValueError("both samples must be non-empty")

    ranks = _average_ranks(list(a) + list(b))
    rank_sum_a = sum(ranks[:n_a])
    u_a = rank_sum_a - n_a * (n_a + 1) / 2.0

    mu = n_a * n_b / 2.0
    n = n_a + n_b

    # Tie correction: without it the variance is overstated and p is too large.
    counts: dict[float, int] = {}
    for v in list(a) + list(b):
        counts[v] = counts.get(v, 0) + 1
    tie_term = sum(t**3 - t for t in counts.values())
    var = (n_a * n_b / 12.0) * ((n + 1) - tie_term / (n * (n - 1))) if n > 1 else 0.0

    if var <= 0:
        return UResult(u_a, 1.0, 0.0)

    # Continuity correction toward the mean.
    diff = abs(u_a - mu)
    z = (diff - 0.5) / math.sqrt(var)
    if z < 0:
        z = 0.0
    return UResult(u_a, min(1.0, 2.0 * _normal_sf(z)), z)


# ---------------------------------------------------------------------------
# Clopper-Pearson
# ---------------------------------------------------------------------------


def _binom_cdf(k: int, n: int, p: float) -> float:
    """P(X <= k). Exact summation; n is small here."""
    if p <= 0.0:
        return 1.0
    if p >= 1.0:
        return 1.0 if k >= n else 0.0
    return sum(math.comb(n, i) * p**i * (1.0 - p) ** (n - i) for i in range(0, k + 1))


def _bisect(f, lo: float, hi: float, target: float, increasing: bool, iters: int = 200) -> float:
    """Solve ``f(p) = target`` on ``[lo, hi]``.

    ``increasing`` must state which way f runs. Getting it wrong does not error,
    it silently returns an endpoint - which is exactly what happened the first
    time this was written, and is why the self-test checks both bounds against
    published values rather than only the upper one.
    """
    for _ in range(iters):
        mid = (lo + hi) / 2.0
        too_big = f(mid) > target
        if too_big == increasing:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2.0


def clopper_pearson(k: int, n: int, confidence: float = 0.95) -> tuple[float, float]:
    """Exact binomial confidence interval.

    Chosen over the normal approximation because cells here are small and
    observed rates sit at or near 1.0, where the normal interval runs past 100%
    and reports an impossible upper bound. BLUEPRINT section 10 asks for a
    binomial CI for exactly this reason.
    """
    if n == 0:
        return 0.0, 1.0
    alpha = 1.0 - confidence

    # Lower: p such that P(X >= k) = alpha/2, i.e. 1 - CDF(k-1) = alpha/2.
    if k == 0:
        lo = 0.0
    else:
        # P(X >= k) INCREASES in p.
        lo = _bisect(lambda p: 1.0 - _binom_cdf(k - 1, n, p), 0.0, 1.0, alpha / 2.0, increasing=True)

    # Upper: p such that P(X <= k) = alpha/2. CDF decreases in p.
    if k == n:
        hi = 1.0
    else:
        # P(X <= k) DECREASES in p.
        hi = _bisect(lambda p: _binom_cdf(k, n, p), 0.0, 1.0, alpha / 2.0, increasing=False)

    return lo, hi


# ---------------------------------------------------------------------------
# Self-test. Run: python analysis/nonparametric.py
# ---------------------------------------------------------------------------


def _selftest() -> int:
    failures = 0

    def check(label: str, ok: bool, detail: str = "") -> None:
        nonlocal failures
        print(f"  [{'PASS' if ok else 'FAIL'}] {label}{'  -> ' + detail if detail else ''}")
        if not ok:
            failures += 1

    print("=== Clopper-Pearson against published reference values ===")
    # Standard textbook values for 95% two-sided intervals.
    lo, hi = clopper_pearson(0, 10)
    check("0/10 -> [0, 0.3085]", abs(lo - 0.0) < 1e-9 and abs(hi - 0.30850) < 1e-4, f"[{lo:.5f}, {hi:.5f}]")
    lo, hi = clopper_pearson(10, 10)
    check("10/10 -> [0.6915, 1]", abs(lo - 0.69150) < 1e-4 and abs(hi - 1.0) < 1e-9, f"[{lo:.5f}, {hi:.5f}]")
    lo, hi = clopper_pearson(5, 10)
    check("5/10 -> [0.1871, 0.8129]", abs(lo - 0.18709) < 1e-4 and abs(hi - 0.81291) < 1e-4, f"[{lo:.5f}, {hi:.5f}]")
    lo, hi = clopper_pearson(25, 25)
    check("25/25 upper bound is exactly 1", hi == 1.0, f"[{lo:.5f}, {hi:.5f}]")
    check("25/25 lower bound is below 1", lo < 1.0, f"lo={lo:.5f}")

    print("\n=== Mann-Whitney U ===")
    a = [1.0, 2.0, 3.0, 4.0, 5.0]
    b = [6.0, 7.0, 8.0, 9.0, 10.0]
    r = mann_whitney_u(a, b)
    check("fully separated samples give U=0", r.u == 0.0, f"U={r.u}")
    r2 = mann_whitney_u(b, a)
    check("U_a + U_b == n_a*n_b", r.u + r2.u == len(a) * len(b), f"{r.u} + {r2.u} = {r.u + r2.u}")
    same = mann_whitney_u([1.0, 2.0, 3.0, 4.0], [1.0, 2.0, 3.0, 4.0])
    check("identical samples give p == 1", abs(same.p - 1.0) < 1e-9, f"p={same.p:.4f}")
    check("identical samples give U = n_a*n_b/2", same.u == 8.0, f"U={same.u}")
    ties = mann_whitney_u([1.0, 1.0, 2.0], [1.0, 3.0, 3.0])
    check("ties handled without error", 0.0 <= ties.p <= 1.0, f"p={ties.p:.4f}")
    big_a = [float(i) for i in range(25)]
    big_b = [float(i) + 100 for i in range(25)]
    r3 = mann_whitney_u(big_a, big_b)
    check("clearly different groups give small p", r3.p < 1e-6, f"p={r3.p:.3g}")

    print(f"\n=== {'ALL PASS' if failures == 0 else f'{failures} FAILURES'} ===")
    return failures


if __name__ == "__main__":
    raise SystemExit(_selftest())
