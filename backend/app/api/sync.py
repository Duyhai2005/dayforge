"""Verified-owner clock and sync endpoints."""

from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Query, Request, Response

from app.core.auth_security import validate_auth_post
from app.core.errors import ProblemHTTPException, build_problem
from app.core.values import format_utc_timestamp, parse_wire_uuid
from app.schemas.common import Cursor, WireUUID
from app.schemas.sync import PushResponse, SyncClockResponse, SyncPage
from app.services.sessions import SessionContext, require_verified_owner
from app.services.sync import (
    SyncOperationError,
    read_owner_sync_head,
    read_sync_page,
    record_operation,
    unix_milliseconds,
)
from app.services.sync_tokens import PageToken, PageTokenError, verify_page_token
from app.services.sync_wire import SyncWireError, ValidatedOperation, validate_operation

router = APIRouter(prefix="/api/v1/sync")


@router.get("/clock", response_model=SyncClockResponse)
async def sync_clock(
    device_id: WireUUID,
    response: Response,
    _context: SessionContext = Depends(require_verified_owner),
) -> SyncClockResponse:
    UUID(device_id)
    now = datetime.now(timezone.utc)
    now = now.replace(microsecond=(now.microsecond // 1000) * 1000)
    response.headers["Cache-Control"] = "no-store"
    return SyncClockResponse(
        calibration_id=str(uuid4()),
        server_time_ms=unix_milliseconds(now),
        server_time=format_utc_timestamp(now),
        max_future_skew_ms=300000,
    )


def _read_operation_id(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    operation_id = value.get("operation_id")
    if not isinstance(operation_id, str):
        return None
    try:
        return str(parse_wire_uuid(operation_id))
    except ValueError:
        return None


def _problem_result(request: Request, operation_id: str | None, error, *, status_code: int, code: str):
    problem = build_problem(
        request,
        status_code=status_code,
        code=code,
        field_errors=getattr(error, "field_errors", None),
        retryable=code == "dependency_missing" or status_code == 503,
    )
    return {
        "operation_id": operation_id,
        "status": "deferred" if getattr(error, "deferred", False) else "rejected",
        "problem": problem.model_dump(exclude_none=True),
    }


def _request_operations(payload: Any) -> list[Any]:
    if not isinstance(payload, dict) or set(payload) != {"operations"}:
        raise ProblemHTTPException(status_code=400, code="malformed_request")
    operations = payload.get("operations")
    if not isinstance(operations, list) or not operations:
        raise ProblemHTTPException(status_code=400, code="malformed_request")
    if len(operations) > 100:
        raise ProblemHTTPException(status_code=413, code="payload_too_large")
    return operations


def _require_query_shape(request: Request, expected_keys: set[str]) -> None:
    pairs = list(request.query_params.multi_items())
    keys = [key for key, _ in pairs]
    if set(keys) != expected_keys or len(keys) != len(expected_keys):
        raise ProblemHTTPException(status_code=400, code="malformed_request")


def _verified_page_token(
    request: Request,
    *,
    token: str,
    endpoint: str,
    owner_id: UUID,
    now: datetime,
) -> PageToken:
    try:
        return verify_page_token(
            request.app.state.settings.secret_key("sync_page_token_key_b64"),
            token,
            endpoint=endpoint,
            owner_id=owner_id,
            now=int(now.timestamp()),
        )
    except PageTokenError as error:
        raise ProblemHTTPException(status_code=error.status_code, code=error.code) from None


@router.get("/bootstrap", response_model=SyncPage)
async def sync_bootstrap(
    request: Request,
    response: Response,
    page_token: str | None = Query(default=None, max_length=2048),
    context: SessionContext = Depends(require_verified_owner),
) -> SyncPage:
    pairs = list(request.query_params.multi_items())
    expected_keys = {"page_token"} if page_token is not None or pairs else set()
    _require_query_shape(request, expected_keys)
    if context.user is None:
        raise ProblemHTTPException(status_code=401, code="authentication_required")
    now = datetime.now(timezone.utc).replace(microsecond=0)
    continuation = (
        None
        if page_token is None
        else _verified_page_token(
            request,
            token=page_token,
            endpoint="bootstrap",
            owner_id=context.user.id,
            now=now,
        )
    )
    page = await read_sync_page(
        request.app.state.database,
        context.user.id,
        endpoint="bootstrap",
        token_key=request.app.state.settings.secret_key("sync_page_token_key_b64"),
        page_token=continuation,
        now=now,
    )
    response.headers["Cache-Control"] = "no-store"
    return page


@router.get("/pull", response_model=SyncPage)
async def sync_pull(
    request: Request,
    response: Response,
    after: Cursor | None = None,
    epoch: WireUUID | None = None,
    page_token: str | None = Query(default=None, max_length=2048),
    context: SessionContext = Depends(require_verified_owner),
) -> SyncPage:
    expected_keys = {"page_token"} if page_token is not None else {"after", "epoch"}
    _require_query_shape(request, expected_keys)
    if context.user is None:
        raise ProblemHTTPException(status_code=401, code="authentication_required")
    now = datetime.now(timezone.utc).replace(microsecond=0)
    continuation = (
        None
        if page_token is None
        else _verified_page_token(
            request,
            token=page_token,
            endpoint="pull",
            owner_id=context.user.id,
            now=now,
        )
    )
    page = await read_sync_page(
        request.app.state.database,
        context.user.id,
        endpoint="pull",
        token_key=request.app.state.settings.secret_key("sync_page_token_key_b64"),
        after_cursor=None if after is None else int(after),
        request_epoch=None if epoch is None else UUID(epoch),
        page_token=continuation,
        now=now,
    )
    response.headers["Cache-Control"] = "no-store"
    return page


def _assert_owner_scope(operations: list[Any], owner_id: UUID) -> None:
    for operation in operations:
        if not isinstance(operation, dict):
            continue
        asserted_owner = operation.get("owner_id")
        if not isinstance(asserted_owner, str):
            continue
        try:
            asserted_owner_id = parse_wire_uuid(asserted_owner)
        except ValueError:
            continue
        if asserted_owner_id != owner_id:
            raise ProblemHTTPException(status_code=403, code="owner_mismatch")


@router.post("/push", response_model=PushResponse, response_model_exclude_unset=True)
async def push_operations(
    request: Request,
    response: Response,
    context: SessionContext = Depends(require_verified_owner),
) -> PushResponse:
    validate_auth_post(request, context.csrf_token)
    if context.user is None:
        raise ProblemHTTPException(status_code=401, code="authentication_required")

    try:
        raw_payload = await request.json()
    except ValueError, UnicodeDecodeError:
        raise ProblemHTTPException(status_code=400, code="malformed_request") from None
    raw_operations = _request_operations(raw_payload)
    owner_id = context.user.id
    _assert_owner_scope(raw_operations, owner_id)

    prepared: list[tuple[str | None, ValidatedOperation | None, SyncWireError | None]] = []
    for raw_operation in raw_operations:
        operation_id = _read_operation_id(raw_operation)
        try:
            prepared.append((operation_id, validate_operation(raw_operation), None))
        except SyncWireError as error:
            if error.code == "payload_too_large":
                raise ProblemHTTPException(status_code=413, code="payload_too_large") from None
            prepared.append((operation_id, None, error))

    results = []
    for operation_id, operation, validation_error in prepared:
        if validation_error is not None:
            status_code = {
                "client_update_required": 409,
                "validation_failed": 422,
            }.get(validation_error.code, 400)
            results.append(
                _problem_result(
                    request,
                    operation_id,
                    validation_error,
                    status_code=status_code,
                    code=validation_error.code,
                )
            )
            continue
        assert operation is not None
        try:
            outcome = await record_operation(request.app.state.database, owner_id, operation)
        except SyncOperationError as error:
            results.append(
                _problem_result(
                    request,
                    operation_id,
                    error,
                    status_code=error.status_code,
                    code=error.code,
                )
            )
            continue
        results.append(
            {
                "operation_id": str(operation.operation_id),
                "status": outcome.status,
                "receipt": outcome.receipt.to_wire(),
            }
        )

    head = await read_owner_sync_head(request.app.state.database, owner_id)
    response.headers["Cache-Control"] = "no-store"
    return PushResponse(
        epoch=str(head.epoch),
        head_cursor=str(head.head_cursor),
        results=results,
    )
