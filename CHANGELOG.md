# Changelog

All notable changes to this project are documented in this file.

## [1.0.0] - 2026-02-15

### Added
- Full online and PvA stabilization test coverage for socket flow, reconnect, queue timeout, rate limiting, and DB retention.
- Redis/Postgres runtime integration paths used by readiness checks and online recovery scenarios.
- `.gitignore` for generated artifacts and local development files.

### Changed
- Hardened reconnect lifecycle and room restoration behavior across disconnect/reconnect and graceful restart paths.
- Improved Redis-backed runtime services (`queue`, `state`, `rate limiter`) with safer connect/timeout behavior.
- Improved server-side matchmaking and socket flow reliability under flood, malformed payloads, and edge timing windows.

### Fixed
- Flaky reconnect and turn-consistency edge cases in online gameplay.
- Queue and active-room recovery issues after restart and stale presence windows.
- Stability issues in end-to-end socket flow integration tests.

