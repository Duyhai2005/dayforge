import asyncio
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import delete, func, select, text

from app.core.database import create_database
from app.models.owner import User
from app.models.sync import ChangeLog, OperationReceipt, OwnerSyncState, RecordedOperation
from app.services.sync import SyncOperationError, read_owner_sync_head, read_sync_page, record_operation
from app.services.sync_wire import validate_operation

pytestmark = pytest.mark.mysql
BACKEND = Path(__file__).resolve().parents[2]
EXAMPLES = BACKEND.parent / "docs" / "tasks" / "t03" / "contract-examples.json"
TEST_NOW = datetime.now(timezone.utc).replace(microsecond=0)
TOKEN_KEY = bytes(range(32))


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


def operation_for(owner_id, *, operation_id=None, sequence=1):
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


async def add_test_owners(database, owner_a, owner_b):
    async with database.engine.begin() as connection:
        # MySQL 8.4 has no session variable for disabling CHECK constraints. Temporarily
        # remove the owner-slot unique index so the test can create one synthetic second owner.
        await connection.execute(text("ALTER TABLE users DROP INDEX uq_users_owner_slot"))
    async with database.sessions() as session:
        async with session.begin():
            session.add(owner_a)
            session.add(owner_b)
            await session.flush()


async def remove_test_owner_and_restore_slot_index(database, owner_id):
    async with database.sessions() as session:
        async with session.begin():
            await session.execute(delete(ChangeLog).where(ChangeLog.owner_id == owner_id))
            await session.execute(delete(OperationReceipt).where(OperationReceipt.owner_id == owner_id))
            await session.execute(delete(RecordedOperation).where(RecordedOperation.owner_id == owner_id))
            await session.execute(delete(OwnerSyncState).where(OwnerSyncState.owner_id == owner_id))
            await session.execute(delete(User).where(User.id == owner_id))
    async with database.engine.begin() as connection:
        await connection.execute(text("ALTER TABLE users ADD CONSTRAINT uq_users_owner_slot UNIQUE (owner_slot)"))


def test_sync_reads_dependencies_and_operation_ids_are_owner_scoped(migrated, user_factory):
    async def run():
        database = create_database(migrated)
        owner_a = user_factory()
        owner_b = user_factory()
        shared_operation_id = uuid4()
        try:
            await add_test_owners(database, owner_a, owner_b)
            operation_a = validate_operation(operation_for(owner_a.id, operation_id=shared_operation_id))
            result_a = await record_operation(database, owner_a.id, operation_a, now=TEST_NOW)

            hidden_dependency = operation_for(owner_b.id)
            hidden_dependency["dependencies"] = [str(shared_operation_id)]
            with pytest.raises(SyncOperationError) as missing:
                await record_operation(
                    database,
                    owner_b.id,
                    validate_operation(hidden_dependency),
                    now=TEST_NOW,
                )
            assert missing.value.code == "dependency_missing"
            assert missing.value.deferred is True

            operation_b = validate_operation(operation_for(owner_b.id, operation_id=shared_operation_id))
            result_b = await record_operation(database, owner_b.id, operation_b, now=TEST_NOW)
            assert result_a.receipt.commit_cursor == result_b.receipt.commit_cursor == 1
            assert result_a.receipt.request_hash != result_b.receipt.request_hash

            head_a, head_b = await asyncio.gather(
                read_owner_sync_head(database, owner_a.id),
                read_owner_sync_head(database, owner_b.id),
            )
            assert head_a.epoch != head_b.epoch
            assert head_a.head_cursor == head_b.head_cursor == 1

            page_a, page_b = await asyncio.gather(
                read_sync_page(
                    database,
                    owner_a.id,
                    endpoint="bootstrap",
                    token_key=TOKEN_KEY,
                    now=TEST_NOW,
                ),
                read_sync_page(
                    database,
                    owner_b.id,
                    endpoint="bootstrap",
                    token_key=TOKEN_KEY,
                    now=TEST_NOW,
                ),
            )
            assert page_a.groups[0].operation.owner_id == str(owner_a.id)
            assert page_b.groups[0].operation.owner_id == str(owner_b.id)
            assert page_a.groups[0].operation.operation_id == page_b.groups[0].operation.operation_id

            async with database.sessions() as session:
                assert await session.scalar(select(func.count()).select_from(RecordedOperation)) == 2
                assert (
                    await session.scalar(
                        select(func.count())
                        .select_from(RecordedOperation)
                        .where(RecordedOperation.owner_id == owner_a.id)
                    )
                    == 1
                )
                assert (
                    await session.scalar(
                        select(func.count())
                        .select_from(RecordedOperation)
                        .where(RecordedOperation.owner_id == owner_b.id)
                    )
                    == 1
                )
                state_b = await session.get(OwnerSyncState, owner_b.id)
                assert state_b is not None and state_b.head_cursor == 1
        finally:
            await remove_test_owner_and_restore_slot_index(database, owner_b.id)
            await database.engine.dispose()

    asyncio.run(run())
