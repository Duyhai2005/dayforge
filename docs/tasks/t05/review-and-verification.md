# T05 — FastAPI/MySQL verification and handoff

Date: **29 October 2026**, Windows 11 build **26300** (win32), timezone Asia/Bangkok. Task 6 base: `744dd4da2637115e7c9e29593c6130539ab9d1e0`, branch `feature/fastapi-mysql-foundation`. See the [plan](plan.md) and [Windows runbook](../../development.md).

**Status: implementation, isolated verification, and final whole-branch review complete.** The reviewer found no Critical/Important issues; all three Minor findings were fixed in `6e442c9` and the scoped re-review passed. Fresh final checks passed `verify:env` (15), `test:api` (200; 38 MySQL cases deselected), and focused system API tests (18). Development-volume operations were not run; root migration wrappers passed against fresh disposable MySQL instead.

## Runtime and dependencies

| Component | Observed version |
| --- | --- |
| Node / pnpm | 24.22.1 / 12.16.1 |
| uv / CPython | 0.13.6 / 3.14.10 |
| FastAPI / Uvicorn | 0.162.0 / 0.54.0 |
| SQLAlchemy / aiomysql / PyMySQL | 2.1.6 / 0.3.2 / 1.1.3 |
| Alembic / Pydantic | 1.19.2 / 2.14.1 |
| pytest / HTTPX / jsonschema | 9.2.0 / 0.28.1 / 4.26.0 |
| Next.js / React / TypeScript (locked frontend) | 16.4.3 / 19.3.1 / 6.0.3 |
| Docker Engine / Compose | 29.5.3 / 5.1.4 |
| mkcert | 1.4.4; existing T04 CA used explicitly |
| MySQL image | `mysql:8.4.13@sha256:a0225d1ea6631c8bc2385dc4c2faba17bbf1834ecf369e1659a9a382bd8d5dd7` |

The ignored worktree-local toolchain supplied the exact runtime pins. Process-only PATH/cache/temp settings were used. Locked sync did not change either lockfile. No environment files, credentials, certificates, private keys or raw private logs are attached.

## Commands and observed results

Commands ran from the root with the pinned tools. The disposable harness invoked Alembic in `backend/` with fresh test credentials in its process environment; these are distinct from root development `db:*` commands.

| Command/check | Result and exit code |
| --- | --- |
| `uv sync --directory backend --locked` | PASS, 0; resolved 39 packages, checked 38; lockfiles unchanged. |
| New smoke tests before implementation: `python -m unittest discover -s scripts/tests -p test_smoke_local.py -v` | Expected RED, 1; six tests ran, 20 failing assertions/subtests because health/version were not probed; two existing safety cases passed. |
| Same smoke tests after implementation | PASS, 0; 6 tests. |
| `pnpm verify:env` | PASS, 0; 15 tests, including duplicate-key and invalid-timestamp smoke regressions (fresh final run: 0.607s). |
| `pnpm test:api` | PASS, 0; 200 passed, 38 MySQL cases deliberately deselected (fresh final run: 4.00s). |
| `pnpm test:api -- tests/api/test_system.py -v` | PASS, 0; 18 passed after the packaged Alembic head assertion was made dynamic. |
| `pnpm test:api:mysql` | PASS, 0; 38 passed, 200 non-MySQL cases deliberately deselected, 101.88s; no skips or warnings. Runner completed scoped cleanup. Together the backend commands cover all 238 collected tests. |
| Isolated live HTTPS harness | PASS, 0, after all checks and exact cleanup below. |
| Isolated `python -m alembic upgrade head`, `current`, repeated `upgrade head` | PASS, each 0; current `0001_owner_workspace (head)`, both application tables empty. |
| `pnpm smoke:local --ca-file <T04 rootCA.pem>` before isolated migration | Expected FAIL, 1; health HTTP 503, no PASS; `SHOW TABLES` remained empty. |
| Same HTTPS smoke after isolated migration | PASS, 0; exact `PASS: local HTTPS web, API and MySQL readiness`. |
| Root `pnpm db:migrate` / `pnpm db:current` | PASS, 0, against a fresh UUID-scoped test database only. A read-only uv environment preflight confirmed `127.0.0.1`, the generated port, `dayforge_t05_test`, `dayforge_test`, and `APP_ENV=test`; repeated migration/current/migration succeeded. The development volume was not targeted. |
| Direct Cốc Cốc health/version and browser trust/version | **NOT RUN / UNVERIFIED**, carried-forward user waiver; no browser opened and no CA trust installed. |
| Interactive API Ctrl+C shutdown | **NOT RUN**; programmatic graceful Uvicorn lifespan shutdown passed instead, with no remaining sleeping application connections. |
| `git diff --check` | PASS, 0; repeated before commit. |
| `git status --short` | PASS, 0; reviewed only intended smoke/tests/docs/plan changes before staging. |

The first sandbox uv invocation failed (exit 1) writing its default cache; the direct interpreter then supplied the expected RED evidence. A sandbox Docker named-pipe probe was denied. A later supplemental rerun omitted the local uv path from the child PATH, so the HTTPS health probe did not run; the home request was 200, schema remained empty, and cleanup passed. Adding the pinned uv path fixed the harness configuration: the final isolated run passed the expected pre-migration 503, root migration scripts, four-probe HTTPS smoke, graceful shutdown and exact cleanup. No tracked implementation code changed.

## Disposable HTTPS and database safety

The live project was `dayforge-t05-9bd52b8e342f48fbb298a9352388182a`, using `backend/tests/compose.mysql.yaml`, a fresh UUID, generated test-only credentials, an available loopback port and anonymous `/var/lib/mysql` storage. Container project label and published endpoint were checked before any database action. Runtime children received only the application credential, not the root credential.

Next.js ran the existing `dev:web` command at `https://localhost:3000` and proxied to the existing FastAPI application at loopback port 8000. The API ran on the same app/engine before and after explicit isolated migration. Smoke verified all four same-origin probes with hostname and CA verification; redirects remained disabled. Before migration, readiness failed without creating tables. After migration and a repeated upgrade, the version contract and health passed without restarting the API or creating an owner.

The API then completed graceful lifespan shutdown, and a fresh test-user connection found zero sleeping application connections in `SHOW PROCESSLIST`. This verifies pool disposal through the shutdown path, while leaving literal interactive Ctrl+C unverified. The harness terminated only its own web process tree. Exact-project `down --volumes --remove-orphans` removed the captured disposable container, network and anonymous volume; narrowly scoped metadata assertions confirmed their absence. Ports 3000/8000 were no longer listening afterward.

The existing `dayforge-dev` resource and `dayforge-dev_mysql-data` were never attached, started, stopped, reset, inspected for contents, dropped, downgraded, seeded or migrated. No real schema was reversed to create a RED result. Development-volume migration/current checks remain outstanding. The exact root scripts `pnpm db:migrate`, `pnpm db:current`, repeated `pnpm db:migrate` were subsequently exercised against an isolated temporary project after a read-only uv preflight verified host/port/database/user/app-env; each exited 0, and exact project cleanup removed its container, network and anonymous volume. No development credentials or resources were used.

## Five review-focus results

| Review focus | Evidence |
| --- | --- |
| Outage/recovery, bounded readiness and transactions | Real MySQL integration cases passed: outage to 503 and recovery to 200 on the same engine, timeout/cancellation, exhausted-pool recovery, explicit commit/rollback and no request auto-commit. Live graceful shutdown released pooled connections. |
| Empty/stale/missing schema and migration safety | Empty, stale/multiple/missing revision and missing table/column cases passed; API does not repair schema. Real clean migration, repeat upgrade, metadata drift check and test-only downgrade/upgrade passed. Live HTTPS separately confirmed empty schema 503 then migrated empty-owner readiness. |
| Canonical dates/UUID/decimal and strict integer types | Unit/API and real SQL-type cases passed, including year 0001 LocalDate round-trip, UTC milliseconds, UUID bytes and invalid canonical/type/boundary rejection. |
| Duplicate JSON keys, lone surrogates, nonfinite numbers and chunked byte limits | Strict parser/API suite passed; malformed JSON and oversized bodies fail before handlers/database writes. The smoke decoder now also rejects duplicate keys recursively, alongside wrong health/version, booleans in integer constants, invalid UTC timestamps and HTML/invalid JSON from proxies. |
| Secrets in errors and logs | Error/log sentinel cases passed for private password/cookie/token/note/URL/query/SQL/exception values. Readiness logs exactly the fixed `database_not_ready` warning with no arguments/exception/stack information. New smoke errors omit response bodies. |

## Handoff and limits

The runbook documents explicit migration before API startup, unit/API and isolated MySQL commands, expected HTTPS output, missing/invalid env, retained-volume credential/port mismatch, unavailable DB, revision drift and partial MySQL DDL failure. Repair requires matching configuration and a deliberate correct migration; it does not use `down -v`, `stamp head` or automatic old-backup restore.

Services own `session.begin()` transactions; request dependencies do not auto-commit and background/concurrent work needs separate sessions. T09 owns atomic verified User plus fixed WorkspaceSettings initialization. T10 adds owner locking, event store and domain tables through Alembic while preserving User IDs and the sync write path. Production migration/runtime privilege separation belongs to T29.

Auth/email/owner initialization, calendars, event log/reducer/sync, offline support, CI and production are not implemented or accepted by this foundation. T06–T36 retain their actual pending status; the existing T04 browser waiver/status is unchanged. T05 acceptance passed on the isolated MySQL setup and its final branch review is complete. The final review fixes made the packaged-head assertion dynamic and hardened the smoke checks against duplicate JSON keys and normalized `24:00` timestamps. Development-volume compatibility, direct Cốc Cốc/browser trust, and literal interactive Ctrl+C remain unverified as recorded above.
