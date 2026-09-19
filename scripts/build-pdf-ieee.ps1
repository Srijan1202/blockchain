# Builds paper-ieee.pdf from docs/PAPER.md - IEEEtran two-column conference layout.
#
#   powershell -ExecutionPolicy Bypass -File scripts/build-pdf-ieee.ps1
#
# Same requirements and same preprocessing as build-pdf.ps1 (see scripts/lib/PaperBuild.ps1).
# This is more than a documentclass switch. pandoc's LaTeX assumes a one-column article,
# and four things break in two-column IEEEtran:
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

[CmdletBinding()]
param(
    [string]$Out = "paper-ieee.pdf"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\PaperBuild.ps1")

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
Push-Location $script:RepoRoot
try {
    # Body only: the preamble is ours. --from and --shift as in build-pdf.ps1.
    & pandoc $buildMd `
        --from=markdown-implicit_figures `
        --shift-heading-level-by=-1 `
        --to=latex `
        -o $bodyTex `
        --resource-path=".;docs;analysis/figures"
    if ($LASTEXITCODE -ne 0) { throw "pandoc exited $LASTEXITCODE" }
} finally {
    Pop-Location
}

Write-Host "[3/5] rewriting tables and figures for two-column"
$body = Read-Utf8 $bodyTex
$figAbs = ($script:FigureDir -replace '\\', '/')
$body = $body.Replace("{../analysis/figures/", "{$figAbs/")

# ---- tables: longtable -> tabular in table* --------------------------------------
# Matches the whole block pandoc emits for a caption-less table, plus an optional
# following "**Table N.**" paragraph:
#
#   {\def\LTcaptype{none} % do not increment counter
#   \begin{longtable}[]{<spec ending in @{}}>
#   <head>            (\toprule ... header cells ... \\ \midrule, possibly twice with \endfirsthead)
#   \endhead
#   \bottomrule\noalign{}
#   \endlastfoot
#   <rows>
#   \end{longtable}
#   }
#
#   \textbf{Table N.} caption text ...
$tablePattern = '(?s)\{\\def\\LTcaptype\{none\}[^\n]*\n' +
                '\\begin\{longtable\}\[\]\{(?<spec>.*?@\{\})\}\n' +
                '(?<head>.*?)\\endhead\n' +
                '(?<foot>.*?)\\endlastfoot\n' +
                '(?<rows>.*?)\\end\{longtable\}\n\}' +
                '(?:\n\n(?<cap>\\textbf\{Table \d+\.\}.*?))?(?=\n\n)'

$tableCount = 0
$wideTables = @()
$tableRewriter = {
    param($m)
    $script:tableCount++
    $spec = $m.Groups["spec"].Value
    $head = $m.Groups["head"].Value
    $rows = $m.Groups["rows"].Value
    $cap  = $m.Groups["cap"].Value

    # Column count: p{} specs list one p per column; simple specs are letters between @{}.
    $nP = ([regex]::Matches($spec, 'p\{')).Count
    if ($nP -gt 0) {
        $nCols = $nP
    } else {
        $nCols = ($spec -replace '@\{\}', '').Trim().Length
    }

    # A repeated running head (\endfirsthead) is a longtable feature; keep the first only.
    $fh = $head.IndexOf('\endfirsthead')
    if ($fh -ge 0) { $head = $head.Substring(0, $fh) }

    # Header cells: drop the \linewidth minipages. p columns wrap without them, and
    # inside an l column a \linewidth minipage is a full-width cell.
    $head = [regex]::Replace($head, '(?s)\\begin\{minipage\}\[b\]\{\\linewidth\}\\raggedright\s*(.*?)\s*\\end\{minipage\}', '$1')

    # \noalign{} is a longtable idiom; strip it but keep the line break after \toprule
    # so the rule is not glued to the first header cell.
    $head = $head.Replace('\noalign{}', '')
    $rows = $rows.Replace('\noalign{}', '')

    $spec = $spec.Replace('\linewidth', '\textwidth').Replace('\columnwidth', '\textwidth')
    $size = '\small'
    if ($nCols -ge 6) {
        $spec = '@{}' + ('l' * $nCols) + '@{}'
        $size = '\footnotesize'
        $script:wideTables += "$($script:tableCount) ($nCols cols)"
    }

    $capBlock = ""
    if ($cap -ne "") {
        $capBlock = "`\par\vspace{5pt}`n{\footnotesize\raggedright $cap\par}`n"
    }

    return "\begin{table*}[!t]`n\centering`n$size`n\begin{tabular}{$spec}`n" +
           $head.TrimEnd() + "`n" + $rows.TrimEnd() + "`n\bottomrule`n\end{tabular}`n" +
           $capBlock + "\end{table*}"
}
$body = [regex]::Replace($body, $tablePattern, $tableRewriter)

if ($body -match '\\begin\{longtable\}') { throw "A longtable survived the rewrite; the pandoc output shape has changed." }
foreach ($leftover in @('\endhead', '\endfirsthead', '\endlastfoot', '\noalign{}')) {
    if ($body.Contains($leftover)) { throw "'$leftover' survived the table rewrite." }
}

# ---- figures: inline image -> figure* -------------------------------------------
$figurePattern = '\\pandocbounded\{\\includegraphics\[[^\]]*\]\{(?<path>[^}]*)\}\}' +
                 '(?:\n\n(?<cap>\\textbf\{Figure \d+\.\}(?s:.*?)))?(?=\n\n)'
$figureCount = 0
$figureRewriter = {
    param($m)
    $script:figureCount++
    $path = $m.Groups["path"].Value
    $cap  = $m.Groups["cap"].Value
    $capBlock = ""
    if ($cap -ne "") { $capBlock = "`\par\vspace{5pt}`n{\footnotesize\raggedright $cap\par}`n" }
    return "\begin{figure*}[!t]`n\centering`n\includegraphics[width=0.86\textwidth]{$path}`n$capBlock\end{figure*}"
}
$body = [regex]::Replace($body, $figurePattern, $figureRewriter)
if ($body -match '\\pandocbounded') { throw "An inline image survived the figure rewrite." }

Write-Host ("  tables -> table*: {0} (content-sized l columns for: {1})" -f $tableCount, ($wideTables -join ", "))
Write-Host ("  figures -> figure*: {0}" -f $figureCount)

# ---- wrap in the IEEEtran preamble ---------------------------------------------
$preamble = @'
\documentclass[conference]{IEEEtran}
\usepackage{calc}        % pandoc column specs use \real{} and fail without it
\usepackage{booktabs}
\usepackage{array}
\usepackage{graphicx}
\usepackage{amsmath}
\usepackage[htt]{hyphenat}  % let long identifiers in \texttt break inside cells
\usepackage{fontspec}
\setmainfont{Times New Roman}
\setmonofont[Scale=MatchLowercase]{Consolas}
\usepackage{xcolor}
\usepackage[colorlinks=true,linkcolor=black,urlcolor=black,citecolor=black]{hyperref}
\providecommand{\tightlist}{\setlength{\itemsep}{0pt}\setlength{\parskip}{0pt}}
\providecommand{\pandocbounded}[1]{#1}
% IEEEtran numbers sections itself; the paper numbers them in the text, and ~80
% cross-references depend on those numbers. Turn the automatic numbering off.
\setcounter{secnumdepth}{0}
\setlength{\emergencystretch}{3em}
\begin{document}
\title{__TITLE__}
\author{\IEEEauthorblockN{Suyash Srivastava}
\IEEEauthorblockA{Vellore Institute of Technology\\Vellore, India}}
\maketitle
'@
$preamble = $preamble.Replace("__TITLE__", $script:PaperTitle)
$full = $preamble + "`n" + $body + "`n\end{document}`n"
Write-Utf8 $tex $full

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
