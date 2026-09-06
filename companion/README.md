Universal Video Detector Companion 0.6.18

Windows-only Native Messaging companion. Python is not required.

Architecture
- uvd_companion.exe is the Native Messaging host and job manager.
- The same executable starts isolated download workers with `--worker <job.json>`.
- Jobs are persisted under `UVD-Companion\jobs` and mirrored into `uvd_store.json`, so a Native Messaging request ending does not cancel a download and CoApp can restore its authoritative state.
- Each worker has its own PID recorded in the job file. If it stops unexpectedly, the next jobs query marks the job failed instead of leaving it queued forever.
- Download item metadata is kept temporarily under `jobitems` and includes page URL, Referer, User-Agent, cookies, and relevant request headers.
- Direct HTTP media is downloaded by the worker. HLS/DASH are handed to ffmpeg for MP4 output.

Install
1. Extract the extension.
2. Run `companion\setup-coapp.ps1` with Windows PowerShell.
3. Select the installation root. The script creates `UVD-Companion`, builds the host, registers the Firefox Native Messaging manifest, and performs host/worker smoke tests.
4. Restart Firefox once after a CoApp update. Extension-only updates do not require reinstalling the CoApp.

The extension owns the user download-root setting. The CoApp only opens the Windows folder picker and returns the selected path.

Bundled tools
- setup-coapp.ps1 builds `uninstaller.exe` in the same UVD-Companion folder.
- setup-coapp.ps1 downloads a Windows x64 LGPL FFmpeg build and installs `ffmpeg.exe` beside `uvd_companion.exe`.
- If no custom FFmpeg path is configured, the Companion automatically uses the same-folder `ffmpeg.exe` for HLS/DASH conversion.
- `uninstaller.exe` stops UVD processes, removes the Firefox Native Messaging registry entry, and removes the UVD-Companion folder.
- The download history UI can delete extension history, CoApp logs, or both.

CoApp version is synchronized with this packaged UVD version for release consistency. The 0.6.18 release keeps CoApp playback/download logic and aligns the companion version with the packaged extension.
