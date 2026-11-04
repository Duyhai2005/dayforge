# T32 manual staging scenarios

Run these only after the staging host, isolated database/secrets, HTTPS origin, inbox, budget, and immutable release have been approved and recorded. Keep production out of the staging configuration. Use an independent second device for device and PC-off cases.

## Evidence rules

- Keep evidence outside the repository until reviewed and redacted. Store only case IDs, UTC timestamps, candidate release ID/digests, masked inbox/account reference, result, and evidence path in the ledger.
- Never capture email tokens, passwords, cookies, logout tickets, raw verification/reset URLs, decrypted notes, or browser storage values. Do not upload Playwright trace/video for staging.
- Each evidence bundle must include `run.json` with `artifact_type: dayforge-staging-evidence`, `scope: staging`, release ID, git SHA, build ID, web/API digests, and UTC test time.
- If a prerequisite is missing, leave the related row `TARGET_PENDING` or `BLOCKED`; do not substitute Mailpit, route mocks, or an old T28 screenshot.

## MAIL-VERIFY — real verification email

1. On a clean staging installation, register the allowlisted test address using the product UI. Record the masked address and UTC request time.
2. Confirm the email arrives in the real test inbox. Open the message in a second browser/device. A mailbox link-preview GET must not consume the token.
3. Confirm the destination uses the exact staging HTTPS origin. Complete verification and set the password through the callback UI; confirm the token fragment is scrubbed from the address bar.
4. Confirm the verified owner can log in and access private sync routes; an unverified account cannot read owner data. Reusing the link or a link with the wrong purpose must fail.
5. Record message ID/provider receipt reference only after masking it. Never save the raw link or token.

## MAIL-RESET — real password reset and revocation

1. Sign the same verified staging owner in on devices A and B. Confirm both show the same owner and shared staging data.
2. Request a reset through the product UI and confirm delivery to the real inbox. Open the link on a separate browser; preview GET must not consume it.
3. Set a new password. Verify the old password is rejected, sessions on A and B are revoked, and the new password logs into the same owner without losing local pending work.
4. Verify a consumed, expired, or wrong-purpose link is rejected. Record inbox/provider reference and times without copying the URL/token.

## DEVICE-LOGIN — independent device and owner continuity

1. On device A, create a uniquely prefixed plan, task, and milestone through the product UI. Confirm them on device B after server sync.
2. On B, edit one item; reconnect A if needed and confirm convergence and no duplicate item. Use only non-sensitive test content.
3. Verify browser sessions identify the same owner without recording the owner ID, cookie, or key in shared artifacts.

## PC-OFF — independent host availability

1. Confirm staging is served by its isolated host and both test devices can load the HTTPS routes and reach the real API.
2. Shut down the personal PC used for preparation/runner work. From device B over an independent network, reload both calendar routes, create/edit a test item, confirm it syncs, and request a real password-reset email.
3. Record host identity class, shutdown/start UTC times, device/network class, results, and candidate release ID. Do not record local addresses or credentials in a public report.
4. Restart the personal PC and confirm A receives B's change. Do not require background sync while the app is closed.

## OWNER-SWITCH — sequential isolated installations

1. With profile A open, create a unique sentinel task and leave one harmless pending edit. Record the staging snapshot ID and verify a tested backup exists.
2. Stop installation A, preserve its database/secrets, then activate installation B with its own staging database/secrets and verified test owner under the same HTTPS origin. Never serve A and B simultaneously under that origin.
3. Reuse the retained browser profile and log in as owner B. Confirm no A task, draft, outbox entry, or private cache response is visible.
4. Stop B and reactivate A intact. Log in as A and confirm its local/pending data remains associated with A and can sync. Do not clear browser storage to make the scenario pass.
