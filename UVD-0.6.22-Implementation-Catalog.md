# UVD 0.6.22 Implementation Catalog

## Base
- Sole development base: Universal-Video-Detector-0.6.21.zip.
- No rollback and no new project created.

## Purpose
- Create the next signed extension solely to test Firefox automatic update from formally installed 0.6.21 to 0.6.22.

## Changes
1. Advanced the extension formal version from 0.6.21 to 0.6.22.
2. Synchronized the extension version in manifest.json, ui/popup.html, ui/popup.js, and background/service.js.
3. Preserved update_url and all existing detection, rawCandidates lifecycle, internal-list authority, download, CoApp, Native Messaging, Adapter, settings, diagnostics, and phase boundaries.
4. CoApp implementation remains 0.6.18 and remains independently versioned.

## Verification
- Formal version x.y.z: P (0.6.22).
- Version synchronization: P in the local 0.6.22 artifact.
- JavaScript syntax: P in the local 0.6.22 artifact.
- Manifest JSON parse: P in the local 0.6.22 artifact.
- Adapter/settings retained: P.
- ZIP root structure: P; no version wrapper.
- AMO signing/release: H until GitHub Actions execution.
- Firefox 0.6.21 -> 0.6.22 automatic update: H until runtime verification.

## Update Phase status
- Phase 0 distribution/signing validation: in progress.
- Automatic update runtime test is the current gate.
- Phase 2 XPI integrity: H pending runtime test.
- Phase 3 CoApp automatic update: not started.
- Phase 4 Extension/CoApp compatibility: not started.
- Phase 5 restart/version verification: not started.
- Load Reduction Phase: temporarily paused.
