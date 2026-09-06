$ErrorActionPreference = 'Stop'
$reg = 'HKCU:\Software\Mozilla\NativeMessagingHosts\universal_video_detector_companion'
if (Test-Path -LiteralPath $reg) { Remove-Item -LiteralPath $reg -Recurse -Force }
Write-Host 'Universal Video Detector Companion Native Messaging Host unregistered.'
