import asyncio
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
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
TEST_NOW = datetime.now(timezone.utc).replace(microsecond=0)
EDIT_TIME = int(TEST_NOW.timestamp() * 1000)


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
    operation["edit_time"]["physical_ms"] = EDIT_TIME
    operation["edit_time"]["raw_wall_ms"] = EDIT_TIME
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
            first = await record_operation(database, owner.id, validated, now=TEST_NOW)
            duplicate = await record_operation(database, owner.id, validated, now=TEST_NOW + timedelta(days=60))

            assert first.status == "recorded"
            assert duplicate.status == "duplicate"
            assert duplicate.receipt == first.receipt
            assert first.receipt.effect_at_commit == "applied"
            assert first.receipt.reason_at_commit is None
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


def test_push_accepts_dependency_in_edit_order_and_rejects_time_invalid_without_recording(migrated, user_factory):
    async def run():
        database = create_database(migrated)
        owner = user_factory()
        try:
            async with database.sessions() as session:
                async with session.begin():
                    session.add(owner)

            dependency = operation_for(owner.id)
            await record_operation(database, owner.id, validate_operation(dependency))

            dependent = operation_for(owner.id)
            dependent["dependencies"] = [dependency["operation_id"]]
            dependent["edit_time"]["physical_ms"] += 1
            dependent["edit_time"]["raw_wall_ms"] += 1
            accepted = await record_operation(database, owner.id, validate_operation(dependent))
            assert accepted.status == "recorded"
            assert accepted.head_cursor == 2

            future = operation_for(owner.id)
            future["edit_time"]["physical_ms"] += 300_001
            future["edit_time"]["raw_wall_ms"] += 300_001
            with pytest.raises(SyncOperationError) as invalid_time:
                await record_operation(database, owner.id, validate_operation(future), now=TEST_NOW)
            assert invalid_time.value.code == "time_invalid"

            async with database.sessions() as session:
                assert await session.scalar(select(func.count()).select_from(RecordedOperation)) == 2
                state = await session.get(OwnerSyncState, owner.id)
                assert state is not None and state.head_cursor == 2
        finally:
            await database.engine.dispose()

    asyncio.run(run())


def test_push_returns_duplicate_receipt_when_server_clock_is_unhealthy(migrated, user_factory, monkeypatch):
    from app.core.errors import ProblemHTTPException
    from app.services import sync as sync_service

    class UnhealthyClock:
        def observe(self, **_kwargs):
            return False

    async def run():
        database = create_database(migrated)
        owner = user_factory()
        try:
            async with database.sessions() as session:
                async with session.begin():
                    session.add(owner)

            envelope = validate_operation(operation_for(owner.id))
            recorded = await record_operation(
                database,
                owner.id,
                envelope,
                now=TEST_NOW,
            )
            monkeypatch.setattr(sync_service, "SERVER_CLOCK_MONITOR", UnhealthyClock())

            duplicate = await record_operation(database, owner.id, envelope)
            assert duplicate.status == "duplicate"
            assert duplicate.receipt == recorded.receipt

            new_operation = validate_operation(operation_for(owner.id))
            with pytest.raises(ProblemHTTPException) as unhealthy:
                await record_operation(database, owner.id, new_operation)
            assert unhealthy.value.status_code == 503
            assert unhealthy.value.code == "clock_unhealthy"
            async with database.sessions() as session:
                assert await session.scalar(select(func.count()).select_from(RecordedOperation)) == 1
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
                    session.add(owner)

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


def test_push_rejects_dependency_with_equal_hlc_even_when_k_tie_breakers_increase(migrated, user_factory):
    async def run():
        database = create_database(migrated)
        owner = user_factory()
        try:
            async with database.sessions() as session:
                async with session.begin():
                    session.add(owner)

            dependency = operation_for(owner.id)
            dependency["device_id"] = "33333333-3333-4333-8333-333333333333"
            dependency["operation_id"] = "44444444-4444-4444-8444-444444444444"
            await record_operation(database, owner.id, validate_operation(dependency), now=TEST_NOW)

            cases = (
                {
                    "name": "delete_rank",
                    "operation_id": "11111111-1111-4111-8111-111111111111",
                    "device_id": dependency["device_id"],
                    "action": "single.delete",
                    "payload": {},
                },
                {
                    "name": "device_id",
                    "operation_id": "11111111-1111-4111-8111-111111111112",
                    "device_id": "ffffffff-ffff-4fff-8fff-ffffffffffff",
                    "action": "work_item.create_single",
                    "payload": dependency["commands"][0]["payload"],
                },
                {
                    "name": "operation_id",
                    "operation_id": "ffffffff-ffff-4fff-8fff-ffffffffffff",
                    "device_id": dependency["device_id"],
                    "action": "work_item.create_single",
                    "payload": dependency["commands"][0]["payload"],
                },
            )
            for case in cases:
                dependent = operation_for(owner.id)
                dependent["operation_id"] = case["operation_id"]
                dependent["device_id"] = case["device_id"]
                dependent["dependencies"] = [dependency["operation_id"]]
                dependent["commands"][0]["action"] = case["action"]
                dependent["commands"][0]["payload"] = case["payload"]
                dependent["edit_time"]["physical_ms"] = dependency["edit_time"]["physical_ms"]
                dependent["edit_time"]["logical"] = dependency["edit_time"]["logical"]
                dependent["edit_time"]["raw_wall_ms"] = dependency["edit_time"]["raw_wall_ms"]

                with pytest.raises(SyncOperationError) as causality:
                    await record_operation(database, owner.id, validate_operation(dependent), now=TEST_NOW)
                assert causality.value.code == "invalid_causality", case["name"]

            async with database.sessions() as session:
                state = await session.get(OwnerSyncState, owner.id)
                assert state is not None and state.head_cursor == 1
                assert await session.scalar(select(func.count()).select_from(RecordedOperation)) == 1
        finally:
            await database.engine.dispose()

    asyncio.run(run())
