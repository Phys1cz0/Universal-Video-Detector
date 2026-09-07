param(
    [string]$SourceDir = "",
    [string]$FirefoxPath = ""
)

$ErrorActionPreference = 'Stop'

# Firefox is normally installed under Program Files, so policy installation may
# require elevation. Re-launch this one-time setup with UAC when necessary.
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`")
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments | Out-Null
    exit 0
}

if ([string]::IsNullOrWhiteSpace($SourceDir)) {
    $SourceDir = Join-Path $env:LOCALAPPDATA 'Universal-Video-Detector-Dev'
}
$SourceDir = [IO.Path]::GetFullPath($SourceDir)
New-Item -ItemType Directory -Force -Path $SourceDir | Out-Null

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
    throw 'Firefox Developer Editionのfirefox.exeを指定してください。'
}

$firefoxDir = Split-Path -Parent $FirefoxPath
$distributionDir = Join-Path $firefoxDir 'distribution'
$policyPath = Join-Path $distributionDir 'policies.json'
$xpiPath = Join-Path $SourceDir 'UVD-Developer.xpi'

if (-not (Test-Path -LiteralPath $xpiPath)) {
    $updateScript = Join-Path $PSScriptRoot 'dev-update.ps1'
    & $updateScript -SourceDir $SourceDir
    if ($LASTEXITCODE -ne 0) { throw 'Developer source initialization failed.' }
}
if (-not (Test-Path -LiteralPath $xpiPath)) { throw "UVD XPI was not created: $xpiPath" }

# Developer Edition permits unsigned extension testing when signature enforcement
# is disabled. Persist the setting in the user's Firefox profiles.
$profilesRoot = Join-Path $env:APPDATA 'Mozilla\Firefox\Profiles'
if (Test-Path -LiteralPath $profilesRoot) {
    $profiles = Get-ChildItem -LiteralPath $profilesRoot -Directory
    foreach ($profile in $profiles) {
        $userJs = Join-Path $profile.FullName 'user.js'
        $existing = if (Test-Path -LiteralPath $userJs) { Get-Content -LiteralPath $userJs -Raw } else { '' }
        if ($existing -notmatch 'xpinstall\.signatures\.required') {
            $line = "user_pref('xpinstall.signatures.required', false);"
            $text = if ([string]::IsNullOrEmpty($existing)) { $line + "`r`n" } else { $existing.TrimEnd() + "`r`n" + $line + "`r`n" }
            $utf8 = New-Object System.Text.UTF8Encoding($false)
            [System.IO.File]::WriteAllText($userJs, $text, $utf8)
        }
    }
}

New-Item -ItemType Directory -Force -Path $distributionDir | Out-Null

if (Test-Path -LiteralPath $policyPath) {
    $backup = "$policyPath.uvd-backup"
    if (-not (Test-Path -LiteralPath $backup)) {
        Copy-Item -LiteralPath $policyPath -Destination $backup -Force
    }
}

$xpiUri = ([System.Uri]::new($xpiPath)).AbsoluteUri
$policy = [ordered]@{
    policies = [ordered]@{
        ExtensionSettings = [ordered]@{
            'universal-video-detector@example.local' = [ordered]@{
                installation_mode = 'force_installed'
                install_url = $xpiUri
                updates_disabled = $false
            }
        }
    }
}
$json = $policy | ConvertTo-Json -Depth 8
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($policyPath, $json, $utf8)

Write-Host 'UVD Developer Edition auto-load setup completed.'
Write-Host "Firefox: $FirefoxPath"
Write-Host "XPI: $xpiPath"
Write-Host "Policy: $policyPath"
Write-Host 'Firefox Developer Editionを通常起動すると、UVDを自動ロードします。'
Write-Host '初回はFirefoxを完全終了してから再起動してください。'
