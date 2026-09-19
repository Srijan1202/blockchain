# arXiv submission package

Generated from `docs/PAPER.md` at commit `f1ed78b03e44` by `scripts/package-arxiv.ps1`.
Do not edit `main.tex` by hand; edit the Markdown and regenerate.

## Contents

| File | Purpose |
|---|---|
| `main.tex` | The manuscript, IEEEtran two-column, self-contained |
| `figures/*.png` | The five figures, referenced by relative path |
| `00README.json` | Tells arXiv to process with **xelatex** and that `main.tex` is top-level |

## Why xelatex, and why these fonts

arXiv (TeX Live 2025) accepts xelatex submissions and the `fontspec` package, with one
condition: fonts must be loaded **by file name** from TeX Live's font tree, because arXiv
registers almost nothing with fontconfig. `main.tex` therefore loads TeX Gyre Termes and
DejaVu Sans Mono by file name. Both ship with TeX Live and MiKTeX; nothing is bundled.

arXiv rejects PDFs produced from TeX unless an exception is granted, so submitting the PDF
alone is not an option.

## Build

    xelatex main.tex
    xelatex main.tex

Two passes settle the float placement and page references. No bibliography step: the
reference list is typeset inline.

## Upload

Zip the contents of this directory (not the directory itself) and upload. When arXiv asks
which processor to use, it should already have read `00README.json` and chosen xelatex;
if it asks, choose xelatex.