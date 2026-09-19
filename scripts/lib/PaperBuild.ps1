# Shared helpers for the two PDF build scripts. Dot-source this file; do not run it.
#
# Everything here operates on a BUILD COPY of docs/PAPER.md. The source file is
# canonical and is never written by any build script.

Set-StrictMode -Version 2.0

$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$script:PaperSource = Join-Path $script:RepoRoot "docs\PAPER.md"
$script:BuildDir = Join-Path $script:RepoRoot "build"
$script:FigureDir = Join-Path $script:RepoRoot "analysis\figures"

# The five figures the paper cites. The build verifies each one was actually read by
# xelatex rather than assuming the include succeeded.
$script:ExpectedFigures = @(
    "ecdf_M_L2.png",
    "ecdf_M_L3.png",
    "cost_comparison.png",
    "cost_decomposition.png",
    "read_delay_cdf.png"
)

$script:PaperTitle = "Escape Hatches in the Wild: Measuring the Real Censorship-Resistance of Ethereum Layer-2 Rollups"

function Read-Utf8 {
    param([string]$Path)
    # Normalise to LF: pandoc and xelatex write CRLF on Windows, and every regex in
    # this file assumes "\n" is the line break.
    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8).Replace("`r`n", "`n")
}

function Write-Utf8 {
    param([string]$Path, [string]$Text)
    # BOM-less UTF-8 with LF endings, matching the repository's .gitattributes.
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text.Replace("`r`n", "`n"), $enc)
}

function Assert-Tool {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "'$Name' is not on PATH. Install it and re-run (see REPRODUCE.md, PDF build)."
    }
}

# Produces the preprocessed build copy and returns its path.
#
# Three transformations, all mechanical, none touching the paper's content:
#   1. A blockquote that directly follows a non-blank, non-blockquote line is a lazy
#      paragraph continuation in Markdown and renders its '>' literally. Insert the
#      missing blank line.
#   2. Cambria has no glyphs for Unicode sub/superscripts, so H_0 / H_1 / 10^-9 / 10^-6
#      would render as blank boxes. Replace them with LaTeX math. Fail if any
#      sub/superscript survives, rather than shipping a box.
#   3. Lift the H1 title out of the body. It is passed as metadata instead, so it
#      does not appear both as a TOC entry and as a heading.
function New-PaperBuildCopy {
    param([string]$OutPath)

    $text = Read-Utf8 $script:PaperSource
    $lines = $text -split "`r?`n"

    # --- 3. lift the H1 ---------------------------------------------------------
    if ($lines[0] -notmatch '^# ') {
        throw "docs/PAPER.md no longer starts with an H1 title; the build assumes it does."
    }
    $lines = $lines[1..($lines.Count - 1)]
    while ($lines.Count -gt 0 -and $lines[0].Trim() -eq "") {
        $lines = $lines[1..($lines.Count - 1)]
    }

    # --- 1. blank line before lazy blockquotes --------------------------------------
    $out = New-Object System.Collections.Generic.List[string]
    $prev = ""
    $inserted = 0
    foreach ($ln in $lines) {
        # Same rule for an image line: without the blank line the image is inline at
        # the end of the preceding paragraph, and pandoc sets it there at full width.
        $lazyQuote = ($ln -match '^>' -and $prev -notmatch '^>')
        $lazyImage = ($ln -match '^!\[')
        if (($lazyQuote -or $lazyImage) -and $prev.Trim() -ne "") {
            $out.Add("")
            $inserted++
        }
        $out.Add($ln)
        $prev = $ln
    }
    $body = [string]::Join("`n", $out)

    # --- 2. Unicode sub/superscripts -> LaTeX math ---------------------------------
    $sub0 = [string][char]0x2080      # subscript zero
    $sub1 = [string][char]0x2081      # subscript one
    $supMinus = [string][char]0x207B  # superscript minus
    $sup9 = [string][char]0x2079      # superscript nine
    $sup6 = [string][char]0x2076      # superscript six

    $replacements = @(
        @{ From = "H$sub0";                 To = '$H_0$';      Label = "H_0" },
        @{ From = "H$sub1";                 To = '$H_1$';      Label = "H_1" },
        @{ From = "10$supMinus$sup9";       To = '$10^{-9}$';  Label = "10^-9" },
        @{ From = "10$supMinus$sup6";       To = '$10^{-6}$';  Label = "10^-6" }
    )
    $counts = @{}
    foreach ($r in $replacements) {
        $n = ([regex]::Matches($body, [regex]::Escape($r.From))).Count
        $counts[$r.Label] = $n
        $body = $body.Replace($r.From, $r.To)
    }

    # Anything left in the sub/superscript blocks (U+2070-209F) or the Latin-1
    # superscripts (U+00B2 U+00B3 U+00B9) is a glyph Cambria will not render. Refuse to build.
    $supRange = [string][char]0x2070 + "-" + [string][char]0x209F + [string][char]0x00B2 + [string][char]0x00B3 + [string][char]0x00B9
    $leftover = [regex]::Matches($body, "[$supRange]")
    if ($leftover.Count -gt 0) {
        $chars = ($leftover | ForEach-Object { "U+{0:X4}" -f [int][char]$_.Value } | Sort-Object -Unique) -join " "
        throw "Unhandled Unicode sub/superscripts remain after preprocessing: $chars. Add them to the replacement table."
    }

    Write-Utf8 $OutPath ($body + "`n")

    Write-Host ("  preprocess: lifted H1; inserted {0} blank line(s) before lazy blockquotes/images; " -f $inserted)
    Write-Host ("              replaced H_0 x{0}, H_1 x{1}, 10^-9 x{2}, 10^-6 x{3}; no sub/superscripts remain" -f `
        $counts["H_0"], $counts["H_1"], $counts["10^-9"], $counts["10^-6"])
    return $OutPath
}

# Runs xelatex on a .tex file in $WorkDir: once, then again while the TOC/refs are
# unstable (max 3 passes). Uses -recorder so the .fls lists every file actually read,
# which is how figure embedding is verified. Returns the path of the final log.
function Invoke-XeLaTeX {
    param([string]$TexPath, [string]$WorkDir)

    $jobName = [System.IO.Path]::GetFileNameWithoutExtension($TexPath)
    $log = Join-Path $WorkDir "$jobName.log"
    $passes = 0
    $maxPasses = 3
    do {
        $passes++
        Write-Host "  xelatex pass $passes ..."
        # Start-Process rather than '& xelatex 2>&1': under Windows PowerShell 5.1 a
        # native command's stderr becomes an ErrorRecord, and MiKTeX writes advisory
        # notices to stderr, so a successful run would abort the script.
        $stdout = Join-Path $WorkDir "$jobName.stdout.txt"
        $stderr = Join-Path $WorkDir "$jobName.stderr.txt"
        $proc = Start-Process -FilePath "xelatex" -WorkingDirectory $WorkDir -Wait -PassThru -NoNewWindow `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
            -ArgumentList @("-interaction=nonstopmode", "-halt-on-error", "-recorder", "-file-line-error",
                            "-jobname", $jobName, "`"$TexPath`"")
        $exit = $proc.ExitCode
        if (-not (Test-Path $log)) { throw "xelatex produced no log at $log" }
        $logText = Read-Utf8 $log

        # Font failures are reported first and stop the build - every other error
        # downstream of a missing font is noise.
        $fontFail = [regex]::Match($logText, 'The font "([^"]+)" cannot be found')
        if ($fontFail.Success) {
            throw ("FONT NOT FOUND: '{0}'. fontspec could not load it; the build stops here. " -f $fontFail.Groups[1].Value) +
                  "Check the font is installed for this user (Settings > Fonts) and the name matches exactly."
        }
        if ($exit -ne 0) {
            $errs = ($logText -split "`n" | Where-Object { $_ -match '^!|^.*:\d+: ' } | Select-Object -First 8) -join "`n    "
            throw "xelatex exited $exit on pass $passes. First errors:`n    $errs`n  Full log: $log"
        }
        $rerun = $logText -match 'Rerun to get|Label\(s\) may have changed|Table widths have changed'
        # Always at least two passes: the TOC and page references are written on pass
        # one and only typeset on pass two, and a stale .aux from a previous build can
        # suppress the "Rerun" hint while still being wrong.
    } while (($rerun -or $passes -lt 2) -and $passes -lt $maxPasses)

    return $log
}

# Reads the log and .fls and prints the verification block. Throws on any LaTeX
# error or on a figure that was not actually read. Returns the page count.
function Test-BuildOutput {
    param([string]$LogPath, [string]$PdfPath, [string]$WorkDir, [string]$JobName)

    $logText = Read-Utf8 $LogPath
    $fls = Join-Path $WorkDir "$JobName.fls"

    # -- LaTeX errors --------------------------------------------------------------
    $errorLines = @($logText -split "`n" | Where-Object { $_ -match '^! ' })
    if ($errorLines.Count -gt 0) {
        throw ("LaTeX reported {0} error(s):`n    {1}" -f $errorLines.Count, ($errorLines -join "`n    "))
    }

    # -- Page count, from the engine, not from guessing -----------------------------
    $m = [regex]::Match($logText, 'Output written on .*?\((\d+) pages?')
    if (-not $m.Success) { throw "Could not find 'Output written on ... (N pages' in $LogPath - no PDF was produced." }
    $pages = [int]$m.Groups[1].Value
    if (-not (Test-Path $PdfPath)) { throw "Log claims output but $PdfPath does not exist." }

    # -- Figures: every expected PNG must appear as an INPUT in the recorder file ---
    if (-not (Test-Path $fls)) { throw "Recorder file $fls missing; cannot verify figure embedding." }
    $inputs = @((Read-Utf8 $fls) -split "`n" | Where-Object { $_ -match '^INPUT ' } | ForEach-Object { $_.Substring(6).Trim() })
    $missingFigs = @()
    foreach ($fig in $script:ExpectedFigures) {
        $hit = $inputs | Where-Object { $_ -replace '\\', '/' -like "*/$fig" }
        if (-not $hit) { $missingFigs += $fig }
    }
    if ($missingFigs.Count -gt 0) {
        throw ("Figures NOT embedded (never read by xelatex): {0}" -f ($missingFigs -join ", "))
    }

    # -- Missing glyphs: a blank box in the PDF, and only the log knows --------------
    $missingChars = @([regex]::Matches($logText, 'Missing character: There is no (\S+) in font ([^!\r\n]+)') |
        ForEach-Object { "{0} in {1}" -f $_.Groups[1].Value, $_.Groups[2].Value.Trim() } | Sort-Object -Unique)

    # -- Overfull hboxes ------------------------------------------------------------
    $overfull = @([regex]::Matches($logText, 'Overfull \\hbox \(([\d.]+)pt too wide') |
        ForEach-Object { [double]$_.Groups[1].Value })
    $worst = 0.0
    if ($overfull.Count -gt 0) { $worst = ($overfull | Measure-Object -Maximum).Maximum }

    Write-Host ""
    Write-Host "  VERIFICATION"
    Write-Host ("    output          : {0} ({1:N0} bytes)" -f $PdfPath, (Get-Item $PdfPath).Length)
    Write-Host ("    pages           : {0}" -f $pages)
    Write-Host ("    LaTeX errors    : 0")
    Write-Host ("    figures embedded: {0}/{1}  ({2})" -f $script:ExpectedFigures.Count, $script:ExpectedFigures.Count, ($script:ExpectedFigures -join ", "))
    if ($missingChars.Count -gt 0) {
        Write-Host ("    MISSING GLYPHS  : {0}" -f ($missingChars -join "; ")) -ForegroundColor Yellow
    } else {
        Write-Host  "    missing glyphs  : none"
    }
    Write-Host ("    overfull hboxes : {0}, worst {1:N1}pt" -f $overfull.Count, $worst)
    Write-Host ("    log             : {0}" -f $LogPath)
    return $pages
}
