$ErrorActionPreference='Stop'
$hostName='universal_video_detector_companion'
$reg="HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"
if(-not (Test-Path -LiteralPath $reg)){throw "Native Messaging registry key not found: $reg"}
$manifest=(Get-ItemProperty -Path $reg -Name '(default)' -ErrorAction Stop).'(default)'
if(-not (Test-Path -LiteralPath $manifest)){throw "Native Messaging manifest not found: $manifest"}
$j=Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
if($j.name -ne $hostName){throw "Manifest name mismatch: $($j.name)"}
if($j.type -ne 'stdio'){throw "Manifest type must be stdio"}
$hostPath = if([System.IO.Path]::IsPathRooted([string]$j.path)){[string]$j.path}else{Join-Path (Split-Path -Parent $manifest) ([string]$j.path)}
if(-not (Test-Path -LiteralPath $hostPath)){throw "Native host executable not found: $hostPath"}
$ext='universal-video-detector@example.local'
if(@($j.allowed_extensions) -notcontains $ext){throw "Extension ID is not in allowed_extensions: $ext"}
Write-Host "OK"
Write-Host "Registry: $reg"
Write-Host "Manifest: $manifest"
Write-Host "Host: $hostPath"
Write-Host "Allowed extension: $ext"
