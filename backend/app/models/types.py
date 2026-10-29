"""MySQL storage types preserving contract values without silent coercion."""

from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy.dialects.mysql import BINARY, CHAR, DATETIME
from sqlalchemy.types import TypeDecorator

from app.core.values import _utc_milliseconds, validate_local_date


class UUIDBytes(TypeDecorator[UUID]):
    impl = BINARY(16)
    cache_ok = True

    def process_bind_param(self, value: UUID | None, dialect) -> bytes | None:
        if value is None:
            return None
        if not isinstance(value, UUID):
            raise ValueError("invalid_uuid")
        return value.bytes

    def process_result_value(self, value: bytes | None, dialect) -> UUID | None:
        return None if value is None else UUID(bytes=value)


class UTCMilliseconds(TypeDecorator[datetime]):
    impl = DATETIME(fsp=3)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect) -> datetime | None:
        return None if value is None else _utc_milliseconds(value).replace(tzinfo=None)

    def process_result_value(self, value: datetime | None, dialect) -> datetime | None:
        return None if value is None else value.replace(tzinfo=timezone.utc)


class LocalDateSQL(TypeDecorator[str]):
    impl = CHAR(10, charset="ascii", collation="ascii_bin")
    cache_ok = True

    def process_bind_param(self, value: str | None, dialect) -> str | None:
        return None if value is None else validate_local_date(value)

    def process_result_value(self, value: str | None, dialect) -> str | None:
        return None if value is None else validate_local_date(value)
