# Database migrations

Run `pnpm db:migrate` to upgrade and `pnpm db:current` to inspect the revision
using the local backend environment. New installations create empty `users` and
`workspace_settings` tables; provisioning an owner belongs to the account service.

For review without credentials or a running database, run from `backend/`:

```console
uv run --locked alembic upgrade head --sql
```

MySQL DDL implicitly commits. If an upgrade fails partway through, do not assume
that a surrounding transaction rolled back previously created tables. Inspect
`alembic current`, `SHOW TABLES`, and `SHOW CREATE TABLE` for the affected tables,
compare them with the revision, and plan an explicit repair based on that state.
Preserve existing data and back it up before a repair. Do not stamp `head` to hide
missing schema or drop a development database to retry an upgrade.

The migration downgrade/upgrade tests run only through `pnpm test:api:mysql` in a
fresh UUID-scoped disposable project. Never run a reset or downgrade against the
development volume as part of test setup.
