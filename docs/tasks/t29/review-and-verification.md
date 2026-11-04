# T29 — Review and verification

Status: **package implementation and CI smoke complete; deployment decision, resource sizing, and live target acceptance remain open**.

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
- Docker image build / Compose smoke: **not run locally** because the Linux Docker Engine pipe is unavailable in this workspace. The `Production Package` GitHub workflow built both images and passed the disposable MySQL/API/web smoke.

## GitHub CI evidence

Candidate source SHA: `907772c5df493ea23881e7e7572549637d7386fd`.

- [CI run #120](https://github.com/Duyhai2005/dayforge/actions/runs/41786244233) passed `quality`, `frontend`, and `backend-mysql`. The two-browser sync acceptance timed out once at the injected pull-page hold, then passed when only `backend-mysql` was rerun on the same SHA.
- [Production Package run #8](https://github.com/Duyhai2005/dayforge/actions/runs/41786244273) passed image builds, release/config contracts, and the disposable production Compose smoke, including MySQL user provisioning, migration, API readiness, and web routes/assets.
- [Offline web shell run #138](https://github.com/Duyhai2005/dayforge/actions/runs/41786244250) passed.

## Not verified

No provider/account/host, budget, DNS zone, registry, SMTP credentials, verified sender, recipient inbox, or device pair is present. This task therefore does not claim a cloud/provider choice, host sizing, real inbox delivery, image push, host deployment, or HTTPS acceptance. T29 remains open until its target and sizing inputs are selected and evidenced. See [`deployment-decision.md`](deployment-decision.md) for the missing inputs.
