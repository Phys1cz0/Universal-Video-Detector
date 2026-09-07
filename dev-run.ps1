param(
    [string]$SourceDir = "",
    [string]$FirefoxPath = ""
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($SourceDir)) {
    $SourceDir = Join-Path $env:LOCALAPPDATA 'Universal-Video-Detector-Dev'
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

& (Join-Path $PSScriptRoot 'setup-dev.ps1') -SourceDir $SourceDir -FirefoxPath $FirefoxPath
if ($LASTEXITCODE -ne 0) { throw 'Developer setup failed.' }

Write-Host 'セットアップ完了。今後はFirefox Developer Editionを通常起動すればUVDが自動ロードされます。'
Write-Host '更新時は dev-update.ps1 を実行してください。'
