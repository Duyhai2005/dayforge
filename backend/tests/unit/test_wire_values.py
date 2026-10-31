import pytest
from pydantic import StrictBool, StrictInt, TypeAdapter, ValidationError

from app.core.errors import ProblemHTTPException
from app.core.strict_json import parse_json_bytes
from app.schemas.common import (
    ContractModel,
    Cursor,
    DeviceSequence,
    LocalDate,
    OrderKey,
    WireTimestamp,
    WireUUID,
)


@pytest.mark.parametrize("value", ["0001-01-01", "2000-02-29", "9999-12-31"])
def test_local_date_accepts_full_contract_range(value):
    assert TypeAdapter(LocalDate).validate_python(value) == value


@pytest.mark.parametrize(
    "value", ["0000-01-01", "1900-02-29", "2026-2-01", "2026-04-31"]
)
def test_local_date_rejects_invalid_gregorian_or_padding(value):
    with pytest.raises(ValidationError):
        TypeAdapter(LocalDate).validate_python(value)


@pytest.mark.parametrize(
    "alias,valid,invalid",
    [
        (Cursor, ["0", "18446744073709551615"], ["-1", "18446744073709551616"]),
        (DeviceSequence, ["1", "18446744073709551615"], ["0", "18446744073709551616"]),
        (
            OrderKey,
            ["-9223372036854775808", "0", "9223372036854775807"],
            ["-9223372036854775809", "9223372036854775808"],
        ),
    ],
)
def test_decimal_bounds_and_canonical_spelling(alias, valid, invalid):
    adapter = TypeAdapter(alias)
    for value in valid:
        assert adapter.validate_python(value) == value
    for value in [*invalid, "01", "+1", "-0", " 1", "1 ", "1.0", 1, 1.0, True, b"1"]:
        with pytest.raises(ValidationError):
            adapter.validate_python(value)


@pytest.mark.parametrize(
    "alias,valid,invalid",
    [
        (
            WireUUID,
            [
                "01234567-89ab-4cde-8fab-0123456789ab",
                "01234567-89ab-5cde-8fab-0123456789ab",
            ],
            [
                "01234567-89AB-4CDE-8FAB-0123456789AB",
                "01234567-89ab-1cde-8fab-0123456789ab",
            ],
        ),
        (
            WireTimestamp,
            ["0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"],
            [
                "2026-10-29T00:00:00.000+00:00",
                "2026-10-29T00:00:00Z",
                "2026-02-30T00:00:00.000Z",
                "2026-10-29T24:00:00.000Z",
            ],
        ),
    ],
)
def test_uuid_and_timestamp_are_not_reformatted(alias, valid, invalid):
    adapter = TypeAdapter(alias)
    for value in valid:
        assert adapter.validate_python(value) == value
    for value in [*invalid, 1, True, 1.0, b"input"]:
        with pytest.raises(ValidationError):
            adapter.validate_python(value)


class StrictProbe(ContractModel):
    duration_minutes: StrictInt | None
    enabled: StrictBool
    label: str


@pytest.mark.parametrize(
    "override",
    [
        {"duration_minutes": True},
        {"duration_minutes": "1"},
        {"duration_minutes": 1.0},
        {"enabled": "true"},
        {"enabled": 1},
        {"label": 1},
        {"private_extra": "secret"},
    ],
)
def test_strict_model_rejects_coercion_and_extra_fields(override):
    values = {"duration_minutes": 1, "enabled": True, "label": "kept exactly"}
    with pytest.raises(ValidationError):
        StrictProbe(**(values | override))


@pytest.mark.parametrize(
    "raw",
    [
        b'{"a":1,"a":2}',
        b'{"outer":{"x":1,"x":2}}',
        b"NaN",
        b"Infinity",
        b"-Infinity",
        b"1e999",
        b'"\\ud800"',
        b'{"\\udfff":1}',
        b'"\xff"',
        b"\xef\xbb\xbf{}",
        b"9007199254740992",
        b"-9007199254740992",
        b'{"private":"test-only-secret",}',
        pytest.param(b"9" * 5000, id="oversized-integer"),
        pytest.param(b"[" * 1100 + b"]" * 1100, id="excessive-depth"),
    ],
)
def test_json_decoder_rejects_invalid_input_without_echo(raw):
    with pytest.raises(ProblemHTTPException) as caught:
        parse_json_bytes(raw)
    assert caught.value.status_code == 400
    assert caught.value.code == "malformed_request"
    assert "test-only-secret" not in str(caught.value)


def test_json_decoder_preserves_valid_json_values():
    assert parse_json_bytes(
        b'{"max":9007199254740991,"min":-9007199254740991,"float":1.25,"items":[true,null,"\\ud83d\\ude00"]}'
    ) == {
        "max": 9007199254740991,
        "min": -9007199254740991,
        "float": 1.25,
        "items": [True, None, "😀"],
    }
