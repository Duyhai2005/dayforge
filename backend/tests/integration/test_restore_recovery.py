import asyncio
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from app.core.database import create_database
from app.models.auth import (
    AuthRateLimit,
    EmailDeliveryJob,
    EmailToken,
)
from app.models.auth import Session as AuthSession
from app.models.owner import User
from app.models.sync import ChangeLog, OperationReceipt, OwnerSyncState, RecordedOperation
from app.services.restore_recovery import prepare_restored_owner
from app.services.sync import read_sync_page, record_operation
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


def operation_for(owner_id, *, physical_ms, operation_id=None):
    document = json.loads(EXAMPLES.read_text(encoding="utf-8"))
    operation = next(
        fixture["value"] for fixture in document["fixtures"] if fixture["name"] == "work-item-create-operation"
    )
    operation["owner_id"] = str(owner_id)
    operation["operation_id"] = str(operation_id or uuid4())
    operation["edit_time"]["physical_ms"] = physical_ms
    operation["edit_time"]["raw_wall_ms"] = physical_ms
    return operation


async def _seed_owner_and_history(database, user_factory):
    owner = user_factory()
    async with database.sessions() as session:
        async with session.begin():
            session.add(owner)
    first = operation_for(owner.id, physical_ms=int(TEST_NOW.timestamp() * 1000))
    second = operation_for(
        owner.id,
        physical_ms=int(TEST_NOW.timestamp() * 1000) + 1,
        operation_id=uuid4(),
    )
    await record_operation(database, owner.id, validate_operation(first), now=TEST_NOW)
    await record_operation(database, owner.id, validate_operation(second), now=TEST_NOW)
    async with database.sessions() as session:
        async with session.begin():
            session.add(
                AuthSession(
                    id=uuid4(),
                    kind="authenticated",
                    token_hash=b"s" * 32,
                    owner_id=owner.id,
                    csrf_token=b"c" * 32,
                    auth_version=owner.auth_version,
                    password_authenticated_at=TEST_NOW - timedelta(minutes=1),
                    remember_me=True,
                    created_at=TEST_NOW - timedelta(minutes=2),
                    last_activity_at=TEST_NOW - timedelta(minutes=1),
                    idle_expires_at=TEST_NOW + timedelta(minutes=30),
                    absolute_expires_at=TEST_NOW + timedelta(hours=12),
                    revoked_at=None,
                )
            )
            session.add(
                EmailToken(
                    id=uuid4(),
                    purpose="password_reset",
                    token_hash=b"t" * 32,
                    email_canonical=owner.email_canonical,
                    owner_id=owner.id,
                    created_at=TEST_NOW,
                    expires_at=TEST_NOW + timedelta(hours=1),
                    consumed_at=None,
                    invalidated_at=None,
                )
            )
            session.add(
                EmailDeliveryJob(
                    id=uuid4(),
                    payload_ciphertext=b"ciphertext",
                    outbox_key_version=1,
                    created_at=TEST_NOW,
                    available_at=TEST_NOW,
                    expires_at=TEST_NOW + timedelta(hours=1),
                    attempt_count=0,
                    sent_at=None,
                    last_error_code=None,
                    claim_token=None,
                    claim_expires_at=None,
                )
            )
            session.add(
                AuthRateLimit(
                    action="login",
                    subject_kind="owner",
                    subject_digest=b"r" * 32,
                    window_seconds=60,
                    request_count=1,
                    event_timestamps=[int(TEST_NOW.timestamp())],
                    updated_at=TEST_NOW,
                    expires_at=TEST_NOW + timedelta(minutes=1),
                )
            )
    return owner, first, second


async def _history_snapshot(database, owner_id):
    async with database.sessions() as session:
        state = await session.get(OwnerSyncState, owner_id)
        operations = list(
            (
                await session.scalars(
                    select(RecordedOperation)
                    .where(RecordedOperation.owner_id == owner_id)
                    .order_by(RecordedOperation.operation_id)
                )
            ).all()
        )
        receipts = list(
            (
                await session.scalars(
                    select(OperationReceipt)
                    .where(OperationReceipt.owner_id == owner_id)
                    .order_by(OperationReceipt.operation_id)
                )
            ).all()
        )
        changes = list(
            (
                await session.scalars(
                    select(ChangeLog).where(ChangeLog.owner_id == owner_id).order_by(ChangeLog.cursor)
                )
            ).all()
        )
        return {
            "epoch": state.epoch,
            "head_cursor": state.head_cursor,
            "operations": [
                (
                    row.operation_id,
                    row.epoch,
                    row.commit_cursor,
                    row.request_hash,
                    row.envelope,
                    row.protocol_version,
                    row.reducer_version,
                    row.device_id,
                    row.device_sequence,
                    row.physical_ms,
                    row.logical_clock,
                    row.delete_rank,
                    row.committed_at,
                )
                for row in operations
            ],
            "receipts": [
                (
                    row.operation_id,
                    row.epoch,
                    row.request_hash,
                    row.recorded,
                    row.commit_cursor,
                    row.effect_at_commit,
                    row.reason_at_commit,
                )
                for row in receipts
            ],
            "changes": [(row.epoch, row.cursor, row.committed_at) for row in changes],
        }


def test_epoch_rotation_preserves_events_and_invalidates_restored_auth(migrated, user_factory):
    async def run():
        database = create_database(migrated)
        owner, first, _second = await _seed_owner_and_history(database, user_factory)
        before = await _history_snapshot(database, owner.id)
        new_epoch = uuid4()
        try:
            async with database.sessions() as session:
                async with session.begin():
                    result = await prepare_restored_owner(
                        session,
                        owner.id,
                        now=TEST_NOW + timedelta(minutes=1),
                        new_epoch=new_epoch,
                        previous_epoch=before["epoch"],
                    )
            after = await _history_snapshot(database, owner.id)
            assert result.preserved_operations == 2
            assert result.preserved_receipts == 2
            assert result.preserved_changes == 2
            assert after["epoch"] == new_epoch
            assert after["head_cursor"] == before["head_cursor"]
            assert [row[0] for row in after["operations"]] == [row[0] for row in before["operations"]]
            assert [row[2:] for row in after["operations"]] == [row[2:] for row in before["operations"]]
            assert all(row[1] == new_epoch for row in after["operations"])
            assert [row[0] for row in after["receipts"]] == [row[0] for row in before["receipts"]]
            assert [row[2:] for row in after["receipts"]] == [row[2:] for row in before["receipts"]]
            assert all(row[1] == new_epoch for row in after["receipts"])
            assert [(row[1], row[2]) for row in after["changes"]] == [(row[1], row[2]) for row in before["changes"]]
            assert all(row[0] == new_epoch for row in after["changes"])

            async with database.sessions() as session:
                saved_user = await session.get(User, owner.id)
                assert saved_user.auth_version == owner.auth_version + 1
                assert (
                    await session.scalar(
                        select(func.count())
                        .select_from(AuthSession)
                        .where(
                            AuthSession.owner_id == owner.id,
                            AuthSession.revoked_at.is_(None),
                        )
                    )
                    == 0
                )
                assert (
                    await session.scalar(
                        select(func.count())
                        .select_from(EmailToken)
                        .where(
                            EmailToken.owner_id == owner.id,
                            EmailToken.invalidated_at.is_(None),
                        )
                    )
                    == 0
                )
                assert await session.scalar(select(func.count()).select_from(EmailDeliveryJob)) == 0
                assert await session.scalar(select(func.count()).select_from(AuthRateLimit)) == 0

            duplicate = await record_operation(
                database, owner.id, validate_operation(first), now=TEST_NOW + timedelta(minutes=2)
            )
            assert duplicate.status == "duplicate"
            assert (
                duplicate.receipt.request_hash == before["operations"][0][3]
                or duplicate.receipt.request_hash == before["operations"][1][3]
            )
            with pytest.raises(HTTPException) as mismatch:
                await read_sync_page(
                    database,
                    owner.id,
                    endpoint="pull",
                    token_key=b"p" * 32,
                    after_cursor=0,
                    request_epoch=before["epoch"],
                    now=TEST_NOW + timedelta(minutes=2),
                )
            assert mismatch.value.status_code == 409
            assert mismatch.value.code == "cursor_epoch_mismatch"

            async with database.sessions() as session:
                async with session.begin():
                    retry = await prepare_restored_owner(
                        session,
                        owner.id,
                        now=TEST_NOW + timedelta(minutes=3),
                        new_epoch=new_epoch,
                        previous_epoch=before["epoch"],
                    )
            assert retry.epoch == new_epoch
            async with database.sessions() as session:
                saved_user = await session.get(User, owner.id)
                assert saved_user.auth_version == owner.auth_version + 1
        finally:
            await database.engine.dispose()

    asyncio.run(run())


def test_recovery_transaction_rolls_back_all_rows_when_caller_aborts(migrated, user_factory):
    class InjectedAbort(RuntimeError):
        pass

    async def run():
        database = create_database(migrated)
        owner, _first, _second = await _seed_owner_and_history(database, user_factory)
        before = await _history_snapshot(database, owner.id)
        new_epoch = uuid4()
        try:
            with pytest.raises(InjectedAbort):
                async with database.sessions() as session:
                    async with session.begin():
                        await prepare_restored_owner(
                            session,
                            owner.id,
                            now=TEST_NOW + timedelta(minutes=1),
                            new_epoch=new_epoch,
                            previous_epoch=before["epoch"],
                        )
                        raise InjectedAbort()
            after = await _history_snapshot(database, owner.id)
            assert after == before
            async with database.sessions() as session:
                saved_user = await session.get(User, owner.id)
                assert saved_user.auth_version == owner.auth_version
                assert await session.scalar(select(func.count()).select_from(EmailDeliveryJob)) == 1
                assert (
                    await session.scalar(
                        select(func.count()).select_from(AuthSession).where(AuthSession.revoked_at.is_(None))
                    )
                    == 1
                )
        finally:
            await database.engine.dispose()

    asyncio.run(run())


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
