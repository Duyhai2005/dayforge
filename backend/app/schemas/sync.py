"""Strict wire DTOs shared by the owner-scoped sync API."""

from typing import Annotated, Any, Literal

from pydantic import Field, model_validator

from app.schemas.common import ContractModel, Cursor, DeviceSequence, WireTimestamp, WireUUID
from app.schemas.problem import Problem

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


class SyncClockResponse(ContractModel):
    calibration_id: WireUUID
    server_time_ms: Annotated[int, Field(ge=0, le=MAX_SAFE_INTEGER)]
    server_time: WireTimestamp
    max_future_skew_ms: Literal[300000]


class OperationReceiptView(ContractModel):
    operation_id: WireUUID
    request_hash: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
    recorded: Literal[True]
    commit_cursor: DeviceSequence
    effect_at_commit: Literal["applied", "superseded", "no_op"]
    reason_at_commit: (
        Literal[
            "duplicate_target",
            "reference_unavailable",
            "target_retired",
            "precondition_failed",
            "undo_not_applicable",
        ]
        | None
    )


class PushResult(ContractModel):
    operation_id: WireUUID | None
    status: Literal["recorded", "duplicate", "deferred", "rejected"]
    receipt: OperationReceiptView | None = None
    problem: Problem | None = None

    @model_validator(mode="after")
    def result_matches_status(self):
        if self.status in ("recorded", "duplicate"):
            if self.operation_id is None or self.receipt is None or self.problem is not None:
                raise ValueError("invalid_push_result")
        elif self.receipt is not None or self.problem is None:
            raise ValueError("invalid_push_result")
        return self


class PushResponse(ContractModel):
    epoch: WireUUID
    head_cursor: Cursor
    results: Annotated[list[PushResult], Field(min_length=1, max_length=100)]


class SyncPageGroup(ContractModel):
    cursor: DeviceSequence
    committed_at: WireTimestamp
    operation: OperationEnvelope


class SyncPage(ContractModel):
    epoch: WireUUID
    through_cursor: Cursor
    next_cursor: Cursor
    has_more: bool
    next_page_token: Annotated[str, Field(min_length=1, max_length=2048)] | None
    groups: Annotated[list[SyncPageGroup], Field(max_length=200)]

    @model_validator(mode="after")
    def page_progress_matches_token(self):
        if self.has_more:
            if (
                self.next_page_token is None
                or not self.groups
                or self.next_cursor != self.groups[-1].cursor
                or int(self.next_cursor) >= int(self.through_cursor)
            ):
                raise ValueError("invalid_sync_page_progress")
        elif self.next_page_token is not None or self.next_cursor != self.through_cursor:
            raise ValueError("invalid_sync_page_progress")
        return self
