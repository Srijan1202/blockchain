"""Was forceInclusion ever reachable on Arbitrum One?

    python analysis/read_delay.py

THE QUESTION. The Class A census found zero successful forceInclusion calls
across all of Nitro-era history. A referee's strongest objection: if no delayed
message ever went unread past delayBlocks, the mechanism's precondition never
held, the zero is arithmetically guaranteed, and the census says nothing about
behaviour. This script answers that from a full-history read-delay census.

WHAT IT COMPUTES. For every delayed message i: the L1 block it arrived in, and
the L1 block of the first SequencerBatchDelivered whose afterDelayedMessagesRead
exceeds i - the batch that read it. Their difference is the read delay. It is
compared against the delayBlocks IN FORCE at that height, which was sampled at
every implementation boundary rather than assumed constant, because it was not:
5,760 from Nitro launch, 7,200 from the BoLD upgrade.

The single number that decides the referee's point is the MAXIMUM read delay as
a fraction of the delayBlocks then in force. Below 1.0, no message was ever
force-eligible and the zero follows from that. At or above 1.0, the mechanism
was reachable and nobody used it.

STREAMS, NOT TABLES. ~1.3M batches and ~2.6M messages are merged with a
two-pointer sweep over sorted inputs, so memory stays at a few hundred MB of
compact integer arrays rather than a DataFrame per stream. Stdlib only.

WHAT "READ DELAY" IS NOT. It is the delay before a batch that COVERS the
message was posted to L1. It is not the delay before the sequencer read the
message off-chain, which is earlier and unobservable here. It is the on-chain
quantity forceInclusion's guard compares against, which is the one that
matters for reachability.
"""

from __future__ import annotations

import argparse
import bisect
import csv
import datetime as dt
import gzip
import os
from array import array
from collections import Counter
from typing import IO


def open_csv(path: str) -> IO[str]:
    """Open a CSV whether it is plain or gzipped; try the release copy if the
    working copy is absent, so a fresh clone runs from dataset/ alone."""
    candidates = [path, path + ".gz", path.replace("data/", "dataset/"), path.replace("data/", "dataset/") + ".gz"]
    for c in candidates:
        if os.path.exists(c):
            return gzip.open(c, "rt", newline="") if c.endswith(".gz") else open(c, newline="")
    raise FileNotFoundError(f"none of {candidates} exists; run: npm run census-read-delay")

RULE = "=" * 78

#: Nitro-era L1 block time, for converting block deltas to durations in prose.
#: Only used for display; every comparison below is in blocks.
L1_BLOCK_SECONDS = 12


def load_params(path: str) -> tuple[list[int], list[int]]:
    """Step function delayBlocks(block): sorted (block, value) knots."""
    blocks: list[int] = []
    values: list[int] = []
    with open_csv(path) as fh:
        for r in csv.DictReader(fh):
            if not r["delayBlocks"]:
                continue
            blocks.append(int(r["block"]))
            values.append(int(r["delayBlocks"]))
    return blocks, values


def delay_blocks_at(knots: tuple[list[int], list[int]], block: int) -> int:
    blocks, values = knots
    i = bisect.bisect_right(blocks, block) - 1
    return values[max(i, 0)]


def load_batches(path: str) -> tuple[array, array]:
    """(block, afterDelayedMessagesRead), sorted by block, only where the read count advanced.

    Duplicate rows (a resumed walk re-fetching a boundary) are removed by
    sequence number when the file carries one, otherwise by exact row identity.
    Either way the ADVANCING ENVELOPE below is what the sweep uses, and a
    duplicate cannot move it: a repeated (block, after) pair never satisfies
    `a > best`. A batch that reads no new delayed messages likewise drops out.

    If sequence numbers are present, their contiguity is a completeness check on
    the batch stream, printed so a gap cannot pass silently.
    """
    rows: list[tuple[int, int]] = []
    seqs: set[int] = set()
    seen: set[tuple[int, int, int]] = set()
    with open_csv(path) as fh:
        rd = csv.DictReader(fh)
        has_seq = rd.fieldnames is not None and "seq" in rd.fieldnames
        for r in rd:
            key = (int(r["block"]), int(r["seq"]) if has_seq else -1, int(r["afterDelayedMessagesRead"]))
            if key in seen:
                continue
            seen.add(key)
            if has_seq:
                seqs.add(key[1])
            rows.append((key[0], key[2]))
    if seqs:
        lo, hi = min(seqs), max(seqs)
        missing = (hi - lo + 1) - len(seqs)
        print(f"  batch seq space    {lo:,}..{hi:,}  distinct {len(seqs):,}  " + ("CONTIGUOUS" if missing == 0 else f"!! {missing:,} MISSING"))
    else:
        print(f"  batch rows         {len(rows):,} distinct (no seq column in this file; completeness not checkable here)")
    rows.sort()
    blocks = array("q")
    after = array("q")
    best = -1
    for b, a in rows:
        if a > best:
            blocks.append(b)
            after.append(a)
            best = a
    return blocks, after


def load_messages(path: str) -> tuple[array, array, array]:
    """(index, block, kind) sorted by index, de-duplicated by index.

    A message index is unique by construction, so a repeated index is a
    re-fetched row, not a second message.
    """
    by_index: dict[int, tuple[int, int]] = {}
    total = 0
    with open_csv(path) as fh:
        for r in csv.DictReader(fh):
            total += 1
            i = int(r["index"])
            if i not in by_index:
                by_index[i] = (int(r["block"]), int(r["kind"]))
    if total != len(by_index):
        print(f"  message rows       {total:,} in file, {len(by_index):,} distinct indices ({total - len(by_index):,} duplicate rows dropped)")
    rows = sorted((i, b, k) for i, (b, k) in by_index.items())
    idx = array("q", (r[0] for r in rows))
    blk = array("q", (r[1] for r in rows))
    kind = array("i", (r[2] for r in rows))
    return idx, blk, kind


def sweep(msgs: tuple[array, array, array], batches: tuple[array, array]) -> tuple[array, int]:
    """Read delay per message, in blocks; -1 where no covering batch was found."""
    idx, blk, _ = msgs
    bblk, bafter = batches
    delays = array("q", bytes(8 * len(idx)))
    j = 0
    unread = 0
    for k in range(len(idx)):
        i = idx[k]
        # First batch whose read count exceeds this index. Both sequences are
        # monotone so j only ever advances.
        while j < len(bafter) and bafter[j] <= i:
            j += 1
        if j >= len(bafter):
            delays[k] = -1
            unread += 1
        else:
            delays[k] = bblk[j] - blk[k]
    return delays, unread


def pct(sorted_vals: list[int], q: float) -> int:
    if not sorted_vals:
        return 0
    k = int(round(q * (len(sorted_vals) - 1)))
    return sorted_vals[k]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--batches", default="data/read_delay_batches.csv")
    ap.add_argument("--messages", default="data/read_delay_messages.csv")
    ap.add_argument("--params", default="data/read_delay_params.csv")
    ap.add_argument("--top", type=int, default=15)
    args = ap.parse_args()

    knots = load_params(args.params)
    batches = load_batches(args.batches)
    msgs = load_messages(args.messages)
    idx, blk, kind = msgs
    delays, unread = sweep(msgs, batches)

    print(f"\nRead-delay census - Arbitrum One delayed inbox")
    print(RULE)
    print(f"  messages           {len(idx):,}   (index {idx[0]:,} .. {idx[-1]:,})")
    print(f"  message blocks     {min(blk):,} .. {max(blk):,}")
    print(f"  batches (advancing) {len(batches[0]):,}")
    print(f"  unread at end      {unread:,}   (no covering batch inside the range; excluded from stats)")
    print(f"  delayBlocks knots  " + ", ".join(f"{b:,}->{v}" for b, v in zip(*knots) if True)[:200])

    # Contiguity of the message index space - a gap means the walk missed events.
    expected = idx[-1] - idx[0] + 1
    if expected != len(idx):
        print(f"\n  !! INDEX GAPS: {expected - len(idx):,} indices missing between {idx[0]} and {idx[-1]} - walk incomplete")
    else:
        print(f"  index space        CONTIGUOUS - every message between first and last is present")

    read = [(delays[k], k) for k in range(len(idx)) if delays[k] >= 0]
    vals = sorted(d for d, _ in read)

    print(f"\n{RULE}")
    print("READ DELAY DISTRIBUTION (L1 blocks from delivery to the batch that read it)")
    print(RULE)
    for q in (0.5, 0.9, 0.99, 0.999, 0.9999):
        v = pct(vals, q)
        print(f"  p{q*100:g}".ljust(10) + f"{v:>8,} blocks   ~{v*L1_BLOCK_SECONDS/60:8.1f} min")
    print(f"  max".ljust(10) + f"{vals[-1]:>8,} blocks   ~{vals[-1]*L1_BLOCK_SECONDS/3600:8.2f} h")

    # The decisive quantity: delay as a fraction of the delayBlocks in force when
    # the message was waiting.
    print(f"\n{RULE}")
    print("REACHABILITY - read delay as a fraction of delayBlocks IN FORCE at that height")
    print(RULE)
    frac_max = 0.0
    frac_max_k = -1
    over = 0
    over_by_era: Counter = Counter()
    n_by_era: Counter = Counter()
    for d, k in read:
        db = delay_blocks_at(knots, blk[k])
        era = f"delayBlocks={db}"
        n_by_era[era] += 1
        f = d / db
        if f >= 1.0:
            over += 1
            over_by_era[era] += 1
        if f > frac_max:
            frac_max, frac_max_k = f, k

    print(f"  messages that exceeded delayBlocks (force-eligible): {over:,} of {len(read):,}")
    for era in sorted(n_by_era):
        print(f"    {era:<18} eligible {over_by_era[era]:,} of {n_by_era[era]:,}")
    k = frac_max_k
    db = delay_blocks_at(knots, blk[k])
    print(f"\n  closest approach: {frac_max:.3f} of delayBlocks")
    print(f"    message index {idx[k]:,}  kind {kind[k]}  delivered block {blk[k]:,}")
    print(f"    read delay {delays[k]:,} blocks (~{delays[k]*L1_BLOCK_SECONDS/3600:.2f} h) against delayBlocks {db} (~{db*L1_BLOCK_SECONDS/3600:.1f} h)")

    if over == 0:
        print("\n  VERDICT: forceInclusion was NEVER REACHABLE. No delayed message in Nitro-era")
        print("  history went unread past the delayBlocks in force. Zero forceInclusion calls")
        print("  follows from that arithmetically; the Class A census measures the precondition,")
        print("  not user behaviour.")
    else:
        print(f"\n  VERDICT: forceInclusion WAS REACHABLE {over:,} time(s) and was never used.")
        print("  The Class A zero is a finding about behaviour, not about the precondition.")

    print(f"\n{RULE}")
    print(f"TOP {args.top} READ DELAYS - where the precondition came closest")
    print(RULE)
    print(f"  {'delay':>8} {'frac':>6}  {'index':>10} {'kind':>4}  {'delivered':>10}  {'read at':>10}  {'~date (12s blocks from a known anchor)':<24}")
    top = sorted(read, key=lambda t: -t[0])[: args.top]
    # Date estimate: anchor on block 15,411,056 = 2022-08-25T20:05:44Z (measured), 12 s/block.
    anchor_block, anchor_ts = 15_411_056, 1_661_457_944
    for d, k in top:
        db = delay_blocks_at(knots, blk[k])
        read_at = blk[k] + d
        ts = anchor_ts + (blk[k] - anchor_block) * L1_BLOCK_SECONDS
        date = dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%d")
        print(f"  {d:>8,} {d/db:>6.3f}  {idx[k]:>10,} {kind[k]:>4}  {blk[k]:>10,}  {read_at:>10,}  {date}")

    print(f"\n{RULE}")
    print("BY MESSAGE KIND (read delay p99 / max)")
    print(RULE)
    by_kind: dict[int, list[int]] = {}
    for d, k in read:
        by_kind.setdefault(kind[k], []).append(d)
    names = {3: "L2_MSG (escape hatch)", 9: "retryable", 12: "ETH deposit", 13: "batch report", 7: "L2FundedByL1", 11: "endOfBlock", 10: "rollup event", 8: "initialize"}
    for kd in sorted(by_kind):
        v = sorted(by_kind[kd])
        print(f"  kind {kd:>2} {names.get(kd, '?'):<22} n={len(v):>9,}  p99={pct(v, 0.99):>6,}  max={v[-1]:>6,}")
    print()


if __name__ == "__main__":
    main()
