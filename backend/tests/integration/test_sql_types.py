import asyncio
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Column, MetaData, Table, insert, select, text
from sqlalchemy.exc import StatementError

from app.core.config import Settings
from app.core.database import create_database
from app.models.types import LocalDateSQL, UTCMilliseconds, UUIDBytes

pytestmark = pytest.mark.mysql


async def round_trip(settings, sql_type, value):
    database = create_database(settings)
    table = Table("probe_" + uuid4().hex, MetaData(), Column("value", sql_type, nullable=False),
                  mysql_engine="InnoDB", mysql_charset="utf8mb4")
    try:
        async with database.engine.begin() as connection:
            await connection.run_sync(table.create)
            await connection.execute(insert(table).values(value=value))
            result = (await connection.execute(select(table.c.value))).scalar_one()
            raw = (await connection.execute(text(f"SELECT HEX(value) FROM {table.name}"))).scalar_one()
            return result, raw
    finally:
        try:
            async with database.engine.begin() as connection:
                await connection.run_sync(lambda c: table.drop(c, checkfirst=True))
        finally:
            await database.engine.dispose()


async def round_trip_local_date(settings: Settings, value: str) -> str:
    return (await round_trip(settings, LocalDateSQL(), value))[0]


@pytest.mark.parametrize("value", ["0001-01-01", "0999-12-31", "2000-02-29", "9999-12-31"])
def test_local_date_round_trip_has_no_year_1000_floor(t05_mysql_settings, value):
    assert asyncio.run(round_trip_local_date(t05_mysql_settings, value)) == value


def test_uuid_bytes_use_network_order(t05_mysql_settings):
    value = UUID("00112233-4455-4677-8899-aabbccddeeff")
    result, raw = asyncio.run(round_trip(t05_mysql_settings, UUIDBytes(), value))
    assert result == value
    assert raw == "00112233445546778899AABBCCDDEEFF"


def test_utc_milliseconds_round_trip(t05_mysql_settings):
    value = datetime(2026, 10, 29, 8, 2, 3, 456000, tzinfo=timezone(timedelta(hours=7)))
    result, _ = asyncio.run(round_trip(t05_mysql_settings, UTCMilliseconds(), value))
    assert result == datetime(2026, 10, 29, 1, 2, 3, 456000, tzinfo=timezone.utc)
    assert result.tzinfo is timezone.utc


@pytest.mark.parametrize("value", [datetime(2026, 1, 1), datetime(2026, 1, 1, microsecond=1, tzinfo=timezone.utc)])
def test_naive_or_submillisecond_datetime_is_rejected(t05_mysql_settings, value):
    with pytest.raises(StatementError, match="invalid_timestamp"):
        asyncio.run(round_trip(t05_mysql_settings, UTCMilliseconds(), value))
