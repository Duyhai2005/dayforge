# Backup and restore runbook

This runbook covers the encrypted server database snapshots and recovery path introduced by T31. A server snapshot contains data that reached the server, the metadata needed to verify it, and the cryptographic keys required to reopen restored vault records. It does not contain a browser's unsent IndexedDB operations, drafts, or other local-only data.

## Backup design and custody

- `mysqldump` streams one InnoDB database with a consistent transaction into a private gzip workspace. Backup, deployment, and restore share `state/operation.lock`; a backup cannot overlap migration or key rotation.
- Restic uses the digest-pinned image in `deploy/images.lock.json`. It encrypts the snapshot before upload. The host stores only the repository locator, the restic password, and an allow-listed credential environment file as separate private files.
- Keep the restic password and a usable recovery credential in a separate password vault or recovery account that remains available if the source VM and its disks are lost. Do not keep the only copy on the source host or inside the repository it unlocks.
- Use an off-host repository for production. The backup command rejects a `local:` repository in production. Grant the host only the repository access needed to write snapshots; keep recovery credentials independently available and test them from a clean target.
- SQL, owner identifiers, runtime restore metadata, and keys are sensitive. Keep repository access private, restrict policy and secret files to root, and do not copy raw backup payloads into tickets or public evidence.

Prepare the target and policy files before enabling timers:

```text
/etc/dayforge/production/target.json
/etc/dayforge/production/runtime.env
/etc/dayforge/production/backup-policy.json
/etc/dayforge/production/restic-repository
/etc/dayforge/production/restic-password
/etc/dayforge/production/restic-credentials.env
/srv/dayforge/production/state/backup-work/
```

Use the secret-free policy shape in `deploy/backup-policy.example.json`, changing the paths to the production files. Create the repository/password/credential files from the approved secret store with mode `0600`; do not place their contents in the JSON policy. The policy workspace must remain below the target's state directory. `runtime.env` and required application key files must also be private regular files. Restic credentials accept only the documented allow-list in `scripts/backup_policy.py`.

The manifest's `LOCAL_KEY_KEK_VERSION` must match `local_key_kek_b64`. Keep an independently recoverable copy of that key and the restic password in custody separate from the host. A snapshot without either item is not a recoverable backup.

## First backup and schedule

Initialize a new empty repository exactly once, after confirming the recovery password and credentials are in independent custody. This command refuses production `local:` repositories and does not reset an existing repository:

```bash
sudo python3 /opt/dayforge/scripts/backup_database.py \
  --config /etc/dayforge/production/target.json \
  --policy /etc/dayforge/production/backup-policy.json \
  --initialize-repository
```

Run one manual production backup after configuring the off-host repository and credentials:

```bash
sudo python3 /opt/dayforge/scripts/backup_database.py \
  --config /etc/dayforge/production/target.json \
  --release /srv/dayforge/releases/<release-id>/release.json \
  --policy /etc/dayforge/production/backup-policy.json
```

The command prints a snapshot ID, UTC completion time, dump checksum, and source revision. Confirm that the snapshot is visible in the configured repository and that `state/last-backup.json` advances only after restic has confirmed that exact ID and its environment/release tags. The state marker contains no SQL, key material, or repository credentials. The first successful snapshot creates `state/backup.enabled`, which makes the T30 host health check report backups older than 26 hours as stale.

The host bootstrap installs four systemd units but intentionally does not enable the timers. After the manual snapshot and independent credential custody are confirmed, validate the calendar entries and enable the environment timers:

```bash
sudo systemd-analyze verify \
  /etc/systemd/system/dayforge-backup@.service \
  /etc/systemd/system/dayforge-backup@.timer \
  /etc/systemd/system/dayforge-backup-check@.service \
  /etc/systemd/system/dayforge-backup-check@.timer
systemd-analyze calendar '*-*-* 02:15:00 Asia/Bangkok'
systemd-analyze calendar 'Sun *-*-* 04:00:00 Asia/Bangkok'
sudo systemctl enable --now dayforge-backup@production.timer
sudo systemctl enable --now dayforge-backup-check@production.timer
systemctl list-timers 'dayforge-backup*'
```

The daily timer runs at 02:15 Asia/Bangkok. The weekly check starts at 04:00 Sunday: it confirms an environment-tagged snapshot exists, checks a 1/50 data subset, previews the exact retention policy with `restic forget --dry-run --json`, validates that the preview only covers this environment's database tags, then prunes using 7 daily, 4 weekly, and 3 monthly snapshots. It filters by environment and database tags, then groups by host and stable payload path so release/build tags do not split each release into its own retention group. If repository checks or the preview fail, retention does not run. The job and timer status are recorded by systemd; this package does not configure an external alert destination.

Inspect a manual job without printing secret files:

```bash
sudo systemctl start dayforge-backup@production.service
sudo systemctl status dayforge-backup@production.service
sudo journalctl -u dayforge-backup@production.service --since today
sudo python3 /opt/dayforge/scripts/check_host_health.py \
  --config /etc/dayforge/production/target.json
```

Never publish journal output together with `runtime.env`, SQL, or key files. The CLI returns fixed error codes and omits subprocess stderr.

## Isolated restore

Restore only to a newly provisioned environment named `restore`. Do not point this process at the staging or production Compose project, database, MySQL volume, state directory, or edge alias. The validated restore configuration requires the same lowercase 32-character identifier in all three names:

```text
compose_project = dayforge-restore-<32-hex-id>
db_name         = dayforge_restore_<32-hex-id>
edge_alias      = restore-<32-hex-id>
```

Give the target its own state/secrets directories, private subnet, MySQL volume, HTTPS origin, and target-only database and SMTP credentials. The restore origin must be distinct from the origin recorded in the snapshot. Use the same owner email and local KEK version as the source. Leave the source key files absent in the clean restore secrets directory, or pre-install byte-identical escrowed copies; restore refuses to overwrite a different key. Never copy the source SMTP credentials or restic credentials into the application secrets directory.

Copy only the repository locator, restic password, and recovery credential file from their independent custody into a private, temporary directory on the restore operator host. Create a restore-target policy pointing to those files and a workspace under the restore target's state directory. Do not place those credentials in the SQL database, snapshot, application runtime file, or evidence report.

Choose a specific snapshot ID and source environment, then run the restore CLI with an immutable API/MySQL release artifact that supports the snapshot's Alembic revision:

```bash
sudo python3 /opt/dayforge/scripts/restore_database.py \
  --config /etc/dayforge/restore/target.json \
  --release /srv/dayforge/releases/<compatible-release-id>/release.json \
  --policy /etc/dayforge/restore/backup-policy.json \
  --snapshot <64-character-snapshot-id> \
  --source-environment production
```

The command pulls and starts only the pinned MySQL service, confirms the database is empty, verifies the selected snapshot tags, manifest, MySQL version, dump checksum, KEK version, and all required key files, installs only matching source keys, and imports the dump. It then provisions the target database roles and confirms the restored database revision. It does not start the API, web container, email worker, or edge. A failed restore leaves no `restore-ready.json` success marker; the imported database is not empty afterward, so an operator must inspect the fixed failure code and choose a fresh isolated restore target before retrying import.

## Prepare authentication and sync before application startup

Run the host launcher after the database import succeeds and before opening the restore app. The launcher uses the target's pinned API image for one one-shot command, mounts a private journal directory owned by the image's non-root UID, and does not start the normal API or edge service:

```bash
sudo python3 /opt/dayforge/scripts/prepare_restore_recovery.py \
  --config /etc/dayforge/restore/target.json \
  --release /srv/dayforge/releases/<compatible-release-id>/release.json
```

The restore project's 32-character identifier is also its stable recovery journal ID, so rerunning the launcher retries the same journal. The transaction increments the owner's auth version, revokes restored sessions, invalidates email tokens, deletes queued source email jobs and rate-limit rows, and changes the sync epoch. It keeps every recorded operation envelope, request hash, operation ID, receipt, cursor, committed timestamp, and the sync head cursor. If the process stops before commit, the transaction rolls back. If it stops after commit and before the journal is marked complete, rerun the launcher; it verifies the recorded operation fingerprint and the new-epoch postconditions before returning success.

Do not start a public API or email worker until the restore-preparation launcher succeeds. Use target-specific SMTP settings. The restored email outbox is intentionally cleared so old password-reset or verification messages cannot be sent from the source snapshot.

## Application and recovery checks

After a controlled operator has configured isolated DNS/TLS and edge routing for the restore origin, use a fresh browser profile. Verify that the known owner can reset or establish a password through the approved recovery channel, open the vault using the restored KEK, and see the expected work and milestone data. A previously authenticated browser profile is not proof that KEK recovery works. Confirm an old session is rejected, old-epoch sync requests receive the epoch mismatch response, and a new bootstrap includes the preserved server operation history.

For a source/target fingerprint comparison, first quiesce source writers and record the source fingerprint against that same database state. Run `scripts/verify_restore.py --write-fingerprint <private-path>` before the snapshot on the source and `--expected-fingerprint <private-path>` against the isolated target. The comparison includes stable table counts, owner IDs, workspace settings, owner-local key IDs/version/wrapped-key hashes, and canonical operation envelope hashes; volatile authentication rows are excluded because T31 deliberately invalidates them. Do not compare a live source fingerprint captured after new writes with an older snapshot.

Record the snapshot ID, source and target revisions, dump size, restore and preparation times, and the fingerprint result in `docs/tasks/t31/restore-results.md`. Keep evidence redacted and private. RPO and RTO remain targets until measured with a representative dataset and the independent off-host credentials. Unsynced local browser data stays outside server backup scope; do not instruct users to clear their browser storage during recovery.
