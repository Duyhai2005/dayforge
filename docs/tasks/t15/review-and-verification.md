# T15 — Quick task editor

Status: complete on `feature/quick-task-editor`; PR #15 merged into `develop` as `f84bb1079adf7b4e21cf4c9d07a801cb3632b041` after all GitHub CI workflows passed.

## Delivered

- Added a task form opened from the calendar widget and quick-add button. It defaults to the current view date and asks for a period when opened from the widget.
- Added title, date, required period, optional duration, plan selection, standalone color, plan color inheritance and a task preview.
- Added a nested plan creation flow that returns to the task form, retains its draft and selects the newly created plan.
- Added field-level validation, dirty-form confirmation, focus containment and return focus to the widget after save or dismissal.
- Writes single tasks through the encrypted owner vault and reducer/outbox; task edits carry an expected root hash and refuse to overwrite a newer change.
- Assigns new tasks a spaced order rank at the end of the selected date/period bucket.

## Verification

| Check | Result |
| --- | --- |
| `pnpm --filter @dayforge/frontend lint` | Passed |
| `pnpm --filter @dayforge/frontend typecheck` | Passed |
| `pnpm build:web` | Passed |
| `pnpm --filter @dayforge/frontend exec playwright test tests/auth-session.spec.ts tests/calendar-widget.spec.ts --reporter=dot` | Passed, 19 tests |
| Focused reducer rank test using the shared T12 fixture | Passed |
| Focused Playwright task creation test | Passed |
| Focused Playwright plan manager regression test | Passed |
| GitHub CI run #41607971522 (`quality`, `frontend`, `backend-mysql`) | Passed |
| GitHub Offline web shell run #41607971453 | Passed |

The task browser test checks the default date, required-period error, preservation of the draft while creating a nested plan, selected plan, local outbox writes and survival of pending changes across reload.

The local browser run uses mocked auth routes. The local API is unavailable, so the Next.js server reports expected connection-refused diagnostics during mocked auth/version probes. The workstation has Node `24.17.0` and pnpm `11.25.0`; the repository pins Node `24.22.1` and pnpm `12.16.1`. GitHub CI remains the final verification on the pinned runtime.

## Scope note

The editor supports both create and edit payloads. T16 will connect real week cards to the edit path once the work calendar displays stored tasks. Recurrence controls remain in T21.
