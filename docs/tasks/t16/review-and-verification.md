# T16 — Weekly work calendar

Status: implementation and local verification complete on `feature/weekly-work-calendar`. PR and GitHub CI are pending.

## Delivered

- Added a seven-day calendar week from Monday through Sunday, grouped into aligned morning, afternoon and evening buckets. The existing widget continues to navigate by week and jump to today.
- Displays unlocked, live single-task roots in their date/period buckets, ordered by `order_key` with a stable ID tie-breaker. Plan colors are inherited; standalone task colors remain effective when no plan is selected.
- Provides an add action in every bucket and opens the existing editor from task cards. Task cards show estimated duration and completed/overdue state without adding recurrence behavior before T21.
- Keeps dense buckets in normal document flow, shows locked/loading/error/empty states and disables task creation until the local vault projection is ready.
- Calculates week dates in UTC calendar arithmetic and safely handles the supported year bounds, including weeks that cross a month or year boundary.

## Verification

| Check | Result |
| --- | --- |
| `pnpm --filter @dayforge/frontend lint` | Passed |
| `pnpm --filter @dayforge/frontend typecheck` | Passed |
| `pnpm build:web` | Passed |
| `pnpm --filter @dayforge/frontend exec playwright test tests/auth-session.spec.ts tests/calendar-widget.spec.ts tests/view-state.spec.ts --reporter=dot` | Passed, 36 tests |
| `git diff --check` | Passed |
| GitHub CI and Offline web shell workflows | Pending PR |

The browser suite verifies the 7×3 week layout across New Year, locked-vault add controls, saving and reloading a task, four tasks in one afternoon bucket without an inner scroll area, and editing a displayed task. Existing plan, navigation, account and view-state coverage also passed.

The local browser tests mock authentication and application APIs. The local backend is unavailable, so the Next.js test server logs expected connection-refused messages during auth/version probes. The workstation reports Node `24.17.0` and pnpm `11.25.0`; GitHub CI will verify the repository-pinned runtime.

## Scope note

This task displays single work roots. Recurring families and occurrence projection remain in T21; milestones remain in T17–T18, and drag reordering and completion/removal actions remain in T19–T20.
