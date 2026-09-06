# UVD 0.6.21 Implementation Catalog

## Base
- Sole development base: Universal-Video-Detector-0.6.20.zip.
- No rollback and no new project created.

## Purpose
Advance the extension version after Mozilla AMO rejected re-submission of 0.6.20 because that version already exists, and continue Update Phase distribution/signing validation.

## Changes
1. Extension formal version advanced from 0.6.20 to 0.6.21.
2. Synchronized the extension version in manifest.json, ui/popup.html, ui/popup.js, and background/service.js in the local 0.6.21 artifact.
3. Added Firefox Gecko update_url pointing to the stable GitHub Release latest/update.json endpoint for self-distributed update discovery.
4. Preserved existing detection, rawCandidates lifecycle, internal-list authority, download, CoApp, Native Messaging, Adapter, settings, diagnostics, and phase boundaries.
5. CoApp implementation remains 0.6.18 and remains independently versioned.

## Verification
- Formal version x.y.z: P (0.6.21).
- Version synchronization: P in the packaged artifact.
- manifest.json parse: P.
- JavaScript syntax: P for ui/popup.js and background/service.js.
- Adapter/settings retained: P.
- ZIP root structure: P; root directly contains project files and required existing subfolders, with no version wrapper.
- AMO submission/signing: pending runtime verification for 0.6.21.
- Firefox update discovery/install: pending runtime verification.

## Update Phase status
- Phase 0 distribution/signing validation: in progress.
- Phase 1 update information retrieval: implemented previously; custom UVD update endpoint remains separate from Firefox update_url.
- Phase 2 XPI download/integrity: not started.
- Phase 3 CoApp automatic update: not started.
- Phase 4 extension/CoApp compatibility: not started.
- Phase 5 restart/version verification: not started.
- Load Reduction Phase: temporarily paused.
