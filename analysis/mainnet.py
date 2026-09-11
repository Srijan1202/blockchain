"""Mainnet classification report (T13 / BLUEPRINT section 12).

    python analysis/mainnet.py --db data/bench.sqlite

Reads the indexer's output and reports what it supports: class counts with the
block range they were counted over, an exact binomial CI on the Class A rate,
and the Class A batch-size distribution.

WHY SQLITE AND NOT A CSV. The Class A *rate* needs a denominator, and the
denominator is the number of SequencerBatchDelivered batches examined - which
lives in ``mainnet_scans.logs_seen``, not in the per-event rows. Reading the
database directly keeps the numerator and denominator from drifting apart.
Opened READ-ONLY via a file: URI so this is safe to run while a scan is still
going.

Stdlib only, like clockcheck.py: ``sqlite3`` and ``math`` ship with Python, and
the exact Clopper-Pearson interval already exists in ``nonparametric.py``
without scipy. Nothing here needs pandas, and a report that cannot be run is
worth nothing.

THE HONESTY GATE (section 12). Class A on Arbitrum mainnet is expected to be
tiny. If it is, that IS the finding - "the escape hatch exists, is documented,
is load-bearing in every security argument for these systems, and is
essentially never used" - and it is reported with a CI rather than padded by
relaxing the classification. This file therefore never filters Class D out of a
denominator and never treats a near-miss as a hit; it prints what the indexer
recorded and, where n is too small for a distribution, says so and lists the
individual values instead.
"""

from __future__ import annotations

import argparse
import math
import sqlite3
from collections import Counter

from nonparametric import clopper_pearson

RULE = "=" * 78

#: Below this many Class A events, a "distribution" is a misleading word for a
#: handful of numbers. The task asks for the individual values in that case.
MIN_FOR_DISTRIBUTION = 8


def connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def report_coverage(conn: sqlite3.Connection) -> dict[str, int]:
    """Which ranges were scanned, by which endpoint, and did they complete."""
    print(RULE)
    print("COVERAGE - every count below is relative to these ranges")
    print(RULE)
    rows = conn.execute(
        "SELECT chain_key, target_label, target, from_block, to_block, rpc_host,"
        "       logs_seen, complete, notes FROM mainnet_scans ORDER BY chain_key, from_block"
    ).fetchall()
    if not rows:
        print("  no scans recorded - run: npm run index-mainnet -- --chain <chain> --from N --to M")
        return {}

    denominators: dict[str, int] = {}
    for r in rows:
        blocks = r["to_block"] - r["from_block"] + 1
        status = "complete" if r["complete"] else "INCOMPLETE"
        print(f"  {r['chain_key']:<14} {r['target_label']:<16} blocks {r['from_block']}..{r['to_block']} ({blocks:,})")
        print(f"  {'':<14} {'':<16} logs_seen={r['logs_seen']:,}  {status}  via {r['rpc_host']}")
        if r["notes"]:
            print(f"  {'':<14} {'':<16} note: {r['notes']}")
        # Any SequencerInbox scan contributes to the binomial denominator,
        # whichever route produced it: "SequencerInbox" (RPC getLogs) and
        # "SequencerInbox:logcensus" (explorer API) count the same population,
        # and an exact-match test here silently dropped the census rows.
        if r["target_label"].startswith("SequencerInbox"):
            denominators[r["chain_key"]] = denominators.get(r["chain_key"], 0) + r["logs_seen"]
        if not r["complete"]:
            print(f"  {'':<14} {'':<16} !! coverage has holes - counts are a LOWER BOUND")

    # Overlapping ranges would be summed twice into the binomial denominator,
    # inflating n and shrinking the CI - i.e. failing in the direction that
    # flatters the "never used" conclusion. Caught here rather than trusted.
    spans: dict[str, list[tuple[int, int, str]]] = {}
    for r in rows:
        population = "SequencerInbox" if r["target_label"].startswith("SequencerInbox") else r["target_label"]
        spans.setdefault(f"{r['chain_key']}/{population}", []).append(
            (r["from_block"], r["to_block"], r["rpc_host"])
        )
    overlaps = []
    for key, items in spans.items():
        items.sort()
        for (a_lo, a_hi, _), (b_lo, b_hi, _) in zip(items, items[1:]):
            if b_lo <= a_hi:
                overlaps.append(f"{key}: {a_lo}..{a_hi} overlaps {b_lo}..{b_hi}")
    if overlaps:
        print("\n  !! OVERLAPPING SCAN RANGES - the denominator below double-counts:")
        for o in overlaps:
            print(f"     {o}")
        print("     Deduplicate the scans before quoting any rate.")
    else:
        print("\n  ranges are disjoint per target: logs_seen sums to a valid denominator")
    return denominators


def report_classes(conn: sqlite3.Connection) -> None:
    print(f"\n{RULE}")
    print("CLASS COUNTS")
    print(RULE)
    rows = conn.execute(
        "SELECT chain_key, class, COUNT(*) AS n FROM mainnet_events GROUP BY chain_key, class ORDER BY chain_key, class"
    ).fetchall()
    if not rows:
        print("  no classified events")
        return
    by_chain: dict[str, Counter] = {}
    for r in rows:
        by_chain.setdefault(r["chain_key"], Counter())[r["class"]] = r["n"]
    for chain, counts in by_chain.items():
        total = sum(counts.values())
        line = "  ".join(f"{c}={counts.get(c, 0):,}" for c in "ABCD")
        print(f"  {chain:<14} {line}   total={total:,}")
    print("\n  Class A - a successful forceInclusion call. The only class supporting strong claims.")
    print("  Class B - delayed beyond the inbox's own on-chain buffer threshold, later batched.")
    print("  Class C - ordinary inclusion, and ALL OP Stack deposits by construction.")
    print("  Class D - insufficient evidence. Never reclassified upward to tidy the table.")


def report_class_a_rate(conn: sqlite3.Connection, denominators: dict[str, int]) -> None:
    print(f"\n{RULE}")
    print("CLASS A RATE - exact binomial (Clopper-Pearson) 95% CI")
    print(RULE)
    print("  Denominator is SequencerBatchDelivered batches examined: every batch either")
    print("  was a forced inclusion or was not, which is what makes this a binomial.\n")
    for chain, n in sorted(denominators.items()):
        k = conn.execute(
            "SELECT COUNT(*) AS n FROM mainnet_events WHERE chain_key = ? AND class = 'A'", (chain,)
        ).fetchone()["n"]
        if n == 0:
            print(f"  {chain:<14} no batches examined - no rate can be stated")
            continue
        lo, hi = clopper_pearson(k, n)
        print(f"  {chain:<14} {k} Class A in {n:,} batches")
        print(f"  {'':<14} rate {k / n:.3e}   95% CI [{lo:.3e}, {hi:.3e}]")
        if k == 0:
            # The rule of three: with 0/n, the one-sided 95% bound is ~3/n.
            print(f"  {'':<14} ZERO observed. Upper bound {hi:.3e} means the true rate could still be")
            print(f"  {'':<14} as high as ~1 in {math.ceil(1 / hi):,} batches - 'none seen' is not 'never happens'.")


def report_batch_sizes(conn: sqlite3.Connection) -> None:
    """The E1 question: does forcing one message pay to include many?"""
    print(f"\n{RULE}")
    print("CLASS A BATCH SIZE - messages swept per forceInclusion call")
    print(RULE)
    print("  E1 measured 102 -> 107: one forcing user, five messages. n=1 on a devnet we")
    print("  controlled. BLUEPRINT 20.1 records two readings this decides between:")
    print("    griefing surface  - queue depth inflates the forcer's bill, uncontrollably")
    print("    public good       - the forcer subsidises everyone, marginal cost per message falls\n")

    rows = conn.execute(
        "SELECT tx_hash, block_number, batch_size, swept_own, swept_other, swept_unknown, actor"
        "  FROM mainnet_events WHERE class = 'A' ORDER BY block_number"
    ).fetchall()
    if not rows:
        print("  NO CLASS A EVENTS in the scanned range.")
        print("  Nothing can be said about the distribution - not 'the batch size is small',")
        print("  not 'the griefing risk is low'. The question stays open on mainnet evidence,")
        print("  and E1's n=1 remains the only measurement.")
        return

    sizes = [r["batch_size"] for r in rows if r["batch_size"] is not None]
    missing = len(rows) - len(sizes)
    print(f"  {len(rows)} Class A call(s); batch size recorded for {len(sizes)}, unknown for {missing}")
    if missing:
        print("    (unknown = the archive read of totalDelayedMessagesRead failed; not guessed)")

    if not sizes:
        print("  no batch sizes available")
    elif len(sizes) < MIN_FOR_DISTRIBUTION:
        print(f"\n  n={len(sizes)} is too few for a distribution. Individual values, in block order:\n")
        for r in rows:
            own, other, unk = r["swept_own"], r["swept_other"], r["swept_unknown"]
            attribution = (
                f"own={own} other={other} unknown={unk}"
                if own is not None
                else "attribution unavailable"
            )
            print(f"    block {r['block_number']:>10}  size={r['batch_size']}  {attribution}")
            print(f"      actor {r['actor']}  tx {r['tx_hash']}")
    else:
        s = sorted(sizes)
        n = len(s)

        def q(p: float) -> float:
            i = p * (n - 1)
            lo, hi = math.floor(i), math.ceil(i)
            return s[lo] if lo == hi else s[lo] + (s[hi] - s[lo]) * (i - lo)

        print(f"\n  n={n}  min={s[0]}  p25={q(0.25):.1f}  median={q(0.5):.1f}  p75={q(0.75):.1f}  p90={q(0.90):.1f}  max={s[-1]}")
        print("\n  Full distribution (size: count):")
        for size, cnt in sorted(Counter(s).items()):
            bar = "#" * min(50, cnt)
            print(f"    {size:>6}: {cnt:>5}  {bar}")

    own_t = sum(r["swept_own"] or 0 for r in rows)
    other_t = sum(r["swept_other"] or 0 for r in rows)
    unk_t = sum(r["swept_unknown"] or 0 for r in rows)
    tot = own_t + other_t + unk_t
    if tot:
        print(f"\n  WHOSE MESSAGES WERE SWEPT (aliasing resolved before comparing):")
        print(f"    forcer's own : {own_t:,} ({own_t / tot:.1%})")
        print(f"    other parties: {other_t:,} ({other_t / tot:.1%})")
        print(f"    unattributed : {unk_t:,} ({unk_t / tot:.1%})   <- never folded into 'other'")
        if other_t > own_t:
            print("    -> forcers pay mostly for OTHER parties' messages: public-good/free-rider reading")
        elif own_t > other_t:
            print("    -> forcers pay mostly for their OWN messages: the griefing surface is narrower")


def report_class_b(conn: sqlite3.Connection) -> None:
    print(f"\n{RULE}")
    print("CLASS B - delayed beyond the inbox's own expected window")
    print(RULE)
    rows = conn.execute(
        "SELECT chain_key, COUNT(*) AS n, MIN(delay_blocks) AS lo, MAX(delay_blocks) AS hi"
        "  FROM mainnet_events WHERE class = 'B' AND delay_blocks IS NOT NULL GROUP BY chain_key"
    ).fetchall()
    if not rows:
        print("  none recorded (or the Bridge pass was skipped for these ranges)")
        return
    for r in rows:
        print(f"  {r['chain_key']:<14} n={r['n']:,}  delay {r['lo']}..{r['hi']} L1 blocks")
    print("\n  Suggestive of the sequencer lagging. NOT proof of censorship (section 12).")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/bench.sqlite")
    args = ap.parse_args()

    conn = connect(args.db)
    print(f"\nMainnet classification report - {args.db}")
    denominators = report_coverage(conn)
    report_classes(conn)
    if denominators:
        report_class_a_rate(conn, denominators)
    report_batch_sizes(conn)
    report_class_b(conn)
    print()
    conn.close()


if __name__ == "__main__":
    main()
