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
import random
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



# ---------------------------------------------------------------------------
# Order-dependence tests (exchangeability)
# ---------------------------------------------------------------------------

#: Fixed so a rerun reproduces the same permutation p-values. A p-value that
#: moves between runs cannot be checked by a reviewer.
PERMUTATION_SEED = 20260911
PERMUTATIONS = 10_000


@dataclass(frozen=True)
class SpearmanResult:
    rho: float
    p: float
    n: int
    permutations: int


def spearman_rho(values: list[float]) -> SpearmanResult:
    """Rank correlation of a series against its own collection index.

    Tests for DRIFT: if later observations are systematically larger or smaller
    than earlier ones, the sample is ordered rather than exchangeable, and a
    bootstrap CI - which resamples as though order carried no information -
    is estimating the wrong thing.

    The p-value is a two-sided MONTE CARLO PERMUTATION test rather than the
    usual t-approximation. With n=25 the approximation is adequate but not
    exact, and permuting is assumption-free, needs no incomplete-beta routine,
    and is reproducible from a fixed seed. Ties get average ranks.
    """
    n = len(values)
    if n < 3:
        return SpearmanResult(float("nan"), float("nan"), n, 0)

    idx = [float(i) for i in range(n)]

    def rho_of(v: list[float]) -> float:
        rx, ry = _average_ranks(idx), _average_ranks(v)
        mx, my = sum(rx) / n, sum(ry) / n
        num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
        dx = math.sqrt(sum((a - mx) ** 2 for a in rx))
        dy = math.sqrt(sum((b - my) ** 2 for b in ry))
        return 0.0 if dx == 0 or dy == 0 else num / (dx * dy)

    observed = rho_of(values)
    if observed != observed:  # NaN guard
        return SpearmanResult(observed, float("nan"), n, 0)

    rng = random.Random(PERMUTATION_SEED)
    shuffled = list(values)
    at_least = 0
    for _ in range(PERMUTATIONS):
        rng.shuffle(shuffled)
        if abs(rho_of(shuffled)) >= abs(observed) - 1e-12:
            at_least += 1
    # +1/+1 so p is never exactly zero: 10,000 permutations cannot demonstrate
    # a p below 1/10,001.
    p = (at_least + 1) / (PERMUTATIONS + 1)
    return SpearmanResult(observed, p, n, PERMUTATIONS)


@dataclass(frozen=True)
class RunsResult:
    runs: int | None
    n_above: int
    n_below: int
    n_tied: int
    expected: float | None
    p: float | None
    note: str


def runs_test(values: list[float]) -> RunsResult:
    """Wald-Wolfowitz runs test against the median, EXACT.

    Complements Spearman: a monotone drift shows up in rho, but a sample split
    into a fast early phase and a slow later one - two regimes rather than a
    trend - shows up as too FEW runs while rho may stay small.

    Values exactly equal to the median are dropped, which is the standard
    treatment and is reported in `n_tied` because it is not free: these
    latencies are integer-valued and heavily tied, so dropping can leave too
    little to test. When it does, the result says so rather than returning a
    number.

    The null distribution is enumerated exactly with math.comb rather than
    normal-approximated, because after dropping ties the group sizes here are
    around ten and the approximation is poor at that size.
    """
    n = len(values)
    if n < 4:
        return RunsResult(None, 0, 0, 0, None, None, "fewer than 4 observations")

    srt = sorted(values)
    median = srt[n // 2] if n % 2 else (srt[n // 2 - 1] + srt[n // 2]) / 2

    seq = [1 if v > median else (0 if v < median else None) for v in values]
    kept = [x for x in seq if x is not None]
    n_tied = n - len(kept)
    n1 = sum(kept)
    n2 = len(kept) - n1
    if n1 < 2 or n2 < 2:
        return RunsResult(
            None, n1, n2, n_tied, None, None,
            f"not computable: {n_tied} of {n} values sit exactly on the median, leaving {n1} above / {n2} below",
        )

    runs = 1 + sum(1 for a, b in zip(kept, kept[1:]) if a != b)
    total = math.comb(n1 + n2, n1)

    def prob(r: int) -> float:
        if r < 2:
            return 0.0
        if r % 2 == 0:
            s = r // 2
            return 2 * math.comb(n1 - 1, s - 1) * math.comb(n2 - 1, s - 1) / total
        s = (r - 1) // 2
        return (math.comb(n1 - 1, s) * math.comb(n2 - 1, s - 1)
                + math.comb(n1 - 1, s - 1) * math.comb(n2 - 1, s)) / total

    dist = {r: prob(r) for r in range(2, n1 + n2 + 1)}
    observed_p = dist.get(runs, 0.0)
    # Two-sided exact p: total probability of outcomes no more likely than the
    # one observed. Standard for a discrete asymmetric null.
    p = sum(v for v in dist.values() if v <= observed_p + 1e-15)
    expected = 2 * n1 * n2 / (n1 + n2) + 1
    return RunsResult(runs, n1, n2, n_tied, expected, min(1.0, p), "exact")



@dataclass(frozen=True)
class BrownForsytheResult:
    statistic: float
    p: float
    n_a: int
    n_b: int
    spread_a: float
    spread_b: float
    note: str


def brown_forsythe(a: list[float], b: list[float]) -> BrownForsytheResult:
    """Brown-Forsythe test for equal dispersion between two groups.

    WHY IT IS NEEDED HERE. Spearman and the runs test are both tests of
    LOCATION order. A sample whose median holds steady while its spread
    collapses - an unstable early phase settling into a stable later one - is
    invisible to both, and that is exactly the shape observed in one cell. This
    tests the spread directly.

    Brown-Forsythe rather than classic Levene: it centres each group on its
    MEDIAN rather than its mean, which is what makes it robust for skewed or
    heavy-tailed data. Latency is both.

    The p-value is a two-sided permutation test over group labels, seeded, for
    the same reasons as spearman_rho: no F-distribution routine is needed, no
    normality is assumed, and a reviewer can rerun it and get the same number.
    """
    n_a, n_b = len(a), len(b)
    if n_a < 3 or n_b < 3:
        return BrownForsytheResult(float("nan"), float("nan"), n_a, n_b, 0.0, 0.0, "groups too small")

    def statistic(xa: list[float], xb: list[float]) -> float:
        # Absolute deviations from each group's own median.
        za = [abs(x - _median(xa)) for x in xa]
        zb = [abs(x - _median(xb)) for x in xb]
        n = len(za) + len(zb)
        grand = (sum(za) + sum(zb)) / n
        ma, mb = sum(za) / len(za), sum(zb) / len(zb)
        between = len(za) * (ma - grand) ** 2 + len(zb) * (mb - grand) ** 2
        within = sum((z - ma) ** 2 for z in za) + sum((z - mb) ** 2 for z in zb)
        if within == 0:
            # Every deviation identical: no dispersion difference to detect, and
            # the ratio is undefined rather than infinite.
            return 0.0
        return (between * (n - 2)) / within

    observed = statistic(a, b)
    pool = a + b
    rng = random.Random(PERMUTATION_SEED)
    at_least = 0
    for _ in range(PERMUTATIONS):
        rng.shuffle(pool)
        if statistic(pool[:n_a], pool[n_a:]) >= observed - 1e-12:
            at_least += 1
    p = (at_least + 1) / (PERMUTATIONS + 1)

    # Reported as IQRs because that is what the draft quotes; the test itself
    # uses absolute deviations from the median, not the IQR.
    return BrownForsytheResult(observed, p, n_a, n_b, _iqr(a), _iqr(b), "permutation")


def _median(x: list[float]) -> float:
    s = sorted(x)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def _quantile(x: list[float], q: float) -> float:
    """Linear interpolation between order statistics (numpy's default)."""
    s = sorted(x)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * q
    f = math.floor(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)


def _iqr(x: list[float]) -> float:
    return _quantile(x, 0.75) - _quantile(x, 0.25)


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
