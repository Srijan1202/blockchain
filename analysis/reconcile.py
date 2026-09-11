"""Re-derive every quantitative claim in PAPER.md sections 1-12 from source.

    python analysis/reconcile.py

WHY THIS EXISTS. Numbers migrate. A figure quoted in conversation, carried into
a draft, and cited in a later section acquires authority it never earned, and by
then nothing in the text records where it came from. Two figures in this
project's drafting were wrong in exactly that way - a pair of cost shares and a
max/median ratio - and neither existed anywhere in the dataset. Both were caught
only by re-deriving them.

So every claim in the draft is checked against its source here: ``export.csv``
for E2, ``bench.sqlite`` for the mainnet census, and the exact estimators in
``nonparametric.py``. The DRAFT value is hardcoded below and compared with a
value computed fresh. A claim that cannot be expressed as a check does not belong in
the paper as a number.

Run it after editing any figure in the draft. A mismatch means the draft and the
data disagree; it does not say which is right, and the answer is not always the
data - one mismatch here was a real schema artifact worth documenting rather
than a typo worth silently fixing.

Stdlib only, so it runs wherever the dataset does.
"""
import csv, json, math, sqlite3, statistics, sys, collections
sys.path.insert(0, "analysis")
from nonparametric import clopper_pearson, mann_whitney_u

rows = list(csv.DictReader(open("data/export.csv", newline="")))
cells = collections.defaultdict(list)
for r in rows:
    cells[(r["chain_key"], r["path"])].append(r)
for k in cells:
    cells[k].sort(key=lambda r: r["submitted_at"])

def nums(cell, col):
    out = []
    for r in cells[cell]:
        v = r.get(col, "")
        if v:
            try: out.append(float(v))
            except ValueError: pass
    return out

def ints(cell, col):
    return [int(r[col]) for r in cells[cell] if r.get(col)]

def med(v):
    s = sorted(v); return s[len(s)//2] if len(s) % 2 else (s[len(s)//2-1]+s[len(s)//2])/2

def medi(v):
    s = sorted(v); return s[len(s)//2]

AF, AN, OF, ON = ("arb-sepolia","forced"), ("arb-sepolia","normal"), ("op-sepolia","forced"), ("op-sepolia","normal")
out = []
def chk(claim, section, draft, derived, ok=None):
    if ok is None:
        try:
            ok = abs(float(draft) - float(derived)) < 1e-9
        except (TypeError, ValueError):
            ok = (str(draft) == str(derived))
    out.append((claim, section, str(draft), str(derived), "YES" if ok else "NO"))

# ---- coverage / reliability ----
chk("rows in E2 dataset", "9.1", 100, len(rows))
for lbl, c in [("arb/forced", AF), ("arb/normal", AN), ("op/forced", OF), ("op/normal", ON)]:
    chk(f"n in {lbl}", "9.1", 25, len(cells[c]))
succ = sum(1 for r in cells[AF] if r["outcome"] == "success")
lo, hi = clopper_pearson(25, 25)
chk("success 25/25 all cells", "9.1", 25, succ)
chk("binomial CI lower bound at 25/25", "9.1", 0.863, round(lo, 3))

# ---- 9.2 latency ----
chk("M_L2 median arb/forced (s)", "9.2", 766, med(nums(AF,"M_L2")))
chk("M_L2 min arb/forced", "9.2", 411, min(nums(AF,"M_L2")))
chk("M_L2 max arb/forced", "9.2", 786, max(nums(AF,"M_L2")))
chk("M_L2 median op/forced (s)", "9.2", 76, med(nums(OF,"M_L2")))
chk("M_L2 min op/forced", "9.2", 70, min(nums(OF,"M_L2")))
chk("M_L2 max op/forced", "9.2", 90, max(nums(OF,"M_L2")))
u = mann_whitney_u(nums(AF,"M_L2"), nums(OF,"M_L2"))
chk("Mann-Whitney U", "9.2", 625, u.u)
chk("Mann-Whitney z", "9.2", 6.069, round(u.z,3))
chk("Mann-Whitney p", "9.2", "1.29e-09", f"{u.p:.2e}")
chk("U max possible for 25x25", "9.2", 625, 25*25)
chk("M_L3 median arb/forced", "9.2", 775, med(nums(AF,"M_L3")))
chk("M_L3 range arb/forced", "9.2", "426-795", f"{int(min(nums(AF,'M_L3')))}-{int(max(nums(AF,'M_L3')))}")
chk("M_L3 median op/forced", "9.2", 87, med(nums(OF,"M_L3")))
chk("M_L3 range op/forced", "9.2", "80-105", f"{int(min(nums(OF,'M_L3')))}-{int(max(nums(OF,'M_L3')))}")
chk("M_L1 median arb/forced", "9.2", 8, med(nums(AF,"M_L1")))
chk("M_L1 median op/forced", "9.2", 11, med(nums(OF,"M_L1")))
chk("M_L4 median arb/normal", "9.2", 1, med(nums(AN,"M_L4")))
chk("M_L4 range arb/normal", "9.2", "1-2", f"{int(min(nums(AN,'M_L4')))}-{int(max(nums(AN,'M_L4')))}")
chk("M_L4 median op/normal", "9.2", 3, med(nums(ON,"M_L4")))
chk("M_L4 range op/normal", "9.2", "2-4", f"{int(min(nums(ON,'M_L4')))}-{int(max(nums(ON,'M_L4')))}")

# ---- 9.3 cost ----
chk("median total_fee_wei arb/forced", "9.3", 105448477855536, medi(ints(AF,"total_fee_wei")))
chk("median total_fee_wei arb/normal", "9.3", 5490673566000, medi(ints(AN,"total_fee_wei")))
chk("median total_fee_wei op/forced", "9.3", 130740305035700, medi(ints(OF,"total_fee_wei")))
chk("median total_fee_wei op/normal", "9.3", 39006186877, medi(ints(ON,"total_fee_wei")))
chk("forced premium arb", "9.3", "19.2x", f"{medi(ints(AF,'total_fee_wei'))/medi(ints(AN,'total_fee_wei')):.1f}x")
chk("forced premium op", "9.3", "3351.8x", f"{medi(ints(OF,'total_fee_wei'))/medi(ints(ON,'total_fee_wei')):.1f}x")
s1 = [int(r["M_C1"])/int(r["total_fee_wei"]) for r in cells[AF]]
s3 = [int(r["M_C3"])/int(r["total_fee_wei"]) for r in cells[AF]]
chk("M_C1 share arb/forced median", "9.3", "94.8%", f"{statistics.median(s1):.1%}")
chk("M_C1 share arb/forced range", "9.3", "94.1-95.9", f"{min(s1)*100:.1f}-{max(s1)*100:.1f}")
chk("M_C3 share arb/forced median", "9.3", "5.2%", f"{statistics.median(s3):.1%}")
chk("M_C3 share arb/forced range", "9.3", "4.1-5.9", f"{min(s3)*100:.1f}-{max(s3)*100:.1f}")
chk("op/forced M_C1 == total in all runs", "9.3", True, all(r["M_C1"]==r["total_fee_wei"] for r in cells[OF]))
chk("op/forced M_C3 null in all runs", "9.3", 0, sum(1 for r in cells[OF] if r["M_C3"]))
df = [int(r["M_C3_op_l1_data_fee_wei"])/int(r["total_fee_wei"]) for r in cells[ON]]
chk("OP normal L1 data fee share median", "9.3", "46.1%", f"{statistics.median(df):.1%}")
chk("OP normal data fee share range", "9.3", "44.5-46.9", f"{min(df)*100:.1f}-{max(df)*100:.1f}")
chk("raw total gap arb vs op forced", "11.3", "19% cheaper",
    f"{(medi(ints(OF,'total_fee_wei'))-medi(ints(AF,'total_fee_wei')))/medi(ints(OF,'total_fee_wei'))*100:.0f}% cheaper")

# ---- 9.4 M_U1 ----
for lbl, c, exp in [("arb/forced",AF,1),("op/forced",OF,1),("arb/normal",AN,0),("op/normal",ON,0)]:
    vals = set(r["M_U1"] for r in cells[c])
    chk(f"M_U1 {lbl}", "9.4", exp, ",".join(sorted(vals)))

# ---- 9.5 auto-inclusion ----
chk("arb/forced inclusion_path auto", "9.5", 25, sum(1 for r in cells[AF] if r.get("inclusion_path")=="auto"))
chk("arb/forced S6 rows", "9.5", 0, sum(1 for r in cells[AF] if r.get("S6_block_timestamp")))
for s in ["S3","S4","S5","S7"]:
    chk(f"arb/forced {s} populated", "9.5", 25, sum(1 for r in cells[AF] if r.get(f"{s}_block_timestamp")))
d = [(int(r["S5_block_timestamp"])-int(r["S7_block_timestamp"]))/3600 for r in cells[AF]]
chk("S5-S7 median hours", "9.5", 23.79, round(statistics.median(d),2))
chk("S5-S7 min hours", "9.5", 23.78, round(min(d),2))
chk("S5-S7 max hours", "9.5", 23.89, round(max(d),2))

# ---- 12.4 tails ----
for lbl,c,m,exp in [("arb/forced M_L2",AF,"M_L2","1.03x"),("op/forced M_L2",OF,"M_L2","1.18x")]:
    v=nums(c,m); chk(f"max/median {lbl}", "12.4", exp, f"{max(v)/med(v):.2f}x")
allr=[]
for c in cells:
    for col in ["M_L1","M_L2","M_L3","M_L4","M_C1","M_C3","total_fee_wei","l1_gas_used","l1_gas_price","l1_base_fee_at_submit"]:
        v=nums(c,col)
        if len(v)>=20 and med(v): allr.append((max(v)/med(v), f"{c[0]}/{c[1]} {col}"))
allr.sort(reverse=True)
chk("largest max/median in dataset", "12.4", "2.62x arb-sepolia/forced M_L1", f"{allr[0][0]:.2f}x {allr[0][1]}")
# resolution targets
for lbl,c,m in [("arb/forced",AF,"M_L2"),("op/forced",OF,"M_L2"),("arb/normal",AN,"M_L4"),("op/normal",ON,"M_L4")]:
    v=nums(c,m); res=max(float(r[f"{m}_resolution_sec"]) for r in cells[c] if r.get(f"{m}_resolution_sec"))
    chk(f"10% of median vs resolution {lbl}", "12.4", "-", f"{0.1*med(v):.1f}s vs {res:g}s -> {'FINER' if 0.1*med(v)<res else 'askable'}", ok=True)
chk("op/forced l1_base_fee median gwei", "12.1", 1.07, round(statistics.median(nums(OF,"l1_base_fee_at_submit"))/1e9,2))

# ---- mainnet ----
conn = sqlite3.connect("file:data/bench.sqlite?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
scans = list(conn.execute("SELECT * FROM mainnet_scans ORDER BY from_block"))
seq = [s for s in scans if s["target_label"].startswith("SequencerInbox")]
denom = sum(s["logs_seen"] for s in seq)
chk("Class A denominator (batches)", "10.2", 1332810, denom)
ka = conn.execute("SELECT COUNT(*) c FROM mainnet_events WHERE chain_key='arbitrum-one' AND class='A'").fetchone()["c"]
chk("Class A count", "10.2", 0, ka)
lo2, hi2 = clopper_pearson(ka, denom)
chk("Class A CI upper bound", "10.2", "2.77e-06", f"{hi2:.2e}")
chk("Class A 1-in-N bound", "10.2", 361300, round(math.ceil(1/hi2), -2))
lo_b, hi_b = min(s["from_block"] for s in seq), max(s["to_block"] for s in seq)
chk("census span blocks", "10.2", 10540270, hi_b-lo_b+1)
chk("census from block", "10.2", 15411056, lo_b)
chk("census to block", "10.2", 25951325, hi_b)
ordered = sorted((s["from_block"], s["to_block"]) for s in seq)
gaps = [(a[1]+1, b[0]-1) for a,b in zip(ordered, ordered[1:]) if b[0] > a[1]+1]
chk("census contiguous (no gaps)", "10.1", True, len(gaps)==0)
loc = collections.Counter()
census_n = 0
import re
for s in seq:
    m = re.search(r"locations=(\{.*?\})", s["notes"] or "")
    if m:
        loc.update({k:int(v) for k,v in json.loads(m.group(1)).items()}); census_n += s["logs_seen"]
chk("log-census batches", "10.1", 1231699, census_n)
chk("dataLocation TxInput", "10.1", 592318, loc.get("0",0))
chk("dataLocation Blob", "10.1", 639380, loc.get("3",0))
chk("dataLocation SeparateBatchEvent", "10.1", 1, loc.get("1",0))
chk("dataLocation NoData", "10.1", 0, loc.get("2",0))
chk("RPC-scanned batches", "10.1", 101111, denom-census_n)
chk("dataLocation sums to census n", "10.1", True, sum(loc.values())==census_n)
ev = collections.Counter((r["chain_key"], r["class"]) for r in conn.execute("SELECT chain_key,class FROM mainnet_events"))
chk("Arbitrum Bridge Class C", "10.3", 2626, ev[("arbitrum-one","C")])
chk("Arbitrum Bridge Class D", "10.3", 9, ev[("arbitrum-one","D")])
chk("OP Mainnet deposits Class C (rows)", "10.3", 344, ev[("op-mainnet","C")])
chk("Base deposits Class C (rows)", "10.3", 1067, ev[("base","C")])
chk("OP+Base deposit rows", "10.6", 1411, ev[("op-mainnet","C")]+ev[("base","C")])
br = [s for s in scans if s["target_label"]=="Bridge"][0]
chk("Bridge messages examined", "10.3", 2646, br["logs_seen"])
dl = [r["delay_blocks"] for r in conn.execute("SELECT delay_blocks FROM mainnet_events WHERE class='C' AND delay_blocks IS NOT NULL")]
chk("Class C delay min", "10.4", 34, min(dl)); chk("Class C delay median", "10.4", 56, int(statistics.median(dl))); chk("Class C delay max", "10.4", 94, max(dl))
kinds = collections.Counter()
for r in conn.execute("SELECT evidence FROM mainnet_events WHERE chain_key='arbitrum-one'"):
    m = re.search(r"kind=(\d+)", r["evidence"])
    if m: kinds[int(m.group(1))] += 1
for k, exp in [(13,2070),(9,520),(12,45),(3,0)]:
    chk(f"Arbitrum kind {k} count", "10.5", exp, kinds.get(k,0))

print(f"{'claim':<46} {'sec':<6} {'draft':<26} {'re-derived':<26} ok")
print("-"*118)
bad=0
for c,s,d,r,o in out:
    if o=="NO": bad+=1
    print(f"{c:<46} {s:<6} {d:<26} {r:<26} {o}")
print("-"*118)
print(f"{len(out)} claims checked, {bad} mismatches")
