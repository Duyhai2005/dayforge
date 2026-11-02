"""Owner-scoped sync state and transactional cursor services."""

from __future__ import annotations

import hmac
import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING
from uuid import UUID, uuid4

from sqlalchemy import and_, func, select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ProblemHTTPException
from app.core.values import format_utc_timestamp
from app.models.owner import User
from app.models.sync import ChangeLog, OperationReceipt, OwnerSyncState, RecordedOperation
from app.schemas.sync import SyncPage, SyncPageGroup
from app.services.sync_clock import SERVER_CLOCK_MONITOR, validate_operation_time
from app.services.sync_tokens import PageToken, create_page_token
from app.services.sync_wire import ValidatedOperation

if TYPE_CHECKING:
    from app.core.database import Database

_SYNC_WRITE_FAILPOINT: Callable[[str], None] | None = None


def _sync_write_failpoint(stage: str) -> None:
    """Private no-op hook that lets MySQL tests inject transactional failures."""
    if _SYNC_WRITE_FAILPOINT is not None:
        _SYNC_WRITE_FAILPOINT(stage)


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


@dataclass(frozen=True)
class _PageCandidate:
    cursor: int
    committed_at: datetime
    envelope_bytes: int


def _utc_now() -> datetime:
    value = datetime.now(timezone.utc)
    return value.replace(microsecond=(value.microsecond // 1000) * 1000)


def unix_milliseconds(value: datetime) -> int:
    utc_value = value.astimezone(timezone.utc)
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    delta = utc_value - epoch
    return delta.days * 86_400_000 + delta.seconds * 1_000 + delta.microseconds // 1_000


def _group_json_overhead(cursor: int, committed_at: str) -> int:
    prefix = (
        b'{"cursor":'
        + json.dumps(str(cursor), separators=(",", ":")).encode("ascii")
        + b',"committed_at":'
        + json.dumps(committed_at, separators=(",", ":")).encode("ascii")
        + b',"operation":'
    )
    return len(prefix) + 1


async def read_sync_page(
    database: Database,
    owner_id: UUID,
    *,
    endpoint: str,
    token_key: bytes,
    after_cursor: int | None = None,
    request_epoch: UUID | None = None,
    page_token: PageToken | None = None,
    now: datetime | None = None,
) -> SyncPage:
    """Read one immutable owner prefix page without holding the head lock while serializing."""
    instant = _utc_now() if now is None else now.astimezone(timezone.utc).replace(microsecond=0)
    now_seconds = int(instant.timestamp())
    if endpoint not in ("bootstrap", "pull"):
        raise ProblemHTTPException(status_code=400, code="malformed_request")

    head = await read_owner_sync_head(database, owner_id)
    if page_token is None:
        if endpoint == "bootstrap":
            if after_cursor is not None or request_epoch is not None:
                raise ProblemHTTPException(status_code=400, code="malformed_request")
            start_cursor = 0
        else:
            if after_cursor is None or request_epoch is None:
                raise ProblemHTTPException(status_code=400, code="malformed_request")
            if request_epoch != head.epoch:
                raise ProblemHTTPException(status_code=409, code="cursor_epoch_mismatch")
            if not 0 <= after_cursor <= head.head_cursor:
                raise ProblemHTTPException(status_code=400, code="malformed_request")
            start_cursor = after_cursor
        epoch = head.epoch
        through_cursor = head.head_cursor
        position = start_cursor
        expires_at = now_seconds + 1800
    else:
        if page_token.endpoint != endpoint or page_token.owner_id != owner_id or page_token.epoch != head.epoch:
            raise ProblemHTTPException(status_code=409, code="cursor_epoch_mismatch")
        epoch = page_token.epoch
        start_cursor = page_token.after_cursor
        through_cursor = page_token.through_cursor
        position = page_token.position
        expires_at = page_token.expires_at
        if through_cursor > head.head_cursor:
            raise ProblemHTTPException(status_code=409, code="cursor_epoch_mismatch")

    try:
        async with database.sessions() as session:
            candidates_result = await session.execute(
                select(
                    ChangeLog.cursor,
                    ChangeLog.committed_at,
                    func.length(RecordedOperation.envelope),
                )
                .select_from(ChangeLog)
                .join(
                    RecordedOperation,
                    and_(
                        RecordedOperation.owner_id == ChangeLog.owner_id,
                        RecordedOperation.epoch == ChangeLog.epoch,
                        RecordedOperation.commit_cursor == ChangeLog.cursor,
                    ),
                )
                .where(
                    ChangeLog.owner_id == owner_id,
                    ChangeLog.epoch == epoch,
                    ChangeLog.cursor > position,
                    ChangeLog.cursor <= through_cursor,
                )
                .order_by(ChangeLog.cursor)
                .limit(201)
            )
            candidates = [
                _PageCandidate(cursor=cursor, committed_at=committed_at, envelope_bytes=envelope_bytes)
                for cursor, committed_at, envelope_bytes in candidates_result.all()
            ]

            selected: list[_PageCandidate] = []
            estimated_page_bytes = 4096
            for candidate in candidates:
                if len(selected) >= 200:
                    break
                committed_at_text = format_utc_timestamp(candidate.committed_at)
                group_size = _group_json_overhead(candidate.cursor, committed_at_text) + candidate.envelope_bytes
                group_size += 1 if selected else 0
                if estimated_page_bytes + group_size > 8_388_608:
                    break
                selected.append(candidate)
                estimated_page_bytes += group_size

            if candidates and not selected:
                raise ProblemHTTPException(status_code=503, code="service_unavailable")

            envelopes_by_cursor: dict[int, tuple[datetime, dict]] = {}
            if selected:
                selected_cursors = [candidate.cursor for candidate in selected]
                operation_result = await session.execute(
                    select(
                        ChangeLog.cursor,
                        ChangeLog.committed_at,
                        RecordedOperation.envelope,
                    )
                    .select_from(ChangeLog)
                    .join(
                        RecordedOperation,
                        and_(
                            RecordedOperation.owner_id == ChangeLog.owner_id,
                            RecordedOperation.epoch == ChangeLog.epoch,
                            RecordedOperation.commit_cursor == ChangeLog.cursor,
                        ),
                    )
                    .where(
                        ChangeLog.owner_id == owner_id,
                        ChangeLog.epoch == epoch,
                        ChangeLog.cursor.in_(selected_cursors),
                    )
                )
                for cursor, committed_at, envelope in operation_result.all():
                    envelopes_by_cursor[cursor] = (committed_at, json.loads(bytes(envelope)))
    except SQLAlchemyError:
        raise ProblemHTTPException(status_code=503, code="service_unavailable") from None

    has_more = len(selected) < len(candidates)
    groups = [
        SyncPageGroup.model_validate(
            {
                "cursor": str(candidate.cursor),
                "committed_at": format_utc_timestamp(envelopes_by_cursor[candidate.cursor][0]),
                "operation": envelopes_by_cursor[candidate.cursor][1],
            }
        )
        for candidate in selected
    ]
    if has_more:
        next_cursor = selected[-1].cursor
        next_page_token = create_page_token(
            token_key,
            endpoint=endpoint,
            owner_id=owner_id,
            epoch=epoch,
            after_cursor=start_cursor,
            through_cursor=through_cursor,
            position=next_cursor,
            now=now_seconds,
            expires_at=expires_at,
        )
    else:
        next_cursor = through_cursor
        next_page_token = None

    return SyncPage(
        epoch=str(epoch),
        through_cursor=str(through_cursor),
        next_cursor=str(next_cursor),
        has_more=has_more,
        next_page_token=next_page_token,
        groups=groups,
    )


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
                    dependency_hlc = (dependency.physical_ms, dependency.logical_clock)
                    operation_hlc = (operation.physical_ms, operation.logical)
                    if dependency_hlc >= operation_hlc:
                        raise SyncOperationError("invalid_causality", 422)

                if now is None:
                    # Sample wall time after the owner lock and dependency reads. Sampling before
                    # waiting for this transaction can make concurrent writes report stale or
                    # out-of-order wall times to the process-wide monitor.
                    instant = _utc_now()
                    if not SERVER_CLOCK_MONITOR.observe(wall_ms=unix_milliseconds(instant)):
                        raise ProblemHTTPException(status_code=503, code="clock_unhealthy")

                owner = await session.get(User, owner_id)
                if owner is None:
                    raise ProblemHTTPException(status_code=503, code="service_unavailable")
                clock_error = validate_operation_time(
                    operation,
                    account_created_ms=unix_milliseconds(owner.created_at),
                    server_now_ms=unix_milliseconds(instant),
                )
                if clock_error is not None:
                    raise SyncOperationError(clock_error, 422)

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
                _sync_write_failpoint("after_event_flush")
                receipt = OperationReceipt(
                    owner_id=owner_id,
                    operation_id=operation.operation_id,
                    epoch=state.epoch,
                    request_hash=operation.request_hash,
                    recorded=True,
                    commit_cursor=cursor,
                    effect_at_commit="not_evaluated",
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
                _sync_write_failpoint("before_commit")
                return OperationWriteResult(
                    status="recorded",
                    epoch=state.epoch,
                    head_cursor=cursor,
                    receipt=ReceiptData(
                        operation_id=operation.operation_id,
                        request_hash=operation.request_hash,
                        commit_cursor=cursor,
                        effect_at_commit="not_evaluated",
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
