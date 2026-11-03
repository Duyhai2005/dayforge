# T20 — Task status, overdue state and deletion

Status: implementation and CI verification complete on `feature/task-status-and-deletion` (PR #20).

## Delivered

- Added a keyboard-accessible status action to each one-time task card. It marks a task completed or returns it to pending without changing its date, period, plan, color or order.
- Kept completed and overdue indicators distinct while resolving plan colors through the shared plan record. A pending task becomes overdue only after its planned LocalDate has ended in UTC+07:00; the app refreshes this state at local midnight and after focus/visibility changes without a timer service or network request.
- Added a confirmed delete action to the task editor. It records `single.delete` with the current semantic root hash, removes the card from the calendar, and leaves undo available from the toast and calendar widget.
- Status changes and deletion create safe reducer `undo` operations with the original operation dependency and the expected post-change root hash. Later edits make an old undo inapplicable rather than restoring stale data.
- All changes use the existing local mutation transaction and encrypted outbox, so status, deletion and undo remain available offline and survive reload.

## Verification

| Check | Result |
| --- | --- |
| `pnpm --filter @dayforge/frontend lint` | Passed |
| `pnpm --filter @dayforge/frontend typecheck` | Passed |
| `pnpm build:web` | Passed |
| `git diff --check` | Passed |
| Focused local Playwright browser flow | Could not reach the local web server because this sandbox denies loopback connections |
| GitHub CI | Passed: frontend development and production browser suites, Next.js production build/API check, quality checks, backend integration tests and two-browser sync acceptance |
| Offline web shell | Passed: production offline suite and same-origin A/B update suite |

The browser scenario checks completed/pending transitions, the plan color on completed and overdue tasks, the UTC+07:00 midnight transition while the page remains open, delete and undo, and local encrypted outbox persistence across a reload while sync requests fail.
