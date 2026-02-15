# Battleship (GraWStatki) v1.0.0

Production stabilization release focused on online reliability, reconnect safety, and server hardening while preserving existing Socket.IO API compatibility.

## Highlights
- Stable PvA and online gameplay flows with server-authoritative state.
- Hardened reconnect handling for queue and active rooms, including graceful restart scenarios.
- Improved Redis-backed runtime reliability (queue/state/rate-limit paths).
- Stronger socket payload validation and flood/rate-limit behavior across critical events.
- End-to-end test stabilization for socket flow, reconnect, timeout, and retention scenarios.

## Included in this release
- Backend stabilization in:
  - `src/server/index.ts`
  - `src/server/matchmaking.ts`
  - `src/server/runtime/redisQueue.ts`
  - `src/server/runtime/redisState.ts`
  - `src/server/runtime/redisLimiter.ts`
- Integration and regression coverage in:
  - `tests/socketflow.test.js`
  - `tests/health.test.js`
  - `tests/matchmaking.test.js`
  - `tests/shared-logic.test.js`
  - `tests/db-retention.test.js`
- Release docs:
  - `CHANGELOG.md`

## Validation status
- `db:init` successful with PostgreSQL.
- `test:core` passed.
- `test:socketflow` passed (full reconnect and restart scenarios).
- `test:db-retention` passed.

## Compatibility
- No breaking changes in public Socket.IO event names/payload contract.
- Existing client flow remains compatible.

## Operational notes
- Configure environment for production:
  - `REDIS_URL`
  - `DATABASE_URL`
  - `CORS_ORIGINS`
- Use HTTPS + reverse proxy in production.
- Keep Redis and Postgres health checks enabled before accepting traffic.
