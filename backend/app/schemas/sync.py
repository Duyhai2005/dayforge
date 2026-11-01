"""Strict wire DTOs shared by the owner-scoped sync API."""

from typing import Annotated, Any, Literal

from pydantic import Field

from app.schemas.common import ContractModel, DeviceSequence, WireUUID

MAX_SAFE_INTEGER = 9007199254740991
UINT32_MAX = 4294967295


class EditTime(ContractModel):
    physical_ms: Annotated[int, Field(ge=0, le=MAX_SAFE_INTEGER)]
    logical: Annotated[int, Field(ge=0, le=UINT32_MAX)]
    calibration_id: WireUUID
    raw_wall_ms: Annotated[int, Field(ge=0, le=MAX_SAFE_INTEGER)]
    quality: Literal["calibrated", "offline_estimate", "untrusted"]


class OperationEnvelope(ContractModel):
    protocol_version: Literal[1]
    reducer_version: Literal[1]
    operation_id: WireUUID
    owner_id: WireUUID
    device_id: WireUUID
    device_sequence: DeviceSequence
    edit_time: EditTime
    dependencies: Annotated[list[WireUUID], Field(max_length=1000)]
    commands: Annotated[list[dict[str, Any]], Field(min_length=1, max_length=1000)]


class PushRequest(ContractModel):
    operations: Annotated[list[dict[str, Any]], Field(min_length=1, max_length=100)]
