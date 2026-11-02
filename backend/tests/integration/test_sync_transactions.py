import asyncio
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import func, select

from app.core.database import create_database
from app.models.sync import ChangeLog, OperationReceipt, OwnerSyncState, RecordedOperation
from app.services import sync as sync_service
from app.services.sync import read_owner_sync_head, record_operation
from app.services.sync_wire import validate_operation

pytestmark = pytest.mark.mysql
BACKEND = Path(__file__).resolve().parents[2]
EXAMPLES = BACKEND.parent / "docs" / "tasks" / "t03" / "contract-examples.json"
TEST_NOW = datetime.now(timezone.utc).replace(microsecond=0)


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


def operation_for(owner_id, *, sequence=1, operation_id=None):
    document = json.loads(EXAMPLES.read_text(encoding="utf-8"))
    operation = next(
        fixture["value"] for fixture in document["fixtures"] if fixture["name"] == "work-item-create-operation"
    )
    edit_ms = int(TEST_NOW.timestamp() * 1000)
    operation["owner_id"] = str(owner_id)
    operation["operation_id"] = str(uuid4() if operation_id is None else operation_id)
    operation["device_sequence"] = str(sequence)
    operation["edit_time"]["physical_ms"] = edit_ms
    operation["edit_time"]["raw_wall_ms"] = edit_ms
    return operation


async def add_owner(database, owner):
    async with database.sessions() as session:
        async with session.begin():
            session.add(owner)


@pytest.mark.parametrize("failure_stage", ["after_event_flush", "before_commit"])
def test_failure_rolls_back_event_receipt_change_and_head_then_reuses_cursor(
    migrated, user_factory, monkeypatch, failure_stage
):
    async def run():
        database = create_database(migrated)
        owner = user_factory()
        await add_owner(database, owner)
        validated = validate_operation(operation_for(owner.id))

        def fail(stage):
            if stage == failure_stage:
                raise RuntimeError("test_sync_failpoint")

        monkeypatch.setattr(sync_service, "_SYNC_WRITE_FAILPOINT", fail)
        try:
            with pytest.raises(RuntimeError, match="test_sync_failpoint"):
                await record_operation(database, owner.id, validated, now=TEST_NOW)

            async with database.sessions() as session:
                assert await session.scalar(select(func.count()).select_from(RecordedOperation)) == 0
                assert await session.scalar(select(func.count()).select_from(OperationReceipt)) == 0
                assert await session.scalar(select(func.count()).select_from(ChangeLog)) == 0
                assert await session.get(OwnerSyncState, owner.id) is None

            monkeypatch.setattr(sync_service, "_SYNC_WRITE_FAILPOINT", None)
            retried = await record_operation(database, owner.id, validated, now=TEST_NOW)
            assert retried.receipt.commit_cursor == 1
            async with database.sessions() as session:
                state = await session.get(OwnerSyncState, owner.id)
                assert state is not None and state.head_cursor == 1
                assert await session.scalar(select(func.count()).select_from(RecordedOperation)) == 1
                assert await session.scalar(select(func.count()).select_from(OperationReceipt)) == 1
                assert await session.scalar(select(func.count()).select_from(ChangeLog)) == 1
        finally:
            await database.engine.dispose()

    asyncio.run(run())


def test_concurrent_distinct_operations_receive_contiguous_owner_cursors(migrated, user_factory):
    async def run():
        database = create_database(migrated)
        owner = user_factory()
        await add_owner(database, owner)
        try:
            operations = [validate_operation(operation_for(owner.id, sequence=index)) for index in range(1, 13)]
            results = await asyncio.gather(
                *(record_operation(database, owner.id, operation) for operation in operations)
            )

            assert all(result.status == "recorded" for result in results)
            assert sorted(result.receipt.commit_cursor for result in results) == list(range(1, 13))
            async with database.sessions() as session:
                state = await session.get(OwnerSyncState, owner.id)
                assert state is not None and state.head_cursor == 12
                assert await session.scalar(select(func.count()).select_from(RecordedOperation)) == 12
                assert await session.scalar(select(func.count()).select_from(OperationReceipt)) == 12
                assert await session.scalar(select(func.count()).select_from(ChangeLog)) == 12
        finally:
            await database.engine.dispose()

    asyncio.run(run())


def test_concurrent_retry_of_same_operation_writes_one_event_and_original_receipt(migrated, user_factory):
    async def run():
        database = create_database(migrated)
        owner = user_factory()
        await add_owner(database, owner)
        operation = validate_operation(operation_for(owner.id))
        try:
            results = await asyncio.gather(*(record_operation(database, owner.id, operation) for _ in range(2)))

            assert sorted(result.status for result in results) == ["duplicate", "recorded"]
            assert results[0].receipt == results[1].receipt
            async with database.sessions() as session:
                state = await session.get(OwnerSyncState, owner.id)
                assert state is not None and state.head_cursor == 1
                assert await session.scalar(select(func.count()).select_from(RecordedOperation)) == 1
                assert await session.scalar(select(func.count()).select_from(OperationReceipt)) == 1
                assert await session.scalar(select(func.count()).select_from(ChangeLog)) == 1
        finally:
            await database.engine.dispose()

    asyncio.run(run())


def test_concurrent_owner_state_creation_returns_one_epoch(migrated, user_factory):
    async def run():
        database = create_database(migrated)
        owner = user_factory()
        await add_owner(database, owner)
        try:
            heads = await asyncio.gather(*(read_owner_sync_head(database, owner.id) for _ in range(8)))
            assert len({head.epoch for head in heads}) == 1
            assert {head.head_cursor for head in heads} == {0}
        finally:
            await database.engine.dispose()

    asyncio.run(run())
