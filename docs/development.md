# Local development on Windows

This guide starts the local foundation from the repository root in Windows PowerShell 5.1 or PowerShell 7. It runs Next.js and FastAPI on the host and MySQL in Docker Desktop. First-time setup needs internet access to download packages and the MySQL image. The scaffold is not an offline app.

T05 adds validated settings, async MySQL sessions, Alembic migrations, strict request validation, private error/log handling, and public health/version endpoints. Calendar, account/email flows, owner initialization, event storage/sync, offline support, CI and production deployment remain later tasks. See the [verification report](tasks/t05/review-and-verification.md) for actual results and outstanding acceptance checks.

## 1. Install the pinned tools

Use these versions for a reproducible setup:

| Tool | Required version | Official source |
| --- | --- | --- |
| Node.js | `24.22.1` | [Windows downloads for Node 24.22.1](https://nodejs.org/dist/v24.22.1/) |
| pnpm | `12.16.1` | Install after Node with `npm install --global pnpm@12.16.1`; [pnpm installation guide](https://pnpm.io/installation) |
| uv | `0.13.6` | PowerShell installer below; [uv installation guide](https://docs.astral.sh/uv/getting-started/installation/) |
| CPython managed by uv | `3.14.10` | Installed in step 2; [Python release](https://www.python.org/downloads/release/python-31410/) |
| Docker Desktop / Compose | Compose `2.20.0` or newer | [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/) |
| mkcert | `1.4.4` | [Official Windows x64 release binary](https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-windows-amd64.exe) |

Install the Node.js `24.22.1` Windows x64 MSI from the versioned official downloads page. Open a new PowerShell window, then install and check pnpm:

```powershell
npm install --global pnpm@12.16.1
node --version
pnpm --version
```

The output should be `v24.22.1` and `12.16.1`. If `where.exe pnpm` shows an older pnpm earlier on `PATH`, remove or correct that stale installation before continuing.

Install the exact uv version using Astral's versioned PowerShell installer, then open a new terminal if `uv` is not yet on `PATH`:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/0.13.6/install.ps1 | iex"
uv --version
uv python install 3.14.10
uv python find 3.14.10
```

`uv python install` manages this interpreter for the current user; it does not replace a system Python installation. The output of `uv --version` must start with `uv 0.13.6`.

Install Docker Desktop with its Linux container engine enabled, start the engine, and check Compose:

```powershell
docker --version
docker compose version
docker info
```

Compose must be at least `2.20.0`; `docker info` must reach the running engine.

Download the mkcert `v1.4.4` Windows x64 executable from the official release link above. Keep it in a user-controlled tools directory and add that directory to `PATH`, or save it as `.local\toolchain\mkcert.exe` after cloning and add that local tools directory to `PATH`. Confirm the exact version:

```powershell
mkcert -version
```

Expected output: `v1.4.4`. Do not run `mkcert -install` as part of the smoke-test setup. That separate command adds the local CA to a trust store and is only needed if you want a browser on this machine to open the development site without a certificate warning.

## 2. Install project dependencies and create local configuration

Run all repository commands from the checkout root:

```powershell
pnpm install --frozen-lockfile
uv sync --directory backend --locked
uv python find 3.14.10
pnpm setup:local
```

The frozen pnpm install and locked uv sync must finish without changing either lockfile. `setup:local` creates `.env`, `backend/.env` and `frontend/.env.local`. It generates independent database app/root passwords, uses the same app password in the two server-side locations that need it, and does not print password values.

The setup command refuses a partial set of local environment files instead of overwriting existing files. If it reports missing files, restore only the missing file from its matching `*.env.example` and deliberately configure the generated database credential values to match, or recover the original local configuration. Do not copy real `.env` files into Git.

## 3. Create localhost TLS files

From the repository root, create a local certificate and key for the development hostnames:

```powershell
New-Item -ItemType Directory -Force .local/tls
mkcert -cert-file .local/tls/localhost.pem -key-file .local/tls/localhost-key.pem localhost 127.0.0.1 ::1
$dayforgeCaFile = Join-Path ((mkcert -CAROOT).Trim()) 'rootCA.pem'
Test-Path $dayforgeCaFile
```

The final command should print `True`. The smoke command uses this CA file explicitly, so it can validate TLS without installing the CA into the Windows trust store. Keep the mkcert CA private key (`rootCA-key.pem`) outside the repository and never share it. The leaf certificate and key stay under ignored `.local/tls/`.

Direct Cốc Cốc/browser trust verification was waived for T04 and remains unverified. The smoke workflow does not install trust, open the browser or bypass TLS.

## 4. Start MySQL, API and web servers

For a new, known development database, start Docker's local MySQL service from the repository root and wait for its health check. If a retained volume's state or credentials are unknown, first recover its matching configuration; do not attach/start it or run migrations merely to obtain a smoke result. The T05 verification leaves the existing `dayforge-dev` volume untouched and uses disposable test projects instead.

```powershell
pnpm db:up
docker compose --env-file .env ps
pnpm db:migrate
pnpm db:current
```

MySQL is published only at `127.0.0.1:3307`, uses the `dayforge_app` database user for the health probe, and persists development data in the Compose named volume. The root password is read by Compose and is not passed to the backend or frontend. `db:migrate` explicitly upgrades to the bundled Alembic head; `db:current` should show `0001_owner_workspace (head)` at this revision. Migration creates empty `users` and `workspace_settings` tables. API startup does not migrate, seed an owner or repair a schema. An empty, stale or unavailable schema makes health return 503.

Open two PowerShell terminals in the repository root. Keep each running:

```powershell
# Terminal 1
pnpm dev:api
```

```powershell
# Terminal 2
pnpm dev:web
```

The API listens on `127.0.0.1:8000`. Next.js listens on HTTPS `localhost:3000`; it checks `API_INTERNAL_ORIGIN` before startup and proxies `/api/v1/*` to FastAPI without changing the prefix. If port `3000`, `8000` or `3307` is occupied, identify and stop the process that owns it. Do not change the ports or origin to work around the conflict.

In a third terminal, run the HTTPS web/API smoke check:

```powershell
$dayforgeCaFile = Join-Path ((mkcert -CAROOT).Trim()) 'rootCA.pem'
pnpm smoke:local --ca-file "$dayforgeCaFile"
```

Expected output:

```text
PASS: local HTTPS web, API and MySQL readiness
```

The smoke checks `/`, `/api/v1/openapi.json`, `/api/v1/health` and `/api/v1/version` through the same HTTPS localhost origin. Health must return HTTP 200 with exactly `{"status":"ok"}`. Version must expose `api_major: 1`, `protocol_versions: [1]`, `reducer_versions: [1]`, a valid UTC millisecond timestamp, and the T03 limits: push operations 100, push request bytes 8388608, operation bytes 2097152, commands per operation 1000, page operations 200, page bytes 8388608 and page token TTL 1800 seconds. All four probes must pass before the success line appears.

Health 503, a wrong version contract, HTML from an API proxy, invalid JSON, a missing/invalid CA or any redirect causes exit 1 without PASS. Response bodies and credentials are omitted from diagnostics. Never pass credentials in the CLI. The smoke verifies readiness; it does not establish login, cookies, CSRF, offline or calendar acceptance. Do not downgrade or drop an existing schema to manufacture a failing smoke.

## Backend checks and transaction boundaries

From the repository root:

```powershell
uv sync --directory backend --locked
pnpm verify:env
pnpm test:api
pnpm test:api -- tests/api/test_system.py -v
pnpm test:api:mysql
```

`test:api` runs unit/API tests without MySQL; MySQL cases are deliberately deselected. `test:api:mysql` requires Docker and runs every MySQL-marked case on the pinned real image in a fresh UUID-scoped Compose project, with generated test-only credentials, a dedicated loopback port and anonymous storage. It cleans up only that exact test project and its anonymous volume, even after test failure. It never uses the development database. A MySQL suite with skipped cases is not a passing acceptance run. `verify:env` also runs the smoke-response regression tests.

Request session dependencies close their sessions but never auto-commit. A service owns its write transaction with `async with session.begin():`; an error rolls it back. Each background or concurrent task needs its own session. API shutdown disposes the engine/pool; stop the API with Ctrl+C before routine database shutdown.

T09 must create a verified `User` and its fixed `WorkspaceSettings` in one transaction. T10 adds the owner lock, event store and domain data through Alembic; it must preserve User IDs and keep domain writes on the sync path instead of introducing bypass CRUD routes. The backend development user has schema privileges for local migration. Separate production migration/runtime privileges belong to T29.

## 5. Build and probe the production Next.js server

Stop `pnpm dev:web` with Ctrl+C before building. Then run:

```powershell
pnpm verify:env
pnpm build:web
pnpm start:web
```

`verify:env` runs the environment-generator and frontend origin-guard regression tests. The guard uses Next.js env parsing, including quoted values, and an existing process variable takes precedence over `frontend/.env.local`. `build:web` builds the Next.js server. `start:web` listens on loopback HTTP port `3001`; in another terminal, verify the response:

```powershell
$response = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3001/
$response.StatusCode
$response.Content.Contains('DAYFORGE')
```

Expected output: `200` and `True`. Stop the server with Ctrl+C.

## 6. Stop services and keep local data

Stop the web and API terminals with Ctrl+C. Stop MySQL from the repository root:

```powershell
pnpm db:down
```

This stops and removes the Compose container/network while retaining the named data volume. Do not add `-v` or delete the volume during routine shutdown. Changing passwords in `.env` does not change credentials already initialized in an existing MySQL volume; restore the matching original local configuration or use a deliberate database credential migration.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `uv` or `mkcert` is not recognized | Install the pinned version and open a new PowerShell window, or add its install directory to the current session's `PATH`. |
| `pnpm install --frozen-lockfile` fails | Check `node --version`, `pnpm --version`, and the package-manager executable returned by `where.exe pnpm`. Use Node `24.22.1` and pnpm `12.16.1`. |
| A port is occupied | Run `Get-NetTCPConnection -State Listen -LocalPort 3000,3001,3307,8000` and stop the intended process. Keep the documented ports. |
| `dev:web` rejects `API_INTERNAL_ORIGIN` | Set `frontend/.env.local` to `API_INTERNAL_ORIGIN=http://127.0.0.1:8000`, or clear an overriding process variable, then restart Next.js. |
| Smoke reports an API HTTP error | Confirm `pnpm dev:api` is still running and use `https://localhost:3000` with the CA from `mkcert -CAROOT`. The smoke output intentionally omits response bodies. |
| TLS check fails | Recreate the localhost leaf cert/key, verify the hostname is `localhost`, and pass the matching `rootCA.pem`. The smoke check never disables certificate verification. |
| `setup:local` reports partial configuration | It will not overwrite files. Restore only the missing environment file and preserve matching database credentials; do not delete or overwrite the remaining local configuration blindly. |
| MySQL starts with a password/volume error | A password change in `.env` does not rotate an existing volume's initialized credentials. Restore the matching `.env` or make a deliberate credential change; do not use `down -v` as a repair shortcut. |
| API startup rejects configuration | Check the named missing/invalid `APP_ENV`, `PUBLIC_ORIGIN` or `DB_*` fields in `backend/.env`; use `https://localhost:3000` in development. Do not paste secret values into logs or tickets. |
| Existing volume uses another port or credentials | Confirm the known volume's original config and intended host mapping before starting it. New `.env` credentials do not establish compatibility with retained state. Do not attach unknown volumes or reset them to make tests pass. |
| Health returns 503 because MySQL is unavailable | Check the intended database service and matching application configuration. Restore connectivity; the existing API engine must recover without restarting the API. Health diagnostics use only the static `database_not_ready` code. |
| Health returns 503 after connection succeeds | On a known development DB, compare `pnpm db:current` with the bundled migration head and apply `pnpm db:migrate`. Missing tables/columns or a stale/multiple revision are not ready; startup does not repair them. |
| Migration DDL fails partway | MySQL DDL can commit partially. Preserve the database, inspect its actual schema/revision with the matching configuration, and plan the correct forward migration or deliberate repair. Do not use `stamp head`, `down -v`, or an automatic old-backup restore to hide drift. |

## Related documents

- [T04 implementation plan](tasks/t04/plan.md)
- [T05 implementation plan](tasks/t05/plan.md)
- [T05 verification results and limits](tasks/t05/review-and-verification.md)
- [Overall task status and dependencies](tasks/README.md)
- [Project architecture](project-definition/04-technical-architecture.md)
