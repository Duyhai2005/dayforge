import importlib.util
import json
from pathlib import Path
from uuid import UUID

import pytest

BACKEND = Path(__file__).resolve().parents[2]
EXAMPLES_PATH = BACKEND.parent / "docs" / "tasks" / "t03" / "contract-examples.json"


def operation_example():
    examples = json.loads(EXAMPLES_PATH.read_text(encoding="utf-8"))
    return next(
        item["value"]
        for item in examples["fixtures"]
        if item["definition"] == "Operation" and item["valid"] and item["name"] == "work-item-create-operation"
    )


def recurrence_operation():
    operation = operation_example()
    operation["commands"][0]["action"] = "work_item.create_recurrence"
    operation["commands"][0]["payload"] = {
        "start_date": "2026-10-28",
        "rule": {"weekdays": [1, 3, 5]},
        "template": {
            "title": "Ôn thi giữa kỳ",
            "period": "morning",
            "duration_minutes": None,
            "plan_id": None,
            "standalone_color_id": "neutral",
            "order_key": "1024",
        },
    }
    return operation


def operation_with_command_fixture(name):
    document = json.loads(EXAMPLES_PATH.read_text(encoding="utf-8"))
    command = next(
        item["value"]
        for item in document["fixtures"]
        if item["definition"] == "Command" and item["valid"] and item["name"] == name
    )
    operation = operation_example()
    operation["commands"][0] = command
    return operation


def assert_invalid_semantic_value(operation, expected_path):
    module = sync_wire()
    with pytest.raises(module.SyncWireError) as error:
        module.validate_operation(operation)

    assert error.value.code == "validation_failed"
    assert error.value.field_errors is not None
    assert expected_path in {item.path for item in error.value.field_errors}


def sync_wire():
    module_spec = importlib.util.find_spec("app.services.sync_wire")
    assert module_spec is not None, "T10 sync wire validator is not implemented"
    from app.services import sync_wire as module

    return module


def test_valid_operation_matches_t03_schema_and_has_stable_hash():
    module = sync_wire()
    result = module.validate_operation(operation_example())

    assert result.operation_id == UUID("22222222-2222-4222-8222-222222222222")
    assert result.owner_id == UUID("11111111-1111-4111-8111-111111111111")
    assert len(result.request_hash) == 32
    assert result.canonical_envelope == module.canonical_json(operation_example())
    assert result.request_hash == module.hash_envelope(result.canonical_envelope)


def test_operation_validator_matches_all_t03_operation_fixtures():
    module = sync_wire()
    document = json.loads(EXAMPLES_PATH.read_text(encoding="utf-8"))
    fixtures = [item for item in document["fixtures"] if item["definition"] == "Operation"]

    assert fixtures
    for fixture in fixtures:
        if fixture["valid"]:
            module.validate_operation(fixture["value"])
        else:
            with pytest.raises(module.SyncWireError):
                module.validate_operation(fixture["value"])


def test_canonical_json_sorts_utf16_keys_and_preserves_unicode():
    module = sync_wire()
    canonical = module.canonical_json({"\ue000": "giữ nguyên", "😀": "ok", "a": 1})

    assert canonical == '{"a":1,"😀":"ok","\ue000":"giữ nguyên"}'.encode("utf-8")


def test_canonical_json_rejects_float_and_unpaired_surrogate():
    module = sync_wire()

    with pytest.raises(module.SyncWireError) as floating_point:
        module.canonical_json({"value": 1.25})
    assert floating_point.value.code == "malformed_request"

    with pytest.raises(module.SyncWireError) as surrogate:
        module.canonical_json({"value": "\ud800"})
    assert surrogate.value.code == "malformed_request"


def test_operation_rejects_unknown_fields_and_duplicate_dependencies():
    module = sync_wire()
    unknown = operation_example()
    unknown["unexpected"] = True
    with pytest.raises(module.SyncWireError) as unknown_error:
        module.validate_operation(unknown)
    assert unknown_error.value.code == "validation_failed"

    duplicate = operation_example()
    dependency = "44444444-4444-4444-8444-444444444444"
    duplicate["dependencies"] = [dependency, dependency]
    with pytest.raises(module.SyncWireError) as dependency_error:
        module.validate_operation(duplicate)
    assert dependency_error.value.code == "validation_failed"


def test_validation_errors_do_not_echo_unknown_property_names():
    module = sync_wire()
    operation = operation_example()
    operation["private-note-as-unknown-property"] = "do not echo"

    with pytest.raises(module.SyncWireError) as error:
        module.validate_operation(operation)

    assert error.value.field_errors is not None
    assert error.value.field_errors[0].path == ""
    assert "private-note-as-unknown-property" not in str(error.value.field_errors)

    nested = operation_example()
    nested["commands"][0]["private-note-as-unknown-property"] = "do not echo"
    with pytest.raises(module.SyncWireError) as nested_error:
        module.validate_operation(nested)
    assert nested_error.value.field_errors is not None
    assert all("private-note-as-unknown-property" not in item.path for item in nested_error.value.field_errors or [])


def test_validation_error_with_newline_property_name_is_sanitized():
    module = sync_wire()
    operation = operation_example()
    operation["unexpected\nfield"] = True

    with pytest.raises(module.SyncWireError) as error:
        module.validate_operation(operation)

    assert error.value.field_errors is not None
    assert error.value.field_errors[0].path == ""


def test_unknown_protocol_returns_client_update_required():
    module = sync_wire()
    operation = operation_example()
    operation["protocol_version"] = 2

    with pytest.raises(module.SyncWireError) as error:
        module.validate_operation(operation)
    assert error.value.code == "client_update_required"


def test_device_sequence_must_fit_unsigned_64_bit():
    module = sync_wire()
    operation = operation_example()
    operation["device_sequence"] = "18446744073709551616"

    with pytest.raises(module.SyncWireError) as error:
        module.validate_operation(operation)
    assert error.value.code == "validation_failed"


@pytest.mark.parametrize("order_key", ["-9223372036854775808", "9223372036854775807"])
def test_task_order_key_accepts_signed_int64_boundaries(order_key):
    operation = operation_example()
    operation["commands"][0]["payload"]["data"]["order_key"] = order_key

    result = sync_wire().validate_operation(operation)
    assert result.envelope["commands"][0]["payload"]["data"]["order_key"] == order_key


@pytest.mark.parametrize("order_key", ["-9223372036854775809", "9223372036854775808"])
def test_task_order_key_rejects_values_outside_signed_int64(order_key):
    operation = operation_example()
    operation["commands"][0]["payload"]["data"]["order_key"] = order_key

    assert_invalid_semantic_value(operation, "/commands/0/payload/data/order_key")


@pytest.mark.parametrize(
    ("fixture", "order_key_path"),
    [
        ("command-work_item.create_recurrence", ("template", "order_key")),
        ("command-set_order", ("order_key",)),
    ],
)
@pytest.mark.parametrize("order_key", ["-9223372036854775809", "9223372036854775808"])
def test_template_and_reorder_keys_reject_values_outside_signed_int64(fixture, order_key_path, order_key):
    operation = operation_with_command_fixture(fixture)
    field = operation["commands"][0]["payload"]
    for part in order_key_path[:-1]:
        field = field[part]
    field[order_key_path[-1]] = order_key

    expected_path = "/commands/0/payload/" + "/".join(order_key_path)
    assert_invalid_semantic_value(operation, expected_path)


@pytest.mark.parametrize("title", ["   ", "Cafe\u0301", "title\u2028continued"])
def test_task_title_must_be_trimmed_and_nfc(title):
    operation = operation_example()
    operation["commands"][0]["payload"]["data"]["title"] = title

    assert_invalid_semantic_value(operation, "/commands/0/payload/data/title")


def test_recurrence_weekdays_must_be_ascending():
    unsorted = recurrence_operation()
    unsorted["commands"][0]["payload"]["rule"]["weekdays"] = [3, 1]
    assert_invalid_semantic_value(unsorted, "/commands/0/payload/rule/weekdays")


def test_new_recurrence_can_start_before_its_first_matching_weekday():
    operation = recurrence_operation()
    operation["commands"][0]["payload"]["rule"]["weekdays"] = [1, 5]

    result = sync_wire().validate_operation(operation)
    assert result.envelope["commands"][0]["payload"]["start_date"] == "2026-10-28"


def test_enable_recurrence_date_must_match_a_selected_weekday():
    operation = operation_with_command_fixture("command-work_item.enable_recurrence")
    operation["commands"][0]["payload"]["rule"]["weekdays"] = [1, 5]

    assert_invalid_semantic_value(operation, "/commands/0/payload/rule/weekdays")


def test_operation_size_is_capped_before_command_schema_validation():
    module = sync_wire()
    operation = operation_example()
    operation["oversized_padding"] = "x" * (2 * 1024 * 1024)

    with pytest.raises(module.SyncWireError) as error:
        module.validate_operation(operation)
    assert error.value.code == "payload_too_large"
