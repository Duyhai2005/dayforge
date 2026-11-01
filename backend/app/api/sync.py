"""Verified-owner clock and sync endpoints."""

from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Response

from app.core.values import format_utc_timestamp
from app.schemas.common import WireUUID
from app.schemas.sync import SyncClockResponse
from app.services.sessions import SessionContext, require_verified_owner
from app.services.sync import unix_milliseconds

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
