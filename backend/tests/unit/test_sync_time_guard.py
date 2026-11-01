import json
from dataclasses import replace
from pathlib import Path

from app.services.sync_clock import ClockMonitor, validate_operation_time
from app.services.sync_wire import validate_operation

EXAMPLES = Path(__file__).resolve().parents[2].parent / "docs" / "tasks" / "t03" / "contract-examples.json"


def operation_at(physical_ms: int, *, quality: str = "offline_estimate"):
    examples = json.loads(EXAMPLES.read_text(encoding="utf-8"))
    envelope = next(
        fixture["value"] for fixture in examples["fixtures"] if fixture["name"] == "work-item-create-operation"
    )
    return replace(validate_operation(envelope), physical_ms=physical_ms, quality=quality)


def test_time_guard_accepts_exact_future_and_account_creation_boundaries():
    assert validate_operation_time(operation_at(1_300_000), account_created_ms=800_000, server_now_ms=1_000_000) is None
    assert validate_operation_time(operation_at(500_000), account_created_ms=800_000, server_now_ms=1_000_000) is None


def test_time_guard_rejects_one_millisecond_outside_either_boundary():
    assert (
        validate_operation_time(operation_at(1_300_001), account_created_ms=800_000, server_now_ms=1_000_000)
        == "time_invalid"
    )
    assert (
        validate_operation_time(operation_at(499_999), account_created_ms=800_000, server_now_ms=1_000_000)
        == "time_invalid"
    )


def test_time_guard_rejects_untrusted_quality():
    assert (
        validate_operation_time(
            operation_at(1_000_000, quality="untrusted"),
            account_created_ms=800_000,
            server_now_ms=1_000_000,
        )
        == "time_invalid"
    )


def test_clock_monitor_detects_large_wall_clock_step_and_stays_unhealthy():
    monitor = ClockMonitor()
    assert monitor.observe(wall_ms=1_000_000, monotonic_ms=20_000) is True
    assert monitor.observe(wall_ms=1_120_000, monotonic_ms=20_000) is True
    assert monitor.observe(wall_ms=1_240_001, monotonic_ms=20_000) is False
    assert monitor.observe(wall_ms=1_240_002, monotonic_ms=20_001) is False
