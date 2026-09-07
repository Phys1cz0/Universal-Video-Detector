# UVD 0.6.25 Implementation Catalog

## Base
- Sole development base: Universal-Video-Detector-0.6.24.zip.
- No rollback and no new product project.
- UVD-Development-Rules.md was reviewed before implementation.

## Purpose
- Establish a low-effort development-only update workflow using Firefox Developer Edition and web-ext.
- This mechanism is explicitly development-only and must not be included in the production/self-distribution extension package.
- Mozilla AMO registration/signing is not used by this development workflow.

## Development workflow
1. `dev-run.ps1` prepares a local development source directory and launches Firefox Developer Edition through `web-ext run`.
2. `web-ext run` loads the extension temporarily and watches the source tree; Mozilla documents that it automatically reloads the extension when source files change.
3. `dev-update.ps1` downloads the current `main` branch archive from the UVD GitHub repository, validates the downloaded formal x.y.z version, stages the extension tree, then updates the local development source directory.
4. The manifest is copied last and the developer copy of popup/service/html is version-synchronized after the source update.
5. When `web-ext run` is active for the same source directory, the extension reload is handled by web-ext; no AMO submission is required.

## Production boundary
- The developer-only scripts are tooling, not WebExtension runtime code.
- They must be excluded from production XPI/ZIP artifacts.
- The production extension continues to use the existing Firefox `update_url`/signed self-distribution architecture.
- No developer-only update action, filesystem write capability, GitHub source download logic, or `browser.runtime.reload()` hook is added to the production extension.

## Verification
- Formal version x.y.z: P (0.6.25).
- Base version: P (0.6.24).
- Existing Adapter/settings/lifecycle retained: P.
- Developer tooling static inspection: P.
- Developer runtime with a real Firefox Developer Edition installation: H; executable path and local environment are user-specific.
- Automatic source update + web-ext reload runtime: H until observed.
- Production distribution ZIP excludes developer tooling: P.

## Update Phase assessment
- Phase 0 distribution/signing validation: partially demonstrated. 0.6.23 automatic signing/release succeeded; 0.6.24 was submitted to Mozilla but current retry is blocked by Mozilla throttling. Full Firefox automatic-update runtime remains H.
- Phase 1 update information retrieval: implemented. Endpoint is configured in `settings/update-config.js`; runtime retrieval has not been observed end-to-end.
- Phase 2 XPI download/integrity: not completed as a verified product phase.
- Phase 3 CoApp automatic update: not started as a completed verification phase.
- Phase 4 Extension/CoApp compatibility: not completed.
- Phase 5 restart/version verification: not completed.
- Phase 6 failure recovery/rollback: not completed.
- Developer-only update workflow: implementation P / runtime H.
- Load Reduction Phase: remains paused by project roadmap.
