# T04 — Review and verification

**Date:** 29/10/2026
**Branch:** `feature/development-environment`
**Result:** T04 development scaffold and clean-checkout runbook verified.

## Verification environment

| Component | Observed version / configuration |
| --- | --- |
| OS | Windows 11 Home, `10.0.26300`, build `26300` |
| Node.js | `24.22.1` |
| pnpm used for verification | `12.16.1` (invoked through a temporary npm package runner because the host fallback `pnpm` on PATH was `11.25.0`) |
| uv / Python | uv `0.13.6`; CPython `3.14.10` |
| Next.js / React | `16.4.3` / `19.3.1` |
| FastAPI / Uvicorn | `0.162.0` / `0.54.0` |
| Docker Engine / Compose | `29.5.3` / `5.1.4` |
| MySQL image | `mysql:8.4.13@sha256:a0225d1ea6631c8bc2385dc4c2faba17bbf1834ecf369e1659a9a382bd8d5dd7` |
| mkcert | `1.4.4` |

The verification checkout was a detached worktree at `.local/verification/Dayforge clean checkout`. It started from committed files and had no copied environment files, virtualenv, `node_modules`, TLS files or Next build output. The walkthrough created those local artifacts afresh. `COMPOSE_PROJECT_NAME=dayforge-t04-verify` isolated its database project from the main checkout.

## Commands and results

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` in the clean checkout and main checkout | **PASS.** Both used pnpm `12.16.1`; `pnpm-lock.yaml` remained unchanged. |
| `uv sync --directory backend --locked` in the clean checkout and main checkout | **PASS.** Both used Python `3.14.10`; `backend/uv.lock` remained unchanged. |
| `pnpm setup:local` in the clean checkout | **PASS.** Created `.env`, `backend/.env` and `frontend/.env.local`; secret values were not printed. |
| mkcert certificate creation in the clean checkout | **PASS.** Created a fresh certificate/key for `localhost`, `127.0.0.1` and `::1`. mkcert reported that the CA was not installed in the system trust store; no trust installation was attempted. |
| `pnpm db:up` in the isolated clean checkout | **PASS.** MySQL became healthy at `127.0.0.1:3307` using the pinned image digest. |
| `pnpm dev:api`, `pnpm dev:web`, `pnpm smoke:local --ca-file <rootCA.pem>` in the clean checkout | **PASS.** The HTTPS page and `/api/v1/openapi.json` passed through the same origin. |
| `pnpm db:down` in the clean checkout | **PASS.** Container/network stopped and the isolated `dayforge-t04-verify_mysql-data` volume remained. |
| Same-origin smoke in the main checkout after restoring services and after the production build | **PASS.** Output: `PASS: local HTTPS web and API bootstrap`. |
| `pnpm verify:env` | **PASS.** Seven unittest cases passed: five environment-generator tests and two frontend origin-guard regression tests. |
| `pnpm build:web` | **PASS.** Next.js production build and TypeScript checks completed; `/` was generated. |
| `pnpm start:web` and `Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3001/` | **PASS.** HTTP `200`; response contained `DAYFORGE`. The probe uses basic parsing for Windows PowerShell 5.1 compatibility. |
| `git diff --check` and locked-file comparison | **PASS.** No whitespace errors or lockfile changes remained. Tracked files contain templates, not generated `.env`, private keys, `.next`, `node_modules` or `.venv` artifacts. |

## Review focus

| Failure mode | Evidence | Result |
| --- | --- | --- |
| Partial or repeated environment generation must not overwrite existing credentials | The five environment tests cover partial config refusal, missing-template behavior, rerun byte preservation and a path containing spaces/Unicode. | **PASS** |
| Manifest/runtime drift must not silently change dependencies | Locked pnpm and uv installs passed without changing lockfiles. Task 1 separately verified stale-lock and mismatched Node/uv pins fail. | **PASS** |
| Missing CA, invalid host, or occupied web port must fail clearly | Missing CA and `https://127.0.0.1:3000` each exited `1`; a second `dev:web` exited `1` with `EADDRINUSE` on port `3000`. | **PASS** |
| MySQL restart, access scope and host binding | Task 3 verified the pinned image, healthy app-user probe, `127.0.0.1:3307` binding, app-user grants limited to `dayforge_dev.*` plus global `USAGE`, and a probe row surviving `db:down`/`db:up`. The clean checkout also retained its isolated volume after `db:down`. | **PASS** |
| API outage must not look like a successful web/API setup | With Next.js left running and FastAPI stopped, smoke returned HTTP `500`, exited `1` and printed no `PASS`; restarting the API restored a passing smoke. | **PASS** |

An invalid `API_INTERNAL_ORIGIN` was also rejected by the `predev` check before Next.js opened its listener.

The final review fix added `scripts/tests/test_check_local_api_origin.py` to the existing `verify:env` discovery suite. Its temporary frontend env files cover quoted origins and exact-origin rejection. The quoted-origin regression failed before replacing literal line parsing with the `@next/env` parser shipped with pinned Next.js `16.4.3`, then passed after the fix. Existing process-variable precedence is preserved. No dependency or lockfile changed.

## Limits

The smoke check trusted the mkcert CA explicitly through `--ca-file`; this verifies the local HTTPS/API path for the smoke client. Browser trust was not verified.

The following remain outside T04 and have not been verified here: FastAPI database connection/settings/schema/migrations/health/logging (T05), calendar and account routes/UI (T06), CI and broader automated test infrastructure (T07), authentication/email, offline storage/sync, and acceptance criteria AC-01–AC-38. The T04 OpenAPI document is only a bootstrap probe.
