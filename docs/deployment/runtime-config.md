# Dayforge runtime configuration and secret custody

## Private file layout

Use a separate directory tree for staging, production, and restore. The target validator requires distinct Compose project, database name, origin, secrets path, state path, edge alias, and private app subnet. Bootstrap only manages the approved `/etc/dayforge/<environment>` and `/srv/dayforge/<environment>` roots.

```text
/etc/dayforge/staging/target.json       root:root 0600
/etc/dayforge/staging/runtime.env       root:root 0600
/etc/dayforge/staging/secrets/          root:root 0700
/srv/dayforge/staging/state/            root:root 0700
/srv/dayforge/releases/<release-id>/    root:root 0700
```

`runtime.env` contains non-secret runtime settings used by Compose, such as the approved origin, project, database name, app subnet, owner inbox, SMTP hostname/port/TLS mode, sender, and absolute secret-file paths. Keep it root-only because it identifies private deployment details. It must not contain passwords, signing keys, SMTP credentials, or any token.

The shared edge has its own `/etc/dayforge/edge/runtime.env`. It contains the pinned Caddy image, certificate contact, staging and production HTTPS origins, and the two maintenance-directory paths. Both origins must belong to the authorized domain/DNS zone; `.example.test` values are parser fixtures, not deployable hostnames.

## Secret files

The backend reads mounted files through the `*_FILE` settings. Generate cryptographic keys and database passwords once per environment with an approved secret manager or host-side CSPRNG workflow. Record key IDs and recovery custody separately; do not regenerate keys on reboot, deploy, or bootstrap rerun. Never copy the same secret bytes between staging, production, and restore.

| File | Consumer | Notes |
| --- | --- | --- |
| `mysql_root_password` | MySQL and principal-provisioning job | Root is mounted only in MySQL/provisioning, never API or web. |
| `db_password` | Runtime API | CRUD principal for this environment database only. |
| `db_migrator_password` | One-shot migration job | Database-scoped DDL and DML grants; not used by API. |
| `local_key_kek_b64` | Runtime API and migration config | Base64url 32-byte key; retain stable for encrypted owner keys. |
| `logout_ticket_key_b64` | Runtime API and migration config | Distinct key; retain stable while tickets may exist. |
| `logout_ticket_previous_keys_b64` | Runtime API and migration config | Optional rotation list; empty file means no previous key. |
| `auth_rate_limit_key_b64` | Runtime API and migration config | Distinct key. |
| `auth_email_outbox_key_b64` | Runtime API and migration config | Distinct key; required to decrypt pending outbox jobs. |
| `sync_page_token_key_b64` | Runtime API and migration config | Distinct from every auth key. |
| `email_smtp_username`, `email_smtp_password` | Runtime API and migration config | Issued by the approved SMTP provider; TLS must be `starttls` or `implicit` in production. |

For bind-mounted Compose secrets, verify the actual file mode and readability under container UID/GID `10001:10001`. Use a root-owned file with a narrowly assigned runtime group and mode such as `0440` when required by the selected host's Docker behavior. Do not make a secret world-readable to fix a mount problem. Confirm Compose's file-backed secret behavior on the selected host before installing real credentials.

The MySQL principal provisioning script accepts printable ASCII passwords, SQL-quotes them, and keeps them out of argv/log output. Do not pass secret text on a command line or put it in Compose interpolation, image build args, source control, shell history, CI output, release manifests, or support screenshots.

## DB privilege model

- Runtime `dayforge_app`: `SELECT`, `INSERT`, `UPDATE`, `DELETE` on the configured database only.
- Migration `dayforge_migrator`: runtime DML plus `CREATE`, `ALTER`, `DROP`, `INDEX`, and `REFERENCES` on that database only.
- Backup principal is not created by T30; T31 defines and tests its read-only privileges.
- MySQL root is used only for private database provisioning and must not be published or mounted into API/web.

Changing grants on an existing MySQL volume requires an explicit run of the provisioning service. MySQL's first-volume initialization scripts do not rerun just because a container was recreated. Verify grants using each principal against a disposable database before accepting a host.

## Public, SMTP, and edge settings

`PUBLIC_ORIGIN`, `OWNER_EMAIL`, `EMAIL_FROM`, SMTP host/port/TLS mode, and environment names are not passwords but are private deployment configuration. Use one approved HTTPS origin per environment. The Caddy edge alone owns public ports 80/443 and forwards to environment-specific web aliases. Keep Caddy admin API disabled, keep callback and API responses un-cached, and verify the trusted proxy chain from an external client.

SMTP TLS trust must remain enabled. A real provider acceptance response is not proof of inbox delivery. The owner must confirm the probe in inbox or spam, and T32 must exercise the real verification/reset callback flow separately.
