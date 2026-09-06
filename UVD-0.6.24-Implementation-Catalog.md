# UVD 0.6.24 Implementation Catalog

## Base
- Sole base: Universal-Video-Detector-0.6.23.zip.
- No rollback and no new product project.
- UVD-Development-Rules.md reviewed before implementation.

## Purpose
- Make the user-facing UVD update check usable with the existing Firefox self-distribution architecture.
- Remove the empty update endpoint left from Phase 1.

## Changes
1. Formal version 0.6.23 -> 0.6.24.
2. Set the UVD update manifest endpoint to the GitHub `releases/latest/download/update.json` URL.
3. The existing `UVD更新確認` button now has a real endpoint to query instead of reporting that the endpoint is unconfigured.
4. The existing manifest `update_url` remains the Firefox-managed extension update source of truth.
5. Detection, Adapter, CoApp protocol, internal-list authority, rawCandidates lifecycle, and download behavior are unchanged.

## Important API boundary
- The popup can explicitly check UVD's update manifest and report a newer version.
- Firefox does not expose a supported WebExtension API that guarantees an immediate forced extension install from a popup. Therefore the implementation does not fake an install operation.
- Firefox's native update mechanism remains responsible for downloading/applying signed extension updates.

## Verification
- Formal x.y.z: P (0.6.24).
- Manifest JSON: P.
- Existing `update_url`: P.
- Update endpoint configured: P.
- Adapter/settings retained: P.
- Automatic GitHub Release for 0.6.24: H until Actions completes.
- Firefox 0.6.23 -> 0.6.24 runtime installation: H until observed in installed Firefox.

## Roadmap
- Update Phase remains active.
- Automatic signing/release: P through the successful 0.6.23 run.
- User-facing update check: implemented in 0.6.24.
- Firefox automatic update runtime: H.
- CoApp automatic update: not started.
- Load Reduction Phase remains paused.
