# Packages the manuscript for arXiv into arxiv/ and verifies the package builds from
# scratch in a directory outside the repository.
#
#   powershell -ExecutionPolicy Bypass -File scripts/package-arxiv.ps1
#
# What arXiv accepts (checked against info.arxiv.org, September 2026): TeX Live 2025 with
# xelatex as a selectable processor, and fontspec - but fonts must be loaded BY FILE NAME
# from TeX Live's own font tree, because arXiv registers practically nothing with
# fontconfig. A PDF produced from TeX is rejected unless an exception is granted, so
# PDF-only is not an option for a LaTeX-built paper.
#
# So the package is the IEEEtran two-column document from build-pdf-ieee.ps1 with the
# Windows fonts swapped for TeX Live's: TeX Gyre Termes (the Times clone IEEE expects) and
# DejaVu Sans Mono, both loaded by file name and both shipped with TeX Live and MiKTeX.
# Everything else - the table and figure rewrite, the preamble, the author block - is the
# same code path, so what arXiv builds is what was reviewed locally.
#
# Contents of arxiv/:
#   main.tex          self-contained; relative figure paths; no repo dependency
#   figures/*.png     the five figures
#   00README.json     tells arXiv to use xelatex and which file is top-level
#   README.md         provenance: source commit, generator, how to build
#
# Verification: the directory is copied to a fresh temp location outside the repo and
# built there with the same checks as the local builds (page count, zero errors, every
# figure read, no missing glyphs, overfull count). Nothing from build/ is used.

[CmdletBinding()]
param(
    [string]$OutDir = "arxiv"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\PaperBuild.ps1")
. (Join-Path $PSScriptRoot "lib\TwoColumn.ps1")

Assert-Tool pandoc
Assert-Tool xelatex
Assert-Tool git
Assert-Tool kpsewhich

$arxivDir = Join-Path $script:RepoRoot $OutDir
New-Item -ItemType Directory -Force $script:BuildDir | Out-Null
$buildMd = Join-Path $script:BuildDir "PAPER.build.md"
$bodyTex = Join-Path $script:BuildDir "arxiv.body.tex"

# ---- fonts: TeX Live files, by file name ------------------------------------------
$fontFiles = @(
    "texgyretermes-regular.otf", "texgyretermes-bold.otf",
    "texgyretermes-italic.otf",  "texgyretermes-bolditalic.otf",
    "DejaVuSansMono.ttf", "DejaVuSansMono-Bold.ttf",
    "DejaVuSansMono-Oblique.ttf", "DejaVuSansMono-BoldOblique.ttf"
)
Write-Host "[1/6] checking the TeX Live fonts are installed here (kpsewhich)"
foreach ($f in $fontFiles) {
    # cmd /c so that MiKTeX's advisory stderr notices do not become PowerShell errors.
    $found = (& cmd /c "kpsewhich $f 2>nul")
    if (-not $found) { throw "Font file '$f' not found by kpsewhich. Install the MiKTeX packages 'tex-gyre' and 'dejavu'." }
}
$fonts = @'
% TeX Live fonts loaded by FILE NAME. arXiv registers almost no fonts with fontconfig,
% so a name lookup ("TeX Gyre Termes") fails there; a file lookup works on arXiv and on
% any TeX Live or MiKTeX install. Termes is the Times clone IEEEtran expects.
\setmainfont[
  BoldFont=texgyretermes-bold.otf,
  ItalicFont=texgyretermes-italic.otf,
  BoldItalicFont=texgyretermes-bolditalic.otf]{texgyretermes-regular.otf}
\setmonofont[
  Scale=MatchLowercase,
  BoldFont=DejaVuSansMono-Bold.ttf,
  ItalicFont=DejaVuSansMono-Oblique.ttf,
  BoldItalicFont=DejaVuSansMono-BoldOblique.ttf]{DejaVuSansMono.ttf}
'@

Write-Host "[2/6] preprocessing build copy and running pandoc"
New-PaperBuildCopy -OutPath $buildMd | Out-Null
$body = Invoke-PandocBody -BuildMd $buildMd -OutTex $bodyTex

Write-Host "[3/6] rewriting for two-column with relative figure paths"
$rw = Convert-BodyForTwoColumn -Body $body -FigurePrefix "figures/"
Write-Host ("  tables -> table*: {0}; figures -> figure*: {1}" -f $rw.Tables, $rw.Figures)
$mainTex = New-IeeeDocument -Body $rw.Body -FontSetup $fonts

# No absolute paths anywhere in the submission.
# A single drive letter followed by ':' and a separator; the lookbehind keeps "https://" out.
$abs = [regex]::Matches($mainTex, '(?<![A-Za-z])[A-Za-z]:[/\\]')
if ($abs.Count -gt 0) { throw "main.tex contains $($abs.Count) absolute path(s); the package would not be portable." }

Write-Host "[4/6] writing $OutDir/"
if (Test-Path $arxivDir) { Remove-Item -Recurse -Force $arxivDir }
New-Item -ItemType Directory -Force (Join-Path $arxivDir "figures") | Out-Null
Write-Utf8 (Join-Path $arxivDir "main.tex") $mainTex
foreach ($fig in $script:ExpectedFigures) {
    Copy-Item (Join-Path $script:FigureDir $fig) (Join-Path $arxivDir "figures\$fig")
}

$commit = (& git -C $script:RepoRoot rev-parse HEAD).Trim()
$short = $commit.Substring(0, 12)
# @() so that a clean tree (git prints nothing, returns $null) is an empty string, not a null.
$dirty = (@(& git -C $script:RepoRoot status --porcelain -- docs/PAPER.md analysis/figures scripts) -join "`n").Trim()
if ($dirty) { Write-Host "  NOTE: docs/PAPER.md, analysis/figures or scripts/ have uncommitted changes; README records the commit as '$short (with uncommitted changes)'." -ForegroundColor Yellow; $short = "$short (with uncommitted changes)" }

$readme = @"
# arXiv submission package

Generated from ``docs/PAPER.md`` at commit ``$short`` by ``scripts/package-arxiv.ps1``.
Do not edit ``main.tex`` by hand; edit the Markdown and regenerate.

## Contents

| File | Purpose |
|---|---|
| ``main.tex`` | The manuscript, IEEEtran two-column, self-contained |
| ``figures/*.png`` | The five figures, referenced by relative path |
| ``00README.json`` | Tells arXiv to process with **xelatex** and that ``main.tex`` is top-level |

## Why xelatex, and why these fonts

arXiv (TeX Live 2025) accepts xelatex submissions and the ``fontspec`` package, with one
condition: fonts must be loaded **by file name** from TeX Live's font tree, because arXiv
registers almost nothing with fontconfig. ``main.tex`` therefore loads TeX Gyre Termes and
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
which processor to use, it should already have read ``00README.json`` and chosen xelatex;
if it asks, choose xelatex.
"@
Write-Utf8 (Join-Path $arxivDir "README.md") $readme

$readmeJson = @'
{
  "process": {
    "compiler": "xelatex"
  },
  "sources": [
    { "filename": "main.tex", "usage": "toplevel" }
  ]
}
'@
Write-Utf8 (Join-Path $arxivDir "00README.json") $readmeJson

# ---- verify: build from scratch, outside the repo ------------------------------------
Write-Host "[5/6] verifying: clean build outside the repository"
$verifyDir = Join-Path $env:TEMP ("arxiv-verify-" + [System.IO.Path]::GetRandomFileName().Replace(".", ""))
New-Item -ItemType Directory -Force $verifyDir | Out-Null
Copy-Item (Join-Path $arxivDir "*") $verifyDir -Recurse
Write-Host "  in $verifyDir"
$log = Invoke-XeLaTeX -TexPath (Join-Path $verifyDir "main.tex") -WorkDir $verifyDir

Write-Host "[6/6] verify"
$pages = Test-BuildOutput -LogPath $log -PdfPath (Join-Path $verifyDir "main.pdf") -WorkDir $verifyDir -JobName "main"
$logText = Read-Utf8 $log
$lostFloats = ([regex]::Matches($logText, 'Float\(s\) lost|Too many unprocessed floats')).Count
Write-Host ("    float problems  : {0}" -f $lostFloats)
# The verification copy's own PDF, kept next to the log for inspection; never in arxiv/.
Copy-Item (Join-Path $verifyDir "main.pdf") (Join-Path $script:BuildDir "arxiv-verify.pdf") -Force
Write-Host ("    verification PDF: {0}" -f (Join-Path $script:BuildDir "arxiv-verify.pdf"))

Write-Host ""
Write-Host ("DONE: {0}\  ({1} pages when built from scratch; source commit {2})" -f $arxivDir, $pages, $short)
