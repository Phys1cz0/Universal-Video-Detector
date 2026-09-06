# UVD 0.6.18 Implementation Catalog

## Base
- Sole development base: Universal-Video-Detector-0.6.17.zip.
- No rollback and no new project.

## User-reported problems addressed
1. The Settings `接続確認` action could open a success dialog while the dialog remained associated with the startup CoApp-update action, so the OK button could be disabled or perform the wrong action.
2. The popup could keep displaying `CoAppバージョンを確認しています…` until the manual connection check changed the status, because startup CoApp state and manual connection state were not unified.
3. The CoApp update button could remain enabled after a successful manual connection because the manual ping result was displayed without replacing the authoritative CoApp update state.
4. Concurrent startup/manual CoApp state checks could issue overlapping Native Messaging requests and produce inconsistent UI state.

## Changes
- `ui/popup.js`
  - Added a single-flight `coAppCheckPromise` so startup and manual CoApp state checks do not overlap.
  - `接続確認` now records the actual ping result into `coAppUpdateState`, including the current and desired CoApp versions and the computed update-required state.
  - `接続確認` now assigns its own dialog action (`connectionCheck`), so its OK button only closes that dialog and cannot accidentally execute the startup-update action.
  - The update button is recalculated immediately from the fresh connection result; when the current CoApp meets the required version it is disabled.
  - CoApp update/startup state is cleared on a successful manual connection check rather than relying on stale prior state.
- `background/service.js`
  - No Native Messaging protocol/action names were changed.
  - Existing 5-second Native Messaging timeout from 0.6.17 is retained.
- Version synchronized to `0.6.18` in current runtime/release metadata.

## Detection behavior
- No detection route was removed or disabled.
- rawCandidates/internal-list lifecycle remains unchanged.
- CoApp gate remains mandatory before rawCandidates finalization, per Rules 249-255.
- No active acquisition was added to passive startup/manual CoApp connection checking.

## Verification
- JSON parse: PASS
- JS syntax checks: PASS
- C# brace balance: PASS (expected equal braces)
- Version synchronization: PASS
- Adapter retained: PASS
- `settings/` structure retained: PASS
- ZIP root structure: PASS
- Native Messaging runtime: H
- Firefox UI dialog runtime: H
- Actual CoApp update/reconnection: H
- Actual target-site video detection: H

## Phase status
- Phase 1: runtime verification remains incomplete (H).
- Phase 2/3: not started and not activated.
