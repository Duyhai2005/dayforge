# T24 — Visual polish and motion

Status: implementation and local verification complete on `feature/calendar-visual-polish`.

## Delivered

- Centralized the selected control, panel, view, drop-settling and related-day motion durations as CSS custom properties.
- Added a one-shot highlight for the target day when opening its related work week from the milestone calendar. The tab-scoped intent is consumed after the first rendered frame, expires after the highlight, and does not replay after reload.
- Added a short settled state to a moved task only after its local reposition operation succeeds.
- Applied the panel arrival motion to calendar editors, the day-details dialog, plan manager and logout confirmation. Reduced-motion mode removes those animations and limits transitions to 80ms.
- Applied the control motion token to calendar buckets, milestone interactions and widget controls.

## Verification

| Check | Result |
| --- | --- |
| `pnpm lint:web` | Passed |
| `pnpm typecheck:web` | Passed |
| `pnpm build:web` | Passed |
| `git diff --check` | Passed |
| `pnpm --filter @dayforge/frontend exec playwright test calendar-widget.spec.ts milestone-calendar.spec.ts --reporter=list` | Passed: 11 tests |

The browser suite covers widget behavior, reduced motion, the related-day highlight through expiry and reload, milestone calendar navigation, and the 180ms day-dialog arrival animation. Playwright ran without a local API process, so calendar-page attempts to check `/api/v1/auth/session` logged the expected refused proxy connection. Those messages did not fail the UI assertions.
