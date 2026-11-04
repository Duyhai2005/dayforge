# T29 — Deployment decision record

Date: 2026-11-04 (Asia/Bangkok)

## Decision

The production packaging contract uses a Linux VM with Docker Compose, a Next.js standalone web image, a FastAPI image, MySQL 8.4, and a Caddy HTTPS edge. Staging, production, and restore rehearsals use distinct Compose projects, application/data networks, MySQL volumes, secrets directories, state directories, aliases, and private app subnets. Only Caddy publishes host ports 80 and 443.

This is a packaging architecture decision. **No cloud provider, account, region, host size, registry, DNS zone, SMTP vendor, sender identity, or monthly budget is selected.** The workspace contains no cloud credentials or inventory, and no domain, budget ceiling, registry, owner inbox, or verified mail account was supplied. The AWS and `ap-southeast-1` values in [`target.example.json`](../../../deploy/target.example.json) are parser examples only. They are not approval to create or purchase resources. T30 remains blocked from provisioning until a real target and operating budget are available.

The project pins build/runtime versions to the existing lockfiles. Base images are pinned by multi-platform manifest digest in [`images.lock.json`](../../../deploy/images.lock.json). The values were checked against official Docker Hub tag details on 2026-11-04: [Node 24.22.1](https://hub.docker.com/layers/library/node/24.22.1-bookworm-slim/images/sha256-294d33a992da016e059121deb0c979dffb4478b77a304376bca41393297c1ea2), [Python 3.14.10](https://hub.docker.com/layers/library/python/3.14.10-slim-bookworm/images/sha256-47d41ea4947601fd5bc7ed6c00a7b9c1fbb936a7684873908a3c3b4e68ce3c86), [MySQL 8.4.13](https://hub.docker.com/layers/library/mysql/8.4.13/images/sha256-b265fd63b9c8168801c1628b0b21e915846e81192f5a493682a1184cbd70d896), and [Caddy 2.11.7](https://hub.docker.com/layers/library/caddy/2.11.7-alpine/images/sha256-5269f9816055b25a025b388964f086cb2ef6e493eaf4a2c6476f8823cc43be19). The recovery tool pin is [restic 0.19.1](https://hub.docker.com/layers/restic/restic/0.19.1/images/sha256-08916bcda4a4435f9d9828ebb4e91bb7ada3d2c8a53699788930e0ae1bd4fa67). Recheck current digests before a release build because upstream tags can move.

## Email decision

Keep the existing SMTP adapter and add explicit STARTTLS/implicit TLS with certificate verification, authentication, bounded timeouts, and secret files. SMTP plain mode remains available only for development and tests. **No real SMTP settings or recipient inbox have been verified**, so this record does not claim inbox delivery. T30/T32 must send verification and password-reset messages to a user-controlled inbox and preserve sanitized evidence.

## External inputs still required

- Provider/account or an already available Linux host, region, platform, monthly budget ceiling, and approval to use it.
- Staging, production, and isolated restore/rehearsal HTTPS origins; DNS control and a certificate contact address.
- Owner inbox, approved sender, SMTP hostname/port/TLS mode, credentials, and permission to deliver to the owner inbox.
- Private image registry and host pull access, or an approved offline image-transfer method.
- Off-host backup destination and the separate custody location for its recovery password.
- Two physical devices and a PC-off window for T32 acceptance.

Until these are supplied, package code and CI smoke tests can be completed, while live host, inbox, backup destination, device acceptance, and upgrade/restore rehearsal remain `BLOCKED` or `TARGET_PENDING` with no false PASS entries.
