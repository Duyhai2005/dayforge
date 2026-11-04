# Production packaging

The package is built once for a selected Linux platform and moved by immutable image digest. It is not deployed by CI. The frontend uses Next.js standalone output; FastAPI runs in a separate non-root image; MySQL receives only the persistent database volume; Caddy is the only public listener.

## Build contract

- [`frontend.Dockerfile`](../../deploy/frontend.Dockerfile) builds with the pinned Node/pnpm versions, `DAYFORGE_CONTAINER_BUILD=1`, and `API_INTERNAL_ORIGIN=http://api:8000`. A normal local build continues to require `http://127.0.0.1:8000`. The generated `dayforge-build.json` and `.next/static` are copied after `next build` into the standalone runtime tree.
- [`backend.Dockerfile`](../../deploy/backend.Dockerfile) uses Python 3.14.10 and uv 0.13.6 with the locked backend dependencies. The runtime contains the app, Alembic configuration and migrations, runs as UID 10001, and has no build tools.
- [`compose.app.yaml`](../../deploy/compose.app.yaml) creates a named MySQL volume, a web/API application network, and a separate internal database network. It runs a one-shot database-user provisioner and Alembic migration before starting the API. No web, API, or MySQL host port is published.
- [`compose.edge.yaml`](../../deploy/compose.edge.yaml) publishes ports 80/443 and connects the Caddy edge to the staging and production ingress networks. [`Caddyfile`](../../deploy/Caddyfile) forwards each HTTPS origin to its environment’s web alias without introducing an API/cache rule.
- [`release.schema.json`](../../deploy/release.schema.json) and [`release_manifest.py`](../../scripts/release_manifest.py) reject mutable tags, short commit SHAs, mismatched supported schema revisions, and any manifest that enables test harnesses.

The `deploy/.env.example` file contains examples only. Keep target-specific non-secret values in a host-owned env file and place each password/key in a mode-restricted file under the `secrets_dir` from a validated target. The file names required by Compose are listed in the `secrets:` section of the Compose file. `*_FILE` and direct secret environment variables cannot be supplied together. Secret files may end in one newline; application loading removes only that one ending and preserves password spaces.

Never pass credentials as Docker build arguments, include them in an image layer, expose them in a release manifest, or copy a real `.env`, `.aws`, `.local`, virtual environment, `node_modules`, or test artifact into the build context. The repository `.dockerignore` excludes those paths. The example registry digest values are intentionally unusable placeholders and must be replaced by a real manifest before starting Compose.

## SMTP runtime settings

Production settings require `EMAIL_SMTP_TLS=starttls` or `implicit`, a non-empty username and password, and `EMAIL_SMTP_TIMEOUT_SECONDS` from 1 through 60. The default TLS context verifies certificates. A TLS handshake or certificate error stops delivery and leaves the encrypted outbox job to the existing retry process; it never retries the same message in plaintext.

## CI and release

The `Production Package` workflow builds local images, runs the release/deployment unit contracts, then starts a disposable MySQL/API/web Compose project and checks both calendar routes, `/api/v1/health`, the build header/manifest/static assets, non-root runtime users, and 404 responses from the two test harness routes. The workflow does not push images or create cloud resources. A real release manifest is written only after an approved registry or offline transfer has supplied immutable web/API image digests and a target platform.

The local Docker Engine was unavailable in this workspace, so the container smoke is delegated to the Docker-enabled GitHub workflow and is not reported as a local PASS. Use this sequence after the T30 host, registry and secrets are approved:

1. Validate the private JSON target with `python scripts/deploy_config.py --target <target.json>` once the target CLI is wired in T30.
2. Create a private release env file from the validated target and a release manifest; never use `target.example.json` or `deploy/.env.example` as live configuration.
3. Check the rendered app stack with `docker compose --env-file <release.env> -f deploy/compose.app.yaml config`.
4. Start Caddy only after the environment ingress networks exist: `docker compose --env-file <edge.env> -f deploy/compose.edge.yaml up -d --wait`.
5. Start the app with the exact image digests from the manifest. Verify health and the release build ID before routing users to it.

Provider, live domain, email delivery and resource sizing are recorded in [`T29 decision`](../tasks/t29/deployment-decision.md), not inferred from example values.
