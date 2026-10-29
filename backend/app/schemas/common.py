"""Shared strict boundary for contract DTOs."""

from functools import partial
from typing import Annotated

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from app.core.values import parse_wire_timestamp, parse_wire_uuid, validate_decimal, validate_local_date


class ContractModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", hide_input_in_errors=True)


def _uuid_string(value: str) -> str:
    parse_wire_uuid(value)
    return value


def _timestamp_string(value: str) -> str:
    parse_wire_timestamp(value)
    return value


WireUUID = Annotated[str, Field(strict=True), AfterValidator(_uuid_string)]
LocalDate = Annotated[str, Field(strict=True), AfterValidator(validate_local_date)]
WireTimestamp = Annotated[str, Field(strict=True), AfterValidator(_timestamp_string)]
Cursor = Annotated[str, Field(strict=True), AfterValidator(partial(validate_decimal, minimum=0, maximum=18446744073709551615))]
DeviceSequence = Annotated[str, Field(strict=True), AfterValidator(partial(validate_decimal, minimum=1, maximum=18446744073709551615))]
OrderKey = Annotated[str, Field(strict=True), AfterValidator(partial(validate_decimal, minimum=-9223372036854775808, maximum=9223372036854775807))]
