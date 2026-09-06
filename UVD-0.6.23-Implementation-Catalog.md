# UVD 0.6.23 Implementation Catalog

## Base
- Sole development base: Universal-Video-Detector-0.6.22.zip.
- No rollback and no new project created.
- UVD-Development-Rules.md was reviewed before implementation; Rules 256-269 remain applicable.

## Purpose
- Remove the need for manual GitHub Actions `Run workflow` when releasing a new UVD version.
- Keep Firefox self-distribution on the existing `update_url` + GitHub Release update manifest architecture.

## Changes
1. Advanced the formal extension version from 0.6.22 to 0.6.23.
2. Synchronized the formal extension version in manifest.json, ui/popup.html, ui/popup.js, and background/service.js.
3. Added an automatic GitHub Actions tag-creation workflow: a push to `main` with a new formal manifest version automatically creates `v<version>`.
4. The existing tag-triggered signing/release workflow then performs AMO unlisted signing, XPI hashing, update.json generation, and GitHub Release creation without manual `Run workflow`.
5. Existing detection, rawCandidates lifecycle, internal-list authority, download, CoApp, Native Messaging, Adapter, settings, diagnostics, and phase boundaries are unchanged.
6. CoApp remains independently versioned and is not changed by this release.

## Automatic release flow
`manifest.json version bump` → `push main` → `auto-tag workflow` → `v<version>` tag → `unlisted signing/release workflow` → `GitHub Release + update.json` → Firefox uses the existing `update_url`.

## Verification
- Formal version x.y.z: P (0.6.23).
- Version synchronization in the packaged artifact: P.
- Existing project structure retained: P.
- Adapter/settings retained: P.
- ZIP root structure: P; no version wrapper.
- Automatic tag/release workflow static design: P.
- GitHub Actions automatic release runtime: H until the 0.6.23 push-triggered run completes.
- Firefox automatic update runtime: H until observed in the installed Firefox.
- `runtime.requestUpdateCheck()` is not used because current Firefox WebExtension API compatibility does not provide that API; Firefox's configured `update_url` remains the automatic update mechanism.

## Rule compliance
- Rule 256: ZIP root is direct; no version wrapper.
- Rules 258-261: release automation is isolated in GitHub Actions and does not mix with detection/UI responsibilities.
- Rule 269: all formal versions remain three-component x.y.z.

## Status
- Update Phase remains the active phase.
- Phase 0 distribution/signing validation: progressing through automatic release verification.
- Load Reduction Phase: temporarily paused.
