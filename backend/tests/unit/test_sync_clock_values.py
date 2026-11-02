from datetime import datetime

from app.schemas.sync import SyncClockResponse
from app.services.sync import unix_milliseconds


def test_unix_milliseconds_uses_utc_and_truncates_submillisecond_precision():
    value = datetime.fromisoformat("1970-01-01T07:00:01.234999+07:00")

    assert unix_milliseconds(value) == 1234


def test_sync_clock_response_keeps_contract_timestamp_and_skew_limit():
    response = SyncClockResponse(
        calibration_id="11111111-1111-4111-8111-111111111111",
        server_time_ms=1_793_140_000_000,
        server_time="2026-10-28T12:00:00.000Z",
        max_future_skew_ms=300000,
    )

    assert response.max_future_skew_ms == 300000
    assert response.server_time_ms == 1_793_140_000_000
