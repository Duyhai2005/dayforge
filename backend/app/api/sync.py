"""Same-origin, verified-owner sync transport endpoints."""

from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session
from app.core.errors import ProblemHTTPException
from app.core.values import parse_wire_uuid, validate_decimal
from app.schemas.common import Cursor, WireUUID
from app.schemas.sync import PushRequest
from app.services.sessions import (
    SessionContext,
    csrf_protected_context,
    get_session_context,
    require_verified_owner,
)
from app.services.sync_log import (
    MAX_FUTURE_SKEW_MS,
    issue_calibration,
    operation_envelope,
    read_head,
    read_page,
    record_operation,
)

router = APIRouter(prefix="/api/v1/sync", tags=["sync"])


def _owner(context: SessionContext):
    return require_verified_owner(context)


@router.get("/clock")
async def sync_clock(
    device_id: WireUUID,
    db: AsyncSession = Depends(get_session),
    context: SessionContext = Depends(get_session_context),
) -> dict:
    owner = _owner(context)
    result = await issue_calibration(db, owner.id, parse_wire_uuid(device_id))
    return {**result, "max_future_skew_ms": MAX_FUTURE_SKEW_MS}


@router.get("/bootstrap")
async def sync_bootstrap(
    page_token: str | None = Query(
        default=None, min_length=43, max_length=43, pattern=r"^[A-Za-z0-9_-]{43}$"
    ),
    after: Cursor | None = None,
    epoch: WireUUID | None = None,
    db: AsyncSession = Depends(get_session),
    context: SessionContext = Depends(get_session_context),
) -> dict:
    owner = _owner(context)
    if (page_token is not None and (after is not None or epoch is not None)) or (
        page_token is None and (after is not None or epoch is not None)
    ):
        raise ProblemHTTPException(status_code=400, code="malformed_request")
    return await read_page(
        db,
        owner.id,
        scope="bootstrap",
        page_token=page_token,
    )


@router.get("/pull")
async def sync_pull(
    page_token: str | None = Query(
        default=None, min_length=43, max_length=43, pattern=r"^[A-Za-z0-9_-]{43}$"
    ),
    after: Cursor | None = None,
    epoch: WireUUID | None = None,
    db: AsyncSession = Depends(get_session),
    context: SessionContext = Depends(get_session_context),
) -> dict:
    owner = _owner(context)
    if page_token is not None:
        if after is not None or epoch is not None:
            raise ProblemHTTPException(status_code=400, code="malformed_request")
        return await read_page(db, owner.id, scope="pull", page_token=page_token)
    if after is None or epoch is None:
        raise ProblemHTTPException(status_code=400, code="malformed_request")
    cursor = int(validate_decimal(after, minimum=0, maximum=18_446_744_073_709_551_615))
    return await read_page(
        db,
        owner.id,
        scope="pull",
        after=cursor,
        expected_epoch=parse_wire_uuid(epoch),
    )


@router.post("/push")
async def sync_push(
    payload: PushRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_session),
    context: SessionContext = Depends(csrf_protected_context),
) -> dict:
    owner = _owner(context)
    owner_id = owner.id
    owner_created_at = owner.created_at
    # Reject the entire HTTP envelope before writing anything if any item is
    # oversized or asserts a different owner.
    if any(operation.owner_id != str(owner_id) for operation in payload.operations):
        raise ProblemHTTPException(status_code=403, code="owner_mismatch")
    if any(
        operation_envelope(operation)[2] > 2_097_152 for operation in payload.operations
    ):
        raise ProblemHTTPException(status_code=413, code="payload_too_large")
    if len(await request.body()) > 8_388_608:
        raise ProblemHTTPException(status_code=413, code="payload_too_large")

    request_id = UUID(request.state.request_id)
    results = []
    for operation in payload.operations:
        result, _ = await record_operation(
            db, owner_id, owner_created_at, operation, request_id
        )
        results.append(result)
    head_cursor = await read_head(db, owner_id)
    response.headers["Cache-Control"] = "private, no-store"
    return {
        "epoch": str((await read_page_epoch(db, owner_id))),
        "head_cursor": str(head_cursor),
        "results": results,
    }


async def read_page_epoch(db: AsyncSession, owner_id: UUID) -> UUID:
    from app.services.sync_log import ensure_owner_state

    state = await ensure_owner_state(db, owner_id)
    epoch = state.epoch
    await db.commit()
    return epoch
