# UVD 0.5.94 Change Record

## 0.5.93

- Base: Universal-Video-Detector 0.5.91 only.
- Removed the confirmation dialog from the explicit UI Update/rescan button. The Update action now starts the existing active acquisition flow directly.
- Kept the CoApp update confirmation dialog for the CoApp update operation itself.
- Strengthened Generic Adapter discovery:
  - detects media URLs attached to parent/sibling item containers rather than only the immediate media element;
  - inspects dynamically appended/updated generic-page DOM through a debounced MutationObserver;
  - accepts media URLs from additional data/href/src attributes and embedded script URLs;
  - supports explicit active re-check without allowing the adapter to scroll/paginate/network-acquire on its own;
  - avoids page-wide root selection for per-item media identity.
- The Generic Adapter does not decide final duplicate identity. Background/CoApp remain responsible for authoritative duplicate handling.
- No automatic active scroll, pagination, or additional acquisition is introduced by the Generic Adapter.
- Version-bearing runtime constants synchronized to 0.5.93.

# UVD 0.5.93 Implementation Catalog

- Base: Universal-Video-Detector 0.5.90 only.
- Popup first paint no longer waits for CoApp/native messaging/filesystem/update synchronization. Required startup checks remain automatic asynchronously.
- Startup never initiates page rescan, scrolling, pagination, or extra acquisition.
- Startup shows a confirmation dialog when a newer required CoApp is detected.
- Generic Adapter scans media/thumbnail-anchored cards for embedded video URLs to recover visible lists that network observation alone may only partially detect.
- Background remains authoritative for duplicate merging.

## 0.5.93 change record
- Base: Universal-Video-Detector 0.5.86 only.
- Popup startup is display-only: no automatic CoApp state request, existing-file probe, companion ping, CoApp update check, or automatic acquisition is started.
- Automatic download polling is absent; passive detectedUpdate events remain the list refresh path.
- Active acquisition remains restricted to explicit Update-triggered rescan.
- Version-bearing runtime constants synchronized to 0.5.93.

## 0.5.85
- Twiigle page-item identity is no longer used as the sole video key. Video identity now combines page-item scope with stable media identity.
- Page-item identity alone no longer merges separate video detections.

# UVD 0.5.85 Implementation Catalog

## Base and scope
- Base: Universal-Video-Detector 0.5.75 only.
- No rollback to an older version and no new product project.
- This version adds sidebar display preference, stabilizes thumbnail DOM across refreshes, and strengthens Twiigle multi-item detection/identity handling while retaining the 0.5.74 baseline.
- Existing detection, internal list, Adapter, download, playback, CoApp, and ad-filter architecture are retained.

## 0.5.73/0.5.74 retained change record
- Preview video elements are created during list-row construction instead of only on mouse-over.
- Each preview video receives its source during list construction with `preload=metadata`, allowing the browser's normal media/network cache to begin preparing metadata before hover.
- `IntersectionObserver` uses a 500px root margin; preview videos near the viewport are upgraded to `preload=auto` so likely-to-be-hovered items can be prepared earlier.
- Hover uses a 120ms debounce and calls `play()` on the already-created video element. Mouse leave pauses and resets to time 0 without destroying the video element.
- Image and video are layered; the video becomes visible only after playback/readiness is available, reducing black-frame flashes.
- HLS/DASH remain excluded from this direct `<video>` preview path; non-previewable items no longer receive hover handlers or preview scheduling, so HLS/DASH cannot repeatedly generate hover-preview work or misleading hover logs.
- Preview diagnostics are persisted in `browser.storage.local` as `uvdPreviewLogs`, capped at 300 records. Events include source assignment, load lifecycle, ready state/network state, play resolution/rejection, waiting/stalled/suspend, media errors, hover enter/leave, and reset errors.
- Settings includes a preview diagnostics panel with refresh/copy/clear controls so runtime failures can be retrieved after the popup is reopened.
- Re-rendering a row no longer intentionally destroys the existing thumbnail/video node before rebuilding the rest of the row. The 0.5.74 preserve-and-reattach behavior is retained historically, but 0.5.85 replaces that approach with a keyed stable row/thumb update: the `.thumb` node is never detached during normal list refreshes. This removes the remaining render-driven pointer enter/leave churn path.


## 0.5.75 change record
- Added `sidebarFixed` as a persisted setting. When enabled from the extension UI, Firefox sidebar mode is opened; disabling it closes the sidebar when possible. The sidebar uses the existing `ui/popup.html` surface, so no new product subfolder is introduced.
- Added Firefox `sidebar_action` pointing to the existing popup UI. Responsive CSS adapts the same UI to the narrower sidebar.
- Twiigle card identity is now captured separately from media URL identity. Where a ranking card contains an X/Twitter status link, `pageItemIdentity` uses the status ID; the ranking number is only a fallback.
- Video-element detections on Twiigle are enriched with the same card-level identity so a playback-induced media URL change can merge into the existing ranking item instead of creating a second video.
- Background video identity prioritizes `pageItemIdentity` only when both items explicitly provide it, preserving media-URL-based separation for unrelated generic detections.
- API-response inspection accepts additional media-bearing fields and scans non-media string leaves for already-classifiable video URLs. This does not initiate pagination outside the existing explicit active-acquisition path.
- Existing preview behavior and diagnostics are retained, with the 0.5.75 keyed DOM update removing the prior thumbnail detach/reattach step.

## Twiigle 60-item acquisition
- Twiigle publicly presents ranking pages with numbered entries through No.60 on its ranking pages. citeturn0search1
- UVD's active Twiigle acquisition continues to use explicit UI-triggered acquisition only; this change improves card discovery, embedded/API URL extraction, and identity merging but does not claim that all 60 items are runtime-verified in this environment.

## Network/cache behavior
- Preview preparation can use the network because the `mediaUrl` is a network resource in the normal case.
- The implementation deliberately uses the browser's ordinary media loading/cache path rather than downloading preview files into a new UVD cache directory.
- `preload=metadata` is used for all constructed preview elements; `preload=auto` is used for preview elements near the viewport. This balances early preparation against unnecessary bandwidth.
- No separate persistent video-file cache is introduced because copying full media responses into extension storage would greatly increase bandwidth, disk usage, memory pressure, and CORS/Range-request complexity.

## Verification scope
- Static source inspection and syntax/JSON/encoding checks are required before packaging.
- Windows/.NET compilation and real Firefox media playback/network-cache behavior are not considered verified unless executed and observed in the target environment.


## 0.5.85 change record
- Base: 0.5.75 only; 0.5.76 is not used as a base.
- Stable keyed row/thumbnail DOM from 0.5.75 is retained.
- Sidebar checkbox invokes `sidebarAction.open()/close()` immediately in the synchronous change handler, before async persistence, to preserve Firefox user activation.
- Twiigle card resolution is now bounded to the individual `.item_ranking` unit and no longer performs broad selector fan-out on every active step.
- Nested API media inherits the nearest Twiigle tweet/status/post identity.
- Static verification only; Firefox runtime, Twiigle acquisition, sidebar opening, and hover behavior remain unverified.


## 0.5.85 change record
- Base: 0.5.75 only; 0.5.76 is not used as a base.
- Twiigle detection is site-specific and bounded: `.item_ranking` is the acquisition unit, each item is processed independently during explicit UI acquisition, and the generic whole-document Twiigle scan is no longer used for each acquisition step.
- Twiigle passive observation is limited to relevant ranking/media DOM mutations and is debounced; image-only churn does not trigger a full Twiigle scan.
- Twiigle API pagination is serialized one page at a time instead of launching all pages concurrently. This prevents request/response parsing fan-out and reduces Firefox main-thread pressure while retaining pagination acquisition.
- Other sites retain the generic detection/Adapter path; Twiigle-specific behavior is isolated by hostname.
- Sidebar setting is located in 外観. Opening/closing is invoked synchronously from the checkbox user-action handler, and enabling the sidebar closes the popup so both UI surfaces are not intentionally left open.
- Static verification only; real Firefox/Twiigle runtime acquisition remains unverified until tested in Firefox.


## 0.5.93 Change Record
- Restored the explicit Update confirmation dialog before the active rescan.
- CoApp startup connection check remains automatic.
- No new working/product subfolder is created.


## 0.5.93 Consolidated design correction
- Base: Universal-Video-Detector 0.5.89 only; no rollback.
- Startup now performs lightweight CoApp ping, authoritative state synchronization, existing-file reconciliation, and CoApp update-state check. Startup never initiates page rescan, scrolling, pagination, or additional acquisition.
- Passive detection and active acquisition state are separated; passive metadata updates no longer advance active scan state.
- Passive DOM observation covers video/resource-related data attributes without scanning unrelated attribute churn.
- Duplicate detection is strengthened with multiple independent video-level signals. Exact canonical media identity, UUID, stable site video ID, and corroborated page-item + thumbnail/filename/duration evidence are used; page identity alone is never sufficient. HLS/DASH rendition URLs are therefore eligible to merge only when corroborating evidence identifies the same video.
- Active API pagination is serialized across sites rather than launching every page concurrently.
- UI now treats internalItems as the source of truth and derives displayItems from it. UI no longer manufactures `exist` download jobs; CoApp remains authoritative.
- Page identity and video identity remain separate; weak page evidence is not used as a standalone video duplicate key.
- Recovery reasons and deeper state-source cleanup remain compatible with the existing CoApp state machine.
- Ad-filter classification/display separation is preserved; no detection/download failure path depends on the filter subsystem.

## 0.5.93 Change Record

- Base: Universal-Video-Detector 0.5.92 only.
- Passive detection no longer performs timed whole-document rescans after page load.
- Initial DOM inspection remains permitted at page load.
- Passive DOM changes are handled by MutationObserver and only the added/changed nodes and their bounded media/card context are inspected.
- Network/media events remain event-driven and are not rediscovered through periodic DOM scans.
- SPA history changes invalidate page identity only; they do not initiate a whole-document passive scan.
- Explicit Update remains the sole entry point for active acquisition, including scrolling, lazy-list discovery, pagination, and additional acquisition.
- Playback button handling was changed from pointerdown interception to delegated click handling to avoid suppressing normal button activation while retaining single-flight protection.
- Playback continues through UI -> Background -> CoApp; UI does not choose a player or finalize playback success.
- Version-bearing runtime constants synchronized to 0.5.93.


## 0.5.94 Change Record

- Base: Universal-Video-Detector 0.5.93 only.
- Removed the Update-button confirmation dialog. CoApp update remains independently confirmable at the UI startup/update notification boundary.
- CoApp update completion now forces the verified state to `available=false`, `updating=false`, and disables the update button when the installed version reaches the bundled target.
- Playback is now two-stage: UI/Background requests authoritative playback resolution from CoApp, receives `jobPath` and `exists`, and only then requests playback.
- Playback launch adds a detached `explorer.exe` breakaway path so the launcher is not kept in the Firefox/CoApp Job object when the primary detached cmd path is unavailable.
- Generic Adapter fixed the missing `bestMediaCard` function that could abort generic DOM detection, and now keeps the initial whole-DOM scan while passive mutations remain node-scoped.
- Active acquisition remains restricted to explicit Update/rescan requests.


## 0.5.96 Change Record

- Base: Universal-Video-Detector 0.5.95 only. 0.6.0 is not used as a base because its actual project artifact was unavailable.
- Fixed Popup geometry: Action Popup is explicitly 600px high; small/medium/large widths remain 500/600/760px. Removed the viewport-height media override that could collapse or change the intended Popup geometry. Internal panels retain their own scrolling.
- Phase 1: fetch/XHR response bodies are no longer read unconditionally. Obvious binary/media URLs and binary/media Content-Types are rejected before text extraction; oversized responses are skipped before body cloning/reading. fetch/XHR monitoring itself remains active.
- Phase 1: passive MutationObserver ownership is centralized in detector.js. Generic Adapter no longer registers a second Document-wide MutationObserver; it receives de-duplicated mutation batches from the central observer.
- Phase 1: passive DOM mutation batches are de-bounced and de-duplicated before detector/Generic Adapter processing.
- Phase 1: repeated timed whole-document image metadata scans were removed. Initial metadata inspection remains once; later DOM changes are handled through the mutation stream.
- Added approved performance rules 230-244, including the revised Observer rule and the revised staged large-response rule.
- Static verification target: JS syntax, JSON parsing, version synchronization, ZIP root structure, Adapter preservation, and rule/catalog consistency. Firefox runtime, Native Messaging, CoApp, Worker, ffmpeg, and real UI rendering remain separate dynamic verification items until actually executed.
