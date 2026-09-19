# Builds paper-ieee.pdf from docs/PAPER.md - IEEEtran two-column conference layout.
#
#   powershell -ExecutionPolicy Bypass -File scripts/build-pdf-ieee.ps1
#
# Same requirements and same preprocessing as build-pdf.ps1 (see scripts/lib/PaperBuild.ps1).
# This is more than a documentclass switch. pandoc's LaTeX assumes a one-column article,
# and four things break in two-column IEEEtran (the rewrite lives in scripts/lib/TwoColumn.ps1):
#
#   1. pandoc emits longtable for every Markdown table. longtable does not work in
#      two-column mode at all. Every table is rewritten as tabular inside a table* float
#      (full width, top of page). \linewidth / \columnwidth in the column specs become
#      \textwidth; \endhead, \endfirsthead, \endlastfoot and \noalign{} are stripped.
#   2. pandoc's equal-width p{} specs are wrong for wide tables: the 8-column
#      scan-coverage table forces "SequencerInbox" into a half-inch cell. Tables with six
#      or more columns get content-sized l columns instead, and their header cells lose
#      the \linewidth minipages pandoc wraps them in (a full-width minipage inside an l
#      column is the same bug again).
#   3. The five figures are promoted to figure* at 0.86\textwidth so the plots stay
#      legible; inline in a 3.4-inch column they are not.
#   4. IEEEtran numbers sections itself, on top of the paper's manual numbering, giving
#      "C. 3. Background". \setcounter{secnumdepth}{0} turns that off. Roughly eighty
#      cross-references in the text depend on the manual numbers, so they stay.
#
# The paper's own "**Table N.**" / "**Figure N.**" caption paragraphs are pulled into the
# float they belong to, so a float that moves to the top of a page carries its caption
# with it instead of leaving it stranded in the body text.
#
# Fonts: Times New Roman and Consolas, which ship with Windows. The arXiv package
# (scripts/package-arxiv.ps1) is this same document with TeX Live fonts instead.

[CmdletBinding()]
param(
    [string]$Out = "paper-ieee.pdf"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\PaperBuild.ps1")
. (Join-Path $PSScriptRoot "lib\TwoColumn.ps1")

Assert-Tool pandoc
Assert-Tool xelatex

New-Item -ItemType Directory -Force $script:BuildDir | Out-Null
$jobName = "paper-ieee"
$buildMd = Join-Path $script:BuildDir "PAPER.build.md"
$bodyTex = Join-Path $script:BuildDir "$jobName.body.tex"
$tex = Join-Path $script:BuildDir "$jobName.tex"
$pdfInBuild = Join-Path $script:BuildDir "$jobName.pdf"
$outPath = Join-Path $script:RepoRoot $Out

Write-Host "[1/5] preprocessing build copy"
New-PaperBuildCopy -OutPath $buildMd | Out-Null

Write-Host "[2/5] pandoc -> LaTeX body"
$body = Invoke-PandocBody -BuildMd $buildMd -OutTex $bodyTex

Write-Host "[3/5] rewriting tables and figures for two-column"
$figAbs = ($script:FigureDir -replace '\\', '/') + "/"
$rw = Convert-BodyForTwoColumn -Body $body -FigurePrefix $figAbs
Write-Host ("  tables -> table*: {0} (content-sized l columns for: {1})" -f $rw.Tables, ($rw.WideTables -join ", "))
Write-Host ("  figures -> figure*: {0}" -f $rw.Figures)

$fonts = @'
\setmainfont{Times New Roman}
\setmonofont[Scale=MatchLowercase]{Consolas}
'@
Write-Utf8 $tex (New-IeeeDocument -Body $rw.Body -FontSetup $fonts)

Write-Host "[4/5] xelatex"
$log = Invoke-XeLaTeX -TexPath $tex -WorkDir $script:BuildDir

Write-Host "[5/5] verify"
$pages = Test-BuildOutput -LogPath $log -PdfPath $pdfInBuild -WorkDir $script:BuildDir -JobName $jobName
$logText = Read-Utf8 $log
$lostFloats = ([regex]::Matches($logText, 'Float\(s\) lost|Too many unprocessed floats')).Count
Write-Host ("    float problems  : {0}" -f $lostFloats)
Copy-Item $pdfInBuild $outPath -Force
Write-Host ""
Write-Host ("DONE: {0}  ({1} pages, two-column IEEE)" -f $outPath, $pages)
