# T18 — Milestone calendar week, month and year views

Status: implementation complete locally on `feature/milestone-calendar-views`; PR and GitHub CI pending.

## Delivered

- Added a milestone calendar for week, month and year scales, reading the shared milestone roots from the unlocked local projection, including milestones hidden from the work calendar.
- Added Monday-first date grids, period labels, inherited plan colors, note indicators, and a year overview with twelve month summaries and date markers.
- Limited month cells to two visible cards; dense days open a full list. Selecting any milestone opens its editor, where the related note can be read or changed.
- Added a day detail action that opens the corresponding work week. The milestone anchor and scale remain saved in session preferences when switching back.
- Added calendar-grid date helpers and coverage for leap dates and the supported year boundaries.

## Verification

| Check | Result |
| --- | --- |
| `pnpm --filter @dayforge/frontend lint` | Passed |
| `pnpm --filter @dayforge/frontend typecheck` | Passed |
| `pnpm build:web` | Passed |
| Pure date-grid test in `tests/milestone-calendar.spec.ts` | Passed |
| Browser interaction tests | Not run locally: Playwright Chromium is not installed on this workstation; GitHub CI pending |
| `git diff --check` | Passed |

The browser tests cover switching among scales, year-to-month navigation, return-context preservation, hidden milestones, dense-day details, note privacy, and opening the related work week. GitHub CI will run those tests with its pinned Playwright browser.
