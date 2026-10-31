from datetime import datetime, timezone

from fastapi import APIRouter, Request, Response

from app.core.errors import ProblemHTTPException
from app.core.values import format_utc_timestamp
from app.schemas.system import HealthResponse, VersionInfo, VersionLimits
from app.services.readiness import check_readiness

router = APIRouter(prefix="/api/v1")


@router.get("/health", response_model=HealthResponse)
async def health(request: Request, response: Response) -> HealthResponse:
    if not await check_readiness(
        request.app.state.database,
        required_revision=request.app.state.required_schema_revision,
    ):
        raise ProblemHTTPException(status_code=503, code="service_unavailable")
    response.headers["Cache-Control"] = "no-store"
    return HealthResponse()


@router.get("/version", response_model=VersionInfo)
async def version(response: Response) -> VersionInfo:
    now = datetime.now(timezone.utc)
    now = now.replace(microsecond=(now.microsecond // 1000) * 1000)
    response.headers["Cache-Control"] = "no-store"
    return VersionInfo(
        protocol_versions=[1],
        reducer_versions=[1],
        server_time=format_utc_timestamp(now),
        limits=VersionLimits(),
    )
