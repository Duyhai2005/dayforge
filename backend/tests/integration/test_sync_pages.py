import asyncio
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest

from app.core.database import create_database
from app.core.errors import ProblemHTTPException
from app.models.sync import ChangeLog, OperationReceipt, OwnerSyncState, RecordedOperation
from app.services.sync import read_owner_sync_head, read_sync_page, record_operation
from app.services.sync_tokens import verify_page_token
from app.services.sync_wire import canonical_json, validate_operation

pytestmark = pytest.mark.mysql
BACKEND = Path(__file__).resolve().parents[2]
EXAMPLES = BACKEND.parent / "docs" / "tasks" / "t03" / "contract-examples.json"
TOKEN_KEY = bytes(range(32))
INSTANT = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)


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


def operation_for(owner_id, *, sequence=1):
    document = json.loads(EXAMPLES.read_text(encoding="utf-8"))
    operation = next(
        fixture["value"] for fixture in document["fixtures"] if fixture["name"] == "work-item-create-operation"
    )
    operation["owner_id"] = str(owner_id)
    operation["operation_id"] = str(uuid4())
    operation["device_sequence"] = str(sequence)
    return operation


def test_bootstrap_keeps_fixed_prefix_when_new_event_commits_during_pagination(migrated, user_factory):
    async def run():
        database = create_database(migrated)
        owner = user_factory()
        epoch = uuid4()
        try:
            events = []
            receipts = []
            changes = []
            for cursor in range(1, 402):
                validated = validate_operation(operation_for(owner.id, sequence=cursor))
                events.append(
                    RecordedOperation(
                        owner_id=owner.id,
                        operation_id=validated.operation_id,
                        epoch=epoch,
                        commit_cursor=cursor,
                        request_hash=validated.request_hash,
                        envelope=validated.canonical_envelope,
                        protocol_version=1,
                        reducer_version=1,
                        device_id=validated.device_id,
                        device_sequence=cursor,
                        physical_ms=validated.physical_ms,
                        logical_clock=validated.logical,
                        delete_rank=validated.delete_rank,
                        committed_at=INSTANT,
                    )
                )
                receipts.append(
                    OperationReceipt(
                        owner_id=owner.id,
                        operation_id=validated.operation_id,
                        epoch=epoch,
                        request_hash=validated.request_hash,
                        recorded=True,
                        commit_cursor=cursor,
                        effect_at_commit="applied",
                        reason_at_commit=None,
                    )
                )
                changes.append(ChangeLog(owner_id=owner.id, epoch=epoch, cursor=cursor, committed_at=INSTANT))

            async with database.sessions() as session:
                async with session.begin():
                    session.add(owner)
                    session.add(
                        OwnerSyncState(
                            owner_id=owner.id,
                            epoch=epoch,
                            head_cursor=401,
                            created_at=INSTANT,
                            updated_at=INSTANT,
                        )
                    )
                    session.add_all(events)
                    session.add_all(receipts)
                    session.add_all(changes)

            first = await read_sync_page(
                database,
                owner.id,
                endpoint="bootstrap",
                token_key=TOKEN_KEY,
                now=INSTANT,
            )
            assert first.through_cursor == "401"
            assert first.next_cursor == "200"
            assert len(first.groups) == 200
            assert first.has_more is True
            assert first.next_page_token is not None

            later = operation_for(owner.id, sequence=202)
            await record_operation(database, owner.id, validate_operation(later), now=INSTANT)
            continuation = verify_page_token(
                TOKEN_KEY,
                first.next_page_token,
                endpoint="bootstrap",
                owner_id=owner.id,
                now=int(INSTANT.timestamp()) + 60,
            )
            second = await read_sync_page(
                database,
                owner.id,
                endpoint="bootstrap",
                token_key=TOKEN_KEY,
                page_token=continuation,
                now=INSTANT + timedelta(seconds=60),
            )

            assert second.through_cursor == "401"
            assert second.next_cursor == "400"
            assert len(second.groups) == 200
            assert second.has_more is True
            assert second.next_page_token is not None
            next_continuation = verify_page_token(
                TOKEN_KEY,
                second.next_page_token,
                endpoint="bootstrap",
                owner_id=owner.id,
                now=int(INSTANT.timestamp()) + 120,
            )
            assert next_continuation.expires_at == continuation.expires_at

            last = await read_sync_page(
                database,
                owner.id,
                endpoint="bootstrap",
                token_key=TOKEN_KEY,
                page_token=next_continuation,
                now=INSTANT + timedelta(seconds=120),
            )
            assert last.through_cursor == "401"
            assert last.next_cursor == "401"
            assert [group.cursor for group in last.groups] == ["401"]
            assert last.has_more is False
            assert last.next_page_token is None
        finally:
            await database.engine.dispose()

    asyncio.run(run())


def test_page_byte_cap_stops_before_splitting_a_large_event(migrated, user_factory):
    async def run():
        database = create_database(migrated)
        owner = user_factory()
        epoch = uuid4()
        padding = "x" * 2_096_000
        try:
            events = []
            changes = []
            for cursor in range(1, 6):
                operation_id = uuid4()
                device_id = uuid4()
                envelope = canonical_json(
                    {
                        "protocol_version": 1,
                        "reducer_version": 1,
                        "operation_id": str(operation_id),
                        "owner_id": str(owner.id),
                        "device_id": str(device_id),
                        "device_sequence": str(cursor),
                        "edit_time": {
                            "physical_ms": 1,
                            "logical": 0,
                            "calibration_id": str(uuid4()),
                            "raw_wall_ms": 1,
                            "quality": "offline_estimate",
                        },
                        "dependencies": [],
                        "commands": [{"action": "work_item.create", "padding": padding}],
                    }
                )
                assert len(envelope) < 2_097_152
                events.append(
                    RecordedOperation(
                        owner_id=owner.id,
                        operation_id=operation_id,
                        epoch=epoch,
                        commit_cursor=cursor,
                        request_hash=bytes([cursor]) * 32,
                        envelope=envelope,
                        protocol_version=1,
                        reducer_version=1,
                        device_id=device_id,
                        device_sequence=cursor,
                        physical_ms=1,
                        logical_clock=0,
                        delete_rank=0,
                        committed_at=INSTANT,
                    )
                )
                changes.append(ChangeLog(owner_id=owner.id, epoch=epoch, cursor=cursor, committed_at=INSTANT))

            async with database.sessions() as session:
                async with session.begin():
                    session.add(owner)
                    session.add(
                        OwnerSyncState(
                            owner_id=owner.id,
                            epoch=epoch,
                            head_cursor=5,
                            created_at=INSTANT,
                            updated_at=INSTANT,
                        )
                    )
                    session.add_all(events)
                    session.add_all(changes)

            page = await read_sync_page(
                database,
                owner.id,
                endpoint="bootstrap",
                token_key=TOKEN_KEY,
                now=INSTANT,
            )
            body = json.dumps(page.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            assert len(page.groups) < 5
            assert page.has_more is True
            assert page.next_cursor == page.groups[-1].cursor
            assert len(body) <= 8_388_608
        finally:
            del padding
            await database.engine.dispose()

    asyncio.run(run())


def test_pull_empty_tail_advances_to_head_and_rejects_wrong_epoch(migrated, user_factory):
    async def run():
        database = create_database(migrated)
        owner = user_factory()
        try:
            async with database.sessions() as session:
                async with session.begin():
                    session.add(owner)

            head = await read_owner_sync_head(database, owner.id)
            page = await read_sync_page(
                database,
                owner.id,
                endpoint="pull",
                token_key=TOKEN_KEY,
                after_cursor=0,
                request_epoch=head.epoch,
                now=INSTANT,
            )
            assert page.through_cursor == "0"
            assert page.next_cursor == "0"
            assert page.groups == []
            assert page.has_more is False

            with pytest.raises(ProblemHTTPException) as mismatch:
                await read_sync_page(
                    database,
                    owner.id,
                    endpoint="pull",
                    token_key=TOKEN_KEY,
                    after_cursor=0,
                    request_epoch=uuid4(),
                    now=INSTANT,
                )
            assert mismatch.value.status_code == 409
            assert mismatch.value.code == "cursor_epoch_mismatch"
        finally:
            await database.engine.dispose()

    asyncio.run(run())
