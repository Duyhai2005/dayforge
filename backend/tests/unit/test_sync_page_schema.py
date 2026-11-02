import pytest
from pydantic import ValidationError

from app.schemas.sync import SyncPage

EPOCH = "11111111-1111-4111-8111-111111111111"
OPERATION = {
    "protocol_version": 1,
    "reducer_version": 1,
    "operation_id": "22222222-2222-4222-8222-222222222222",
    "owner_id": "33333333-3333-4333-8333-333333333333",
    "device_id": "44444444-4444-4444-8444-444444444444",
    "device_sequence": "1",
    "edit_time": {
        "physical_ms": 1793140000000,
        "logical": 0,
        "calibration_id": "55555555-5555-4555-8555-555555555555",
        "raw_wall_ms": 1793140000000,
        "quality": "offline_estimate",
    },
    "dependencies": [],
    "commands": [{"action": "work_item.create", "payload": {}}],
}


def test_sync_page_accepts_empty_terminal_page_and_advances_to_watermark():
    page = SyncPage.model_validate(
        {
            "epoch": EPOCH,
            "through_cursor": "0",
            "next_cursor": "0",
            "has_more": False,
            "next_page_token": None,
            "groups": [],
        }
    )

    assert page.groups == []
    assert page.next_cursor == page.through_cursor


def test_sync_page_requires_progressing_token_with_complete_groups():
    values = {
        "epoch": EPOCH,
        "through_cursor": "2",
        "next_cursor": "1",
        "has_more": True,
        "next_page_token": "opaque-token",
        "groups": [
            {
                "cursor": "1",
                "committed_at": "2026-10-28T12:00:00.000Z",
                "operation": OPERATION,
            }
        ],
    }
    page = SyncPage.model_validate(values)
    assert page.groups[0].operation.model_dump(mode="json") == OPERATION

    for invalid in (
        {**values, "next_cursor": "0"},
        {**values, "groups": []},
        {**values, "next_cursor": "2"},
        {**values, "next_page_token": None},
    ):
        with pytest.raises(ValidationError):
            SyncPage.model_validate(invalid)


def test_sync_page_caps_complete_groups_at_two_hundred():
    group = {
        "cursor": "1",
        "committed_at": "2026-10-28T12:00:00.000Z",
        "operation": OPERATION,
    }
    with pytest.raises(ValidationError):
        SyncPage.model_validate(
            {
                "epoch": EPOCH,
                "through_cursor": "1",
                "next_cursor": "1",
                "has_more": False,
                "next_page_token": None,
                "groups": [group] * 201,
            }
        )
