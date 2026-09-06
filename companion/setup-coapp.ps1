$ErrorActionPreference = 'Stop'

function Show-UvdError([string]$message) {
    $text = if ([string]::IsNullOrWhiteSpace($message)) { 'Unknown setup error.' } else { $message }
    try { Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue } catch {}
    try { [System.Windows.Forms.Clipboard]::SetText($text) } catch { try { Set-Clipboard -Value $text -ErrorAction SilentlyContinue } catch {} }
    try { [System.Windows.Forms.MessageBox]::Show($text + [Environment]::NewLine + [Environment]::NewLine + 'The error text was copied to the clipboard.', 'Universal Video Detector', 'OK', 'Error') | Out-Null } catch {}
}

trap { Show-UvdError $_.Exception.ToString(); exit 1 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Microsoft.CSharp

$reg = 'HKCU:\Software\Mozilla\NativeMessagingHosts\universal_video_detector_companion'

function Show-UvdStep([string]$message) {
    Write-Host ('[UVD Setup] ' + [string]$message)
}

function Fail($message) {
    $text = [string]$message
    Write-Error $text
    exit 1
}

function Stop-UvdProcesses {
    $names = @('uvd_companion', 'uvd_downloader_worker')
    foreach ($name in $names) {
        $processes = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
        foreach ($process in $processes) {
            try { $process.CloseMainWindow() | Out-Null } catch {}
        }
    }
    Start-Sleep -Milliseconds 500
    foreach ($name in $names) {
        $processes = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
        foreach ($process in $processes) {
            try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
    Start-Sleep -Milliseconds 500
}

function Get-RegisteredManifestPath {
    if (-not (Test-Path -LiteralPath $reg)) { return $null }
    try {
        $value = (Get-ItemProperty -LiteralPath $reg -Name '(default)' -ErrorAction Stop).'(default)'
        if ([string]::IsNullOrWhiteSpace([string]$value)) { return $null }
        $path = [string]$value
        if (($path.StartsWith('"')) -and ($path.EndsWith('"'))) { $path = $path.Substring(1, $path.Length - 2) }
        $path = [Environment]::ExpandEnvironmentVariables($path)
        if (-not [System.IO.Path]::IsPathRooted($path)) {
            $path = Join-Path (Get-Location).Path $path
        }
        return [System.IO.Path]::GetFullPath($path)
    } catch {
        throw ('Failed to read the existing Native Messaging manifest from the registry: ' + $_.Exception.Message)
    }
}

function Get-ExistingCoAppFolder([string]$manifestPath) {
    if ([string]::IsNullOrWhiteSpace($manifestPath)) { return $null }
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $null }
    $dir = Split-Path -Parent $manifestPath
    if ([string]::IsNullOrWhiteSpace($dir)) { return $null }
    return [System.IO.Path]::GetFullPath($dir)
}

try {
    $source = Split-Path -Parent $MyInvocation.MyCommand.Path
    $extensionRoot = Split-Path -Parent $source
    $extensionManifest = Join-Path $extensionRoot 'manifest.json'
    if (-not (Test-Path -LiteralPath $extensionManifest -PathType Leaf)) { throw ('Extension manifest not found: ' + $extensionManifest) }

    $extJson = [System.IO.File]::ReadAllText($extensionManifest, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $extensionId = [string]$extJson.browser_specific_settings.gecko.id
    if ([string]::IsNullOrWhiteSpace($extensionId)) { throw 'Firefox extension ID is missing from manifest.json.' }

    # The bundled metadata is the expected CoApp version for this installer.
    # Keep it explicit so post-install verification never compares against an
    # uninitialized value. The C# source is validated against the same value below.
    $coAppVersionFile = Join-Path $source 'coapp-version.json'
    if (-not (Test-Path -LiteralPath $coAppVersionFile -PathType Leaf)) { throw ('CoApp version metadata not found: ' + $coAppVersionFile) }
    $coAppVersionJson = [System.IO.File]::ReadAllText($coAppVersionFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $coAppVersion = [string]$coAppVersionJson.coAppVersion
    if ([string]::IsNullOrWhiteSpace($coAppVersion)) { throw 'CoApp version metadata is empty.' }
    $coAppVersionParsed = $null
    if (-not [System.Version]::TryParse($coAppVersion, [ref]$coAppVersionParsed)) { throw ('Invalid CoApp version metadata: ' + $coAppVersion) }

    # Do NOT delete the registry first. Read the currently registered manifest first
    # so an existing installation can be updated in place.
    $registeredManifest = Get-RegisteredManifestPath
    $existingCoApp = Get-ExistingCoAppFolder $registeredManifest
    $dest = $null
    $replaceExisting = $false

    if ($existingCoApp -and (Test-Path -LiteralPath $existingCoApp -PathType Container)) {
        $answer = [System.Windows.Forms.MessageBox]::Show(
            ('An existing UVD-Companion was found at:' + [Environment]::NewLine + [Environment]::NewLine +
             $existingCoApp + [Environment]::NewLine + [Environment]::NewLine +
             'Replace this CoApp in the same folder?'),
            'Universal Video Detector',
            'YesNo',
            'Question')
        if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
            $dest = $existingCoApp
            $replaceExisting = $true
        }
    }

    if (-not $dest) {
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = 'Select the installation folder for UVD-Companion'
        $dialog.ShowNewFolderButton = $true
        $result = $dialog.ShowDialog()
        if ($result -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
        $root = $dialog.SelectedPath
        $dest = Join-Path $root 'UVD-Companion'
    }

    $dest = [System.IO.Path]::GetFullPath($dest)
    $sourceFull = [System.IO.Path]::GetFullPath($source)
    if ($dest.TrimEnd('\') -ieq $sourceFull.TrimEnd('\')) {
        throw 'The selected UVD-Companion folder cannot be the extension companion source folder.'
    }

    # Firefox can keep the native host process alive. Ask before closing it,
    # then stop CoApp and downloader workers immediately before replacement.
    $firefox = @(Get-Process -Name firefox -ErrorAction SilentlyContinue)
    if ($firefox.Count -gt 0) {
        $answer = [System.Windows.Forms.MessageBox]::Show(
            'Firefox is currently running. Close Firefox now before installing UVD-Companion?',
            'Universal Video Detector',
            'YesNo',
            'Question')
        if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
            $firefox | Stop-Process -Force
            Start-Sleep -Seconds 2
        }
    }

    Stop-UvdProcesses

    $preservedFfmpeg = Join-Path $env:TEMP ('uvd-preserved-ffmpeg-' + [Guid]::NewGuid().ToString('N') + '.exe')
    $oldFfmpeg = Join-Path $dest 'ffmpeg.exe'
    $hasOldFfmpeg = Test-Path -LiteralPath $oldFfmpeg -PathType Leaf
    if ($hasOldFfmpeg) {
        Show-UvdStep 'Existing ffmpeg.exe found. Preserving it during the update.'
        Copy-Item -LiteralPath $oldFfmpeg -Destination $preservedFfmpeg -Force
    }
    if (Test-Path -LiteralPath $dest) {
        if (-not $replaceExisting) {
            $answer = [System.Windows.Forms.MessageBox]::Show(
                ('The selected installation folder already contains UVD-Companion:' + [Environment]::NewLine + [Environment]::NewLine +
                 $dest + [Environment]::NewLine + [Environment]::NewLine + 'Replace it?'),
                'Universal Video Detector', 'YesNo', 'Question')
            if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { exit 0 }
        }
    }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    if ($hasOldFfmpeg -and (Test-Path -LiteralPath $preservedFfmpeg -PathType Leaf)) {
        Copy-Item -LiteralPath $preservedFfmpeg -Destination (Join-Path $dest 'ffmpeg.exe') -Force
        Remove-Item -LiteralPath $preservedFfmpeg -Force -ErrorAction SilentlyContinue
    }

    # Registry is changed only after the old installation location has been
    # identified and the old processes have been stopped.
    if (Test-Path -LiteralPath $reg) {
        Remove-Item -LiteralPath $reg -Recurse -Force -ErrorAction SilentlyContinue
    }

    $sourceCs = Join-Path $source 'uvd_companion.cs'
    $destCs = Join-Path $dest 'uvd_companion.cs'
    $exe = Join-Path $dest 'uvd_companion.exe'
    $workerExe = Join-Path $dest 'uvd_downloader_worker.exe'
    $manifest = Join-Path $dest 'uvd_companion_host.json'
    Copy-Item -LiteralPath $sourceCs -Destination $destCs -Force

    $code = [System.IO.File]::ReadAllText($sourceCs, [System.Text.Encoding]::UTF8)
    $versionMatch = [regex]::Match($code, 'const\s+string\s+Version\s*=\s*"([^"]+)"\s*;')
    if (-not $versionMatch.Success) { throw 'CoApp source version declaration was not found.' }
    $sourceCoAppVersion = [string]$versionMatch.Groups[1].Value
    if ($sourceCoAppVersion -ne $coAppVersion) { throw ('CoApp version metadata/source mismatch. Metadata=' + $coAppVersion + ' Source=' + $sourceCoAppVersion) }
    $provider = New-Object Microsoft.CSharp.CSharpCodeProvider
    $parameters = New-Object System.CodeDom.Compiler.CompilerParameters
    $parameters.GenerateExecutable = $true
    $parameters.GenerateInMemory = $false
    $parameters.OutputAssembly = $exe
    $parameters.CompilerOptions = '/target:exe /platform:anycpu'
    foreach ($ref in @('System.dll','System.Core.dll','System.Windows.Forms.dll','System.Web.Extensions.dll','System.Xml.dll','System.Threading.Tasks.dll')) {
        [void]$parameters.ReferencedAssemblies.Add($ref)
    }

    $compile = $provider.CompileAssemblyFromSource($parameters, $code)
    if ($compile.Errors.HasErrors -or -not (Test-Path -LiteralPath $exe)) {
        $errors = ($compile.Errors | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
        throw ('Failed to build uvd_companion.exe.' + [Environment]::NewLine + $errors)
    }

    $workerParameters = New-Object System.CodeDom.Compiler.CompilerParameters
    $workerParameters.GenerateExecutable = $true
    $workerParameters.GenerateInMemory = $false
    $workerParameters.OutputAssembly = $workerExe
    $workerParameters.CompilerOptions = '/target:exe /platform:anycpu'
    foreach ($ref in @('System.dll','System.Core.dll','System.Windows.Forms.dll','System.Web.Extensions.dll','System.Xml.dll','System.Threading.Tasks.dll')) {
        [void]$workerParameters.ReferencedAssemblies.Add($ref)
    }
    $workerCompile = $provider.CompileAssemblyFromSource($workerParameters, $code)
    if ($workerCompile.Errors.HasErrors -or -not (Test-Path -LiteralPath $workerExe)) {
        $errors = ($workerCompile.Errors | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
        throw ('Failed to build uvd_downloader_worker.exe.' + [Environment]::NewLine + $errors)
    }

    # Build the same-folder uninstaller. It removes the Native Messaging registration and the CoApp folder.
    $uninstallerSource = Join-Path $source 'uninstaller.cs'
    $uninstallerExe = Join-Path $dest 'uninstaller.exe'
    Copy-Item -LiteralPath $uninstallerSource -Destination (Join-Path $dest 'uninstaller.cs') -Force
    $uninstallerCode = [System.IO.File]::ReadAllText($uninstallerSource, [System.Text.Encoding]::UTF8)
    $uninstallerParameters = New-Object System.CodeDom.Compiler.CompilerParameters
    $uninstallerParameters.GenerateExecutable = $true
    $uninstallerParameters.GenerateInMemory = $false
    $uninstallerParameters.OutputAssembly = $uninstallerExe
    $uninstallerParameters.CompilerOptions = '/target:winexe /platform:anycpu'
    foreach ($ref in @('System.dll','System.Core.dll','System.Windows.Forms.dll')) { [void]$uninstallerParameters.ReferencedAssemblies.Add($ref) }
    $uninstallerCompile = $provider.CompileAssemblyFromSource($uninstallerParameters, $uninstallerCode)
    if ($uninstallerCompile.Errors.HasErrors -or -not (Test-Path -LiteralPath $uninstallerExe)) {
        $errors = ($uninstallerCompile.Errors | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
        throw ('Failed to build uninstaller.exe.' + [Environment]::NewLine + $errors)
    }

    # Install a bundled Windows FFmpeg beside the CoApp only when it is missing.
    # An existing ffmpeg.exe was preserved above and must never trigger a new download.
    $ffmpegExe = Join-Path $dest 'ffmpeg.exe'
    if (Test-Path -LiteralPath $ffmpegExe -PathType Leaf) {
        Show-UvdStep 'Existing ffmpeg.exe is present. Skipping FFmpeg download.'
    } else {
        Show-UvdStep 'Downloading required resource: FFmpeg for Windows x64.'
        $ffmpegZip = Join-Path $env:TEMP ('uvd-ffmpeg-' + [Guid]::NewGuid().ToString('N') + '.zip')
        $ffmpegExtract = Join-Path $env:TEMP ('uvd-ffmpeg-' + [Guid]::NewGuid().ToString('N'))
        $ffmpegUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-lgpl-9.0.zip'
        try {
            Invoke-WebRequest -Uri $ffmpegUrl -OutFile $ffmpegZip -UseBasicParsing
            Show-UvdStep 'Extracting FFmpeg package.'
            New-Item -ItemType Directory -Force -Path $ffmpegExtract | Out-Null
            Expand-Archive -LiteralPath $ffmpegZip -DestinationPath $ffmpegExtract -Force
            $foundFfmpeg = Get-ChildItem -LiteralPath $ffmpegExtract -Filter 'ffmpeg.exe' -File -Recurse | Select-Object -First 1
            if (-not $foundFfmpeg) { throw 'The downloaded FFmpeg package did not contain ffmpeg.exe.' }
            Copy-Item -LiteralPath $foundFfmpeg.FullName -Destination $ffmpegExe -Force
        } finally {
            Remove-Item -LiteralPath $ffmpegExtract -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $ffmpegZip -Force -ErrorAction SilentlyContinue
        }
    }
    if (-not (Test-Path -LiteralPath $ffmpegExe -PathType Leaf)) { throw 'Bundled ffmpeg.exe was not installed.' }

    $manifestObject = [ordered]@{
        name = 'universal_video_detector_companion'
        description = 'Universal Video Detector Companion'
        path = $exe
        type = 'stdio'
        allowed_extensions = @($extensionId)
    }
    $json = $manifestObject | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($manifest, $json, (New-Object System.Text.UTF8Encoding($false)))

    New-Item -Path $reg -Force | Out-Null
    Set-ItemProperty -Path $reg -Name '(default)' -Value $manifest
    $registeredManifestAfter = [string](Get-ItemProperty -Path $reg -Name '(default)').'(default)'
    if ($registeredManifestAfter -ne $manifest) { throw ('Native Messaging registry value mismatch: ' + $registeredManifestAfter) }

    $smokePsi = New-Object System.Diagnostics.ProcessStartInfo
    $smokePsi.FileName = $exe
    $smokePsi.Arguments = '--self-test'
    $smokePsi.UseShellExecute = $false
    $smokePsi.CreateNoWindow = $true
    $smokePsi.RedirectStandardOutput = $true
    $smokePsi.RedirectStandardError = $true
    $smoke = New-Object System.Diagnostics.Process
    $smoke.StartInfo = $smokePsi
    [void]$smoke.Start()
    $stdout = $smoke.StandardOutput.ReadToEnd()
    $stderr = $smoke.StandardError.ReadToEnd()
    $smoke.WaitForExit(10000) | Out-Null
    if (-not $smoke.HasExited) { try { $smoke.Kill() } catch {} ; throw 'CoApp self-test timed out.' }
    if ($smoke.ExitCode -ne 0 -or $stdout.Trim() -ne 'UVD-COAPP-OK') { throw ('CoApp executable self-test failed. ExitCode=' + $smoke.ExitCode + ' Output=' + $stdout.Trim() + ' Error=' + $stderr.Trim()) }
    $smoke.Dispose()

    $versionPsi = New-Object System.Diagnostics.ProcessStartInfo
    $versionPsi.FileName = $exe
    $versionPsi.Arguments = '--version'
    $versionPsi.UseShellExecute = $false
    $versionPsi.CreateNoWindow = $true
    $versionPsi.RedirectStandardOutput = $true
    $versionProc = New-Object System.Diagnostics.Process
    $versionProc.StartInfo = $versionPsi
    [void]$versionProc.Start()
    $installedVersion = $versionProc.StandardOutput.ReadToEnd().Trim()
    $versionProc.WaitForExit(10000) | Out-Null
    if (-not $versionProc.HasExited) { try { $versionProc.Kill() } catch {} ; throw 'CoApp version verification timed out.' }
    if ($installedVersion -ne $coAppVersion) { throw ('Installed CoApp version mismatch. Expected=' + $coAppVersion + ' Actual=' + $installedVersion) }
    $versionProc.Dispose()

    $workerPsi = New-Object System.Diagnostics.ProcessStartInfo
    $workerPsi.FileName = $workerExe
    $workerPsi.Arguments = '--worker-self-test'
    $workerPsi.UseShellExecute = $false
    $workerPsi.CreateNoWindow = $true
    $workerPsi.RedirectStandardOutput = $true
    $workerPsi.RedirectStandardError = $true
    $workerSmoke = New-Object System.Diagnostics.Process
    $workerSmoke.StartInfo = $workerPsi
    [void]$workerSmoke.Start()
    $workerOut = $workerSmoke.StandardOutput.ReadToEnd()
    $workerErr = $workerSmoke.StandardError.ReadToEnd()
    $workerSmoke.WaitForExit(10000) | Out-Null
    if (-not $workerSmoke.HasExited) { try { $workerSmoke.Kill() } catch {} ; throw 'Download worker self-test timed out.' }
    if ($workerSmoke.ExitCode -ne 0 -or $workerOut.Trim() -ne 'UVD-WORKER-OK') { throw ('Download worker self-test failed. ExitCode=' + $workerSmoke.ExitCode + ' Output=' + $workerOut.Trim() + ' Error=' + $workerErr.Trim()) }
    $workerSmoke.Dispose()

    $checkManifest = [System.IO.File]::ReadAllText($manifest, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ([string]$checkManifest.name -ne 'universal_video_detector_companion') { throw 'Native manifest name mismatch.' }
    if ([string]$checkManifest.type -ne 'stdio') { throw 'Native manifest type must be stdio.' }
    if (-not (Test-Path -LiteralPath ([string]$checkManifest.path))) { throw 'Native manifest executable path does not exist.' }
    if (-not (Test-Path -LiteralPath $workerExe)) { throw 'Downloader worker executable does not exist.' }
    if (-not (Test-Path -LiteralPath $uninstallerExe)) { throw 'Uninstaller executable does not exist.' }
    if (-not (Test-Path -LiteralPath $ffmpegExe)) { throw 'Bundled ffmpeg.exe does not exist.' }
    if (-not ($checkManifest.allowed_extensions -contains $extensionId)) { throw 'Native manifest allowed_extensions does not contain the Firefox extension ID.' }

    [System.Windows.Forms.MessageBox]::Show(
        ('CoApp installed successfully.' + [Environment]::NewLine + [Environment]::NewLine +
         'Installed at:' + [Environment]::NewLine + $dest + [Environment]::NewLine + [Environment]::NewLine +
         'Firefox extension ID:' + [Environment]::NewLine + $extensionId + [Environment]::NewLine + [Environment]::NewLine +
         'Native Messaging Host: registered' + [Environment]::NewLine +
         'CoApp self-test: OK' + [Environment]::NewLine +
         'Download worker self-test: OK' + [Environment]::NewLine +
         'Bundled FFmpeg: ' + $ffmpegExe + [Environment]::NewLine +
         'Uninstaller: ' + $uninstallerExe + [Environment]::NewLine +
         'Downloader Worker: ' + $workerExe + [Environment]::NewLine +
         'Native manifest: ' + $manifest + [Environment]::NewLine + [Environment]::NewLine +
         'Restart Firefox before testing.'),
        'Universal Video Detector') | Out-Null
}
catch { $full=$_.Exception.ToString(); Show-UvdError $full; exit 1 }
