# T21 — Recurrence rules and visible occurrences

Status: implementation and CI verification complete on `feature/recurring-rules` (PR #21).

## Delivered locally

- Added daily and selected-weekday recurrence controls to the task form. A new series starts on the first matching date on or after the selected start date, and the form explains that date before saving.
- Added recurrence creation and one-time-task conversion through the existing local mutation/outbox path. Enabling recurrence preserves the first task's date, fields and completion status; an incompatible weekday is rejected.
- Added bounded expansion for the currently visible date range. The projection includes generated occurrences, moved replacements at their effective date, and detached one-time tasks, while suppressing deleted or detached source occurrences and deduplicating card IDs.
- Added recurrence and detached-task markers to week cards. Editing and reordering individual occurrences is intentionally completed by T22.

## Local verification

| Check | Result |
| --- | --- |
| `pnpm typecheck:web` | Passed |
| `pnpm lint:web` | Passed |
| `git diff --check` | Passed |
| Reducer work-week expansion Playwright case | Passed |
| Create weekly recurrence across viewed weeks Playwright case | Passed |
| Enable recurrence while preserving a completed first task Playwright case | Passed |
| GitHub CI run #80 | Passed: quality, development/production browser suites, production build/API check, MySQL integration and two-browser sync acceptance |
| Offline web shell run #65 | Passed: production offline suite and same-origin A/B update suite |

The local browser cases use the app's auth and offline mutation flow. The CI backend-mysql job also passed the current MySQL and two-browser sync acceptance suites; T23 will add recurrence-specific multi-device scenarios.
