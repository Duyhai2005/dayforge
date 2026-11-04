# T28 — Acceptance Results

- **Candidate branch:** `feature/integration-acceptance`
- **Current implementation SHA:** `8076c1e48a6396b5c7c674311692304d865263fd`
- **Local environment:** Windows 11 Home (build 26300, x64), Chromium 156.0.8078.4, Playwright 1.64.1, Node 24.17.0, pnpm 11.25.0, uv 0.13.6.
- **Run date:** 2026-11-04 (Asia/Bangkok)

| Summary | Count |
| --- | ---: |
| PASS | 35 |
| FAIL | 0 |
| BLOCKED | 0 |
| TARGET_PENDING | 3 |

`TARGET_PENDING` is reserved for the real inbox checks AC-31/32 (T32) and the independent-host check AC-36 (T32/T36). Local Mailpit/mocked auth checks do not count as delivery to a real inbox. This is a pre-deploy acceptance candidate, not production sign-off.

## Evidence index

| ID | Command / scenario | Result and tested revision |
| --- | --- | --- |
| E1 | `pnpm verify:fast` | PASS: lint/format/type checks, environment checks (30 passed), and backend tests (320 passed, 88 deselected); one Starlette deprecation warning. Local run on `600341888a4ae8a67ced204b1a02093bab193d7d`. |
| E2 | `pnpm verify:web-discovery` | PASS on current SHA `8076c1e48a6396b5c7c674311692304d865263fd`: 210 development tests, 210 production tests, 6 offline tests; offline-suite isolation verified. |
| E3 | `pnpm test:web` | PASS: 208 passed, 1 benchmark-only test skipped on `600341888a4ae8a67ced204b1a02093bab193d7d`. The later AC-05 and AC-10/11 scenarios were run separately on their listed revisions. |
| E4 | `pnpm build:web` | PASS on `600341888a4ae8a67ced204b1a02093bab193d7d`; Next.js production compilation and static generation completed. |
| E5 | `pnpm --filter @dayforge/frontend exec playwright test --config=playwright.production.config.ts --workers=4` | PASS: 208 passed, 1 benchmark-only skip on `600341888a4ae8a67ced204b1a02093bab193d7d`. A first 10-worker run timed out one reducer fixture under CPU contention; that fixture passed alone and the complete 4-worker run passed. The later AC-05 and AC-10/11 scenarios were also run in production mode. |
| E6 | `pnpm test:web:offline` | PASS: 6 offline shell/schema tests on `600341888a4ae8a67ced204b1a02093bab193d7d`. |
| E7 | `pnpm test:web:offline:update` | PASS: same-origin A/B update scenarios, including quota handling, old-build cache, dirty-input deferral, dead-tab timeout, pending-data retention, and byte-identical retries, on `600341888a4ae8a67ced204b1a02093bab193d7d`. |
| E8 | `pnpm test:api:mysql` | PASS: 88 passed, 320 deselected; isolated MySQL integration run on `600341888a4ae8a67ced204b1a02093bab193d7d`. |
| E9 | `pnpm test:sync:browser` | PASS: two-browser/MySQL sync run on `600341888a4ae8a67ced204b1a02093bab193d7d`; lost-response idempotency, LWW, pull/retry/recovery, and offline Vietnamese multiline milestone-note edit/clear converged on both devices. |
| E10 | Focused browser and static checks | PASS on current implementation SHA `8076c1e48a6396b5c7c674311692304d865263fd`: `pnpm typecheck:web`, `pnpm lint:web`, and `pnpm verify:web-discovery`; both AC-05 and AC-10/11 focused tests passed in development and production mode. |

The Windows Chromium install is under `C:\Users\ADMIN\AppData\Local\ms-playwright`; focused local Playwright commands set `PLAYWRIGHT_BROWSERS_PATH` to that directory. The focused commands were:

```powershell
pnpm --filter @dayforge/frontend exec playwright test tests/auth-session.spec.ts --grep "ownerCanMoveAndReorderTasksInsideABucketWithRecurringOccurrences" --workers=1
pnpm --filter @dayforge/frontend exec playwright test --config=playwright.production.config.ts tests/auth-session.spec.ts --grep "ownerCanMoveAndReorderTasksInsideABucketWithRecurringOccurrences" --workers=1
pnpm --filter @dayforge/frontend exec playwright test tests/auth-session.spec.ts --grep "milestoneEditsStayConsistentAcrossBothCalendarsWhenAWorkItemMoves" --workers=1
pnpm --filter @dayforge/frontend exec playwright test --config=playwright.production.config.ts tests/auth-session.spec.ts --grep "milestoneEditsStayConsistentAcrossBothCalendarsWhenAWorkItemMoves" --workers=1
```

The final PR CI run will execute the complete workflows on the pushed candidate SHA.

## AC-01–AC-38 matrix

| AC | Status | Test / scenario | Command | Evidence | Tested SHA / run / environment | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| AC-01 | PASS | `workWeekShowsSevenDaysAndThreeAlignedPeriodsAcrossNewYear` — seven days, three aligned periods, year boundary | E3 | `frontend/tests/calendar-widget.spec.ts` | E3; Windows Chromium | All seven dates and morning/afternoon/evening buckets are asserted. |
| AC-02 | PASS | Create from a work-week bucket; prefilled day/period and no exact start time | E3 | `frontend/tests/auth-session.spec.ts::ownerCanCompleteOverdueAndDeleteTasksWithOfflineUndoAtUtc7Midnight` | E3; Windows Chromium | The scenario starts from a dated period bucket and saves the task there. |
| AC-03 | PASS | `ownerCanCreateTaskAndNestedPlanWithoutLosingTheTaskDraft` also creates quick tasks without selecting a plan | E3 | `frontend/tests/auth-session.spec.ts` | E3; Windows Chromium | Quick-created tasks appear in the bucket without a plan selection. |
| AC-04 | PASS | `ownerCanCreateTaskAndNestedPlanWithoutLosingTheTaskDraft` | E3 | `frontend/tests/auth-session.spec.ts` | E3; Windows Chromium | Name, day, period, estimate and selected new plan survive the nested plan dialog. |
| AC-05 | PASS | `ownerCanMoveAndReorderTasksInsideABucketWithRecurringOccurrences` — drag/move plus keyboard reorder using Enter | E10 | `frontend/tests/auth-session.spec.ts` | E10; current SHA; dev and production Chromium | The reorder action is activated from the keyboard, not only by pointer. |
| AC-06 | PASS | `ownerCanCompleteOverdueAndDeleteTasksWithOfflineUndoAtUtc7Midnight` | E3 | `frontend/tests/auth-session.spec.ts` | E3; Windows Chromium | Completed and overdue states are distinct and retain the plan color. |
| AC-07 | PASS | `ownerCanCompleteOverdueAndDeleteTasksWithOfflineUndoAtUtc7Midnight` | E3 | `frontend/tests/auth-session.spec.ts` | E3; Windows Chromium | Delete removes the card; undo restores it. |
| AC-08 | PASS | `ownerCanCreateAndEditAPlanThroughTheCalendarWidget` | E3 | `frontend/tests/auth-session.spec.ts` | E3; Windows Chromium | Plan edits and member task color are checked. |
| AC-09 | PASS | `calendarSwitchClosesAndFocusesMain`; `milestoneCalendarSupportsWeekMonthYearAndReturnsToItsSavedContext` | E3 | `frontend/tests/calendar-widget.spec.ts`; `frontend/tests/milestone-calendar.spec.ts` | E3; Windows Chromium | Calendar routes and scale context are asserted; widget/dialog controls remain operable. |
| AC-10 | PASS | `milestoneEditsStayConsistentAcrossBothCalendarsWhenAWorkItemMoves` | E10 | `frontend/tests/auth-session.spec.ts` | E10; current SHA; dev and production Chromium | Same milestone ID, edited name/date and color are verified in both views. |
| AC-11 | PASS | `milestoneCanBeKeptOutOfTheWorkCalendar`; `milestoneEditsStayConsistentAcrossBothCalendarsWhenAWorkItemMoves` | E3, E10 | `frontend/tests/auth-session.spec.ts` | E3/E10; Windows Chromium | A task move leaves the separate milestone's ID/date unchanged; visibility can be disabled independently. |
| AC-12 | PASS | `denseMilestoneDayKeepsEveryMarkerOpenable`; dense work-week recurrence fixture | E3, E5 | `frontend/tests/calendar-density.spec.ts`; `docs/tasks/t27/performance-results.md` | E3/E5; Windows Chromium | 20 markers on one day remain available in the day dialog; dense work occurrences are also covered. |
| AC-13 | PASS | `ownerCanCreateAWeeklyTaskAndSeeItsOccurrencesAcrossViewedWeeks`; `ownerCanEnableRecurrenceWithoutChangingTheExistingFirstOccurrence` | E3 | `frontend/tests/auth-session.spec.ts` | E3; Windows Chromium | Weekly recurrence and the existing first occurrence are checked. |
| AC-14 | PASS | `ownerCanEditDeleteAndUndoOneRecurringOccurrenceWithoutChangingItsSiblings` | E3 | `frontend/tests/auth-session.spec.ts` | E3; Windows Chromium | Edit/delete/undo are scoped to one occurrence. |
| AC-15 | PASS | Recurrence expansion with moved/detached occurrences; `denseWorkWeekKeepsMovedAndDetachedOccurrencesExactlyOnce` | E3, E5 | `frontend/tests/reducer-parity.spec.ts`; `frontend/tests/calendar-density.spec.ts` | E3/E5; Windows Chromium | A moved occurrence remains visible in its destination week exactly once. |
| AC-16 | PASS | `ownerCanEditFutureRuleDetachExceptionsAndStopByOriginalDate` | E3 | `frontend/tests/auth-session.spec.ts` | E3; Windows Chromium | Future exceptions detach while earlier history remains intact. |
| AC-17 | PASS | `ownerCanEditFutureRuleDetachExceptionsAndStopByOriginalDate`; single-occurrence delete/undo scenario | E3 | `frontend/tests/auth-session.spec.ts` | E3; Windows Chromium | Stop removes future members, preserving prior history and detached work. |
| AC-18 | PASS | `ownerCanCompleteOverdueAndDeleteTasksWithOfflineUndoAtUtc7Midnight` | E3 | `frontend/tests/auth-session.spec.ts` | E3; Windows Chromium | Fixed-clock browser scenario checks the UTC+07:00 day boundary. |
| AC-19 | PASS | `production shell survives a browser restart offline and keeps private paths out of Cache Storage` | E6 | `frontend/tests/offline-shell.spec.ts` | E6; production Chromium | Shell is reopened offline after browser restart; private routes are excluded from Cache Storage. |
| AC-20 | PASS | Offline update suite: local edits/outbox survive reload and build transition | E7 | `scripts/test-offline-update.cjs` | E7; production same-origin browser lanes | Includes queued data, draft/cache privacy, and pending update scenarios. |
| AC-21 | PASS | Two-browser offline reconnect and app-open sync | E9 | `scripts/test_sync_browser.cjs` | E9; isolated MySQL and two Chromium devices | Reconnect/pull converges without requiring a closed-app background sync. |
| AC-22 | PASS | Lost push response and identical retry | E9 | `scripts/test_sync_browser.cjs` | E9; isolated MySQL and two Chromium devices | Recorded/duplicate receipts prove idempotent replay. |
| AC-23 | PASS | Edit during an in-flight push; ACK and pull recovery | E9 | `scripts/test_sync_browser.cjs` | E9; isolated MySQL and two Chromium devices | Newer local edit remains authoritative through stale response/retry. |
| AC-24 | PASS | Two-device LWW by edit time under reverse arrival | E9 | `scripts/test_sync_browser.cjs`; `frontend/tests/reducer-parity.spec.ts` | E9/E3; isolated MySQL and Chromium | Convergence is automatic; no manual conflict picker. |
| AC-25 | PASS | Delete/edit ordering and tombstone/retry behavior | E8, E9 | `backend/tests/`; `scripts/test_sync_browser.cjs` | E8/E9; isolated MySQL and two Chromium devices | Delete-versus-edit outcomes converge deterministically. |
| AC-26 | PASS | Pull while a local outbox edit exists; stale pull refetch | E9 | `scripts/test_sync_browser.cjs` | E9; isolated MySQL and two Chromium devices | Old remote state does not overwrite the newer local edit. |
| AC-27 | PASS | Multi-tab leadership, cursor recovery, retries and close-to-concurrent server writes | E8, E9 | `backend/tests/`; `scripts/test_sync_browser.cjs` | E8/E9; isolated MySQL and two Chromium devices | Runner checks no missing cursor changes and no false synced state. |
| AC-28 | PASS | Service-worker/build update with dirty input and pending operations | E7 | `scripts/test-offline-update.cjs` | E7; production same-origin browser lanes | Pending content remains available through update. |
| AC-29 | PASS | Long-offline bootstrap and epoch recovery | E9 | `scripts/test_sync_browser.cjs` | E9; isolated MySQL and two Chromium devices | Snapshot/cursor recovery retains unsubmitted local operations. |
| AC-30 | PASS | `expiredSessionKeepsPendingForMatchingOwnerOnly`; `quotaFailureNeverClaimsLocalSaveOrSync` | E3 | `frontend/tests/auth-session.spec.ts`; `frontend/tests/storage-failures.spec.ts` | E3; Windows Chromium | Expiry preserves the matching owner's pending work; quota errors never claim save/sync success. |
| AC-31 | TARGET_PENDING | Local registration/callback/API checks; real inbox delivery | E3, E8 | `frontend/tests/auth-session.spec.ts::verifyCallbackPostsOnlyAfterConfirmationAndScrubsFragment`; `backend/tests/api/test_auth_account_flows.py` | E3/E8; local mocks/Mailpit only | Production inbox verification remains for T32; mocked/local delivery is not counted as PASS. |
| AC-32 | TARGET_PENDING | Local reset callback/API checks; real reset inbox and old-password revocation | E3, E8 | `frontend/tests/auth-session.spec.ts::resetCallbackRequiresMatchingPasswords`; `backend/tests/api/test_auth_account_flows.py` | E3/E8; local mocks/Mailpit only | End-to-end reset email delivery to the real inbox remains for T32. |
| AC-33 | PASS | `accountLoginDefaultsRememberMeAndUnlocksOwner`; `expiredSessionKeepsPendingForMatchingOwnerOnly`; `reloadRestoresUnlockedOwnerWhenSessionApiIsUnavailable` | E3 | `frontend/tests/auth-session.spec.ts` | E3; Windows Chromium | Remembered session and reauthentication for the same owner are covered. |
| AC-34 | PASS | `logoutLocksOtherTabsAndPreservesEncryptedPendingData`; `logoutWithDirtyFormRequiresContinueOrExplicitDiscard` | E3 | `frontend/tests/auth-session.spec.ts` | E3; Windows Chromium | Logout warning/choice locks local access while encrypted pending operations remain. |
| AC-35 | PASS | Origin/CSRF, no-store callback/auth responses, owner isolation, secret storage and private-cache exclusion | E1, E6, E8, E9 | `backend/tests/api/test_auth_account_flows.py`; `frontend/tests/auth-routes.spec.ts`; `frontend/tests/storage-security.spec.ts`; `frontend/tests/storage-failures.spec.ts`; `frontend/tests/offline-shell.spec.ts` | E1/E6/E8/E9; local HTTPS/auth/sync harness | Software-level checks pass, including local HTTPS same-origin sync; no production DNS/certificate claim is made. |
| AC-36 | TARGET_PENDING | Independent host remains available while the personal PC is off | — | T32/T36 target-environment run | Not run; no independent production host configured | Requires the selected independent host and live two-device check. |
| AC-37 | PASS | `milestoneCalendarShowsHiddenMarkersAndOpensTheFullDayAndRelatedWorkWeek`; milestone editor flow | E3 | `frontend/tests/auth-session.spec.ts` | E3; Windows Chromium | All-day and morning/afternoon/evening markers are represented across both calendars. |
| AC-38 | PASS | Offline multiline Vietnamese milestone note edit and clear across two browsers | E9 | `scripts/test_sync_browser.cjs`; Unicode storage test in `frontend/tests/storage-failures.spec.ts` | E9/E3; isolated MySQL and two Chromium devices | Note content, line breaks, all-day state and cleared note converge on both devices. |

## Remaining target checks

- **T32:** Verify registration and password-reset emails reach the real inbox and complete each link against the isolated deployed candidate.
- **T32/T36:** Verify the independent host continues serving the app and syncing while the personal PC is off.

No production deployment was performed as part of T28.
