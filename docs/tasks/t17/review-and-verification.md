# T17 — Milestone editor and work-calendar integration

Status: complete. PR #17 merged into `develop` as `b20783a709a1b613f4fbe1a13e52a9ebae728125` after GitHub CI and Offline web shell passed.

## Delivered

- Added a dedicated milestone form for title, date, optional all-day/morning/afternoon/evening period, multiline related note, optional plan, inherited or standalone color, and work-calendar visibility.
- Added nested plan creation that returns to the milestone form with the draft intact and the new plan selected.
- Added stale-edit protection for replacement and removal, plus a confirmation before removing a milestone. All writes use the encrypted local vault, reducer, outbox, and existing sync coordinator.
- Enabled the widget milestone action and added all-day and period placements to the work-week calendar for milestones whose shared record opts into work-calendar display. Notes remain private to the editor; the calendar shows only a note indicator.
- Made displayed milestone cards open the editor. A milestone hidden from the work calendar remains a milestone record and is expected to be reachable in the milestone calendar delivered by T18.

## Verification

| Check | Result |
| --- | --- |
| `pnpm --filter @dayforge/frontend lint` | Passed |
| `pnpm --filter @dayforge/frontend typecheck` | Passed |
| `pnpm build:web` | Passed |
| `pnpm --filter @dayforge/frontend exec playwright test tests/auth-session.spec.ts tests/calendar-widget.spec.ts tests/routes.spec.ts tests/view-state.spec.ts --reporter=dot` | Passed, 41 tests |
| Focused milestone CRUD/visibility tests after focus-return update | Passed, 2 tests |
| `git diff --check` | Passed |
| GitHub CI run #67 (`quality`, `frontend`, `backend-mysql`) | Passed; the backend job passed after a rerun of its two-browser acceptance step |
| Offline web shell run #43 | Passed |
| `git diff --check` after the offline checkpoint test stabilization | Passed |

The browser suite covers create/edit/delete, same-record display in the work calendar, all-day/period fields, nested plan selection and draft retention, note privacy on cards, visibility opt-out, and locked-vault controls. Existing task, plan, navigation, account, route, and date-boundary cases also passed.

The local browser tests mock authentication and application APIs. The local backend is unavailable, so the Next.js test server reports expected connection-refused messages during auth/version probes. The workstation reports Node `24.17.0` and pnpm `11.25.0`; GitHub CI passed with the repository-pinned runtime.

## Scope note

The milestone editor and work-week projection are delivered here. Week/month/year milestone navigation, browsing hidden milestones, dense-day panels, and opening a related work week remain in T18.
