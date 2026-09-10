"""Validity check: can any L2 timestamp precede the L1 timestamp it is measured from?

    python analysis/clockcheck.py --csv data/export.csv

WHY THIS EXISTS. On the E1 devnet a forced transaction's L2 block carried a
timestamp 20s EARLIER than the L1 block whose ``forceInclusion`` call put it
there. Computing M-L5 from those two numbers gave 73s against a 93s L1-only
lower bound - an impossible result. The cause was sequencer backlog: under
load, Nitro stamped six consecutive L2 blocks with one timestamp and fell
behind real time. A calibration on the same, unloaded sequencer showed 0s
offset, so this is load-induced lag rather than a configuration skew.

Public testnet sequencers also run under load, so the same effect could have
understated ``M_L2`` (S3 -> S7) across the E2 dataset. This file tests that
directly, on the one relation that admits no argument: **a transaction cannot
appear on L2 before the L1 block that carried it.** Any run where the L2
timestamp is below the L1 timestamp is definitive evidence of the lag; the
magnitude of the shortfall is a lower bound on how far the L2 clock trailed.

Stdlib only, deliberately. pandas is not installed in every environment this
has to run in, and a validity check that cannot be executed is worth nothing -
the same reasoning that produced ``nonparametric.py``. It also keeps every
timestamp an ``int``: a float64 seconds value is fine today but the wei-column
lesson in the README argues for never introducing the hazard at all.

WHICH PAIRS ARE COMPARED, AND WHICH ARE NOT
  compared    an L1-anchored OBSERVED stage that precedes an L2-anchored stage
              in the lifecycle: S3/S4 (L1 inclusion, queue entry) against
              S7/S8 (L2 appearance, execution).
  excluded    S5 - clock_source is l1_block but confidence is INFERRED. It is a
              projected force-eligibility time, not an observation of a block
              that carried anything, and BLUEPRINT 20.1 showed messages are
              auto-included ~24h BEFORE it. S7 < S5 is the expected finding,
              not a clock defect.
  excluded    S9 - L1 finality genuinely follows L2 appearance, so S7 < S9 is
              correct ordering.
  excluded    S1, S2 - wall clock, a different question (host NTP, not
              sequencer lag).

The clustering report is the second signature. A sequencer stamping many
blocks with one timestamp shows up as runs sharing an L2 block timestamp with
the run submitted next to them. Shared block NUMBERS are reported alongside,
since two runs landing in one L2 block necessarily share its timestamp and
that is the stronger form of the same evidence.
"""

from __future__ import annotations

import argparse
import csv
from collections import Counter, defaultdict

#: Lifecycle order. Position matters: only an L1 stage that comes BEFORE an L2
#: stage can produce a violation.
STAGE_ORDER = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"]

#: Observed L1-anchored stages that precede L2 appearance. S5 is inferred and
#: S9 follows L2; see the module docstring.
L1_STAGES = ["S3", "S4"]
L2_STAGES = ["S7", "S8"]


def _int(row: dict, stage: str, field: str) -> int | None:
    v = row.get(f"{stage}_{field}", "")
    if v is None or v == "":
        return None
    try:
        return int(v)
    except ValueError:
        return None


def cell_of(row: dict) -> str:
    return f"{row['chain_key']}/{row['path']}"


def check_ordering(rows: list[dict]) -> tuple[list[dict], Counter, Counter]:
    """Every (L1 stage, L2 stage) pair where the L2 timestamp is lower."""
    violations: list[dict] = []
    compared: Counter = Counter()
    cells: Counter = Counter()
    for row in rows:
        cell = cell_of(row)
        cells[cell] += 1
        for a in L1_STAGES:
            ta = _int(row, a, "block_timestamp")
            if ta is None:
                continue
            # Guard the invariant this check depends on rather than assuming it.
            if row.get(f"{a}_clock_source") != "l1_block":
                continue
            for b in L2_STAGES:
                tb = _int(row, b, "block_timestamp")
                if tb is None or row.get(f"{b}_clock_source") != "l2_block":
                    continue
                if STAGE_ORDER.index(a) >= STAGE_ORDER.index(b):
                    continue
                compared[cell] += 1
                if tb < ta:
                    violations.append({
                        "run_id": row["run_id"],
                        "cell": cell,
                        "pair": f"{a}->{b}",
                        "l1_ts": ta,
                        "l2_ts": tb,
                        "shortfall": ta - tb,
                        "l1_block": _int(row, a, "block_number"),
                        "l2_block": _int(row, b, "block_number"),
                    })
    return violations, compared, cells


def check_clustering(rows: list[dict], stage: str = "S7") -> dict[str, dict]:
    """Runs sharing an L2 timestamp (or block) with the run submitted next to them."""
    by_cell: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_cell[cell_of(row)].append(row)

    out: dict[str, dict] = {}
    for cell, group in by_cell.items():
        # "Adjacent" must mean collection order; any other sort invents adjacency.
        group = sorted(group, key=lambda r: r.get("submitted_at", ""))
        ts = [_int(r, stage, "block_timestamp") for r in group]
        bn = [_int(r, stage, "block_number") for r in group]

        adj_ts = sum(
            1 for i, t in enumerate(ts)
            if t is not None and (
                (i > 0 and ts[i - 1] == t) or (i + 1 < len(ts) and ts[i + 1] == t)
            )
        )
        dup_ts = sum(c for c in Counter(t for t in ts if t is not None).values() if c > 1)
        dup_bn = sum(c for c in Counter(b for b in bn if b is not None).values() if c > 1)
        observed = [t for t in ts if t is not None]
        gaps = [b - a for a, b in zip(observed, observed[1:])]
        out[cell] = {
            "n": len(group),
            "observed": len(observed),
            "adjacent_shared_ts": adj_ts,
            "any_shared_ts": dup_ts,
            "any_shared_block": dup_bn,
            "min_gap": min(gaps) if gaps else None,
            "distinct_ts": len(set(observed)),
        }
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default="data/export.csv")
    ap.add_argument("--stage", default="S7", help="L2 stage used for the clustering report")
    args = ap.parse_args()

    with open(args.csv, newline="") as fh:
        rows = list(csv.DictReader(fh))

    rule = "=" * 78
    print(f"\nClock-ordering validity check - {args.csv}")
    print(f"{len(rows)} runs\n")

    violations, compared, cells = check_ordering(rows)

    print(rule)
    print("ORDERING - is any L2 timestamp below the L1 timestamp it is measured from?")
    print(rule)
    print(f"  pairs compared: {L1_STAGES} x {L2_STAGES}   (S5 inferred and S9 post-L2 are excluded)")
    for cell in sorted(cells):
        n_v = sum(1 for v in violations if v["cell"] == cell)
        worst = max((v["shortfall"] for v in violations if v["cell"] == cell), default=None)
        detail = f"worst shortfall {worst}s" if worst is not None else "none"
        print(f"    {cell:<24} runs={cells[cell]:<4} pairs={compared[cell]:<5} violations={n_v:<4} {detail}")

    if violations:
        print("\n  VIOLATIONS - an L2 block dated before the L1 block that carried the tx:")
        for v in sorted(violations, key=lambda v: -v["shortfall"]):
            print(
                f"    {v['run_id'][:8]}  {v['cell']:<22} {v['pair']:<8} "
                f"L1 #{v['l1_block']} ts={v['l1_ts']}  L2 #{v['l2_block']} ts={v['l2_ts']}  "
                f"shortfall {v['shortfall']}s"
            )
        print("\n  -> The l2_block clock trailed the l1_block clock by AT LEAST the shortfall.")
        print("     Any metric spanning those two stages is understated. Do not correct in")
        print("     place - recompute on a single clock, as M-L5 was.")
    else:
        print(f"\n  PASSED: 0 violations across {sum(compared.values())} compared pairs.")
        print("  No L2 timestamp precedes its L1 anchor, so the E1 failure mode does not")
        print("  appear in this dataset. This bounds the lag only where the two clocks are")
        print("  compared; it is not a claim that the sequencer never lagged at all.")

    print(f"\n{rule}")
    print(f"CLUSTERING - runs sharing an {args.stage} L2 timestamp with an adjacent run")
    print(rule)
    print("  A backlogged sequencer stamps consecutive blocks with one timestamp.\n")
    clus = check_clustering(rows, args.stage)
    for cell in sorted(clus):
        c = clus[cell]
        print(f"    {cell:<24} n={c['n']:<4} observed={c['observed']:<4} distinct_ts={c['distinct_ts']:<4}")
        print(
            f"    {'':<24} adjacent_shared={c['adjacent_shared_ts']:<4} "
            f"any_shared_ts={c['any_shared_ts']:<4} shared_block={c['any_shared_block']:<4} "
            f"min_gap={c['min_gap']}s"
        )

    total_clustered = sum(c["adjacent_shared_ts"] for c in clus.values())
    if total_clustered == 0:
        print("\n  No run shares an L2 timestamp with an adjacent run: no clustering signature.")
    else:
        print(f"\n  {total_clustered} runs share an L2 timestamp with an adjacent run - inspect before")
        print("  reporting any latency at finer than the observed timestamp spacing.")
    print()


if __name__ == "__main__":
    main()
