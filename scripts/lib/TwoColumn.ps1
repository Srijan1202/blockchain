# Two-column (IEEEtran) rewriting. Dot-source after PaperBuild.ps1.
#
# Shared by build-pdf-ieee.ps1 and package-arxiv.ps1 so the local build and the arXiv
# package are the same document with different fonts. Nothing here reads docs/PAPER.md.

Set-StrictMode -Version 2.0

# Identifiers such as M_C3_op_l1_data_fee_wei have no hyphenation points, so a long one
# is an unbreakable box. Letting a line break after an underscore fixes that without
# splitting inside a word; hyphenat's [htt] handles ordinary hyphenation in \texttt.
$script:BreakableUnderscore = '\renewcommand{\_}{\textunderscore\allowbreak}'

# Wide tables in ONE-column mode. pandoc's equal-width p{} columns squeeze
# "SequencerInbox" into a 2 cm cell; all-l columns overflow the 16.6 cm text width by
# 65pt on the 8-column scan table. So: content-sized l columns for every column except
# the one with the longest cell, which becomes an X column (xltabular = longtable +
# tabularx) and absorbs whatever width is left, wrapping as needed. Header cells lose
# pandoc's \linewidth minipages and the table is set \footnotesize. Used by build-pdf.ps1;
# needs \usepackage{xltabular} in the preamble.
function Convert-WideLongtables {
    param([string]$Tex, [int]$MinCols = 6)
    $pattern = '(?s)(\{\\def\\LTcaptype\{none\}[^\n]*\n)' +
               '\\begin\{longtable\}\[\]\{(?<spec>.*?@\{\})\}\n' +
               '(?<head>.*?\\endhead\n)(?<foot>.*?\\endlastfoot\n)(?<rows>.*?)\\end\{longtable\}'
    $script:wideCount = 0
    $evaluator = {
        param($m)
        $spec = $m.Groups["spec"].Value
        $nP = ([regex]::Matches($spec, 'p\{')).Count
        if ($nP -lt $MinCols) { return $m.Value }
        $script:wideCount++
        $head = [regex]::Replace($m.Groups["head"].Value,
            '(?s)\\begin\{minipage\}\[b\]\{\\linewidth\}\\raggedright\s*(.*?)\s*\\end\{minipage\}', '$1')
        $rows = $m.Groups["rows"].Value

        # Widest column = the one whose longest cell has the most characters.
        $maxLen = New-Object int[] $nP
        foreach ($row in ($rows -split '\\\\\s*\n')) {
            $cells = $row -split '(?<!\\)&'
            for ($i = 0; $i -lt [Math]::Min($cells.Count, $nP); $i++) {
                $len = ($cells[$i] -replace '\s+', ' ').Trim().Length
                if ($len -gt $maxLen[$i]) { $maxLen[$i] = $len }
            }
        }
        $widest = 0
        for ($i = 1; $i -lt $nP; $i++) { if ($maxLen[$i] -gt $maxLen[$widest]) { $widest = $i } }
        $cols = ""
        for ($i = 0; $i -lt $nP; $i++) { if ($i -eq $widest) { $cols += ">{\raggedright\arraybackslash}X" } else { $cols += "l" } }

        return $m.Groups[1].Value + "\footnotesize`n\begin{xltabular}{\linewidth}{@{}" + $cols + "@{}}`n" +
               $head + $m.Groups["foot"].Value + $rows + "\end{xltabular}"
    }
    $out = [regex]::Replace($Tex, $pattern, $evaluator)
    return @{ Tex = $out; Wide = $script:wideCount }
}

# Rewrites a pandoc LaTeX BODY (no preamble) for two-column IEEEtran. See the header
# comment of build-pdf-ieee.ps1 for the four things that break without this.
# $FigurePrefix replaces pandoc's "../analysis/figures/" in image paths.
function Convert-BodyForTwoColumn {
    param([string]$Body, [string]$FigurePrefix)

    $body = $Body.Replace("{../analysis/figures/", "{$FigurePrefix")

    # ---- tables: longtable -> tabular in table* ----------------------------------
    # Matches the whole block pandoc emits for a caption-less table, plus an optional
    # following "**Table N.**" paragraph:
    #
    #   {\def\LTcaptype{none} % do not increment counter
    #   \begin{longtable}[]{<spec ending in @{}>}
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
    $script:tcTables = 0
    $script:tcWide = @()
    $tableRewriter = {
        param($m)
        $script:tcTables++
        $spec = $m.Groups["spec"].Value
        $head = $m.Groups["head"].Value
        $rows = $m.Groups["rows"].Value
        $cap  = $m.Groups["cap"].Value

        # Column count: p{} specs list one p per column; simple specs are letters between @{}.
        $nP = ([regex]::Matches($spec, 'p\{')).Count
        if ($nP -gt 0) { $nCols = $nP } else { $nCols = ($spec -replace '@\{\}', '').Trim().Length }

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
            $script:tcWide += "$($script:tcTables) ($nCols cols)"
        }

        $capBlock = ""
        if ($cap -ne "") { $capBlock = "\par\vspace{5pt}`n{\footnotesize\raggedright $cap\par}`n" }

        return "\begin{table*}[!t]`n\centering`n$size`n\begin{tabular}{$spec}`n" +
               $head.TrimEnd() + "`n" + $rows.TrimEnd() + "`n\bottomrule`n\end{tabular}`n" +
               $capBlock + "\end{table*}"
    }
    $body = [regex]::Replace($body, $tablePattern, $tableRewriter)

    if ($body -match '\\begin\{longtable\}') { throw "A longtable survived the rewrite; the pandoc output shape has changed." }
    foreach ($leftover in @('\endhead', '\endfirsthead', '\endlastfoot', '\noalign{}')) {
        if ($body.Contains($leftover)) { throw "'$leftover' survived the table rewrite." }
    }

    # ---- figures: inline image -> figure* ---------------------------------------
    $figurePattern = '\\pandocbounded\{\\includegraphics\[[^\]]*\]\{(?<path>[^}]*)\}\}' +
                     '(?:\n\n(?<cap>\\textbf\{Figure \d+\.\}(?s:.*?)))?(?=\n\n)'
    $script:tcFigures = 0
    $figureRewriter = {
        param($m)
        $script:tcFigures++
        $path = $m.Groups["path"].Value
        $cap  = $m.Groups["cap"].Value
        $capBlock = ""
        if ($cap -ne "") { $capBlock = "\par\vspace{5pt}`n{\footnotesize\raggedright $cap\par}`n" }
        return "\begin{figure*}[!t]`n\centering`n\includegraphics[width=0.86\textwidth]{$path}`n$capBlock\end{figure*}"
    }
    $body = [regex]::Replace($body, $figurePattern, $figureRewriter)
    if ($body -match '\\pandocbounded') { throw "An inline image survived the figure rewrite." }

    return @{ Body = $body; Tables = $script:tcTables; WideTables = $script:tcWide; Figures = $script:tcFigures }
}

# Wraps a rewritten body in the IEEEtran preamble. $FontSetup is the fontspec block:
# Windows system fonts for the local build, TeX Live fonts by FILE NAME for arXiv.
function New-IeeeDocument {
    param([string]$Body, [string]$FontSetup)
    $preamble = @'
\documentclass[conference]{IEEEtran}
\usepackage{calc}        % pandoc column specs use \real{} and fail without it
\usepackage{booktabs}
\usepackage{array}
\usepackage{graphicx}
\usepackage{amsmath}
\usepackage[htt]{hyphenat}  % let long identifiers in \texttt break inside cells
\usepackage{fontspec}
__FONTS__
\usepackage{xcolor}
\usepackage[colorlinks=true,linkcolor=black,urlcolor=black,citecolor=black]{hyperref}
\providecommand{\tightlist}{\setlength{\itemsep}{0pt}\setlength{\parskip}{0pt}}
\providecommand{\pandocbounded}[1]{#1}
__UNDERSCORE__
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
    $preamble = $preamble.Replace("__TITLE__", $script:PaperTitle).Replace("__FONTS__", $FontSetup.Trim()).Replace("__UNDERSCORE__", $script:BreakableUnderscore)
    return $preamble + "`n" + $Body + "`n\end{document}`n"
}

# Runs pandoc on the build copy and returns the LaTeX BODY (no preamble).
function Invoke-PandocBody {
    param([string]$BuildMd, [string]$OutTex)
    Push-Location $script:RepoRoot
    try {
        & pandoc $BuildMd `
            --from=markdown-implicit_figures `
            --shift-heading-level-by=-1 `
            --to=latex `
            -o $OutTex `
            --resource-path=".;docs;analysis/figures"
        if ($LASTEXITCODE -ne 0) { throw "pandoc exited $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
    return (Read-Utf8 $OutTex)
}
