Original prompt: PLEASE IMPLEMENT THIS PLAN: Command Deck UX Overhaul Plan (Full Frontend Modernization)

## TODO
- Add Playwright smoke tests for Command Deck UX states (expected to fail first).
- Implement new information architecture in index.html.
- Replace styles.css with Command Deck visual system and responsive behavior.
- Update main.ts for phase/mode hooks, objective/helper text, advanced panel behavior, geometric markers.
- Run build/lint/tests and Playwright smoke, then iterate fixes.

## Notes
- Preserve existing gameplay/socket behavior and IDs required by logic.
- Keep chat drag-to-corner behavior and mobile collapsed default.
## Progress
- Added Playwright smoke setup (`playwright.config.js`) and `tests/ui-smoke.spec.js` for Command Deck UX contract.
- Ran smoke tests in RED phase: failed as expected because new Command Deck elements/hooks are not implemented yet (`#objectiveText`, `#btnAdvancedToggle`, app `data-mode`/`data-phase`).
- Implemented Command Deck UI architecture in `public/index.html` with mission header, hybrid command strip, tactical objective panel, and board helper copy.
- Rebuilt `public/styles.css` with steel/cyan tokenized visual system, cinematic motion, tactical geometric board markers, and responsive/mobile chat refinements.
- Updated `src/client/main.ts` for advanced panel state persistence, objective/helper narrative updates, app `data-mode`/`data-phase` hooks, and geometric marker rendering.
- Added Playwright smoke tooling (`playwright.config.js`) and tests (`tests/ui-smoke.spec.js`) plus `npm run test:ui:smoke` script.
- Verification:
  - `npm run build` ✅
  - `npm run test:ui:smoke` ✅ (3/3)
  - `npm test` ✅
  - `npm run lint` ❌ (pre-existing server lint error in `src/server/index.ts:206` and unrelated warnings)
- Expanded Playwright smoke coverage to 6 scenarios: local PvA flow, manual placement preview states, phase control behavior, mobile chat collapsed default, chat dock drag, and reduced-motion rendering sanity.
- Re-ran `npm run test:ui:smoke`: all 6 tests pass.
- Final verification rerun:
  - `npm run build` ✅
  - `npm test` ✅
  - `npm run test:ui:smoke` ✅ (6/6)
  - `npm run lint` ❌ (same pre-existing server lint issue, unchanged by frontend work)
- Follow-up step: fixed pre-existing lint blockers in backend/shared files.
- Removed unused eslint-disable directives and unused import, adjusted unused helper name, and replaced unsafe control-char regex with Unicode property class.
- Verification after fix:
  - `npm run lint` ✅
  - `npm run build` ✅
  - `npm test` ✅
  - `npm run test:ui:smoke` ✅ (6/6)
- Found and fixed refresh/setup regression: `init()` seeded `yourBoard` with `placeFleetRandomly(...)` while `placement` stayed `manual` and `remainingShips` reset, which allowed over-placement after refresh.
- Added Playwright regression test: `refresh keeps manual setup board empty before placement` in `tests/ui-smoke.spec.js` (RED failed with `20` ship cells, then GREEN after fix).
- Updated `src/client/main.ts` initialization (`state` default + `init()`) to use empty boards in manual setup.
- Verification for this bugfix:
  - `npx playwright test tests/ui-smoke.spec.js -g "refresh keeps manual setup board empty before placement"` ✅
  - `npm run test:ui:smoke` ✅ (7/7)
  - `npm test` ✅
  - `npm run lint` ✅
