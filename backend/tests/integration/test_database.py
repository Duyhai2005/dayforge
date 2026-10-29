import asyncio
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import text


pytestmark = pytest.mark.mysql


def _check_transaction(settings, action, expected):
    from app.core.database import close_database, create_database, get_session

    async def check():
        database = create_database(settings)
        table = "probe_" + uuid4().hex
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(database=database)))
        try:
            async with database.engine.begin() as connection:
                await connection.execute(text(f"CREATE TABLE {table} (value INT NOT NULL) ENGINE=InnoDB"))
            dependency = get_session(request)
            session = await anext(dependency)
            if action == "commit":
                async with session.begin():
                    await session.execute(text(f"INSERT INTO {table} VALUES (1)"))
                await dependency.aclose()
            elif action == "exception":
                await session.execute(text(f"INSERT INTO {table} VALUES (1)"))
                with pytest.raises(RuntimeError):
                    await dependency.athrow(RuntimeError("probe failure"))
            else:
                await session.execute(text(f"INSERT INTO {table} VALUES (1)"))
                await dependency.aclose()
            async with database.engine.connect() as connection:
                assert await connection.scalar(text(f"SELECT COUNT(*) FROM {table}")) == expected
        finally:
            async with database.engine.begin() as connection:
                await connection.execute(text(f"DROP TABLE IF EXISTS {table}"))
            await close_database(database)

    asyncio.run(check())


def test_explicit_transaction_commits(t05_mysql_settings):
    _check_transaction(t05_mysql_settings, "commit", 1)


def test_exception_rolls_back(t05_mysql_settings):
    _check_transaction(t05_mysql_settings, "exception", 0)


def test_close_without_commit_rolls_back(t05_mysql_settings):
    _check_transaction(t05_mysql_settings, "close", 0)


def test_database_round_trip_uses_utf8mb4_utc_and_strict_mode(t05_mysql_settings):
    from app.core.database import close_database, create_database

    async def check():
        database = create_database(t05_mysql_settings)
        try:
            async with database.engine.connect() as connection:
                row = (await connection.execute(text(
                    "SELECT 1, @@character_set_connection, @@session.time_zone, @@session.sql_mode"
                ))).one()
                assert row[0] == 1
                assert row[1] == "utf8mb4"
                assert row[2] == "+00:00"
                assert {"STRICT_TRANS_TABLES", "STRICT_ALL_TABLES"}.intersection(row[3].split(","))
        finally:
            await close_database(database)

    asyncio.run(check())
