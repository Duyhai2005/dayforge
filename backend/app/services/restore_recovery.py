"""Prepare a restored owner without losing its acknowledged sync history."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Sequence
from uuid import UUID

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import Database
from app.models.auth import AuthRateLimit, EmailDeliveryJob, EmailToken, Session
from app.models.owner import User
from app.models.sync import ChangeLog, OperationReceipt, OwnerSyncState, RecordedOperation

_MAX_AUTH_VERSION = (1 << 64) - 1


class RestoreRecoveryError(ValueError):
    """Fixed-code restore preparation error without database values."""


@dataclass(frozen=True, slots=True)
class RestoredOwnerResult:
    owner_id: UUID
    previous_epoch: UUID
    epoch: UUID
    preserved_operations: int
    preserved_receipts: int
    preserved_changes: int


@dataclass(frozen=True, slots=True)
class OwnerEpochRotation:
    owner_id: UUID
    previous_epoch: UUID | None
    new_epoch: UUID


def _utc_milliseconds(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise RestoreRecoveryError("restore_clock_invalid")
    instant = value.astimezone(timezone.utc)
    return instant.replace(microsecond=(instant.microsecond // 1000) * 1000)


async def _count(session: AsyncSession, model, *conditions) -> int:
    value = await session.scalar(select(func.count()).select_from(model).where(*conditions))
    return int(value or 0)


async def prepare_restored_owner(
    session: AsyncSession,
    owner_id: UUID,
    *,
    now: datetime,
    new_epoch: UUID,
    previous_epoch: UUID | None = None,
) -> RestoredOwnerResult:
    """Re-epoch the current immutable log and invalidate restored credentials.

    The caller owns the surrounding transaction. This function does not commit.
    """
    if not isinstance(owner_id, UUID) or not isinstance(new_epoch, UUID):
        raise RestoreRecoveryError("restore_identity_invalid")
    instant = _utc_milliseconds(now)
    if previous_epoch is not None and previous_epoch == new_epoch:
        raise RestoreRecoveryError("restore_epoch_invalid")
    user = (await session.execute(select(User).where(User.id == owner_id).with_for_update())).scalar_one_or_none()
    if user is None:
        raise RestoreRecoveryError("restore_owner_missing")
    state = (
        await session.execute(select(OwnerSyncState).where(OwnerSyncState.owner_id == owner_id).with_for_update())
    ).scalar_one_or_none()

    if state is not None and state.epoch == new_epoch:
        active_sessions = await _count(
            session,
            Session,
            Session.owner_id == owner_id,
            Session.revoked_at.is_(None),
        )
        active_tokens = await _count(
            session,
            EmailToken,
            EmailToken.owner_id == owner_id,
            EmailToken.invalidated_at.is_(None),
        )
        queued_jobs = await _count(session, EmailDeliveryJob)
        if active_sessions or active_tokens or queued_jobs:
            raise RestoreRecoveryError("restore_idempotency_state_mismatch")
        operation_count = await _count(
            session,
            RecordedOperation,
            RecordedOperation.owner_id == owner_id,
            RecordedOperation.epoch == new_epoch,
        )
        receipt_count = await _count(
            session,
            OperationReceipt,
            OperationReceipt.owner_id == owner_id,
            OperationReceipt.epoch == new_epoch,
        )
        change_count = await _count(
            session,
            ChangeLog,
            ChangeLog.owner_id == owner_id,
            ChangeLog.epoch == new_epoch,
        )
        max_cursor = await session.scalar(
            select(func.max(RecordedOperation.commit_cursor)).where(
                RecordedOperation.owner_id == owner_id,
                RecordedOperation.epoch == new_epoch,
            )
        )
        if (
            operation_count != receipt_count
            or operation_count != change_count
            or (max_cursor or 0) != state.head_cursor
            or operation_count != state.head_cursor
        ):
            raise RestoreRecoveryError("restore_idempotency_history_mismatch")
        previous_for_result = previous_epoch or new_epoch
        return RestoredOwnerResult(
            owner_id=owner_id,
            previous_epoch=previous_for_result,
            epoch=new_epoch,
            preserved_operations=operation_count,
            preserved_receipts=receipt_count,
            preserved_changes=change_count,
        )

    if state is not None:
        if previous_epoch is None or state.epoch != previous_epoch:
            raise RestoreRecoveryError("restore_epoch_precondition_failed")
    elif previous_epoch is not None:
        raise RestoreRecoveryError("restore_epoch_precondition_failed")
    if await _count(
        session,
        RecordedOperation,
        RecordedOperation.owner_id == owner_id,
        RecordedOperation.epoch == new_epoch,
    ):
        raise RestoreRecoveryError("restore_new_epoch_not_empty")

    if state is None:
        previous_for_result = new_epoch
        state = OwnerSyncState(
            owner_id=owner_id,
            epoch=new_epoch,
            head_cursor=0,
            created_at=instant,
            updated_at=instant,
        )
        session.add(state)
        await session.flush()
        operations = []
        receipts = []
        changes = []
    else:
        previous_for_result = state.epoch
        operations = list(
            (
                await session.scalars(
                    select(RecordedOperation)
                    .where(
                        RecordedOperation.owner_id == owner_id,
                        RecordedOperation.epoch == state.epoch,
                    )
                    .order_by(RecordedOperation.commit_cursor)
                    .with_for_update()
                )
            ).all()
        )
        receipts = list(
            (
                await session.scalars(
                    select(OperationReceipt)
                    .where(
                        OperationReceipt.owner_id == owner_id,
                        OperationReceipt.epoch == state.epoch,
                    )
                    .order_by(OperationReceipt.commit_cursor)
                    .with_for_update()
                )
            ).all()
        )
        changes = list(
            (
                await session.scalars(
                    select(ChangeLog)
                    .where(
                        ChangeLog.owner_id == owner_id,
                        ChangeLog.epoch == state.epoch,
                    )
                    .order_by(ChangeLog.cursor)
                    .with_for_update()
                )
            ).all()
        )
        if (
            len(operations) != len(receipts)
            or len(operations) != len(changes)
            or len(operations) != state.head_cursor
            or (operations and operations[-1].commit_cursor != state.head_cursor)
        ):
            raise RestoreRecoveryError("restore_sync_log_inconsistent")
        receipt_values = [
            {
                "owner_id": row.owner_id,
                "operation_id": row.operation_id,
                "epoch": new_epoch,
                "request_hash": row.request_hash,
                "recorded": row.recorded,
                "commit_cursor": row.commit_cursor,
                "effect_at_commit": row.effect_at_commit,
                "reason_at_commit": row.reason_at_commit,
            }
            for row in receipts
        ]
        change_values = [
            {
                "owner_id": row.owner_id,
                "epoch": new_epoch,
                "cursor": row.cursor,
                "committed_at": row.committed_at,
            }
            for row in changes
        ]
        await session.execute(
            delete(ChangeLog).where(
                ChangeLog.owner_id == owner_id,
                ChangeLog.epoch == previous_for_result,
            )
        )
        await session.execute(
            delete(OperationReceipt).where(
                OperationReceipt.owner_id == owner_id,
                OperationReceipt.epoch == previous_for_result,
            )
        )
        for row in operations:
            row.epoch = new_epoch
        await session.flush()
        session.add_all(OperationReceipt(**value) for value in receipt_values)
        session.add_all(ChangeLog(**value) for value in change_values)

    if user.auth_version >= _MAX_AUTH_VERSION:
        raise RestoreRecoveryError("restore_auth_version_exhausted")
    user.auth_version += 1
    user.updated_at = instant
    state.epoch = new_epoch
    state.updated_at = instant
    await session.execute(
        update(Session).where(Session.owner_id == owner_id, Session.revoked_at.is_(None)).values(revoked_at=instant)
    )
    await session.execute(
        update(EmailToken)
        .where(EmailToken.owner_id == owner_id, EmailToken.invalidated_at.is_(None))
        .values(invalidated_at=instant)
    )
    # This is a single-owner service: no source mail may be replayed on restore.
    await session.execute(delete(EmailDeliveryJob))
    await session.execute(delete(AuthRateLimit))
    await session.flush()
    return RestoredOwnerResult(
        owner_id=owner_id,
        previous_epoch=previous_for_result,
        epoch=new_epoch,
        preserved_operations=len(operations),
        preserved_receipts=len(receipts),
        preserved_changes=len(changes),
    )


async def prepare_restored_database(
    database: Database,
    *,
    now: datetime,
    rotations: Sequence[OwnerEpochRotation],
) -> list[RestoredOwnerResult]:
    """Rotate every selected owner in one database transaction."""
    instant = _utc_milliseconds(now)
    items = tuple(rotations)
    if not items or len({item.owner_id for item in items}) != len(items):
        raise RestoreRecoveryError("restore_rotation_set_invalid")
    if len({item.new_epoch for item in items}) != len(items):
        raise RestoreRecoveryError("restore_epoch_collision")
    async with database.sessions() as session:
        async with session.begin():
            results = [
                await prepare_restored_owner(
                    session,
                    item.owner_id,
                    now=instant,
                    new_epoch=item.new_epoch,
                    previous_epoch=item.previous_epoch,
                )
                for item in items
            ]
            return results
