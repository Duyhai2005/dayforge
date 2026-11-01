"""Server-side clock health and edit-time integrity guards for sync writes."""

import time
from datetime import datetime, timezone
from threading import Lock

from app.services.sync_wire import ValidatedOperation

MAX_FUTURE_SKEW_MS = 300_000
MAX_CLOCK_STEP_MS = 120_000


def _unix_milliseconds(value: datetime) -> int:
    utc_value = value.astimezone(timezone.utc)
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    delta = utc_value - epoch
    return delta.days * 86_400_000 + delta.seconds * 1_000 + delta.microseconds // 1_000


def validate_operation_time(
    operation: ValidatedOperation,
    *,
    account_created_ms: int,
    server_now_ms: int,
) -> str | None:
    if (
        operation.quality == "untrusted"
        or operation.physical_ms < account_created_ms - MAX_FUTURE_SKEW_MS
        or operation.physical_ms > server_now_ms + MAX_FUTURE_SKEW_MS
    ):
        return "time_invalid"
    return None


class ClockMonitor:
    """Detect a wall clock step against monotonic elapsed time and fail closed."""

    def __init__(self, *, max_step_ms: int = MAX_CLOCK_STEP_MS):
        if type(max_step_ms) is not int or max_step_ms < 0:
            raise ValueError("invalid_clock_monitor")
        self._max_step_ms = max_step_ms
        self._lock = Lock()
        self._last_wall_ms: int | None = None
        self._last_monotonic_ms: int | None = None
        self._healthy = True

    def observe(self, *, wall_ms: int | None = None, monotonic_ms: int | None = None) -> bool:
        if wall_ms is None:
            wall_ms = _unix_milliseconds(datetime.now(timezone.utc))
        if monotonic_ms is None:
            monotonic_ms = time.monotonic_ns() // 1_000_000
        if type(wall_ms) is not int or type(monotonic_ms) is not int or wall_ms < 0 or monotonic_ms < 0:
            raise ValueError("invalid_clock_sample")

        with self._lock:
            if self._last_wall_ms is not None and self._last_monotonic_ms is not None and self._healthy:
                wall_elapsed = wall_ms - self._last_wall_ms
                monotonic_elapsed = monotonic_ms - self._last_monotonic_ms
                if monotonic_elapsed < 0 or abs(wall_elapsed - monotonic_elapsed) > self._max_step_ms:
                    self._healthy = False
            self._last_wall_ms = wall_ms
            self._last_monotonic_ms = monotonic_ms
            return self._healthy


SERVER_CLOCK_MONITOR = ClockMonitor()
