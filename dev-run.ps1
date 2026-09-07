param(
    [string]$SourceDir = "",
    [string]$FirefoxPath = "",
    [switch]$BrowserConsole
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($SourceDir)) {
    $SourceDir = Join-Path $env:LOCALAPPDATA 'Universal-Video-Detector-Dev'
}
$SourceDir = [IO.Path]::GetFullPath($SourceDir)

if (-not (Test-Path -LiteralPath (Join-Path $SourceDir 'manifest.json'))) {
    & (Join-Path $PSScriptRoot 'dev-update.ps1') -SourceDir $SourceDir
    if ($LASTEXITCODE -ne 0) { throw 'Developer source initialization failed.' }
}

if ([string]::IsNullOrWhiteSpace($FirefoxPath)) {
    $candidates = @(
        "$env:ProgramFiles\Mozilla Firefox Developer Edition\firefox.exe",
        "$env:ProgramFiles\Firefox Developer Edition\firefox.exe",
        "${env:ProgramFiles(x86)}\Mozilla Firefox Developer Edition\firefox.exe",
        "${env:ProgramFiles(x86)}\Firefox Developer Edition\firefox.exe"
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    $FirefoxPath = $candidates | Select-Object -First 1
}

if ([string]::IsNullOrWhiteSpace($FirefoxPath) -or -not (Test-Path -LiteralPath $FirefoxPath)) {
    throw 'Firefox Developer Editionのfirefox.exeを指定してください。例: -FirefoxPath "C:\Program Files\Firefox Developer Edition\firefox.exe"'
}

$webExt = Get-Command web-ext -ErrorAction SilentlyContinue
if (-not $webExt) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $node -or -not $npm) {
        throw 'web-extが見つかりません。Node.js 22+ と web-ext 10.x をインストールしてください。'
    }
    Write-Host 'web-extが見つからないため、npx経由で実行します。'
    $webExtCommand = 'npx'
    $webExtArgs = @('--yes','web-ext','run','--source-dir', $SourceDir, '--firefox', $FirefoxPath)
} else {
    $webExtCommand = $webExt.Source
    $webExtArgs = @('run','--source-dir', $SourceDir, '--firefox', $FirefoxPath)
}

if ($BrowserConsole) { $webExtArgs += '--browser-console' }

Write-Host "UVD Developer Edition runner"
Write-Host "Source: $SourceDir"
Write-Host "Firefox: $FirefoxPath"
Write-Host 'web-ext runはソース変更を監視し、自動的に一時アドオンを再読み込みします。'
& $webExtCommand @webExtArgs
exit $LASTEXITCODE
