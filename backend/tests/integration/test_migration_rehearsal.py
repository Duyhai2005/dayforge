"""Prove a MySQL interruption can leave DDL behind while readiness stays closed."""

import asyncio
import shutil
import tempfile
from pathlib import Path

import pymysql
import pytest
from alembic import command
from alembic.config import Config

from app.core.database import create_database
from app.services.readiness import check_readiness, required_schema_revision

pytestmark = pytest.mark.mysql
BACKEND = Path(__file__).resolve().parents[2]


def _alembic_config() -> Config:
    return Config(str(BACKEND / "alembic.ini"))


def _connect(settings):
    return pymysql.connect(
        host=settings.db_host,
        port=settings.db_port,
        user=settings.db_user,
        password=settings.db_password.get_secret_value(),
        database=settings.db_name,
        charset="utf8mb4",
        autocommit=True,
    )


def test_interrupted_0004_stays_unready_then_recovers_by_verified_roll_forward(mysql_test_settings):
    settings = mysql_test_settings
    base_config = _alembic_config()
    connection = _connect(settings)
    try:
        with connection.cursor() as cursor:
            cursor.execute("DROP TABLE IF EXISTS owner_sync_states")
        command.downgrade(base_config, "base")
        command.upgrade(base_config, "0003_auth_lifecycle_hardening")

        with tempfile.TemporaryDirectory(prefix="dayforge-migration-fixture-") as directory:
            script_directory = Path(directory) / "migrations"
            shutil.copytree(BACKEND / "migrations", script_directory)
            migration = script_directory / "versions" / "0004_sync.py"
            source = migration.read_text(encoding="utf-8")
            boundary = '\n    )\n    op.create_table(\n        "recorded_operations"'
            if source.count(boundary) != 1:
                pytest.fail("Migration fault-injection boundary changed")
            migration.write_text(
                source.replace(
                    boundary,
                    '\n    )\n    raise RuntimeError("injected migration interruption")\n'
                    '    op.create_table(\n        "recorded_operations"',
                    1,
                ),
                encoding="utf-8",
            )
            fault_config = _alembic_config()
            fault_config.set_main_option("script_location", str(script_directory))
            with pytest.raises(RuntimeError, match="injected migration interruption"):
                command.upgrade(fault_config, "head")

        with connection.cursor() as cursor:
            cursor.execute("SELECT version_num FROM alembic_version")
            revision = cursor.fetchone()[0]
            cursor.execute("SHOW TABLES LIKE 'owner_sync_states'")
            partial_table = cursor.fetchone()
        assert revision == "0003_auth_lifecycle_hardening"
        assert partial_table is not None

        database = create_database(settings)
        loop = asyncio.new_event_loop()
        try:
            ready = loop.run_until_complete(check_readiness(database, required_revision=required_schema_revision()))
            assert ready is False

            # On this disposable fixture only, remove the one verified orphan
            # created before the injected fault and replay the forward migration.
            with connection.cursor() as cursor:
                cursor.execute("DROP TABLE owner_sync_states")
            command.upgrade(base_config, "head")
            recovered = loop.run_until_complete(check_readiness(database, required_revision=required_schema_revision()))
            assert recovered is True
            with connection.cursor() as cursor:
                cursor.execute("SELECT version_num FROM alembic_version")
                assert cursor.fetchone()[0] == "0004_sync"
        finally:
            try:
                loop.run_until_complete(database.engine.dispose())
            finally:
                loop.close()
    finally:
        try:
            command.downgrade(base_config, "base")
        finally:
            try:
                with connection.cursor() as cursor:
                    cursor.execute("DROP TABLE IF EXISTS owner_sync_states")
            finally:
                connection.close()
