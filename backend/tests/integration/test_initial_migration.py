import asyncio
import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.core.database import create_database

pytestmark = pytest.mark.mysql
BACKEND = Path(__file__).resolve().parents[2]


def alembic(*arguments):
    result = subprocess.run([sys.executable, "-m", "alembic", *arguments],
                            cwd=BACKEND, env=os.environ.copy(), capture_output=True, text=True)
    code, output = result.returncode, result.stdout
    del result
    assert code == 0, "Alembic command failed (output suppressed for secret safety)"
    return output


async def query(settings, sql, parameters=None):
    database = create_database(settings)
    try:
        async with database.engine.begin() as connection:
            result = await connection.execute(text(sql), parameters or {})
            return result.all() if result.returns_rows else []
    finally:
        await database.engine.dispose()


@pytest.fixture
def migrated(t05_mysql_settings):
    # The guarded fixture must run before any CLI command; no create_all shortcut.
    alembic("downgrade", "base")
    alembic("upgrade", "head")
    try:
        yield t05_mysql_settings
    finally:
        alembic("downgrade", "base")


def schema(settings):
    return asyncio.run(query(settings, "SHOW TABLES"))


def test_upgrade_from_empty_and_repeat_upgrade(migrated):
    assert {row[0] for row in schema(migrated)} == {"alembic_version", "users", "workspace_settings"}
    assert asyncio.run(query(migrated, "SELECT version_num FROM alembic_version")) == [("0001_owner_workspace",)]
    assert "0001_owner_workspace" in alembic("current")
    assert asyncio.run(query(migrated, "SELECT COUNT(*) FROM users")) == [(0,)]
    assert asyncio.run(query(migrated, "SELECT COUNT(*) FROM workspace_settings")) == [(0,)]
    alembic("upgrade", "head")
    assert {row[0] for row in schema(migrated)} == {"alembic_version", "users", "workspace_settings"}
    assert asyncio.run(query(migrated, "SELECT COUNT(*) FROM users")) == [(0,)]
    assert asyncio.run(query(migrated, "SELECT COUNT(*) FROM workspace_settings")) == [(0,)]


def insert_owner(settings, owner, **overrides):
    values = dict(id=owner.id.bytes, email=owner.email_canonical, delivery=owner.email_delivery,
                  password=owner.password_hash, slot=1, version=1)
    values.update(overrides)
    asyncio.run(query(settings, """INSERT INTO users
        (id, owner_slot, email_canonical, email_delivery, password_hash, auth_version,
         email_verified_at, created_at, updated_at)
        VALUES (:id, :slot, :email, :delivery, :password, :version,
                '2026-10-29 01:02:03.456', '2026-10-29 01:02:03.456', '2026-10-29 01:02:03.456')""", values))


def test_owner_slot_is_singleton(migrated, user_factory):
    insert_owner(migrated, user_factory())
    with pytest.raises(IntegrityError):
        insert_owner(migrated, user_factory())
    with pytest.raises(DBAPIError) as error:
        insert_owner(migrated, user_factory(), slot=2)
    assert error.value.orig.args[0] == 3819
    assert asyncio.run(query(migrated, "SELECT owner_slot FROM users")) == [(1,)]


def test_auth_version_must_be_positive(migrated, user_factory):
    with pytest.raises(DBAPIError) as error:
        insert_owner(migrated, user_factory(), version=0)
    assert error.value.orig.args[0] == 3819
    assert asyncio.run(query(migrated, "SELECT COUNT(*) FROM users")) == [(0,)]


def test_workspace_requires_existing_owner(migrated):
    with pytest.raises(IntegrityError):
        asyncio.run(query(migrated, "INSERT INTO workspace_settings (owner_id) VALUES (:id)", {"id": uuid4().bytes}))
    assert asyncio.run(query(migrated, "SELECT COUNT(*) FROM workspace_settings")) == [(0,)]


@pytest.mark.parametrize(("field", "value"), [("time_zone", "UTC"), ("utc_offset_minutes", 0), ("week_start", 7)])
def test_workspace_constants_are_enforced(migrated, user_factory, field, value):
    owner = user_factory()
    insert_owner(migrated, owner)
    with pytest.raises(DBAPIError) as error:
        asyncio.run(query(migrated, f"INSERT INTO workspace_settings (owner_id, {field}) VALUES (:id, :value)",
                          {"id": owner.id.bytes, "value": value}))
    assert error.value.orig.args[0] == 3819
    assert asyncio.run(query(migrated, "SELECT COUNT(*) FROM workspace_settings")) == [(0,)]


def test_workspace_defaults_and_owner_delete_restrict(migrated, user_factory):
    owner = user_factory()
    insert_owner(migrated, owner)
    asyncio.run(query(migrated, "INSERT INTO workspace_settings (owner_id) VALUES (:id)", {"id": owner.id.bytes}))
    assert asyncio.run(query(migrated, "SELECT time_zone, utc_offset_minutes, week_start FROM workspace_settings")) == [("Asia/Bangkok", 420, 1)]
    with pytest.raises(IntegrityError):
        asyncio.run(query(migrated, "DELETE FROM users WHERE id=:id", {"id": owner.id.bytes}))
    assert asyncio.run(query(migrated, "SELECT COUNT(*) FROM users")) == [(1,)]


def test_email_has_its_own_binary_unique_constraint(migrated):
    async def check():
        database = create_database(migrated)
        try:
            async with database.engine.connect() as connection:
                columns, indexes = await connection.run_sync(lambda c: (
                    inspect(c).get_columns("users"), inspect(c).get_indexes("users")))
                email = next(c for c in columns if c["name"] == "email_canonical")
                assert str(email["type"]) == "VARBINARY(254)"
                index = next(i for i in indexes if i["name"] == "uq_users_email_canonical")
                assert index["unique"] and index["column_names"] == ["email_canonical"]
        finally:
            await database.engine.dispose()
    asyncio.run(check())


def test_binary_email_comparison_preserves_local_part_case(migrated, user_factory):
    insert_owner(migrated, user_factory(email_canonical=b"Owner@example.test"))
    assert asyncio.run(query(migrated, "SELECT COUNT(*) FROM users WHERE email_canonical=:email", {"email": b"owner@example.test"})) == [(0,)]
    assert asyncio.run(query(migrated, "SELECT COUNT(*) FROM users WHERE email_canonical=:email", {"email": b"Owner@example.test"})) == [(1,)]


def test_alembic_check_has_no_metadata_drift(migrated):
    alembic("check")


def test_downgrade_upgrade_on_disposable_db(migrated):
    alembic("downgrade", "base")
    assert {row[0] for row in schema(migrated)} == {"alembic_version"}
    alembic("upgrade", "head")
    assert {row[0] for row in schema(migrated)} == {"alembic_version", "users", "workspace_settings"}
    assert asyncio.run(query(migrated, "SELECT COUNT(*) FROM users")) == [(0,)]
    assert asyncio.run(query(migrated, "SELECT COUNT(*) FROM workspace_settings")) == [(0,)]
