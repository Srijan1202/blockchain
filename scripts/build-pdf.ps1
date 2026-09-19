# Builds paper.pdf from docs/PAPER.md - single-column, A4, with a table of contents.
#
#   powershell -ExecutionPolicy Bypass -File scripts/build-pdf.ps1
#
# Requirements: pandoc, MiKTeX (xelatex), and the Windows fonts Cambria and Consolas.
# See REPRODUCE.md, "Building the PDF", for why those fonts and for the MiKTeX
# package-database step that must run once before the first build.
#
# docs/PAPER.md is never modified. A preprocessed copy is written to build/ and
# compiled from there. pandoc is asked for LaTeX rather than PDF so that xelatex's
# log and recorder file survive - they are what the verification step reads.

[CmdletBinding()]
param(
    [string]$Out = "paper.pdf"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\PaperBuild.ps1")

Assert-Tool pandoc
Assert-Tool xelatex

New-Item -ItemType Directory -Force $script:BuildDir | Out-Null
$jobName = "paper"
$buildMd = Join-Path $script:BuildDir "PAPER.build.md"
$tex = Join-Path $script:BuildDir "$jobName.tex"
$pdfInBuild = Join-Path $script:BuildDir "$jobName.pdf"
$outPath = Join-Path $script:RepoRoot $Out

Write-Host "[1/4] preprocessing build copy"
New-PaperBuildCopy -OutPath $buildMd | Out-Null

Write-Host "[2/4] pandoc -> LaTeX"
# --from=markdown-implicit_figures: the paper writes its own "**Figure N.**" captions.
# With implicit figures on, pandoc would also emit "Figure N:" from the alt text and
# every plot would carry two captions with different numbers.
# --shift-heading-level-by=-1: the H1 was lifted into metadata, so the paper's "##"
# sections are its top level. Without the shift they become \subsection and the
# depth-2 TOC lists 3.1, 3.2, ... as its second level instead of 3, 4, ...
Push-Location $script:RepoRoot
try {
    & pandoc $buildMd `
        --from=markdown-implicit_figures `
        --shift-heading-level-by=-1 `
        --to=latex --standalone `
        -o $tex `
        --pdf-engine=xelatex `
        --resource-path=".;docs;analysis/figures" `
        --toc --toc-depth=2 `
        -V "title=$($script:PaperTitle)" `
        -V "geometry:a4paper,margin=2.2cm" `
        -V fontsize=10pt `
        -V "mainfont=Cambria" -V "monofont=Consolas" `
        -V colorlinks=true -V linkcolor=black
    if ($LASTEXITCODE -ne 0) { throw "pandoc exited $LASTEXITCODE" }
} finally {
    Pop-Location
}

# Image paths in the source are relative to docs/. Make them absolute so the
# result does not depend on where xelatex happens to be run from.
$figAbs = ($script:FigureDir -replace '\\', '/')
$texText = Read-Utf8 $tex
$texText = $texText.Replace("{../analysis/figures/", "{$figAbs/")
Write-Utf8 $tex $texText

Write-Host "[3/4] xelatex"
$log = Invoke-XeLaTeX -TexPath $tex -WorkDir $script:BuildDir

Write-Host "[4/4] verify"
$pages = Test-BuildOutput -LogPath $log -PdfPath $pdfInBuild -WorkDir $script:BuildDir -JobName $jobName
Copy-Item $pdfInBuild $outPath -Force
Write-Host ""
Write-Host ("DONE: {0}  ({1} pages)" -f $outPath, $pages)
