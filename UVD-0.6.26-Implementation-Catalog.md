# UVD 0.6.26 Implementation Catalog

## Base
- Sole development base: Universal-Video-Detector-0.6.25.zip.
- No rollback and no new product project.
- UVD-Development-Rules.md was reviewed before implementation; Rules 245-269 remain in force.

## Purpose
- Correct the Firefox WebExtension manifest update URL placement that caused the Developer Edition warning.
- Keep the production self-distribution update mechanism separate from the Developer Edition source-update mechanism.
- Developer-only automatic source update remains external tooling (`dev-update.ps1` / `dev-run.ps1`) and is not part of the extension package.

## Change
- Bumped formal version to 0.6.26.
- Moved `update_url` from the manifest top level to `browser_specific_settings.gecko.update_url`.
- Synchronized popup.js, service.js, and popup.html to 0.6.26.
- Improved `dev-update.ps1` so Windows PowerShell-compatible UTF-8 without BOM is used and runtime/display version fields are synchronized from manifest.json before web-ext reload.
- No detection, Adapter, CoApp protocol, rawCandidates, internal-list, download, or lifecycle behavior was intentionally changed.

## Developer-only update boundary
- Developer Edition workflow uses the external `dev-update.ps1` + `dev-run.ps1` tooling.
- These scripts are not included in the production UVD ZIP/XPI.
- The production extension does not receive a filesystem-writing GitHub updater or a `browser.runtime.reload()` update hook.
- Mozilla signing remains reserved for explicit formal/self-distribution release or automatic-update testing.

## Verification
- JSON parse: P.
- Node syntax (`ui/popup.js`, `background/service.js`): P.
- Formal x.y.z version synchronization: P (0.6.26).
- `update_url` location: P (`browser_specific_settings.gecko.update_url`).
- Developer updater PowerShell compatibility review: P; Windows PowerShell runtime execution remains H because the user's machine must be observed.
- Adapter/settings/project structure retained: P.
- ZIP root has no version wrapper: P.
- Developer Edition runtime warning removal: H until observed on the user's Firefox Developer Edition.
- Developer source update + web-ext automatic reload: H until observed.

## Update Phase assessment
- Phase 0 distribution/signing: partially demonstrated; Firefox automatic-update runtime remains H.
- Phase 1 update information retrieval: implementation exists, runtime end-to-end remains H.
- Phase 2 XPI retrieval/integrity: H.
- Phase 3 CoApp automatic update: H.
- Phase 4 Extension/CoApp compatibility: H.
- Phase 5 restart/version verification: H.
- Phase 6 failure recovery/rollback: H.
- Load Reduction Phase: remains paused.
