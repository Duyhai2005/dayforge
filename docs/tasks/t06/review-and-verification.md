# T06 — Verification and handoff

**Date:** 29/10/2026  
**Branch:** `feature/t06-nextjs-shell`  
**Task 5 base:** `5a60f5d9f6a8bc49993a51f83a75941e46a0ffd2`  
**Result:** the T06 framework shell is implemented and the checks below pass. Native Cốc Cốc acceptance was skipped at the user direction. The configured HTTPS/API smoke was unavailable in this checkout and is not claimed as passed.

## Delivered scope

- `/` redirects to `/work`; `/work` and `/milestones` render the dark calendar shell without calendar records or owner data.
- View date/scale uses URLs and history. Separate session preferences preserve each calendar view and scroll position; invalid or unavailable storage falls back safely. Dates use UTC+07:00, with month-end/leap-day navigation covered.
- The collapsed navigation widget opens date/range/scale/calendar/account controls. Dismissal returns focus, calendar switching closes the widget and focuses the destination main region, and reduced motion is supported. Add controls remain disabled with an explicit saving-unavailable explanation.
- `/account` is an account placeholder. `/verify-email` and `/reset-password` are dynamic neutral callback shells; they retain a fragment token only in component refs and remove the full fragment without posting, rendering, logging or persisting it. The existing API rewrite remains in place.
- The T04 smoke web probe now requests `/work` directly, preserving HTTPS validation, no redirects and the unchanged `/api/v1/openapi.json` probe. Caught HTTP error responses are closed before the safe error is raised.

## Verification environment

| Component | Observed version/configuration |
| --- | --- |
| OS | Microsoft Windows 11 Home, `10.0.26300`, build `26300` |
| Node.js | `24.22.1` |
| pnpm | `12.16.1`, invoked via `npm exec --yes --package=pnpm@12.16.1 -- pnpm ...` |
| uv / CPython | `0.13.6` / `3.14.10`; the existing pinned local uv toolchain was added to process PATH |
| Next.js / React / TypeScript | `16.4.3` / `19.3.1` / `6.0.3` |
| Playwright / test browser | `1.64.1` / Playwright Chromium `156.0.8078.4` |
| Internal API origin used for build | `http://127.0.0.1:8000` |
| Production test origin | `http://127.0.0.1:3001` |

## Commands and results

Node/uv binaries were added to the verification process PATH. The pnpm commands below used the npm package runner shown above; `FORCE_COLOR` and `NO_COLOR` were cleared for browser runs. No environment secret values were printed or copied.

| Check | Actual command and result |
| --- | --- |
| Environment suite before smoke fix | `pnpm verify:env` — **PASS**, original 7 cases. |
| Complete development browser suite | `pnpm --filter @dayforge/frontend exec playwright test`, with `PLAYWRIGHT_BASE_URL` unset — **PASS**, 26/26 (`14.6s`); managed Next dev server on port `3010`. |
| Production build | Set `API_INTERNAL_ORIGIN=http://127.0.0.1:8000`, then `pnpm build:web` — **PASS**, compilation, TypeScript and page generation complete. Build identifies both callback routes as dynamic. |
| Production server | `pnpm start:web` — **PASS**, Next.js ready on loopback port `3001`. |
| Complete production browser suite | Set `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001`, then `pnpm --filter @dayforge/frontend exec playwright test` — **PASS**, 26/26 (`6.5s`), including strict callback `private` and `no-store` assertions. |
| Production callback header probe | `Invoke-WebRequest -UseBasicParsing` for both callback URLs — **PASS**, exact observed values in the table below. |
| Smoke path regression RED | `uv run --directory backend --locked python -m unittest discover -s ../scripts/tests -p test_smoke_local.py -v` — expected failure before the fix: the root fixture redirects and the web probe is not 200. The no-redirect case passed. |
| Smoke path/no-redirect regression GREEN | Same focused command after the fix — **PASS**, 2/2, no warnings. The route test uses a controlled transport fixture; the no-redirect test uses a real loopback HTTP server. These are not a configured HTTPS/API end-to-end run. |
| Complete environment suite after smoke fix | `pnpm verify:env` — **PASS**, 9/9, no warnings; includes generator, origin guard and smoke regressions. |
| Source hygiene | `git diff --check` — **PASS**. Generated environment files, keys, browser screenshots, build output and node modules are not staged. |

### Production callback headers

| Path | HTTP | Cache-Control | Pragma | Referrer-Policy |
| --- | --- | --- | --- | --- |
| `/verify-email` | `200` | `no-store, private` | `no-cache` | `no-referrer` |
| `/reset-password` | `200` | `no-store, private` | `no-cache` | `no-referrer` |

Next.js dev replaces `Cache-Control` with `no-store`; the dev suite checks this and the other required headers. Supplying the built production origin through `PLAYWRIGHT_BASE_URL` makes the same browser test require `private` too. The production run above exercised that strict assertion.

## Interaction and layout evidence

The full browser runs cover root/calendar/account routes, UTC+07:00 midnight, URL precedence and invalid fields, month-end/leap-day movement, malformed/blocked storage, separate calendar preferences and scroll restoration, Back/Forward, widget toggle/Escape/outside dismissal, destination-main focus, view controls, disabled add actions, reduced motion, token cleanup/leakage and same-origin scripts.

A transient Playwright layout probe rendered both calendar routes with the widget expanded at `1024×768` and `1920×1080`. Document scroll width equaled viewport width in all four cases. The widget stayed 16px above the viewport bottom, and the expanded panel remained entirely inside the viewport. The milestone laptop and work desktop screenshots were visually inspected; controls and Vietnamese labels were visible without overlap. This proves those Chromium layouts, not native Cốc Cốc acceptance.

Known minor from Task 3 review: the expanded panel precedes its toggle in DOM order, so forward Tab from the toggle skips the panel; Shift+Tab reaches it. Escape/dismissal and destination-main focus pass. This item remains visible to the final whole-branch review.

## Explicit exceptions and limits

- **Native Cốc Cốc: not run at the user direction.** No native-browser PASS, version, certificate trust or end-to-end acceptance is claimed.
- **Configured HTTPS same-origin smoke: not run in the T06 checkout.** The `.env`, `backend/.env` and `frontend/.env.local` files and local TLS leaf certificate/key are absent; neither API port `8000` nor HTTPS port `3000` was listening at preflight. The global mkcert public CA exists. No config, credentials, database volume or trust store was created or changed for this task. After preparing the runbook inputs, run `pnpm dev:api`, `pnpm dev:web` and `pnpm smoke:local --ca-file <rootCA.pem>`; this remains an unverified integration item for this checkout.
- Browser suites ran with the API absent and the shell remained usable. They do not establish API/DB behavior, authentication, actual email delivery, owner isolation, IndexedDB, synchronization, service-worker caching or offline reopen behavior.
- Session preference storage is a temporary UI mechanism, not owner-scoped persistence or a saved-calendar claim. No login/verify/reset business flow or calendar mutation is active.

## Handoff

| Task | Receives / remaining responsibility |
| --- | --- |
| T05 | Existing FastAPI bootstrap and API rewrite; implement settings, MySQL connection, schema/migrations, health and logs. T05 remains the next task in the existing sequence. |
| T07 | Pinned Playwright dependency/config/tests and Python regression discovery; integrate appropriate lint, type checks, broader test organization and CI. T06 did not add CI. |
| T08 | Calendar shells and view-state helpers; implement device/owner-aware local data and migrate temporary view preferences deliberately. |
| T09 | Neutral account/callback routes and verified production response headers; implement real auth/session/token-confirmation flows and owner-aware persistence against T03. Preserve fragment cleanup, no token leakage and no shared auth cache. |
| T10–T12 | No sync implementation exists in T06; build server/client sync and LWW on the later data/auth foundations. |
| T13 | Public calendar shell has no private payload; implement offline shell/resource caching while keeping callbacks and private APIs network-only and preserving pending data through upgrades. |
| T24/T26/T28 | Complete feature-level visual/keyboard acceptance and native Cốc Cốc verification after the functional flows exist; triage the recorded Tab-order minor in the final branch review. |

All commits remain local. No push, pull request or merge was performed during Task 5.
