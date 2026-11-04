# Dayforge Linux host runbook

## Readiness and scope

This runbook prepares an already authorized Linux host. It does not create cloud resources, configure a DNS zone, purchase a domain, or select a provider. T29 has not selected a provider/account, region, VM size, registry, budget, origin, SMTP account, or owner inbox. Do not run the mutating commands below until those inputs are recorded in the deployment decision and the host owner has approved the target.

The bootstrap supports Debian/Ubuntu systemd hosts with Docker Engine and Compose v2 already installed. It validates the host and target, creates only the managed directories and two labeled ingress networks, installs the Dayforge systemd units, and enables Docker at boot. It does not install packages, alter SSH/firewall policy, create cloud resources or DB volumes, generate keys, or change DNS.

## Host and target inputs

Before staging, record and verify:

- Authorized host reference, provider/account, region, OS release, CPU architecture, memory, disk, and recovery access.
- A monthly budget ceiling and an approved image registry or image-transfer path.
- A staging HTTPS origin and DNS authority; production uses a separate origin and remains a later task.
- Non-overlapping private app subnets for each environment and the host/VPC networks.
- An owner inbox, verified sender, SMTP TLS mode, provider credentials, and permission to send a probe.
- Off-host backup destination and recovery-key custody before any existing data is upgraded.

The example JSON in `deploy/target.example.json` uses example values only. The private target file must use these managed paths:

```text
/etc/dayforge/staging/secrets
/srv/dayforge/staging/state
```

The application and data networks are private Compose networks. Only Caddy publishes host ports 80 and 443. Do not publish 3000, 8000, or 3306, the Docker socket, or the Caddy admin API.

## Bootstrap an approved host

Copy the approved target JSON to `/etc/dayforge/staging/target.json` and set its owner/mode to root-only. Install the pinned Docker Engine/Compose versions using the approved host procedure, then copy the release control files to `/opt/dayforge` and create the private runtime configuration described in [runtime-config.md](runtime-config.md).

Run the read-only check first:

```bash
sudo bash deploy/host/bootstrap.sh --check --config /etc/dayforge/staging/target.json
```

It checks Linux architecture, Docker/Compose availability, systemd, target paths, and synchronized clock. `--check` makes no changes. After reviewing the host and confirming the target authorization, apply the directory and systemd setup:

```bash
sudo bash deploy/host/bootstrap.sh --apply --config /etc/dayforge/staging/target.json
```

Existing secret files are not generated, overwritten, or chmodded by bootstrap. The script does not modify SSH rules or host/cloud firewalls. Configure the approved firewall separately: SSH only from the administration source, and public 80/443 only. Allow the selected registry, DNS, HTTPS certificate, SMTP, and backup egress needed by the approved design.

The bootstrap creates `dayforge-staging-ingress` and `dayforge-production-ingress` as separate Docker networks for the shared edge. The app Compose project creates its own application/data networks and MySQL volume. Verify the app Compose model without printing resolved configuration:

```bash
docker compose --env-file /etc/dayforge/staging/runtime.env \
  --file /opt/dayforge/deploy/compose.app.yaml \
  --project-name dayforge-staging config --quiet
```

The bootstrap also creates `/etc/dayforge/edge`. Copy `deploy/edge.env.example` there as `runtime.env`, replace every example with approved values, and set it root-only.

The edge stack requires both environment ingress networks and private `runtime.env` values for both origins and maintenance directories. Start it after the networks exist and the staging origin is live in DNS. Until the web container is deployed, the upstream may be unavailable; Caddy can still provision the TLS certificate:

```bash
docker compose --env-file /etc/dayforge/edge/runtime.env \
  --file /opt/dayforge/deploy/compose.edge.yaml \
  --project-name dayforge-edge up -d --wait edge
```

## First staging release and restart services

The first initialization is allowed only against an empty staging or restore database. The CLI checks the database table count, refuses an existing release record, pins all three images by manifest digest, creates DB principals, places the environment in Caddy maintenance mode, runs migration as a one-shot job, starts the runtime, checks the candidate from inside the web container, opens the edge, then runs public smoke checks. On migration/internal smoke failure, the edge remains in maintenance. If public smoke or release recording fails, the edge is returned to maintenance. It does not drop tables or overwrite an existing release.

```bash
sudo python3 /opt/dayforge/scripts/deploy_release.py \
  --config /etc/dayforge/staging/target.json \
  --release /srv/dayforge/releases/<release-id>/release.json \
  --env-file /etc/dayforge/staging/runtime.env \
  --compose-file /opt/dayforge/deploy/compose.app.yaml \
  --initialize
```

After a successful first start, enable boot restart and the five-minute health timer:

```bash
sudo systemctl enable --now dayforge-app@staging.service
sudo systemctl enable --now dayforge-health@staging.timer
systemctl list-timers dayforge-health@staging.timer
```

The host bootstrap also installs the daily encrypted backup and weekly repository-check units. It leaves those timers disabled until private restic credentials and the independent recovery password have been configured and a manual off-host backup has been verified. Follow [the backup and restore runbook](backup-restore.md), then enable `dayforge-backup@<environment>.timer` and `dayforge-backup-check@<environment>.timer`. The daily job is scheduled for 02:15 Asia/Bangkok; weekly check and retention runs at 04:00 Sunday. The first confirmed snapshot creates `state/backup.enabled`; only after that does the existing health check enforce the 26-hour backup freshness threshold.

`dayforge-app@staging.service` starts existing containers only. It does not pull an image, create containers, or run migration. Docker restart policies recover container exits. An unhealthy container is reported by health checks; health state alone does not restart or recreate MySQL.

For later release upgrades, the deployment CLI requires the release's current database revision to be in `supported_db_revisions` and a successful backup record no older than 26 hours. Use the same immutable release manifest that passed package CI. Do not use `--initialize` to bypass an upgrade or recovery gate.

## Health, smoke, and operational evidence

Run a manual host check:

```bash
sudo python3 /opt/dayforge/scripts/check_host_health.py --config /etc/dayforge/staging/target.json
```

It prints only a UTC check time, a Boolean, and fixed codes: `api_unhealthy`, `web_unhealthy`, `disk_pressure`, `backup_stale`, and `clock_unsynchronized`. Disk pressure starts at 85% on the state or Docker data filesystem. The backup check is enabled only when T31 creates `state/backup.enabled`; it reads T31's `state/last-backup.json` and treats a missing/invalid result or an age over 26 hours as stale. The unit records failure to systemd/journal; no external alert channel is configured by this package.

The public smoke checks `/work`, `/milestones`, `/dayforge-build.json`, `/sw.js`, `/api/v1/health`, and `/api/v1/version`. It rejects redirects and checks the web build header/manifest and API protocol/reducer versions. It creates no account or user data.

After reboot or a fault-recovery drill, capture the UTC time, release ID, container state, fixed health codes, recovery time, TLS result from an external device, and whether the owner observed the probe in inbox/spam. Never include SMTP credentials, auth tokens, cookies, user data, or full secret-bearing configuration in evidence.

## Email delivery probe

After the verified SMTP settings and owner inbox have been installed, run from the API container:

```bash
docker compose --env-file /etc/dayforge/staging/runtime.env \
  --file /opt/dayforge/deploy/compose.app.yaml \
  --project-name dayforge-staging exec -T api \
  python -m app.cli.send_mail_probe --probe-id t30-stage-<utc-id>
```

`mail_probe_accepted` means the SMTP adapter accepted the send attempt. The operator must inspect inbox and spam, record the arrival time and probe ID, and redact provider details. This probe contains no verify/reset token and does not prove the authentication callback flow; that is part of T32.
