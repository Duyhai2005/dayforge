# T09 — Account and session verification

Date: 2026-11-01
Status: T09 acceptance checks pass for local development and the production Next.js build. Sending mail to a real production inbox remains T30/T32.

## Acceptance checks

| Case | Command or fixture | Expected behavior | Observed result |
| --- | --- | --- | --- |
| Neutral initial-account and password-reset requests | pnpm test:api -- tests/api/test_auth_account_flows.py; test_register_is_neutral_for_non_allowlisted_email; test_forgot_is_neutral_for_unknown_and_non_allowlisted_email | Ineligible/unknown addresses receive the same accepted response; no owner or delivery job is created. | Passed API suite; responses remain neutral and no account eligibility is disclosed. |
| Development email delivery | compose.auth-mailpit.yaml with Mailpit SMTP on loopback | Verify/reset messages arrive in the dev sink; tokens are in URL fragments and the encrypted outbox entry is removed after delivery. | Mailpit smoke passed for verify/reset delivery; captured links used fragments. Production provider and real inbox delivery remain T30/T32. |
| Callback scanner safety | Backend test_email_get_does_not_consume_token; browser verifyCallbackPostsOnlyAfterConfirmationAndScrubsFragment | GET only scrubs the fragment; no mutation occurs until explicit form submission. | Passed API and browser checks; the token is kept in memory and submitted only on confirmation. |
| Password login and local-key unlock | accountLoginDefaultsRememberMeAndUnlocksOwner, loginDoesNotAutoUnlockFromRestoredCookie; API local-key tests | Remember-me is selected by default. Only the explicit password-login flow fetches/imports the owner key and unlocks the vault; a restored cookie alone does not. | Passed; /auth/local-key remains protected by verified-owner and recent-password checks. |
| Password reset and expired session | API test_reset_revokes_sessions_but_preserves_owner_key; browser resetCallbackRequiresMatchingPasswords, expiredSessionKeepsLocalVaultAvailable | Mismatched passwords are rejected; reset revokes sessions while preserving the owner key; expiry status does not lock already-open local data. | Passed API and browser checks. |
| Offline logout across tabs | logoutOfflineLocksAllTabsAndPreservesPendingData with an unlocked owner and pending operation | Explicit offline logout locks all tabs, stores the revoke ticket for retry, and preserves encrypted pending data/drafts byte-for-byte. | Passed browser coverage; ticket is persisted in auth_state, and lock notification reaches the other tab. |
| Owner-state migration | ownerAuthStateMigrationPreservesT08Stores; storage migration suite | Schema v1→v2 adds auth_state without deleting T08 stores, outbox data, or drafts. | Passed; T08 storage and pending data remain readable after migration. |
| Owner isolation and API boundary | API auth account/session suites; route registration | A verified owner and fixed workspace are created atomically; local-key access is owner-gated; T09 exposes no calendar CRUD endpoints. | Passed backend unit/API/MySQL suites; calendar CRUD/sync remains outside T09. |
| Production cache/referrer policy | PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 pnpm --filter @dayforge/frontend exec playwright test --config playwright.production.config.ts tests/auth-session.spec.ts tests/auth-routes.spec.ts --workers=2 --reporter=line | Auth and callback responses carry private no-store, Pragma: no-cache, and Referrer-Policy: no-referrer. | Passed: 14 production auth/callback tests. |

## Verification runs

- pnpm verify:fast — passed: ESLint, Ruff, Black, TypeScript, mypy, 28 environment/script regressions, and 234 non-MySQL backend tests; 60 MySQL tests were deselected.
- pnpm test:api:mysql — passed: 60 tests, 234 deselected, no skips.
- pnpm --filter @dayforge/frontend exec playwright test --workers=4 --reporter=line — passed: 132 browser tests.
- pnpm build:web — passed.
- Production auth/callback Playwright command above — passed: 14 tests.
- pnpm test:api:mysql -- tests/integration/test_readiness.py -v — passed: 14 tests after fixing the fixture to drop auth child tables before users.
- Mailpit development SMTP smoke — passed for verification/reset delivery, fragment links, and encrypted outbox cleanup.

The FastAPI startup check continues to bind OWNER_EMAIL to the existing owner. Owner creation preserves the fixed WorkspaceSettings transaction and does not add calendar CRUD routes.

The default local Playwright invocation selected 10 workers in this environment and hit the 30-second timeout once for viewControlsEnforceT03DomainBounds (131/132). The isolated test passed in 8.5 seconds and the full suite passed with --workers=4 (132/132), so final local verification pins four workers. No application changes were made for this runner-only timeout.

The 2-worker production auth run following the full dev suite/build also had one transient setup failure (13/14) while waiting for owner metadata. The case passed alone in 2.7 seconds and the full production auth/callback suite passed with --workers=1 (14/14). This points to local scheduling pressure; no application change was made for the non-reproducing failure.

## Handoffs

- **T10:** protect sync endpoints with require_verified_owner; preserve the T09 owner ID and use the existing auth session boundary.
- **T11:** subscribe through subscribeOwnerLock / the owner-lock event before starting sync; stop in-flight requests and replay when the owner locks. Offline logout tickets are retried before a later authenticated session proceeds.
- **T13:** exclude /api/**, /verify-email, /reset-password, and auth responses from shared caches; preserve private no-store and no-referrer behavior.
- **T25:** report expiry, logout/revoke-pending, and neutral email-request states clearly without exposing account eligibility.

## Remaining scope

T09 covers the development SMTP sink only. A production mail provider, delivery to a real inbox, and deployed-origin verification remain T30/T32.