# T14 — Plan and color management

Status: complete on `feature/plan-color-management`; PR #14 was merged into `develop` as `3ccb08159647be432d267d4a526fa06ff80391d4` after all GitHub CI workflows passed.

## Delivered

- Added a plan manager to the calendar widget for creating plans and editing their name and shared color.
- Added the nine-color palette with labeled native radio controls and a color preview.
- Stored plan mutations through the encrypted owner vault, existing sync outbox and reducer. Local mutation replay must apply before the write is committed.
- Refreshes the displayed calendar projection after local writes and owner-scoped vault changes from other tabs.
- Added dirty-form confirmation, focus containment, reduced-motion-compatible presentation and service-worker dirty-field detection.

## Verification

| Check | Result |
| --- | --- |
| `pnpm --filter @dayforge/frontend lint` | Passed |
| `pnpm --filter @dayforge/frontend typecheck` | Passed |
| `pnpm --filter @dayforge/frontend exec playwright test tests/auth-session.spec.ts tests/calendar-widget.spec.ts --reporter=line` | Passed, 18 tests |
| GitHub CI run #59 (`quality`, `frontend`, `backend-mysql`) | Passed |
| GitHub Offline web shell run #30 | Passed |

The plan browser test signs into a mocked account, creates a green plan, edits its name, confirms a dirty draft is preserved or discarded as selected, and verifies that only the two intended plan writes remain in the encrypted outbox. Calendar widget and existing account session tests passed in the same run.

Playwright required the elevated local runner because the sandbox blocks the Next.js loopback server. The mocked browser suite passed. Its auth coordinator emitted expected connection-refused diagnostics for the unavailable local API while the browser API routes were mocked.

The workstation reports Node `24.17.0` and pnpm `11.25.0`, while the repository pins Node `24.22.1` and pnpm `12.16.1`. The successful GitHub CI runs verified T14 on the pinned versions.

## Scope note

This task delivers plan creation and editing. Task and milestone forms, their inherited colors, the week projection, and the complete cross-calendar flows remain in T15–T18. T14 does not add public wire or backend APIs.
