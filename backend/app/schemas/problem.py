"""RFC 9457 extensions from the shared T03 wire contract."""

from pydantic import Field

from app.schemas.common import ContractModel


class FieldError(ContractModel):
    path: str = Field(pattern=r"^(|/.*)$")
    code: str = Field(min_length=1)


class Problem(ContractModel):
    type: str
    title: str = Field(min_length=1)
    status: int = Field(ge=400, le=599)
    detail: str
    instance: str
    code: str = Field(min_length=1)
    request_id: str = Field(
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    )
    retryable: bool
    server_time: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
    field_errors: list[FieldError] | None = None
    retry_after_seconds: int | None = Field(default=None, ge=0)
