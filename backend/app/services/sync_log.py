"""Owner-scoped durable operation log and stable-prefix page reads."""

import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ProblemHTTPException
from app.core.values import format_utc_timestamp
from app.models.sync import (
    SyncCalibration,
    SyncOperation,
    SyncOwnerState,
    SyncPageToken,
)
from app.schemas.sync import Operation
from app.services.canonical_json import canonicalize
from app.services.reducer import ReducerValidationError, effect_at_commit

UINT64_MAX = 18_446_744_073_709_551_615
MAX_FUTURE_SKEW_MS = 300_000
PAGE_LIMIT = 200
PAGE_BYTE_LIMIT = 8_388_608
PAGE_TOKEN_TTL_SECONDS = 1800


def now_utc() -> datetime:
    value = datetime.now(timezone.utc)
    return value.replace(microsecond=(value.microsecond // 1000) * 1000)


def timestamp_ms(value: datetime) -> int:
    return int(value.timestamp() * 1000)


async def ensure_owner_state(
    db: AsyncSession, owner_id: UUID, *, lock: bool = False
) -> SyncOwnerState:
    await db.execute(
        mysql_insert(SyncOwnerState)
        .values(owner_id=owner_id, epoch=uuid4(), head_cursor=0)
        .on_duplicate_key_update(owner_id=owner_id)
    )
    query = select(SyncOwnerState).where(SyncOwnerState.owner_id == owner_id)
    if lock:
        query = query.with_for_update()
    result = await db.scalar(query)
    if result is None:
        raise ProblemHTTPException(status_code=503, code="service_unavailable")
    return result


async def issue_calibration(db: AsyncSession, owner_id: UUID, device_id: UUID) -> dict:
    now = now_utc()
    calibration = SyncCalibration(
        id=uuid4(),
        owner_id=owner_id,
        device_id=device_id,
        server_time_ms=timestamp_ms(now),
        created_at=now,
    )
    db.add(calibration)
    await db.commit()
    return {
        "calibration_id": str(calibration.id),
        "server_time_ms": calibration.server_time_ms,
        "server_time": format_utc_timestamp(now),
        "max_future_skew_ms": MAX_FUTURE_SKEW_MS,
    }


def operation_envelope(operation: Operation) -> tuple[str, bytes, int]:
    value = operation.model_dump(mode="json")
    encoded = canonicalize(value).encode("utf-8")
    return encoded.decode("utf-8"), hashlib.sha256(encoded).digest(), len(encoded)


def _problem(code: str, status: int, request_id: UUID, now: datetime) -> dict:
    text = {
        "dependency_missing": (
            "Dependency missing",
            "Record the required operation before retrying.",
        ),
        "operation_id_reused": (
            "Operation identifier reused",
            "This operation identifier was already used for different content.",
        ),
        "time_invalid": (
            "Invalid edit time",
            "The operation edit time cannot be accepted.",
        ),
        "invalid_causality": (
            "Invalid operation dependency",
            "The operation dependency is invalid.",
        ),
        "validation_failed": (
            "Validation failed",
            "The operation does not match reducer version 1.",
        ),
    }
    title, detail = text[code]
    return {
        "type": f"/api/v1/problems/{code}",
        "title": title,
        "status": status,
        "detail": detail,
        "instance": f"/api/v1/requests/{request_id}",
        "code": code,
        "request_id": str(request_id),
        "retryable": status == 503,
        "server_time": format_utc_timestamp(now),
    }


async def _dependency_problem(
    db: AsyncSession,
    operation: Operation,
    owner_id: UUID,
    request_id: UUID,
    now: datetime,
) -> tuple[str, dict] | None:
    if not operation.dependencies:
        return None
    rows = (
        await db.scalars(
            select(SyncOperation).where(
                SyncOperation.owner_id == owner_id,
                SyncOperation.operation_id.in_(
                    [UUID(value) for value in operation.dependencies]
                ),
            )
        )
    ).all()
    found = {row.operation_id: row for row in rows}
    for dependency_text in operation.dependencies:
        dependency = found.get(UUID(dependency_text))
        if dependency is None:
            return "deferred", _problem("dependency_missing", 409, request_id, now)
        dependency_envelope = json.loads(dependency.canonical_envelope)
        dependency_time = dependency_envelope["edit_time"]
        if (dependency_time["physical_ms"], dependency_time["logical"]) >= (
            operation.edit_time.physical_ms,
            operation.edit_time.logical,
        ):
            return "rejected", _problem("invalid_causality", 422, request_id, now)
    return None


async def validate_operation_for_recording(
    db: AsyncSession,
    owner_id: UUID,
    owner_created_at: datetime,
    operation: Operation,
    request_id: UUID,
    now: datetime,
) -> tuple[str, dict] | None:
    if operation.edit_time.quality == "untrusted":
        return "rejected", _problem("time_invalid", 422, request_id, now)
    now_ms = timestamp_ms(now)
    if operation.edit_time.physical_ms > now_ms + MAX_FUTURE_SKEW_MS:
        return "rejected", _problem("time_invalid", 422, request_id, now)
    created_ms = timestamp_ms(owner_created_at)
    if operation.edit_time.physical_ms < created_ms - MAX_FUTURE_SKEW_MS:
        return "rejected", _problem("time_invalid", 422, request_id, now)

    calibration = await db.get(
        SyncCalibration, UUID(operation.edit_time.calibration_id)
    )
    if calibration is not None and (
        calibration.owner_id != owner_id
        or calibration.device_id != UUID(operation.device_id)
    ):
        return "rejected", _problem("invalid_causality", 422, request_id, now)
    return await _dependency_problem(db, operation, owner_id, request_id, now)


async def record_operation(
    db: AsyncSession,
    owner_id: UUID,
    owner_created_at: datetime,
    operation: Operation,
    request_id: UUID,
) -> tuple[dict, int]:
    envelope, request_hash, envelope_bytes = operation_envelope(operation)
    if envelope_bytes > 2_097_152:
        raise ProblemHTTPException(status_code=413, code="payload_too_large")
    if operation.owner_id != str(owner_id):
        raise ProblemHTTPException(status_code=403, code="owner_mismatch")

    state = await ensure_owner_state(db, owner_id, lock=True)
    existing = await db.scalar(
        select(SyncOperation).where(
            SyncOperation.owner_id == owner_id,
            SyncOperation.operation_id == UUID(operation.operation_id),
        )
    )
    if existing is not None:
        await db.commit()
        if existing.request_hash != request_hash:
            return {
                "operation_id": operation.operation_id,
                "status": "rejected",
                "problem": _problem("operation_id_reused", 409, request_id, now_utc()),
            }, state.head_cursor
        return {
            "operation_id": operation.operation_id,
            "status": "duplicate",
            "receipt": {
                "operation_id": operation.operation_id,
                "request_hash": existing.request_hash.hex(),
                "recorded": True,
                "commit_cursor": str(existing.commit_cursor),
                "effect_at_commit": existing.effect_at_commit,
                "reason_at_commit": existing.reason_at_commit,
            },
        }, state.head_cursor

    now = now_utc()
    failure = await validate_operation_for_recording(
        db, owner_id, owner_created_at, operation, request_id, now
    )
    if failure is not None:
        await db.rollback()
        status, problem = failure
        return {
            "operation_id": operation.operation_id,
            "status": status,
            "problem": problem,
        }, await read_head(db, owner_id)

    existing_rows = (
        await db.scalars(
            select(SyncOperation)
            .where(SyncOperation.owner_id == owner_id)
            .order_by(SyncOperation.commit_cursor)
        )
    ).all()
    try:
        effect, reason = effect_at_commit(
            [json.loads(row.canonical_envelope) for row in existing_rows],
            json.loads(envelope),
            str(owner_id),
        )
    except ReducerValidationError:
        await db.rollback()
        return {
            "operation_id": operation.operation_id,
            "status": "rejected",
            "problem": _problem("validation_failed", 422, request_id, now),
        }, await read_head(db, owner_id)

    if state.head_cursor >= UINT64_MAX:
        await db.rollback()
        raise ProblemHTTPException(status_code=503, code="service_unavailable")
    cursor = state.head_cursor + 1
    event = SyncOperation(
        owner_id=owner_id,
        commit_cursor=cursor,
        operation_id=UUID(operation.operation_id),
        request_hash=request_hash,
        canonical_envelope=envelope,
        committed_at=now,
        effect_at_commit=effect,
        reason_at_commit=reason,
    )
    state.head_cursor = cursor
    db.add(event)
    await db.commit()
    return {
        "operation_id": operation.operation_id,
        "status": "recorded",
        "receipt": {
            "operation_id": operation.operation_id,
            "request_hash": request_hash.hex(),
            "recorded": True,
            "commit_cursor": str(cursor),
            "effect_at_commit": effect,
            "reason_at_commit": reason,
        },
    }, cursor


async def read_head(db: AsyncSession, owner_id: UUID) -> int:
    state = await db.scalar(
        select(SyncOwnerState).where(SyncOwnerState.owner_id == owner_id)
    )
    if state is None:
        return 0
    head = state.head_cursor
    await db.commit()
    return head


def _page_token_hash(token: str) -> bytes:
    return hashlib.sha256(token.encode("ascii")).digest()


async def _mint_page_token(
    db: AsyncSession,
    owner_id: UUID,
    epoch: UUID,
    scope: str,
    through_cursor: int,
    next_cursor: int,
    now: datetime,
) -> str:
    token = secrets.token_urlsafe(32)
    db.add(
        SyncPageToken(
            token_hash=_page_token_hash(token),
            owner_id=owner_id,
            epoch=epoch,
            scope=scope,
            through_cursor=through_cursor,
            next_cursor=next_cursor,
            expires_at=now + timedelta(seconds=PAGE_TOKEN_TTL_SECONDS),
            created_at=now,
        )
    )
    await db.commit()
    return token


async def read_page(
    db: AsyncSession,
    owner_id: UUID,
    *,
    scope: str,
    after: int | None = None,
    expected_epoch: UUID | None = None,
    page_token: str | None = None,
) -> dict:
    now = now_utc()
    state = await ensure_owner_state(db, owner_id)
    if page_token is not None:
        token_row = await db.get(SyncPageToken, _page_token_hash(page_token))
        if token_row is None or token_row.expires_at <= now:
            await db.rollback()
            raise ProblemHTTPException(status_code=409, code="page_token_expired")
        if token_row.owner_id != owner_id or token_row.scope != scope:
            await db.rollback()
            raise ProblemHTTPException(status_code=400, code="malformed_request")
        if token_row.epoch != state.epoch:
            await db.rollback()
            raise ProblemHTTPException(status_code=409, code="cursor_epoch_mismatch")
        start_after = token_row.next_cursor
        highwater = token_row.through_cursor
        epoch = token_row.epoch
    else:
        if after is None:
            start_after = 0
        else:
            start_after = after
        if scope == "pull" and expected_epoch != state.epoch:
            await db.rollback()
            raise ProblemHTTPException(status_code=409, code="cursor_epoch_mismatch")
        highwater = state.head_cursor
        epoch = state.epoch

    if start_after > highwater or highwater > state.head_cursor:
        await db.rollback()
        raise ProblemHTTPException(status_code=400, code="malformed_request")
    rows = (
        await db.scalars(
            select(SyncOperation)
            .where(
                SyncOperation.owner_id == owner_id,
                SyncOperation.commit_cursor > start_after,
                SyncOperation.commit_cursor <= highwater,
            )
            .order_by(SyncOperation.commit_cursor)
            .limit(PAGE_LIMIT + 1)
        )
    ).all()
    groups: list[dict[str, object]] = []
    next_cursor = start_after
    byte_size = 0
    for row in rows:
        group = {
            "cursor": str(row.commit_cursor),
            "committed_at": format_utc_timestamp(row.committed_at),
            "operation": json.loads(row.canonical_envelope),
        }
        group_bytes = len(canonicalize(group).encode("utf-8"))
        if groups and byte_size + group_bytes > PAGE_BYTE_LIMIT:
            break
        if not groups and group_bytes > PAGE_BYTE_LIMIT:
            await db.rollback()
            raise ProblemHTTPException(status_code=503, code="service_unavailable")
        groups.append(group)
        byte_size += group_bytes
        next_cursor = row.commit_cursor
        if len(groups) >= PAGE_LIMIT:
            break
    has_more = next_cursor < highwater
    if has_more and not groups:
        await db.rollback()
        raise ProblemHTTPException(status_code=503, code="service_unavailable")
    next_token = None
    if has_more:
        next_token = await _mint_page_token(
            db, owner_id, epoch, scope, highwater, next_cursor, now
        )
    else:
        await db.commit()
    return {
        "epoch": str(epoch),
        "through_cursor": str(highwater),
        "next_cursor": str(next_cursor if has_more else highwater),
        "has_more": has_more,
        "next_page_token": next_token,
        "groups": groups,
    }
