$ErrorActionPreference = 'Stop'
$manifest = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'uvd_companion_host.json'
if (-not (Test-Path -LiteralPath $manifest)) { throw 'uvd_companion_host.json was not found. Run setup-coapp.ps1 first.' }
$reg = 'HKCU:\Software\Mozilla\NativeMessagingHosts\universal_video_detector_companion'
New-Item -Path $reg -Force | Out-Null
Set-ItemProperty -Path $reg -Name '(default)' -Value (Resolve-Path $manifest).Path
Write-Host 'Universal Video Detector Companion Native Messaging Host registered.'
Write-Host 'Restart Firefox before testing.'
