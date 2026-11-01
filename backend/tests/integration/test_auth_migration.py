import asyncio
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import text

from app.core.database import create_database

pytestmark = pytest.mark.mysql
BACKEND = Path(__file__).resolve().parents[2]


def alembic(*arguments):
    result = subprocess.run(
        [sys.executable, "-m", "alembic", *arguments],
        cwd=BACKEND,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
    )
    code = result.returncode
    del result
    assert code == 0, "Alembic command failed (output suppressed for secret safety)"


async def query(settings, sql, parameters=None):
    database = create_database(settings)
    try:
        async with database.engine.begin() as connection:
            result = await connection.execute(text(sql), parameters or {})
            return result.all() if result.returns_rows else []
    finally:
        await database.engine.dispose()


@pytest.fixture
def owner_schema(mysql_test_settings):
    alembic("downgrade", "base")
    alembic("upgrade", "0001_owner_workspace")
    owner = {
        "id": bytes.fromhex("00112233445566778899aabbccddeeff"),
        "email": b"Owner@example.test",
        "delivery": "Owner@example.test",
        "password": "$argon2id$v=19$test-fixture",
    }
    asyncio.run(
        query(
            mysql_test_settings,
            """INSERT INTO users
            (id, owner_slot, email_canonical, email_delivery, password_hash,
             email_verified_at, auth_version, created_at, updated_at)
            VALUES (:id, 1, :email, :delivery, :password,
                    '2026-10-31 12:00:00.000', 7,
                    '2026-10-30 12:00:00.000', '2026-10-31 12:00:00.000')""",
            owner,
        )
    )
    yield mysql_test_settings, owner
    alembic("downgrade", "base")


def test_auth_migration_adds_auth_tables_and_preserves_existing_owner_schema(
    owner_schema,
):
    settings, owner = owner_schema
    before = asyncio.run(
        query(
            settings,
            "SELECT id, email_canonical, email_delivery, password_hash, auth_version FROM users",
        )
    )

    alembic("upgrade", "head")
    alembic("upgrade", "head")

    tables = {row[0] for row in asyncio.run(query(settings, "SHOW TABLES"))}
    assert {
        "users",
        "workspace_settings",
        "sessions",
        "email_tokens",
        "owner_local_keys",
        "auth_rate_limits",
        "email_delivery_jobs",
        "auth_audit_events",
    } <= tables
    after = asyncio.run(
        query(
            settings,
            "SELECT id, email_canonical, email_delivery, password_hash, auth_version FROM users",
        )
    )
    assert after == before
    assert after[0][0] == owner["id"]
    audit_columns = {row[0] for row in asyncio.run(query(settings, "SHOW COLUMNS FROM auth_audit_events"))}
    assert {"action", "outcome", "request_id", "email_digest", "peer_digest"} <= audit_columns
    outbox_columns = {row[0] for row in asyncio.run(query(settings, "SHOW COLUMNS FROM email_delivery_jobs"))}
    assert {"claim_token", "claim_expires_at"} <= outbox_columns
