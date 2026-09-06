# UVD 0.6.17 Implementation Catalog

## Base
- Sole development base: Universal-Video-Detector-0.6.16.zip.
- No rollback and no new project.

## User-reported problems addressed
1. Settings screen remained visually stuck at `CoAppバージョンを確認しています…` when the startup CoApp gate failed or timed out.
2. Native Messaging could wait indefinitely at the Background `sendNativeMessage()` boundary, preventing a deterministic startup result and consequently preventing rawCandidates from being finalized into the UI list.

## Changes
- `background/service.js`
  - Added a 5-second Native Messaging response timeout.
  - A stuck/dead CoApp now returns an explicit timeout error instead of leaving callers pending indefinitely.
  - Existing Native Messaging protocol/action names and response fields are unchanged.
- `ui/popup.js`
  - Startup CoApp-gate failure now updates `companionStatus` with the actual failure reason instead of leaving `CoAppバージョンを確認しています…` displayed indefinitely.
  - Startup status explicitly states that the video list is withheld because the mandatory CoApp gate did not complete.
- Version synchronized to `0.6.17` in manifest/UI/Background/CoApp metadata/C# and release metadata.

## Detection behavior
- No detection route was removed or disabled.
- rawCandidates/internal-list lifecycle remains unchanged: CoApp gate must settle before rawCandidates finalization, per Rules 249-255.
- Extensionless media remains supported through passive response-header Content-Type detection; no unsafe arbitrary response-body reading was added.

## Verification
- JSON parse: PASS
- JS syntax checks for touched/runtime JS: PASS
- C# brace balance: PASS (893/893); C# compilation: H (Windows compiler not available in this environment)
- Version synchronization: PASS
- Adapter retained: PASS
- ZIP root structure: PASS
- Windows/Firefox Native Messaging runtime: H (not directly executable in this environment)
- Actual CoApp update/reconnection: H
- Actual target-site video detection: H

## Phase status
- Phase 1: runtime verification remains incomplete (H).
- Phase 2/3: not started and not activated.
