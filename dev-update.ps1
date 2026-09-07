param(
    [string]$SourceDir = "",
    [string]$Branch = "main"
)

$ErrorActionPreference = 'Stop'
$Repo = 'Phys1cz0/Universal-Video-Detector'
$ArchiveUrl = "https://github.com/$Repo/archive/refs/heads/$Branch.zip"

function Get-FormalVersion([string]$Value) {
    $m = [regex]::Match($Value, '^([0-9]+)\.([0-9]+)\.([0-9]+)$')
    if (-not $m.Success) { throw "正式バージョンではありません: $Value" }
    return [version]::new([int]$m.Groups[1].Value, [int]$m.Groups[2].Value, [int]$m.Groups[3].Value)
}

if ([string]::IsNullOrWhiteSpace($SourceDir)) {
    $SourceDir = Join-Path $env:LOCALAPPDATA 'Universal-Video-Detector-Dev'
}
$SourceDir = [IO.Path]::GetFullPath($SourceDir)
$parent = Split-Path -Parent $SourceDir
New-Item -ItemType Directory -Force -Path $parent | Out-Null

$tempRoot = Join-Path $env:TEMP ("UVD-DevUpdate-" + [guid]::NewGuid().ToString('N'))
$zipPath = Join-Path $tempRoot 'source.zip'
$extractRoot = Join-Path $tempRoot 'extract'
$stageDir = Join-Path $tempRoot 'stage'
New-Item -ItemType Directory -Force -Path $tempRoot,$extractRoot,$stageDir | Out-Null

try {
    Write-Host "UVD Developer Update"
    Write-Host "Source: $SourceDir"
    Write-Host "Download: $ArchiveUrl"

    Invoke-WebRequest -Uri $ArchiveUrl -OutFile $zipPath -UseBasicParsing
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force

    $root = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
    if (-not $root) { throw 'GitHub archive root was not found.' }
    $manifestPath = Join-Path $root.FullName 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'manifest.json was not found in the downloaded source.' }

    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $remoteVersion = Get-FormalVersion ([string]$manifest.version)

    $localVersion = $null
    $localManifestPath = Join-Path $SourceDir 'manifest.json'
    if (Test-Path -LiteralPath $localManifestPath) {
        try {
            $localManifest = Get-Content -LiteralPath $localManifestPath -Raw | ConvertFrom-Json
            $localVersion = Get-FormalVersion ([string]$localManifest.version)
        } catch { $localVersion = $null }
    }

    if ($localVersion -and $remoteVersion -le $localVersion) {
        Write-Host "Already current: $($localVersion.ToString())"
        exit 0
    }

    $allowed = @(
        'manifest.json',
        'THIRD-PARTY-NOTICES.md',
        'adapters',
        'background',
        'content',
        'settings',
        'ui'
    )

    foreach ($name in $allowed) {
        $src = Join-Path $root.FullName $name
        if (Test-Path -LiteralPath $src) {
            Copy-Item -LiteralPath $src -Destination $stageDir -Recurse -Force
        }
    }

    if (-not (Test-Path -LiteralPath (Join-Path $stageDir 'manifest.json'))) {
        throw 'Staged manifest.json is missing.'
    }

    # Copy the extension tree first and manifest.json last so web-ext observes
    # the final formal version only after the rest of the tree is present.
    foreach ($name in $allowed | Where-Object { $_ -ne 'manifest.json' }) {
        $src = Join-Path $stageDir $name
        if (Test-Path -LiteralPath $src) {
            Copy-Item -LiteralPath $src -Destination $SourceDir -Recurse -Force
        }
    }
    Copy-Item -LiteralPath (Join-Path $stageDir 'manifest.json') -Destination (Join-Path $SourceDir 'manifest.json') -Force

    $installedManifest = Get-Content -LiteralPath (Join-Path $SourceDir 'manifest.json') -Raw | ConvertFrom-Json
    $installedVersion = Get-FormalVersion ([string]$installedManifest.version)
    if ($installedVersion -ne $remoteVersion) { throw "Installed version verification failed: $installedVersion != $remoteVersion" }

    Write-Host "Updated UVD Developer source to $($remoteVersion.ToString())."
    Write-Host "If web-ext run is active for this source directory, Firefox will reload the extension automatically."
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
