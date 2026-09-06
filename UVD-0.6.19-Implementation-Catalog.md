# UVD 0.6.19 Implementation Catalog

## Base
- Sole development base: Universal-Video-Detector-0.6.18.zip.
- No rollback and no new project.
- Adapter retained.

## Update Phase
### Phase 1：更新情報取得
**実装済み・ランタイム未確認**

Implemented:
- Added `settings/update-config.js` as the single deployment endpoint configuration point.
- Added background update-manifest retrieval with an 8-second timeout.
- Requires HTTPS/HTTP manifest URL.
- Requires formal `x.y.z` update version.
- Requires package URL using HTTP/HTTPS.
- Requires exactly 64 hexadecimal SHA-256 characters.
- Requires boolean `required`.
- Compares only formal three-component versions; no two-component compatibility conversion was added.
- Stores the latest check result in `storage.local` as diagnostic state; stored state is not treated as authoritative.
- Added Settings UI for manual UVD update-information checks.
- Added automatic non-blocking update-information check after the normal UI/CoApp startup gate and list rendering.
- Phase 1 does not download or replace ZIP files.

Deployment dependency:
- `UVD_UPDATE_CONFIG.manifestUrl` is intentionally empty because the project currently has no designated public update-manifest host. A fabricated URL was not introduced. The endpoint must be selected before Phase 1 can be runtime-verified.

## Versioning
- Extension version: 0.6.19.
- CoApp implementation is unchanged, so CoApp remains 0.6.18 under the independent CoApp version rule.
- `manifest.json`, `ui/popup.js`, `background/service.js`, and `ui/popup.html` were synchronized to extension version 0.6.19.

## Static verification
- JavaScript syntax: passed (`node --check`).
- JSON parsing: passed.
- Formal version checks: implemented for update metadata.
- Adapter presence: verified.
- Settings directory: retained.
- ZIP root layout: verified after packaging.
- Runtime Update Phase 1 network retrieval: **HOLD** because no designated update-manifest URL is currently configured.

## Phase status
- Update Phase Phase 1: implementation complete, runtime verification HOLD.
- Update Phase Phase 2/3/4/5: not started.
- Load Reduction Phase Phase 1: temporarily paused while Update Phase is prioritized.
