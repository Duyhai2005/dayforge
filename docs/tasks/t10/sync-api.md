# T10 — sync API and server storage

This document describes the server API implemented for T10 and the client/server boundary for T11 and T12. The normative wire contract remains [T03 API](../t03/api-contract.md), [T03 sync](../t03/sync-contract.md), and [T03 data](../t03/data-contract.md).

## Routes and request flow

All sync routes use `/api/v1/sync` and require a verified owner session; `/api/v1/version` is public. The server obtains the owner from the verified session. `owner_id` in an operation is checked as an assertion and never grants access by itself.

| Route | Purpose | Cursor behavior |
| --- | --- | --- |
| `GET /sync/clock?device_id=...` | Return a server UTC timestamp and maximum future skew for client clock calibration. | Does not create an operation or advance a cursor. |
| `POST /sync/push` | Validate a batch and process each operation in request order, each in its own database transaction. | A newly recorded operation receives one owner cursor. A retry with the same operation ID and hash returns its original receipt and cursor. |
| `GET /sync/bootstrap` | Read the owner event log from the start through a captured committed head `H`. | Continuation pages keep the same `H` and epoch. |
| `GET /sync/pull?after=...&epoch=...` | Read changes after the client's pulled cursor. | The first page requires both `after` and `epoch`; continuation uses only `page_token`. The response cursor advances through returned groups, and the final page advances to `H`. |

Every successful sync response and every API Problem response uses `Cache-Control: no-store`. POST requests require JSON, a matching `Origin` (or same-origin `Referer`), and the session CSRF token. Problem bodies use `application/problem+json`. Request logs contain only an allowlisted event, request ID, method, route template, status, duration, and stable error code; they do not read or serialize request bodies.

## Limits and compatibility

`GET /api/v1/version` publishes the current limits and supported versions. The values are also fixed in `backend/app/schemas/system.py` and covered by `backend/tests/api/test_system.py`.

| Limit | Value |
| --- | ---: |
| Operations per push | 100 |
| Push request body | 8,388,608 bytes |
| One operation envelope | 2,097,152 bytes |
| Commands per operation | 1,000 |
| Groups per page | 200 |
| Page response body | 8,388,608 bytes |
| Page token lifetime | 1,800 seconds |
| Protocol/reducer versions | 1 / 1 |

The page token is opaque HMAC-SHA256 authenticated data signed with `SYNC_PAGE_TOKEN_KEY_B64`, a dedicated 32-byte secret distinct from authentication secrets. It binds the endpoint, owner, epoch, initial cursor, fixed head `H`, current position, API/schema versions, and expiry. It contains no operation payload. Tampering or wrong-owner use returns a generic malformed-request Problem; expiry and epoch changes have their T03 Problem codes.

## Storage and migration

Migration `0004_sync` follows `0003_auth_lifecycle_hardening`. It creates InnoDB tables for the owner epoch/head, immutable recorded envelopes, receipts, and owner-scoped change-log cursors. A push locks the owner's sync-state row and writes the envelope, receipt, change row, and next cursor in one transaction. Failed transactions leave the prior head intact. Pull reads the primary database and scopes event queries by owner and epoch. The event log and tombstones are retained; T10 does not prune or compact them.

Set a unique random 32-byte `SYNC_PAGE_TOKEN_KEY_B64` in each environment before starting the backend. Local setup adds a key to an existing generated backend environment file without overwriting its other settings. Apply schema changes with the normal backend Alembic upgrade (`alembic upgrade head`). Do not deploy a backend that has not applied `0004_sync`.

## T11 client handoff

- Persist an operation ID and exact envelope before first push. Retry the same ID and same content after a lost response; a changed body under that ID is an integrity error.
- Send dependencies before dependent operations. `dependency_missing` is deferred and does not ACK the operation.
- Treat a `recorded` or `duplicate` receipt as proof that the event was durably accepted, not proof that local pull state has advanced.
- Track the local pull cursor separately from `head_cursor` and receipt `commit_cursor`. Advance it only from successful pull/bootstrap pages after the corresponding groups are saved locally.
- Keep pending state through auth, epoch, token expiry, validation, and retryable server errors as required by T03.

## T12 reducer boundary and current acceptance gap

T10 stores and returns immutable envelopes; it does not apply calendar commands to a business projection or implement canonical LWW replay. T12 owns reducer behavior, semantic effect calculation, and projection.

There is a contract gap to resolve before declaring T10 fully accepted: fresh receipts currently write `effect_at_commit="applied"` as a placeholder, while T03 defines this field using reducer outcomes such as applied, superseded, and no-op. T12 must either provide the reducer result to receipt creation or revise the versioned contract before production use. No reducer outcome is claimed by this T10 implementation.

## Verification status

The full backend API suite passes (**115 tests**), the complete non-MySQL backend suite passes (**289 tests**), and the isolated backend MySQL suite passes (**87 tests**). API/MySQL tests were run outside the sandbox because Windows asyncio's local socketpair and Docker API pipe are blocked inside it. PNPM wrapper commands cannot start because workspace project symlink creation returns `EPERM`; the Python MySQL runner was invoked directly and completed. See [the T10 plan](plan.md) and [verification report](review-and-verification.md) for exact commands and outcomes. The API remains partial and not ready to merge until T12 supplies truthful `effect_at_commit` values or the versioned T03 contract is revised.
