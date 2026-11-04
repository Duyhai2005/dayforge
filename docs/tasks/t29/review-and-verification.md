# T29 — Review and verification

Status: **package implementation in progress; external target and Docker smoke pending**.

## Implemented

- Runtime SMTP options and TLS/auth transport; production rejects plaintext and incomplete credentials.
- Restricted `*_FILE` support with conflict checks, single trailing newline handling and field-only errors.
- Validated environment isolation contract, digest-pinned image lock, release manifest parser/schema, two Dockerfiles, separate app/edge Compose topology, Caddy routes and a Docker-backed package smoke test/workflow.
- Container build mode keeps local API-origin guard intact and requests Next standalone output rooted at the monorepo.

## Checks run in this workspace

- SMTP/config unit files: **60 passed, 1 deselected**. The deselected test opens an asyncio TestClient; this Windows sandbox blocks the loopback socketpair that asyncio needs (`socket.accept` in `asyncio.windows_events._make_self_pipe`).
- Deployment target parser: **7 passed**.
- Release manifest parser/schema: **7 passed**.
- Ruff and Black on all changed Python files: **passed**.
- Backend mypy: **passed** (43 source files); frontend ESLint and TypeScript typecheck: **passed**.
- `scripts/tests` discovery with the loopback-only test excluded: **43 passed, 1 deselected, 53 subtests passed**. Full discovery also attempted the remaining existing `test_smoke_local` case; the Windows sandbox cannot accept its loopback HTTP connection and received a `URLError` before the expected 307 response. The same test is included in Linux CI.
- `docker compose config -q` for both the app and edge files: **passed** with disposable sample values.
- Docker image build / Compose smoke: **not run locally**. Docker CLI reports the Linux Engine pipe unavailable in this workspace; the `Production Package` GitHub workflow runs the container smoke.

## Not verified

No provider/account/host, budget, DNS zone, registry, SMTP credentials, verified sender, recipient inbox, or device pair is present. This task therefore does not claim a cloud/provider choice, real inbox delivery, image push, host deployment, or HTTPS acceptance. See [`deployment-decision.md`](deployment-decision.md) for the missing inputs.
