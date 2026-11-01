"""Owner-scoped sync state and transactional cursor services."""

from __future__ import annotations

import hmac
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ProblemHTTPException
from app.models.sync import ChangeLog, OperationReceipt, OwnerSyncState, RecordedOperation
from app.services.sync_wire import ValidatedOperation

if TYPE_CHECKING:
    from app.core.database import Database


class SyncOperationError(ValueError):
    """A safe rejection scoped to one operation in a push batch."""

    def __init__(self, code: str, status_code: int, *, deferred: bool = False):
        super().__init__(code)
        self.code = code
        self.status_code = status_code
        self.deferred = deferred


@dataclass(frozen=True)
class ReceiptData:
    operation_id: UUID
    request_hash: bytes
    commit_cursor: int
    effect_at_commit: str
    reason_at_commit: str | None

    def to_wire(self) -> dict[str, object]:
        return {
            "operation_id": str(self.operation_id),
            "request_hash": self.request_hash.hex(),
            "recorded": True,
            "commit_cursor": str(self.commit_cursor),
            "effect_at_commit": self.effect_at_commit,
            "reason_at_commit": self.reason_at_commit,
        }


@dataclass(frozen=True)
class OperationWriteResult:
    status: str
    epoch: UUID
    head_cursor: int
    receipt: ReceiptData


@dataclass(frozen=True)
class OwnerSyncHead:
    epoch: UUID
    head_cursor: int


def _utc_now() -> datetime:
    value = datetime.now(timezone.utc)
    return value.replace(microsecond=(value.microsecond // 1000) * 1000)


def unix_milliseconds(value: datetime) -> int:
    utc_value = value.astimezone(timezone.utc)
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    delta = utc_value - epoch
    return delta.days * 86_400_000 + delta.seconds * 1_000 + delta.microseconds // 1_000


async def ensure_owner_sync_state(
    session: AsyncSession,
    owner_id: UUID,
    *,
    now: datetime | None = None,
) -> OwnerSyncState:
    """Create one epoch row if needed and lock it for the caller transaction."""
    instant = (
        _utc_now()
        if now is None
        else now.astimezone(timezone.utc).replace(microsecond=(now.microsecond // 1000) * 1000)
    )
    insert = mysql_insert(OwnerSyncState).values(
        owner_id=owner_id,
        epoch=uuid4(),
        head_cursor=0,
        created_at=instant,
        updated_at=instant,
    )
    await session.execute(insert.on_duplicate_key_update(owner_id=insert.inserted.owner_id))
    state = (
        await session.execute(select(OwnerSyncState).where(OwnerSyncState.owner_id == owner_id).with_for_update())
    ).scalar_one()
    return state


def _operation_order(operation: ValidatedOperation) -> tuple[int, int, int, bytes, bytes]:
    return (
        operation.physical_ms,
        operation.logical,
        operation.delete_rank,
        operation.device_id.bytes,
        operation.operation_id.bytes,
    )


def _recorded_order(operation: RecordedOperation) -> tuple[int, int, int, bytes, bytes]:
    return (
        operation.physical_ms,
        operation.logical_clock,
        operation.delete_rank,
        operation.device_id.bytes,
        operation.operation_id.bytes,
    )


def _receipt_data(receipt: OperationReceipt) -> ReceiptData:
    return ReceiptData(
        operation_id=receipt.operation_id,
        request_hash=receipt.request_hash,
        commit_cursor=receipt.commit_cursor,
        effect_at_commit=receipt.effect_at_commit,
        reason_at_commit=receipt.reason_at_commit,
    )


async def record_operation(
    database: Database,
    owner_id: UUID,
    operation: ValidatedOperation,
    *,
    now: datetime | None = None,
) -> OperationWriteResult:
    """Atomically append one immutable operation and allocate one owner cursor."""
    if operation.owner_id != owner_id:
        raise SyncOperationError("owner_mismatch", 403)
    instant = (
        _utc_now()
        if now is None
        else now.astimezone(timezone.utc).replace(microsecond=(now.microsecond // 1000) * 1000)
    )
    try:
        async with database.sessions() as session:
            async with session.begin():
                state = await ensure_owner_sync_state(session, owner_id, now=instant)
                previous = await session.get(OperationReceipt, (owner_id, operation.operation_id))
                if previous is not None:
                    if not hmac.compare_digest(previous.request_hash, operation.request_hash):
                        raise SyncOperationError("operation_id_reused", 409)
                    return OperationWriteResult(
                        status="duplicate",
                        epoch=state.epoch,
                        head_cursor=state.head_cursor,
                        receipt=_receipt_data(previous),
                    )

                for dependency_id in operation.dependencies:
                    if dependency_id == operation.operation_id:
                        raise SyncOperationError("invalid_causality", 422)
                    dependency = await session.get(RecordedOperation, (owner_id, dependency_id))
                    if dependency is None:
                        raise SyncOperationError("dependency_missing", 409, deferred=True)
                    if _recorded_order(dependency) >= _operation_order(operation):
                        raise SyncOperationError("invalid_causality", 422)

                if operation.quality == "untrusted":
                    raise SyncOperationError("time_invalid", 422)

                cursor = state.head_cursor + 1
                event = RecordedOperation(
                    owner_id=owner_id,
                    operation_id=operation.operation_id,
                    epoch=state.epoch,
                    commit_cursor=cursor,
                    request_hash=operation.request_hash,
                    envelope=operation.canonical_envelope,
                    protocol_version=1,
                    reducer_version=1,
                    device_id=operation.device_id,
                    device_sequence=operation.device_sequence,
                    physical_ms=operation.physical_ms,
                    logical_clock=operation.logical,
                    delete_rank=operation.delete_rank,
                    committed_at=instant,
                )
                session.add(event)
                await session.flush()
                receipt = OperationReceipt(
                    owner_id=owner_id,
                    operation_id=operation.operation_id,
                    epoch=state.epoch,
                    request_hash=operation.request_hash,
                    recorded=True,
                    commit_cursor=cursor,
                    effect_at_commit="applied",
                    reason_at_commit=None,
                )
                session.add(receipt)
                session.add(
                    ChangeLog(
                        owner_id=owner_id,
                        epoch=state.epoch,
                        cursor=cursor,
                        committed_at=instant,
                    )
                )
                state.head_cursor = cursor
                state.updated_at = instant
                await session.flush()
                return OperationWriteResult(
                    status="recorded",
                    epoch=state.epoch,
                    head_cursor=cursor,
                    receipt=ReceiptData(
                        operation_id=operation.operation_id,
                        request_hash=operation.request_hash,
                        commit_cursor=cursor,
                        effect_at_commit="applied",
                        reason_at_commit=None,
                    ),
                )
    except SyncOperationError:
        raise
    except SQLAlchemyError:
        raise ProblemHTTPException(status_code=503, code="service_unavailable") from None


async def read_owner_sync_head(database: Database, owner_id: UUID) -> OwnerSyncHead:
    try:
        async with database.sessions() as session:
            async with session.begin():
                state = await ensure_owner_sync_state(session, owner_id)
                return OwnerSyncHead(epoch=state.epoch, head_cursor=state.head_cursor)
    except SQLAlchemyError:
        raise ProblemHTTPException(status_code=503, code="service_unavailable") from None
