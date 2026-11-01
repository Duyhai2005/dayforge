import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import func, select

from app.core.database import create_database
from app.models.sync import ChangeLog, OperationReceipt, OwnerSyncState, RecordedOperation
from app.services.sync import SyncOperationError, record_operation
from app.services.sync_wire import validate_operation

pytestmark = pytest.mark.mysql
BACKEND = Path(__file__).resolve().parents[2]
EXAMPLES = BACKEND.parent / "docs" / "tasks" / "t03" / "contract-examples.json"


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


@pytest.fixture
def migrated(mysql_test_settings):
    alembic("downgrade", "base")
    alembic("upgrade", "head")
    try:
        yield mysql_test_settings
    finally:
        alembic("downgrade", "base")


def operation_for(owner_id):
    document = json.loads(EXAMPLES.read_text(encoding="utf-8"))
    operation = next(
        fixture["value"] for fixture in document["fixtures"] if fixture["name"] == "work-item-create-operation"
    )
    operation["owner_id"] = str(owner_id)
    operation["operation_id"] = str(uuid4())
    return operation


def test_push_retry_returns_original_receipt_and_different_hash_is_rejected(migrated, user_factory):
    async def run():
        database = create_database(migrated)
        owner = user_factory()
        try:
            async with database.sessions() as session:
                async with session.begin():
                    session.add(owner)

            envelope = operation_for(owner.id)
            validated = validate_operation(envelope)
            first = await record_operation(database, owner.id, validated)
            duplicate = await record_operation(database, owner.id, validated)

            assert first.status == "recorded"
            assert duplicate.status == "duplicate"
            assert duplicate.receipt == first.receipt
            assert first.head_cursor == duplicate.head_cursor == 1

            changed = operation_for(owner.id)
            changed["operation_id"] = envelope["operation_id"]
            changed["commands"][0]["payload"]["data"]["title"] = "Nội dung đã thay đổi"
            with pytest.raises(SyncOperationError) as reused:
                await record_operation(database, owner.id, validate_operation(changed))
            assert reused.value.code == "operation_id_reused"

            async with database.sessions() as session:
                assert await session.scalar(select(func.count()).select_from(RecordedOperation)) == 1
                assert await session.scalar(select(func.count()).select_from(OperationReceipt)) == 1
                assert await session.scalar(select(func.count()).select_from(ChangeLog)) == 1
                state = await session.get(OwnerSyncState, owner.id)
                assert state is not None and state.head_cursor == 1
        finally:
            await database.engine.dispose()

    asyncio.run(run())


def test_push_missing_dependency_is_deferred_without_recording(migrated, user_factory):
    async def run():
        database = create_database(migrated)
        owner = user_factory()
        try:
            async with database.sessions() as session:
                async with session.begin():
                    session.add(owner)

            envelope = operation_for(owner.id)
            envelope["dependencies"] = [str(uuid4())]
            with pytest.raises(SyncOperationError) as missing:
                await record_operation(database, owner.id, validate_operation(envelope))
            assert missing.value.code == "dependency_missing"
            assert missing.value.deferred is True

            async with database.sessions() as session:
                assert await session.scalar(select(func.count()).select_from(RecordedOperation)) == 0
        finally:
            await database.engine.dispose()

    asyncio.run(run())


def test_push_rejects_owner_assertion_and_nonincreasing_dependency_order(migrated, user_factory):
    async def run():
        database = create_database(migrated)
        owner = user_factory()
        other_owner = user_factory()
        try:
            async with database.sessions() as session:
                async with session.begin():
                    session.add_all([owner, other_owner])

            envelope = operation_for(owner.id)
            valid = validate_operation(envelope)
            with pytest.raises(SyncOperationError) as mismatch:
                await record_operation(database, other_owner.id, valid)
            assert mismatch.value.code == "owner_mismatch"

            await record_operation(database, owner.id, valid)
            dependent = operation_for(owner.id)
            dependent["dependencies"] = [envelope["operation_id"]]
            dependent["edit_time"]["physical_ms"] -= 1
            dependent["edit_time"]["raw_wall_ms"] -= 1
            with pytest.raises(SyncOperationError) as order:
                await record_operation(database, owner.id, validate_operation(dependent))
            assert order.value.code == "invalid_causality"

            async with database.sessions() as session:
                assert await session.scalar(select(func.count()).select_from(RecordedOperation)) == 1
        finally:
            await database.engine.dispose()

    asyncio.run(run())
