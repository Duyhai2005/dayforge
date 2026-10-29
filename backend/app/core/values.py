"""Canonical scalar boundaries shared by wire validation and SQL storage."""

from datetime import date, datetime, timezone
import re
from uuid import UUID

_LOCAL_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
_TIMESTAMP = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z")
_DECIMAL = re.compile(r"0|-?[1-9][0-9]*")


def validate_local_date(value: str) -> str:
    if not isinstance(value, str) or not _LOCAL_DATE.fullmatch(value):
        raise ValueError("invalid_local_date")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise ValueError("invalid_local_date") from None
    return value


def parse_wire_uuid(value: str) -> UUID:
    if not isinstance(value, str) or not _UUID.fullmatch(value):
        raise ValueError("invalid_uuid")
    return UUID(value)


def parse_wire_timestamp(value: str) -> datetime:
    if not isinstance(value, str) or not _TIMESTAMP.fullmatch(value):
        raise ValueError("invalid_timestamp")
    try:
        # Python 3.14's ISO parser normalizes 24:00 into the next day; the wire
        # contract permits only clock hours 00..23 and no leap seconds.
        return datetime(int(value[:4]), int(value[5:7]), int(value[8:10]),
                        int(value[11:13]), int(value[14:16]), int(value[17:19]),
                        int(value[20:23]) * 1000, tzinfo=timezone.utc)
    except ValueError:
        raise ValueError("invalid_timestamp") from None


def _utc_milliseconds(value: datetime) -> datetime:
    """Reject lost precision and normalize before stripping timezone for MySQL."""
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("invalid_timestamp")
    if value.microsecond % 1000:
        raise ValueError("invalid_timestamp")
    try:
        result = value.astimezone(timezone.utc)
    except (ValueError, OverflowError):
        raise ValueError("invalid_timestamp") from None
    if result.microsecond % 1000:
        raise ValueError("invalid_timestamp")
    return result


def format_utc_timestamp(value: datetime) -> str:
    value = _utc_milliseconds(value)
    return (f"{value.year:04d}-{value.month:02d}-{value.day:02d}T"
            f"{value.hour:02d}:{value.minute:02d}:{value.second:02d}.{value.microsecond // 1000:03d}Z")


def validate_decimal(value: str, *, minimum: int, maximum: int) -> str:
    if not isinstance(value, str) or not _DECIMAL.fullmatch(value):
        raise ValueError("invalid_decimal")
    # Bound length before int conversion, including Python's integer-string safety limit.
    if len(value.lstrip("-")) > max(len(str(abs(minimum))), len(str(abs(maximum)))):
        raise ValueError("invalid_decimal")
    try:
        number = int(value)
    except ValueError:
        raise ValueError("invalid_decimal") from None
    if not minimum <= number <= maximum:
        raise ValueError("invalid_decimal")
    return value
