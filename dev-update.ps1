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

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

if ([string]::IsNullOrWhiteSpace($SourceDir)) {
    $SourceDir = Join-Path $env:LOCALAPPDATA 'Universal-Video-Detector-Dev'
}
$SourceDir = [IO.Path]::GetFullPath($SourceDir)
$parent = Split-Path -Parent $SourceDir
New-Item -ItemType Directory -Force -Path $parent | Out-Null

$xpiPath = Join-Path $SourceDir 'UVD-Developer.xpi'
$tempRoot = Join-Path $env:TEMP ("UVD-DevUpdate-" + [guid]::NewGuid().ToString('N'))
$zipPath = Join-Path $tempRoot 'source.zip'
$extractRoot = Join-Path $tempRoot 'extract'
$stageDir = Join-Path $tempRoot 'stage'
$xpiTemp = Join-Path $tempRoot 'UVD-Developer.xpi'
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

    foreach ($name in $allowed | Where-Object { $_ -ne 'manifest.json' }) {
        $src = Join-Path $stageDir $name
        if (Test-Path -LiteralPath $src) {
            Copy-Item -LiteralPath $src -Destination $SourceDir -Recurse -Force
        }
    }
    Copy-Item -LiteralPath (Join-Path $stageDir 'manifest.json') -Destination (Join-Path $SourceDir 'manifest.json') -Force

    $versionedFiles = @(
        (Join-Path $SourceDir 'ui/popup.js'),
        (Join-Path $SourceDir 'background/service.js')
    )
    foreach ($file in $versionedFiles) {
        if (-not (Test-Path -LiteralPath $file)) { throw "Required versioned source file is missing: $file" }
        $text = Get-Content -LiteralPath $file -Raw
        $updated = [regex]::Replace($text, "const UVD_VERSION='[^']+';", "const UVD_VERSION='$($remoteVersion.ToString())';", 1)
        if ($updated -eq $text) { throw "UVD_VERSION declaration was not found: $file" }
        Write-Utf8NoBom -Path $file -Text $updated
    }

    $popupHtml = Join-Path $SourceDir 'ui/popup.html'
    if (-not (Test-Path -LiteralPath $popupHtml)) { throw "Required popup source file is missing: $popupHtml" }
    $html = Get-Content -LiteralPath $popupHtml -Raw
    $html = [regex]::Replace($html, '<title>[^<]* - Video Detector</title>', "<title>$($remoteVersion.ToString()) - Video Detector</title>", 1)
    $html = [regex]::Replace($html, '(<span class="version">)[^<]*(</span>)', "`$1$($remoteVersion.ToString())`$2", 1)
    Write-Utf8NoBom -Path $popupHtml -Text $html

    $installedManifest = Get-Content -LiteralPath (Join-Path $SourceDir 'manifest.json') -Raw | ConvertFrom-Json
    $installedVersion = Get-FormalVersion ([string]$installedManifest.version)
    if ($installedVersion -ne $remoteVersion) { throw "Installed version verification failed: $installedVersion != $remoteVersion" }

    foreach ($file in $versionedFiles) {
        $text = Get-Content -LiteralPath $file -Raw
        if ($text -notmatch [regex]::Escape("const UVD_VERSION='$($remoteVersion.ToString())';")) { throw "Installed runtime version verification failed: $file" }
    }

    # Firefox Developer Edition policy points to this stable local XPI path.
    # Replacing the XPI makes Firefox update/reinstall the extension automatically.
    $xpiEntries = @('manifest.json','THIRD-PARTY-NOTICES.md','adapters','background','content','settings','ui')
    if (Test-Path -LiteralPath $xpiTemp) { Remove-Item -LiteralPath $xpiTemp -Force }
    Compress-Archive -Path ($xpiEntries | ForEach-Object { Join-Path $SourceDir $_ }) -DestinationPath $xpiTemp -Force
    Move-Item -LiteralPath $xpiTemp -Destination $xpiPath -Force

    Write-Host "Updated UVD Developer source and XPI to $($remoteVersion.ToString())."
    Write-Host "Firefox Developer Edition will detect the changed local XPI when the developer policy is installed."
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
