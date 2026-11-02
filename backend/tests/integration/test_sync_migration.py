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


async def query(settings, sql):
    database = create_database(settings)
    try:
        async with database.engine.begin() as connection:
            result = await connection.execute(text(sql))
            return result.all() if result.returns_rows else []
    finally:
        await database.engine.dispose()


@pytest.fixture
def migrated(mysql_test_settings):
    alembic("downgrade", "base")
    alembic("upgrade", "head")
    try:
        yield mysql_test_settings
    finally:
        alembic("downgrade", "base")


def test_sync_migration_installs_owner_scoped_event_log(migrated):
    tables = {row[0] for row in asyncio.run(query(migrated, "SHOW TABLES"))}
    assert {"owner_sync_states", "recorded_operations", "operation_receipts", "change_log"} <= tables
    revision = asyncio.run(query(migrated, "SELECT version_num FROM alembic_version"))
    assert revision == [("0004_sync",)]
    assert {row[0] for row in asyncio.run(query(migrated, "SHOW COLUMNS FROM change_log"))} >= {
        "owner_id",
        "epoch",
        "cursor",
        "committed_at",
    }
