# UVD 0.6.20 Implementation Catalog

## Base
- Sole development base: Universal-Video-Detector-0.6.19.zip.
- No rollback and no new project created.

## Purpose
AMO submission compatibility correction for the Update Phase distribution/signing validation.

## Changes
1. Extension version advanced from 0.6.19 to 0.6.20.
2. Added Firefox Gecko `data_collection_permissions.required: ["none"]` to manifest.json.
3. Removed dynamic `innerHTML` assignments from ui/popup.js and replaced them with DOM construction/textContent/replaceChildren.
4. Preserved existing detection, download, CoApp, Native Messaging, Adapter, settings, and lifecycle architecture.
5. CoApp implementation was not changed; CoApp remains 0.6.18 and is intentionally independent of extension version.

## Verification
- JS syntax: P.
- Manifest JSON parse: P.
- Formal extension version x.y.z: P (0.6.20).
- No dynamic `innerHTML` remains in ui/popup.js: P.
- Adapter retained: P.
- settings directory retained: P.
- Runtime Firefox/AMO submission result: H until user submits 0.6.20 to Mozilla.

## Update Phase status
- Phase 0 distribution/signing validation: in progress.
- Phase 1 update information retrieval: implemented in 0.6.19.
- Phase 2 XPI download/integrity: not started.
- Phase 3 CoApp automatic update: not started.
- Phase 4 extension/CoApp compatibility: not started.
- Phase 5 restart/version verification: not started.
- Load Reduction Phase: temporarily paused.
