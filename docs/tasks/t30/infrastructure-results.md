# T30 infrastructure results and remaining acceptance gates

Date: 2026-11-04 (Asia/Bangkok)

## Prepared in code

- Deployment target and release manifest validators from T29 are used by the T30 CLI.
- Added an empty-target guard, one-operation lock, digest-pinned pull, separate provisioning/migration/runtime sequence, supported DB revision check, recent-backup gate for upgrades, fixed error codes, and atomic current-release record. Caddy maintenance is enabled before API stop/migration; candidate smoke runs inside the web container, and public smoke runs before the release record is advanced.
- API no longer depends on the one-shot migration service at container startup. Migration is explicitly invoked by the release CLI. Migrator privileges are scoped to the environment database and limited to the planned DML/DDL set.
- Added read-only public smoke checks for shell routes, build manifest/header, API readiness, and protocol/reducer compatibility.
- Added five-minute health-check units and bounded checks for API, web, disk pressure (85% on the state/Docker data filesystems), T31's `last-backup.json` freshness (26 hours), and host clock synchronization.
- Added a same-owner SMTP delivery probe that cannot accept an arbitrary recipient or a token-like message.
- Added a Debian/Ubuntu systemd host bootstrap. `--check` is read-only. `--apply` creates private managed directories and labeled ingress networks, installs units, and enables Docker; it does not install packages, change firewall/SSH policy, or create provider resources.
- Added [host runbook](../../deployment/infrastructure.md) and [runtime secret custody](../../deployment/runtime-config.md).

## Local evidence

The deployment sequencing/configuration/manifest/HTTP smoke/host health unit suites passed locally (30 tests). The backend email probe unit suite passed locally (7 tests). Ruff, mypy for the new CLI module, Python 3.12/3.14 compilation, and `git diff --check` passed locally. Bash syntax is checked by the Linux package workflow because this Windows sandbox blocks starting Bash.

## External evidence not collected

No host, provider/account, region, budget, image registry, origin/domain, DNS authority, SMTP provider/credentials, or owner inbox has been selected or provided. Therefore these checks have **not** been run:

- Host bootstrap `--check`/`--apply`, container privilege integration against MySQL 8.4, restart/reboot/fault recovery, log rotation on Linux, external TLS/proxy tests, or public smoke against a staging origin.
- SMTP delivery observed in the owner inbox, DNS sender authentication records, callback verification/reset flows, or PC-off/two-device acceptance.
- No AC-31/32/35/36 acceptance result is changed to PASS by these code and unit checks.

T30 remains open until a real authorized target and budget are selected and the staging, DNS/TLS, DB privilege, recovery, inbox, and external-device evidence is recorded. Production deployment remains in T35.
