# T09 — Account and session verification

Date: 2026-11-01
Status: T09 acceptance checks pass for local development and the production Next.js build. Sending mail to a real production inbox remains T30/T32.

## Acceptance checks

| Case | Command or fixture | Expected behavior | Observed result |
| --- | --- | --- | --- |
| Neutral initial-account and password-reset requests | pnpm test:api -- tests/api/test_auth_account_flows.py; test_register_is_neutral_for_non_allowlisted_email; test_forgot_is_neutral_for_unknown_and_non_allowlisted_email | Ineligible/unknown addresses receive the same accepted response; no owner or delivery job is created. | Passed API suite; responses remain neutral and no account eligibility is disclosed. |
| Development email delivery | compose.auth-mailpit.yaml with Mailpit SMTP on loopback | Verify/reset messages arrive in the dev sink; tokens are in URL fragments and the encrypted outbox entry is removed after delivery. | Mailpit smoke passed for verify/reset delivery; captured links used fragments. Production provider and real inbox delivery remain T30/T32. |
| Callback scanner safety | Backend test_email_get_does_not_consume_token; browser verifyCallbackPostsOnlyAfterConfirmationAndScrubsFragment | GET only scrubs the fragment; no mutation occurs until explicit form submission. | Passed API and browser checks; the token is kept in memory and submitted only on confirmation. |
| Password login and local-key unlock | accountLoginDefaultsRememberMeAndUnlocksOwner, loginDoesNotAutoUnlockFromRestoredCookie; API local-key tests | Remember-me is selected by default. Only explicit password login fetches/imports the key. Reload may restore an already-unlocked owner from validated IndexedDB state without network access; a restored cookie never unlocks a locked owner. | Passed; reload recovery validates the persisted non-extractable key and sentinel without another local-key request. `/auth/local-key` remains protected by verified-owner and recent-password checks. |
| Password reset and expired session | API test_reset_revokes_sessions_but_preserves_owner_key; browser resetCallbackRequiresMatchingPasswords, expiredSessionKeepsLocalVaultAvailable, expiredSessionStillAllowsManualLocalLock | Mismatched passwords are rejected; reset revokes sessions but preserves the owner key; expiry does not lock local data, and the user can still lock it manually without a live session. | Passed API and browser checks; the local-only lock sends no server revoke request. |
| Unicode email input | unicodeEmailReachesServerCanonicalization | Unicode local parts and IDNA domains reach server-side canonicalization without native browser validation rejecting or rewriting the input. | Passed; browser sends `chủ@BÜCHER.example` unchanged. |
| Delayed login cancellation | delayedLocalKeyCannotReopenOwnerAfterRemoteLogout | A delayed `/local-key` response cannot reopen the vault after another tab logs out. | Passed; lock events invalidate pending login attempts and a stale in-flight unlock is re-locked. |
| Offline logout across tabs | logoutOfflineLocksAllTabsAndPreservesPendingData with an unlocked owner and pending operation | Explicit offline logout locks all tabs, notifies local lock subscribers in each tab, stores the revoke ticket for retry, and preserves encrypted pending data/drafts byte-for-byte. | Passed browser coverage; remote lock emits the local `dayforge:owner-locked` event without rebroadcasting. |
| Logout-ticket key rotation | test_logout_ticket_survives_key_rotation_until_session_expiry; test_logout_ticket_accepts_previous_verification_key_after_rotation | Tickets signed by a previous key remain valid until their sessions expire and can revoke only their target session. | Passed unit, settings, and MySQL integration checks. New tickets use the current key; verification checks the configured current and previous key ring. |
| Owner-state migration | ownerAuthStateMigrationPreservesT08Stores; storage migration suite | Schema v1→v2 adds auth_state without deleting T08 stores, outbox data, or drafts. | Passed; T08 storage and pending data remain readable after migration. |
| Owner isolation and API boundary | API auth account/session suites; route registration | A verified owner and fixed workspace are created atomically; local-key access is owner-gated; T09 exposes no calendar CRUD endpoints. | Passed backend unit/API/MySQL suites; calendar CRUD/sync remains outside T09. |
| Production cache/referrer policy | PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 pnpm --filter @dayforge/frontend exec playwright test --config playwright.production.config.ts tests/auth-session.spec.ts tests/auth-routes.spec.ts --workers=1 --reporter=line | Auth and callback responses carry private no-store, Pragma: no-cache, and Referrer-Policy: no-referrer. | Passed: 18 production auth/callback tests. |

## Verification runs

- pnpm verify:fast — passed: ESLint, Ruff, Black, TypeScript, mypy, 28 environment/script regressions, and 236 non-MySQL backend tests; 61 MySQL tests were deselected.
- pnpm test:api:mysql — passed: 61 tests, 236 deselected, no skips.
- pnpm --filter @dayforge/frontend exec playwright test --workers=4 --reporter=line — passed: 136 browser tests.
- pnpm build:web — passed.
- Production auth/callback Playwright command above — passed: 18 tests with one worker.
- pnpm test:api:mysql -- tests/integration/test_readiness.py -v — passed: 14 tests after fixing the fixture to drop auth child tables before users.
- Mailpit development SMTP smoke — passed for verification/reset delivery, fragment links, and encrypted outbox cleanup.

The FastAPI startup check continues to bind OWNER_EMAIL to the existing owner. Owner creation preserves the fixed WorkspaceSettings transaction and does not add calendar CRUD routes.

The default local Playwright invocation selected 10 workers in this environment and hit the 30-second timeout once for viewControlsEnforceT03DomainBounds (131/132 in the original suite). The isolated test passed in 8.5 seconds; the final full suite, including the review regressions, passed with --workers=4 (136/136), so local verification pins four workers. No application changes were made for this runner-only timeout.

The earlier 2-worker production auth run following the full dev suite/build had one transient setup failure (13/14) while waiting for owner metadata. The case passed alone in 2.7 seconds; the final production auth/callback suite passed with --workers=1 (18/18). This points to local scheduling pressure; the acceptance command now records the stable one-worker setting.

## Independent final review

The independent review of `8d8debe..dc3971f` found no Critical findings and six Important findings, with a verdict of not ready to merge. All six Important findings were fixed and covered by the final runs above:

| Finding | Disposition |
| --- | --- |
| Delayed login could reopen the vault after logout | Added attempt invalidation and a stale-unlock re-lock; `delayedLocalKeyCannotReopenOwnerAfterRemoteLogout` passes. |
| Session expiry hid the local lock action | Logout derives its owner from local access, skips server revoke for an anonymous session, and keeps a “Khóa dữ liệu” action; `expiredSessionStillAllowsManualLocalLock` passes. |
| Reload/new tab lost an unlocked local owner | Added network-independent IndexedDB restore with CryptoKey and sentinel validation, gated on pending logout tickets; `reloadRestoresUnlockedOwnerWhenSessionApiIsUnavailable` passes and the restored-cookie test remains passing. |
| Native email validation rejected Unicode local parts | Changed the field to text with email input mode; `unicodeEmailReachesServerCanonicalization` passes. |
| Remote logout skipped local lock subscribers | Remote BroadcastChannel receipt now dispatches the local-only owner-lock event; cross-tab logout asserts one subscriber notification. |
| Previous logout-ticket keys were not accepted | Added an optional previous-key ring and constant-time comparisons across all configured keys; the MySQL rotation replay test passes. |

The review’s Minor finding was the production acceptance command’s `--workers=2` mismatch; this report now records the final passing `--workers=1` command. The reviewer declined to judge real inbox delivery/T30/T32, sync cancellation and offline cache/T11/T13, and deployment capacity/Argon2 latency; those remain outside T09 acceptance.

## PR #9 review follow-up

Date: 2026-11-02

The follow-up changes address the PR #9 lifecycle and concurrency findings:

| Area | Change |
| --- | --- |
| Offline logout | The pending revoke ticket and local owner lock now commit in one IndexedDB transaction. Tickets bind to an owner; recovery locks that owner before replay, and legacy unbound tickets lock all known local owners. |
| CSRF refresh | Auth mutations refresh the session and retry once only for an explicit `csrf_failed` response. Request-attempt guards prevent a stale login/local-key response from reopening a vault after logout. |
| Password/session race | Successful login rehashes outdated Argon2 parameters and creates the session only after locking and re-reading the user. A changed auth version rejects the attempt, and concurrent rehashes are not overwritten. |
| Audit trail | Added a migration-backed auth audit table and privacy-safe records for auth lifecycle outcomes. Email and peer identifiers use scoped HMAC digests; raw email, IP, token, password, and request body are not stored. |
| Email delivery concurrency | Outbox work is claimed in a short transaction with a claim token and 120-second lease. SMTP runs outside the transaction, and finalization compares the claim token. |
| Retention and bounded cleanup | A separate 60-second maintenance worker deletes at most 500 rows per table per pass, using the documented session, token, rate-limit, outbox-lease, and 30-day audit retention rules. |

### Follow-up verification

- `pnpm --filter @dayforge/frontend typecheck` — passed.
- `pnpm --filter @dayforge/frontend exec playwright test tests/auth-session.spec.ts` — passed, 13/13.
- `pnpm --filter @dayforge/frontend exec playwright test --workers=4 --reporter=line` — passed, 156/156; the dev web server logs expected refused proxy connections because the backend is not running in this browser-only suite.
- `pnpm build:web` — passed.
- `python -m ruff check --no-cache backend/app backend/tests` — passed.
- `python -m compileall -q backend/app backend/tests` — passed.
- `python -m alembic upgrade head --sql` — passed; offline SQL generation includes migration 0003.
- Backend pytest collection/integration could not run in this environment: the configured Python environment is missing `argon2` and `email_validator`. MySQL integration behavior therefore remains unverified here.
- The final Black recheck did not complete in this Python 3.12 environment; Black reports the project formatter target is Python 3.14. The earlier pre-final-edit check passed, but this follow-up does not claim a final Black pass.

The follow-up changes are tracked on PR #9.

## PR #9 review corrections after `76736e0`

Date: 2026-11-02

- Login now captures its active attempt after synchronously publishing locks recovered from pending logout tickets. A recovery event from the current login no longer cancels that same login; a ticket that still cannot be replayed remains visible as an error. The browser regression covers both the failed replay and subsequent successful login in the same tab.
- Email delivery renews the active claim immediately before SMTP and keeps renewing it while that message is in flight. A worker skips a claim whose token was replaced, and the finalizer still uses token compare-and-set. A two-worker regression crosses the lease boundary with multiple queued messages.
- The login owner check now narrows `canonical` explicitly for mypy. Authenticated `session_created` audit events now include the owner email pseudonym, matching the auth-event assertions.
- The seven-day token-pruning test now calls `cleanup_auth_storage()`, and the bounded-cleanup result expects the one eligible stale token deleted in its one-row pass.

## Handoffs

- **T10:** protect sync endpoints with require_verified_owner; preserve the T09 owner ID and use the existing auth session boundary.
- **T11:** subscribe through subscribeOwnerLock / the owner-lock event before starting sync; stop in-flight requests and replay when the owner locks. Offline logout tickets are retried before a later authenticated session proceeds.
- **T13:** exclude /api/**, /verify-email, /reset-password, and auth responses from shared caches; preserve private no-store and no-referrer behavior.
- **T25:** report expiry, logout/revoke-pending, and neutral email-request states clearly without exposing account eligibility.

## Remaining scope

T09 covers the development SMTP sink only. A production mail provider, delivery to a real inbox, and deployed-origin verification remain T30/T32.
