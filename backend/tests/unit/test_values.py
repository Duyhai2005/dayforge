from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest

from app.core.values import (
    format_utc_timestamp,
    parse_wire_timestamp,
    parse_wire_uuid,
    validate_decimal,
    validate_local_date,
)
from app.models.types import LocalDateSQL, UTCMilliseconds, UUIDBytes


@pytest.mark.parametrize(
    "value", ["0001-01-01", "0999-12-31", "2000-02-29", "9999-12-31"]
)
def test_local_date_accepts_canonical_gregorian(value):
    assert validate_local_date(value) == value


@pytest.mark.parametrize(
    "value",
    [
        "0000-01-01",
        "1900-02-29",
        "2000-2-29",
        "2026-04-31",
        "2000-01-01\n",
        None,
        "secret",
    ],
)
def test_local_date_rejects_invalid_without_echo(value):
    with pytest.raises(ValueError, match="^invalid_local_date$"):
        validate_local_date(value)


@pytest.mark.parametrize(
    "value",
    ["00112233-4455-4677-8899-aabbccddeeff", "00112233-4455-5677-8899-aabbccddeeff"],
)
def test_wire_uuid_accepts_v4_and_v5(value):
    assert parse_wire_uuid(value) == UUID(value)


@pytest.mark.parametrize(
    "value",
    [
        "00112233-4455-1677-8899-aabbccddeeff",
        "00112233-4455-4677-7899-aabbccddeeff",
        "00112233-4455-4677-8899-AABBCCDDEEFF",
        "00112233445546778899aabbccddeeff",
        None,
        "secret",
    ],
)
def test_wire_uuid_rejects_noncanonical(value):
    with pytest.raises(ValueError, match="^invalid_uuid$"):
        parse_wire_uuid(value)


def test_timestamp_early_year_and_utc_conversion():
    assert parse_wire_timestamp("0001-01-01T00:00:00.001Z") == datetime(
        1, 1, 1, microsecond=1000, tzinfo=timezone.utc
    )
    assert (
        format_utc_timestamp(datetime(1, 1, 1, microsecond=1000, tzinfo=timezone.utc))
        == "0001-01-01T00:00:00.001Z"
    )
    assert (
        format_utc_timestamp(
            datetime(2026, 1, 1, 7, tzinfo=timezone(timedelta(hours=7)))
        )
        == "2026-01-01T00:00:00.000Z"
    )


@pytest.mark.parametrize(
    "value",
    [
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00.000+00:00",
        "2026-02-30T00:00:00.000Z",
        "2026-01-01T24:00:00.000Z",
        "2026-01-01T00:00:60.000Z",
        "2026-01-01T00:00:00.000Z\n",
        None,
    ],
)
def test_timestamp_rejects_invalid(value):
    with pytest.raises(ValueError, match="^invalid_timestamp$"):
        parse_wire_timestamp(value)


@pytest.mark.parametrize(
    "value",
    [datetime(2026, 1, 1), datetime(2026, 1, 1, microsecond=1, tzinfo=timezone.utc)],
)
def test_naive_or_submillisecond_datetime_is_rejected(value):
    with pytest.raises(ValueError, match="^invalid_timestamp$"):
        UTCMilliseconds().process_bind_param(value, None)
    with pytest.raises(ValueError, match="^invalid_timestamp$"):
        format_utc_timestamp(value)


@pytest.mark.parametrize("value", ["-9223372036854775808", "0", "9223372036854775807"])
def test_decimal_canonical_int64(value):
    assert validate_decimal(value, minimum=-(2**63), maximum=2**63 - 1) == value


@pytest.mark.parametrize(
    "value",
    [
        "+1",
        "01",
        "-0",
        "-01",
        "1.0",
        "1\n",
        "9223372036854775808",
        "-9223372036854775809",
        "9" * 5000,
        None,
    ],
)
def test_decimal_rejects_noncanonical_and_out_of_range(value):
    with pytest.raises(ValueError, match="^invalid_decimal$"):
        validate_decimal(value, minimum=-(2**63), maximum=2**63 - 1)


def test_decimal_custom_bounds():
    assert validate_decimal("1", minimum=1, maximum=2**64 - 1) == "1"
    assert (
        validate_decimal("18446744073709551615", minimum=1, maximum=2**64 - 1)
        == "18446744073709551615"
    )
    with pytest.raises(ValueError, match="^invalid_decimal$"):
        validate_decimal("0", minimum=1, maximum=2**64 - 1)


def test_sql_types_validate_at_boundaries():
    with pytest.raises(ValueError, match="^invalid_uuid$"):
        UUIDBytes().process_bind_param("00112233-4455-4677-8899-aabbccddeeff", None)
    for method in (
        LocalDateSQL().process_bind_param,
        LocalDateSQL().process_result_value,
    ):
        with pytest.raises(ValueError, match="^invalid_local_date$"):
            method("1900-02-29", None)
