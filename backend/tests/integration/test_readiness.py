import asyncio
import logging
import os
from pathlib import Path
import subprocess
import sys
from time import monotonic
import warnings

import pytest
from sqlalchemy import event, text

with warnings.catch_warnings():
    warnings.filterwarnings("ignore", message="Using `httpx` with `starlette.testclient` is deprecated.*")
    from fastapi.testclient import TestClient

from app.core.database import create_database
from app.main import create_app
from app.services.readiness import check_readiness, required_schema_revision

pytestmark = pytest.mark.mysql


@pytest.fixture
def assert_readiness_logs(caplog):
    caplog.set_level(logging.WARNING, logger="app.services.readiness")

    def check(count=1):
        records = [record for record in caplog.records if record.name == "app.services.readiness"]
        assert [(record.levelname, record.getMessage(), record.args, record.exc_info, record.stack_info)
                for record in records] == [("WARNING", "database_not_ready", (), None, None)] * count
    return check


def migrate():
    result = subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"],
                            cwd=Path(__file__).resolve().parents[2], env=os.environ.copy(),
                            capture_output=True, text=True, timeout=30)
    code = result.returncode
    del result
    assert code == 0, "Isolated migration failed (details suppressed)"


async def query(settings, statement):
    database = create_database(settings)
    try:
        async with database.engine.begin() as connection:
            result = await connection.execute(text(statement))
            return result.all() if result.returns_rows else []
    finally:
        await database.engine.dispose()


@pytest.fixture
def isolated_schema(t05_mysql_settings):
    def reset():
        for table in ("workspace_settings", "users", "alembic_version"):
            asyncio.run(query(t05_mysql_settings, f"DROP TABLE IF EXISTS {table}"))
    reset()
    try:
        yield t05_mysql_settings
    finally:
        reset()


def test_empty_database_is_not_ready(isolated_schema, assert_readiness_logs):
    with TestClient(create_app(isolated_schema)) as client:
        assert client.get("/api/v1/health").status_code == 503
    assert asyncio.run(query(isolated_schema, "SHOW TABLES")) == []
    assert_readiness_logs()


@pytest.mark.parametrize("damage", ["stale", "missing_table", "missing_column", "no_revision", "multiple_revisions"])
def test_behind_revision_or_missing_table_is_not_ready(isolated_schema, damage, assert_readiness_logs):
    migrate()
    statements = {
        "stale": "UPDATE alembic_version SET version_num = 'stale_test_revision'",
        "missing_table": "DROP TABLE workspace_settings",
        "missing_column": "ALTER TABLE workspace_settings RENAME COLUMN owner_id TO missing_owner_id",
        "no_revision": "DELETE FROM alembic_version",
        "multiple_revisions": "INSERT INTO alembic_version VALUES ('another_test_revision')",
    }
    asyncio.run(query(isolated_schema, statements[damage]))
    with TestClient(create_app(isolated_schema)) as client:
        assert client.get("/api/v1/health").status_code == 503
    assert asyncio.run(query(isolated_schema, "SELECT COUNT(*) FROM users")) == [(0,)]
    if damage in ("missing_table", "missing_column"):
        assert asyncio.run(query(isolated_schema, "SELECT version_num FROM alembic_version")) == [(required_schema_revision(),)]
    assert_readiness_logs()


def test_migrated_database_is_ready(isolated_schema, assert_readiness_logs):
    migrate()
    with TestClient(create_app(isolated_schema)) as client:
        assert client.get("/api/v1/health").json() == {"status": "ok"}
    assert asyncio.run(query(isolated_schema, "SELECT COUNT(*) FROM users")) == [(0,)]
    assert asyncio.run(query(isolated_schema, "SELECT COUNT(*) FROM workspace_settings")) == [(0,)]
    assert_readiness_logs(0)


def test_database_outage_recovers_without_api_restart(isolated_schema, mysql_control, assert_readiness_logs):
    migrate()
    app = create_app(isolated_schema)
    with TestClient(app) as client:
        engine = app.state.database.engine
        assert client.get("/api/v1/health").status_code == 200
        try:
            mysql_control("stop")
            start = monotonic()
            response = client.get("/api/v1/health")
            assert response.status_code == 503
            assert monotonic() - start <= 3
            assert engine.pool.checkedout() == 0
        finally:
            mysql_control("start")
        assert app.state.database.engine is engine
        assert client.get("/api/v1/health").status_code == 200
        assert engine.pool.checkedout() == 0
    assert_readiness_logs()


def test_timeout_releases_connection_and_readiness_is_not_cached(isolated_schema, assert_readiness_logs):
    migrate()
    async def check():
        database = create_database(isolated_schema)
        def slow_probe(connection, cursor, statement, parameters, context, executemany):
            return ("SELECT SLEEP(10)", parameters) if statement == "SELECT 1" else (statement, parameters)
        try:
            assert await check_readiness(database, required_revision=required_schema_revision())
            event.listen(database.engine.sync_engine, "before_cursor_execute", slow_probe, retval=True)
            start = monotonic()
            assert not await check_readiness(database, required_revision=required_schema_revision())
            assert monotonic() - start <= 3
            assert database.engine.pool.checkedout() == 0
            event.remove(database.engine.sync_engine, "before_cursor_execute", slow_probe)
            assert await check_readiness(database, required_revision=required_schema_revision())
        finally:
            await database.engine.dispose()
    asyncio.run(check())
    assert_readiness_logs()


@pytest.mark.parametrize("setting", ["SET SESSION time_zone = '+01:00'", "SET SESSION sql_mode = ''", "SET NAMES latin1"])
def test_changed_session_invariants_are_not_ready(isolated_schema, setting, assert_readiness_logs):
    migrate()
    async def check():
        database = create_database(isolated_schema)
        try:
            async with database.engine.begin() as connection:
                await connection.execute(text(setting))
            assert not await check_readiness(database, required_revision=required_schema_revision())
            assert database.engine.pool.checkedout() == 0
        finally:
            await database.engine.dispose()
    asyncio.run(check())
    assert_readiness_logs()


def test_pool_wait_is_bounded_and_recovers(isolated_schema, assert_readiness_logs):
    migrate()
    async def check():
        database = create_database(isolated_schema)
        held = []
        try:
            for _ in range(5):
                held.append(await database.engine.connect())
            start = monotonic()
            assert not await check_readiness(database, required_revision=required_schema_revision())
            assert monotonic() - start <= 3
            assert database.engine.pool.checkedout() == 5
            for connection in held:
                await connection.close()
            held.clear()
            assert await check_readiness(database, required_revision=required_schema_revision())
            assert database.engine.pool.checkedout() == 0
        finally:
            for connection in held:
                await connection.close()
            await database.engine.dispose()
    asyncio.run(check())
    assert_readiness_logs()


def test_database_error_log_excludes_private_details(isolated_schema, assert_readiness_logs, caplog):
    from sqlalchemy.exc import SQLAlchemyError

    private_details = "mysql+aiomysql://private_user:private_password@private_host/private_db SELECT private_note"

    async def check():
        database = create_database(isolated_schema)

        def fail_probe(*args):
            raise SQLAlchemyError(private_details)

        event.listen(database.engine.sync_engine, "before_cursor_execute", fail_probe)
        try:
            assert not await check_readiness(database, required_revision=required_schema_revision())
        finally:
            await database.engine.dispose()

    asyncio.run(check())
    assert_readiness_logs()
    assert "private_" not in caplog.text
    assert "SELECT" not in caplog.text
    assert "mysql+aiomysql://" not in caplog.text
