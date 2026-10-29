from typing import Literal

from pydantic import Field, field_validator

from app.schemas.common import ContractModel, WireTimestamp


class HealthResponse(ContractModel):
    status: Literal["ok"] = "ok"


class VersionLimits(ContractModel):
    push_operations: Literal[100] = 100
    push_request_bytes: Literal[8388608] = 8388608
    operation_bytes: Literal[2097152] = 2097152
    commands_per_operation: Literal[1000] = 1000
    page_operations: Literal[200] = 200
    page_bytes: Literal[8388608] = 8388608
    page_token_ttl_seconds: Literal[1800] = 1800

    @field_validator("*", mode="before")
    @classmethod
    def strict_integer(cls, value):
        if type(value) is not int:
            raise ValueError("invalid_version_constant")
        return value


class VersionInfo(ContractModel):
    api_major: Literal[1] = 1
    protocol_versions: list[Literal[1]] = Field(min_length=1, max_length=1)
    reducer_versions: list[Literal[1]] = Field(min_length=1, max_length=1)
    server_time: WireTimestamp
    limits: VersionLimits

    @field_validator("api_major", mode="before")
    @classmethod
    def strict_integer(cls, value):
        if type(value) is not int:
            raise ValueError("invalid_version_constant")
        return value

    @field_validator("protocol_versions", "reducer_versions", mode="before")
    @classmethod
    def strict_integer_array(cls, value):
        if not isinstance(value, list) or any(type(item) is not int for item in value):
            raise ValueError("invalid_version_constant")
        return value
