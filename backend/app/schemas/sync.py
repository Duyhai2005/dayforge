"""Strict wire models for sync protocol v1 envelopes and pages."""

from typing import Any, Literal

from pydantic import Field, StrictInt, StrictStr, field_validator, model_validator

from app.schemas.common import ContractModel, DeviceSequence, WireUUID

MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_UINT32 = 4_294_967_295


class EditTime(ContractModel):
    physical_ms: StrictInt = Field(ge=0, le=MAX_SAFE_INTEGER)
    logical: StrictInt = Field(ge=0, le=MAX_UINT32)
    calibration_id: WireUUID
    raw_wall_ms: StrictInt = Field(ge=0, le=MAX_SAFE_INTEGER)
    quality: Literal["calibrated", "offline_estimate", "untrusted"]


class RootRef(ContractModel):
    kind: Literal["plan", "milestone", "work_item"]
    id: WireUUID


class Command(ContractModel):
    root: RootRef
    action: StrictStr = Field(min_length=1, max_length=64)
    payload: dict[str, Any]
    precondition: dict[str, Any] | None

    @field_validator("precondition")
    @classmethod
    def validate_precondition(
        cls, value: dict[str, Any] | None
    ) -> dict[str, Any] | None:
        if value is None:
            return None
        allowed = {"expected_root_hash", "expected_bucket"}
        if not value or set(value) - allowed:
            raise ValueError("invalid_precondition")
        root_hash = value.get("expected_root_hash")
        if root_hash is not None and (
            not isinstance(root_hash, str)
            or len(root_hash) != 64
            or any(c not in "0123456789abcdef" for c in root_hash)
        ):
            raise ValueError("invalid_precondition")
        bucket = value.get("expected_bucket")
        if bucket is not None:
            if not isinstance(bucket, dict) or set(bucket) != {
                "date",
                "period",
                "order_hash",
            }:
                raise ValueError("invalid_precondition")
            if not isinstance(bucket["date"], str) or bucket["period"] not in (
                "morning",
                "afternoon",
                "evening",
            ):
                raise ValueError("invalid_precondition")
            order_hash = bucket["order_hash"]
            if (
                not isinstance(order_hash, str)
                or len(order_hash) != 64
                or any(c not in "0123456789abcdef" for c in order_hash)
            ):
                raise ValueError("invalid_precondition")
        return value


class Operation(ContractModel):
    protocol_version: Literal[1]
    reducer_version: Literal[1]
    operation_id: WireUUID
    owner_id: WireUUID
    device_id: WireUUID
    device_sequence: DeviceSequence
    edit_time: EditTime
    dependencies: list[WireUUID] = Field(max_length=1000)
    commands: list[Command] = Field(min_length=1, max_length=1000)

    @field_validator("dependencies")
    @classmethod
    def dependencies_are_unique(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("duplicate_dependency")
        return value

    @model_validator(mode="after")
    def validate_command_groups(self) -> "Operation":
        actions = [command.action for command in self.commands]
        if "undo" in actions and (len(actions) != 1 or actions[0] != "undo"):
            raise ValueError("undo_must_be_single_command")
        if "set_order" in actions and not any(
            command.action == "set_order"
            and command.precondition is not None
            and {"expected_root_hash", "expected_bucket"}.issubset(command.precondition)
            for command in self.commands
        ):
            raise ValueError("set_order_requires_bucket_precondition")
        return self


class PushRequest(ContractModel):
    operations: list[Operation] = Field(min_length=1, max_length=100)


class ClockResponse(ContractModel):
    calibration_id: WireUUID
    server_time_ms: StrictInt = Field(ge=0, le=MAX_SAFE_INTEGER)
    server_time: StrictStr
    max_future_skew_ms: Literal[300000] = 300000
