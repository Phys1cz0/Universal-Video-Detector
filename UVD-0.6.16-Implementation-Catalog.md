# UVD 0.6.16 Implementation Catalog

## Base
- Sole base: Universal-Video-Detector-0.6.15.zip
- No rollback and no new product/project.

## Change
- CoApp in-place updater no longer polls the Native Messaging host PID with `tasklist | findstr`.
- The updater waits briefly, then retries file replacement based on Windows file locking.
- Update command is launched with `CREATE_NO_WINDOW` to prevent a visible CMD window.
- Target executable version verification remains mandatory after replacement.
- Formal version remains x.y.z: 0.6.16.

## Verification
- Static JS syntax checks: P
- JSON parse: P
- Version consistency: P
- C# brace balance: P
- ZIP root structure: P
- Adapter retained: P
- Runtime CoApp update: H (requires Windows/Firefox execution)
