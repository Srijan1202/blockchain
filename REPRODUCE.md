# Reproducing the results

This document was verified by following it literally on a fresh clone. Where it says a
command produces a specific number, that number was obtained that way.

There are two kinds of reproduction here and it matters which one you want:

- **Every analysis, statistic and figure in the paper regenerates from the shipped dataset.**
  This takes about ten minutes and needs no chain access, no API key, and no funds. Start at
  §3 and stop at §7.
- **The dataset itself cannot be recollected.** §9 says why, plainly. Do not read the rest of
  this document as a promise that it can.

---

## 1. Prerequisites

| Tool | Version verified | Notes |
|---|---|---|
| Node.js | v26.3.1 | `package.json` requires ≥ 20 |
| npm | 11.16.0 | ships with Node |
| Python | 3.13.14 | 3.11+ should work; nothing below is version-specific |
| git | any | |
| sqlite3 CLI | optional | Python's `sqlite3` module is used instead |

The analysis has two tiers:

- **Stdlib-only scripts** — `nonparametric.py`, `clockcheck.py`, `drift.py`, `mainnet.py`,
  `reconcile.py`. These run on a bare Python install. Every exact estimator the paper quotes
  (Clopper–Pearson, Mann–Whitney, Spearman, runs, Brown–Forsythe) lives in `nonparametric.py`
  and is self-tested there.
- **pandas/matplotlib scripts** — `report.py`, `stability.py`, `figures.py`. These need the
  packages in `analysis/requirements.txt`. `scipy` is deliberately **not** required (see
  `analysis/README.md`).

---

## 2. Clone and install

```bash
git clone https://github.com/Srijan1202/blockchain.git l2-escape-bench
cd l2-escape-bench
npm ci --ignore-scripts
npm run typecheck        # must print nothing but the tsc invocation
```

**`--ignore-scripts` is required, not optional.** `better-sqlite3` ships prebuilt N-API
binaries for every common platform inside its package and needs no compiler — but it also
carries a `binding.gyp`, and on seeing one npm attempts a native build regardless. On a
machine without a C++ toolchain (no Visual Studio Build Tools on Windows, no
`build-essential` on Linux) that build fails and `npm ci` aborts, even though the prebuilt
binary it would have used is already on disk. Verified on a fresh clone: plain `npm ci` fails
on Node 26; `npm ci --ignore-scripts` succeeds and the module loads from the bundled prebuild.
None of this project's other dependencies has an install script, so nothing is lost.

Python, in a virtual environment so the pinned packages do not collide with anything else:

```bash
python -m venv .venv
# Windows:  .venv\Scripts\activate      POSIX:  source .venv/bin/activate
pip install -r analysis/requirements.txt
python analysis/nonparametric.py       # self-test: must end with "=== ALL PASS ==="
```

---

## 3. Install the dataset

The working data directory `data/` is gitignored. The released dataset ships in `dataset/`.
Copy it in and verify the digests:

```bash
cd dataset && sha256sum -c SHA256SUMS && cd ..
cp dataset/bench.sqlite dataset/export.csv dataset/export_manifest.json data/
```

`sha256sum -c` must print `OK` for all three files. If it does not, the files were altered in
transit and nothing below is meaningful. (A `.gitattributes` in the repository forces LF line
endings on `dataset/` so this check passes on Windows checkouts with `core.autocrlf=true`; the
first version of this document did not have it and the check failed on every such machine.)

Read `dataset/DATA_DICTIONARY.md` before touching the CSV. Three things in it will produce a
wrong number if skipped, and the first — that wei columns overflow float64 — is silent.

---

## 4. Environment variables

Copy the template and fill in only what the commands you intend to run need:

```bash
cp .env.example .env
```

| Command | Needs | Purpose |
|---|---|---|
| `npm run typecheck` | nothing | |
| `npm run export` | `DB_PATH` (optional; default `./data/bench.sqlite`) | RPC vars are recorded as hosts if set, `(unset)` otherwise; not required |
| `python analysis/*.py` | nothing | reads `data/export.csv` and `data/bench.sqlite` |
| `npm run index-mainnet` | `RPC_ETH_MAINNET` | read-only; needs archive `eth_getLogs` — see §8 |
| `npm run census` | `RPC_ETH_MAINNET`, `ETHERSCAN_API_KEY` | read-only; see §8 |
| `npm run verify` | `RPC_ETH_SEPOLIA`, `RPC_ARB_SEPOLIA`, `RPC_OP_SEPOLIA`, `RPC_BASE_SEPOLIA` | testnet connectivity; not needed for reproduction |
| `npm run run` | all of the above plus `PRIVATE_KEY` | **collects new data — see §9, this cannot be meaningfully run** |

No command in §5–§7 needs any variable set. `.env` may be left as the template.

---

## 5. Migrations and the export

Migrations run automatically whenever a command opens the database for writing; there is no
separate migrate step. The shipped `bench.sqlite` is already at migration 005. To confirm:

```bash
python -c "import sqlite3; print([r[0] for r in sqlite3.connect('data/bench.sqlite').execute('SELECT name FROM schema_migrations ORDER BY name')])"
```

Expected: `['001_init.sql', '002_lifecycle_revisions.sql', '003_l1_data_fee.sql', '004_mainnet_index.sql', '005_mainnet_event_log_index.sql']`.

Regenerate the export from the database:

```bash
npm run export -- --out data/export.csv --manifest data/export_manifest.json
```

Expected in the log line: `"rows":100,"columns":108`. The regenerated `export.csv` is
**byte-identical** to the shipped one — verify with `sha256sum data/export.csv` against
`dataset/SHA256SUMS`. The manifest will differ only in `export_timestamp`, `git_commit`, and
`rpc_hosts` (which reflect your environment, not the data).

---

## 6. Every statistic and figure, from `export.csv` alone

Run in this order. Each command's key output is given so you can check it.

### 6.1 Self-test the estimators

```bash
python analysis/nonparametric.py
```
Must end `=== ALL PASS ===`.

### 6.2 Validity checks — run these before trusting any latency

```bash
python analysis/clockcheck.py --csv data/export.csv
```
Expected: `PASSED: 0 violations across 200 compared pairs`; every cell `adjacent_shared=0`.

```bash
python analysis/drift.py --csv data/export.csv
```
Expected: no `<-DRIFT` or `<-REGIME` marks; three `<-DISPERSION` marks, all in
`arb-sepolia/forced` (M_L1 p=0.0188, M_L2 p=0.0445, M_L3 p=0.0497). Spearman and
Brown–Forsythe p-values are seeded permutation tests, so they reproduce exactly.

### 6.3 The report (needs pandas)

```bash
python analysis/report.py --csv data/export.csv
```
Key figures to check against the paper: M_L2 medians **766 s** (arb-sepolia/forced) and
**76 s** (op-sepolia/forced); cross-protocol Mann–Whitney **U = 625, p = 1.29e-09**; every
cell `success 25/25`.

```bash
python analysis/stability.py --csv data/export.csv
```
Expected verdicts: `arb-sepolia/forced` GUARDED; the other three cells ILL-POSED (the ±10%
target is finer than the clock). This is the finding in paper §12.4, not a failure.

### 6.4 Figures (needs matplotlib)

```bash
python analysis/figures.py --csv data/export.csv --out analysis/figures
```
Writes five figures: `ecdf_M_L2.png`, `ecdf_M_L3.png`, `cost_comparison.png`,
`cost_decomposition.png` and `read_delay_cdf.png`. Captions embed the mixed-clock flag and
resolution automatically. M-L1 and M-L4 are deliberately not plotted — both sit at or below
their clock's resolution, so an ECDF would render quantisation as curve shape (paper §10.4).
`read_delay_cdf.png` additionally needs the read-delay streams; it is skipped with a message if
they are absent, rather than failing the run.

### 6.5 The mainnet results

Two census products. The first reads `bench.sqlite`:

```bash
python analysis/mainnet.py --db data/bench.sqlite
```
Expected:
```
arbitrum-one/SequencerInbox: CONTIGUOUS 15411056..25951325 (10,540,270 blocks, no unexamined gaps)
arbitrum-one   0 Class A in 1,332,810 batches
               rate 0.000e+00   95% CI [0.000e+00, 2.768e-06]
```
The `CONTIGUOUS` line is what licenses "across all of Nitro-era history". If it reports
`OVERLAPPING` or `UNEXAMINED`, the denominator cannot be quoted.

The second is the full-history read-delay census — the one that decides what the Class A zero
means (paper §10.1). It reads three files shipped in `dataset/` (`read_delay_params.csv`,
`read_delay_messages.csv.gz`, `read_delay_batches.csv.gz`) and falls back to them
automatically when `data/` has no working copy:

```bash
python analysis/read_delay.py
```
Expected: `index space CONTIGUOUS`; `batch seq space ... CONTIGUOUS`; read-delay max
**1,250** blocks; `messages that exceeded delayBlocks (force-eligible): 0 of 2,563,777`;
closest approach **0.174**; `VERDICT: forceInclusion was NEVER REACHABLE`. Takes about two
minutes and ~1.5 GB of memory. The two `CONTIGUOUS` lines are the completeness checks — a gap
in either stream means the walk missed events and the verdict cannot be quoted.

---

## 7. Reconcile the paper against the data

```bash
python analysis/reconcile.py
```

Re-derives all 91 quantitative claims in paper sections 1–12 from `export.csv`, `bench.sqlite`
and the estimators, and prints `claim / section / draft / re-derived / YES|NO` for each.
Expected last line: **`91 claims checked, 0 mismatches`**.

A mismatch means the draft and the data disagree. It does not say which is right — one
mismatch in this project's history was a real schema artifact worth documenting rather than a
typo — so read the row before deciding.

---

## 8. Re-running the mainnet census (optional; needs network)

The census is read-only, signs nothing, and loads no key beyond the explorer's. It is the one
data-collection step that *can* be repeated, because mainnet history does not expire.

**Prerequisites.** A free Etherscan API key (etherscan.io/apis; 5 calls/s, 100k/day — the full
census uses about 1,000). Put it in `.env` as `ETHERSCAN_API_KEY`. Also `RPC_ETH_MAINNET`, used
for the head block and to confirm any candidate's receipt; the free `https://eth.drpc.org`
suffices. **Do not use a transaction-list API for this** — the SequencerInbox's transactions
carry ~199 KB of batch calldata each, and enumerating them would move ~266 GB. The census walks
logs instead.

**Run.** The tool runs a positive control before it trusts the source, and refuses to run if
the control fails:

```bash
npm run census -- --api etherscan --dry-run                 # control only; must print "positive control PASSED"
npm run census -- --api etherscan --from 15411056 --offset 1000 --throttle-ms 220
```

Block 15,411,056 is where the SequencerInbox proxy first has code (verified by bisection);
`--to` defaults to the current head. The run takes roughly ten minutes. If your connection
drops, the tool records the range it actually reached; resume with `--from <that block + 1>`.

To regenerate the read-delay streams themselves (~4,000 calls, ~90 minutes at Etherscan's
3 calls/sec; resumable):

```bash
npm run census-read-delay -- --only params      # delayBlocks history via archive eth_call (needs RPC_ETH_MAINNET)
npm run census-read-delay -- --only batches     # every SequencerBatchDelivered, windowed, with sequence numbers
npm run census-read-delay -- --only messages    # every MessageDelivered
```
Run the streams one at a time — two in parallel exceed the 3 calls/sec limit and both stall.
Each is resumable from its CSV; a truncated final line from an abrupt kill is detected and
dropped on resume.

**Then** `python analysis/mainnet.py` again. The batch count will be *larger* than 1,332,810
because the chain has advanced; Class A should still be 0, and the `CONTIGUOUS` line should
cover your new head. If a Class A event has occurred since this paper's census, the tool will
report it with its batch size and the paper's headline is superseded — which is the point of
making this repeatable.

**Do not** run `npm run census` against a database that already holds a census over an
overlapping range without deleting the old scan rows first; `mainnet.py` will refuse to quote a
rate over overlapping ranges, which is correct, but the fix is manual.

The bounded `index-mainnet` scans (Bridge, OP Mainnet, Base) can be repeated the same way over
their recorded ranges — they are listed in `mainnet_scans` — but need an archive RPC that
serves wide `eth_getLogs`; see `README.md` for which free endpoints do.

---

## 9. What cannot be reproduced, and why

**E2 — the 100 testnet runs — cannot be recollected.** They were collected on Ethereum Sepolia
and its rollups (Arbitrum Sepolia, OP Sepolia). The Ethereum Foundation's expected end of life
for Sepolia is **30 September 2026** — stated verbatim as "Expected end of life 30th September,
2026" in [*Holesky and Hoodi Testnet Updates*](https://blog.ethereum.org/2025/03/18/hoodi-holesky)
(EF blog, 18 March 2025), which also gives an expected launch of March 2026 for its replacement.
That page was read directly on 2026-09-15 to confirm the date; the EF's own wording is
"expected", and this document uses it. After that date the network is not maintained, and its
state and the L1 the rollups settle to are not available to transact against. `npm run run` remains in the
repository as the record of how the data was collected, and the harness re-reads every
protocol parameter live rather than from a constant, so it would run against a successor
testnet — but the numbers it produced would be from a different chain at a different time and
would not reproduce this paper's dataset. The shipped `bench.sqlite` is the primary artifact;
treat it as an observational record, not a regenerable one.

**E1 — the devnet censorship run — requires a local rollup you operate.** It needs
`OffchainLabs/nitro-testnode` (nitro `v3.9.6-91bf578`, nitro-contracts `v3.1.0`), Docker with
~10 GB free, and two post-deployment changes recorded in `docs/BLUEPRINT.md` §15:
`delayBlocks` set to 60 via the UpgradeExecutor, and the sequencer restarted with
`--node.delayed-sequencer.enable=false`. The procedure is step-by-step in BLUEPRINT §15 and
§20.1. It can be repeated, and the structural results (batch semantics, retroactive buffer
depletion) will reproduce; the **timing** will not — M-L5 is n = 1, on a chain with ~1 s L1
blocks, and a rerun is a second sample, not a replication of the first. The E1 run's figures
are not in `bench.sqlite`; they are reported in the paper from the run's recorded state.

**The devnet buffer `threshold` of 600 is not what any production chain runs** (Arbitrum One
reads 150 on-chain), so E1 timings are not portable even in principle.

**Everything in §5–§7 is reproducible from the shipped files without any of the above**, and
that is the reproducibility claim this project makes: a reader can verify every number in the
paper, but not recollect the observations behind them.

---

## 9a. Building the PDF (optional; Windows)

Two scripts render `docs/PAPER.md`. Neither modifies it: each writes a preprocessed copy to
`build/` and compiles that, so the Markdown stays canonical.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-pdf.ps1        # -> paper.pdf       (A4, one column, TOC)
powershell -ExecutionPolicy Bypass -File scripts/build-pdf-ieee.ps1   # -> paper-ieee.pdf  (IEEEtran two-column)
```

**Requirements.** pandoc 3.x and MiKTeX (xelatex). Both scripts end with a verification
block read from the xelatex log and recorder file, not from the exit code: page count, zero
LaTeX errors, all five figures actually read, no missing glyphs, and the overfull-hbox count
with its worst magnitude. A font that fails to load stops the build with its name.

**Refresh MiKTeX first, once.** MiKTeX installs packages on demand during a build and warns
that it "has never checked for updates". With a stale package database those on-demand
installs fail in ways that look unrelated to the real cause. Run both of these before the
first build; the second is what clears the warning and it exits 100 when updates exist,
which is not an error:

```powershell
miktex packages update-package-database
miktex packages check-update
```

The first build is slow (several minutes): MiKTeX fetches `fontspec`, `unicode-math`,
`IEEEtran` and their dependencies, and rebuilds its font cache. Later builds take under a
minute.

**Fonts.** The scripts use Cambria (body) and Consolas (mono) for the one-column build and
Times New Roman / Consolas for IEEE, because these ship with Windows. DejaVu, which the
figures and most Linux builds use, is not installed here and is not available through
winget. Cambria has no glyphs for Unicode sub- and superscripts, so the build copy rewrites
the paper's twelve such tokens on eight lines (H₀, H₁, 10⁻⁹, 10⁻⁶) as LaTeX math and refuses to build if any
survive — otherwise they render as blank boxes with no error. On a machine with DejaVu, pass
`-V mainfont="DejaVu Serif" -V monofont="DejaVu Sans Mono"` to pandoc instead; the
substitution is the only Windows-specific part.

**What the preprocessing does**, all mechanical: lifts the H1 title into metadata so it is
not both a TOC entry and a heading; inserts the blank line Markdown needs before a blockquote
or image that directly follows a paragraph; and the sub/superscript rewrite above. The
build is run with `--from=markdown-implicit_figures` because the paper writes its own
"**Figure N.**" captions and pandoc would otherwise add a second, differently numbered one
from the alt text; and with `--shift-heading-level-by=-1` so that, with the H1 gone, the
paper's `##` sections are top-level.

**The IEEE build rewrites what pandoc emits**, because a two-column IEEEtran document breaks
pandoc's LaTeX in four places: `longtable` does not work in two-column mode at all, so every
table becomes `tabular` inside a `table*`; tables with six or more columns get content-sized
`l` columns instead of pandoc's equal-width `p{}` specs (the 8-column scan table is
unreadable otherwise); the five figures become `figure*` at 0.86 of the text width; and
IEEEtran's own section numbering is switched off, since the paper numbers its sections in
the text and some eighty cross-references depend on those numbers. The paper's caption
paragraphs are moved inside the float they describe so they travel with it.

Both builds target, and on this machine reach, **zero overfull hboxes**. Two things make that
possible and are worth knowing if a future edit reintroduces one: a line may break after
an underscore inside `	exttt` (identifiers such as `M_C3_op_l1_data_fee_wei` are otherwise
unbreakable boxes), and in the one-column build any table with six or more columns is set
with `xltabular` — content-sized columns except the one with the longest cell, which
absorbs the remaining width and wraps.

**The arXiv package.** `scripts/package-arxiv.ps1` writes `arxiv/` — `main.tex`, the five
figures under `figures/`, `00README.json` selecting xelatex, and a README recording the
source commit — and then verifies it by copying it to a fresh directory outside the
repository and building it there with the same checks. arXiv (TeX Live 2025, checked
September 2026) accepts xelatex and `fontspec`, but only with fonts loaded **by file name**
from TeX Live's own tree, since it registers almost nothing with fontconfig; and it rejects
PDFs produced from TeX. So the package is the IEEE document with TeX Gyre Termes and DejaVu
Sans Mono loaded by file name, which also removes the Windows-font dependency: `arxiv/`
builds on any TeX Live or MiKTeX install with

```
xelatex main.tex && xelatex main.tex
```

`arxiv/` is committed; it is the frozen submission. Regenerate it from the Markdown rather
than editing `main.tex`.

Build outputs (`build/`, `paper.pdf`, `paper-ieee.pdf`) are gitignored.

---

## 10. Verification log

Followed on a fresh clone from the remote, 2026-09-15, Windows 11, Node v26.3.1,
Python 3.13.14, in a directory with no prior state. Two steps failed on the first attempt.
Both were fixed in the repository or in this document, never by hand in the clone, and the
clone was discarded and re-created from the remote before re-testing.

| Step | First attempt | Fix | Re-test |
|---|---|---|---|
| §2 `npm ci` | **FAILED** — `node-gyp rebuild` for `better-sqlite3`, no Visual Studio found | Document `npm ci --ignore-scripts`; the package's bundled prebuild loads without compiling | OK; `better-sqlite3` loads, sqlite 3.53.4 |
| §2 `npm run typecheck` | not reached | — | clean |
| §2 Python venv + `requirements.txt` | OK | — | pandas 3.0.5, numpy 2.5.3, matplotlib 3.11.2 |
| §2 `nonparametric.py` | OK | — | ALL PASS |
| §3 `sha256sum -c SHA256SUMS` | **FAILED** — all three files: `core.autocrlf=true` rewrote every `dataset/` text file to CRLF on checkout, so `SHA256SUMS` carried a trailing CR on each filename and `export.csv` was 101 bytes larger | Added `.gitattributes` forcing `eol=lf` on `dataset/**` and `binary` on the sqlite | 3 × OK; `export.csv` LF, 75,271 bytes |
| §5 migrations present | OK | — | 001–005 |
| §5 `npm run export` | OK | — | 100 × 108; CSV hash matches `SHA256SUMS` |
| §6.2 `clockcheck.py` | OK | — | 0 violations / 200 pairs |
| §6.2 `drift.py` | OK | — | 3 DISPERSION flags, all arb-sepolia/forced; no DRIFT/REGIME |
| §6.3 `report.py` | OK | — | M_L2 medians 766 / 76; U = 625 |
| §6.3 `stability.py` | OK | — | GUARDED + 3 × ILL-POSED |
| §6.4 `figures.py` | OK | — | 5 figures written |
| §6.5 `mainnet.py` | OK | — | CONTIGUOUS 15411056..25951325; 0 in 1,332,810; CI [0, 2.768e-06] |
| §7 `reconcile.py` | OK | — | 91 claims, 0 mismatches (133 after the read-delay census and the H1/H2 intervals were added) |
| §8 `npm run census --dry-run` | OK (with a key) | — | positive control PASSED, 255 logs, all decoded |

The `bench.sqlite` in the clone passed `PRAGMA integrity_check` before and after the
line-ending fix; git had correctly detected it as binary throughout, so the database was never
at risk — only the text files and the digest check were.

Both first-attempt failures are the kind this document exists to find: each would have
stopped a reader at step two or three with an error that looks like their environment's fault,
and neither is visible from the machine the project was developed on.
