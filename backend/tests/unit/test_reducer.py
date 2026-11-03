import json
from itertools import permutations
from pathlib import Path

import pytest

from app.services.reducer import ReducerValidationError, effect_at_commit, replay

FIXTURE = Path(__file__).resolve().parents[3] / "docs" / "tasks" / "t12" / "fixtures" / "reducer-v1-basic.json"


def test_basic_reducer_fixture_is_independent_of_arrival_order():
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    expected = fixture["expected_projection"]
    for operations in permutations(fixture["operations"]):
        projection, _ = replay(operations, fixture["owner_id"])
        assert projection == expected
    _, outcomes = replay(fixture["operations"], fixture["owner_id"])
    assert [outcome["operation_id"] for outcome in outcomes] == [
        operation["operation_id"] for operation in fixture["operations"]
    ]


def test_delete_wins_equal_hlc_and_newer_replace_restores_single():
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    projection, _ = replay(fixture["operations"][:4], fixture["owner_id"])
    assert projection["roots"]["work_item:55555555-5555-4555-8555-555555555555"]["deleted"] is True


def test_operation_group_rolls_back_as_a_unit_on_semantic_noop():
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    candidate = dict(fixture["operations"][0])
    candidate["operation_id"] = "99999999-9999-4999-8999-999999999999"
    candidate["commands"] = [
        fixture["operations"][0]["commands"][0],
        {
            "root": {"kind": "milestone", "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},
            "action": "milestone.create",
            "payload": {
                "data": {
                    "title": "Sai tham chiếu",
                    "date": "2026-11-02",
                    "period": None,
                    "note": "",
                    "plan_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    "standalone_color_id": "neutral",
                    "show_in_work_calendar": False,
                }
            },
            "precondition": None,
        },
    ]
    projection, outcomes = replay([candidate], fixture["owner_id"])
    assert projection["roots"] == {}
    assert outcomes[0]["effect"] == "no_op"
    assert outcomes[0]["reason"] == "reference_unavailable"


def test_recurrence_family_fixture_matches_expected_projection_independent_of_arrival_order():
    fixture_path = FIXTURE.with_name("reducer-v1-recurrence.json")
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    expected = fixture["expected_projection"]
    for operations in permutations(fixture["operations"]):
        projection, outcomes = replay(operations, fixture["owner_id"])
        assert projection == expected
        assert all(outcome["reason"] is None for outcome in outcomes)
    _, outcomes = replay(fixture["operations"], fixture["owner_id"])
    assert [outcome["effect"] for outcome in outcomes] == fixture["expected_effects"]


def test_undo_fixture_restores_previous_root_as_an_addressable_tombstone():
    fixture_path = FIXTURE.with_name("reducer-v1-undo.json")
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    for operations in permutations(fixture["operations"]):
        projection, outcomes = replay(operations, fixture["owner_id"])
        assert projection == fixture["expected_projection"]
        assert all(outcome["reason"] is None for outcome in outcomes)
    _, outcomes = replay(fixture["operations"], fixture["owner_id"])
    assert [outcome["effect"] for outcome in outcomes] == fixture["expected_effects"]


def test_new_create_matching_existing_root_is_a_recorded_noop_effect():
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    first = fixture["operations"][0]
    duplicate = {
        **first,
        "operation_id": "99999999-9999-4999-8999-999999999999",
        "edit_time": {**first["edit_time"], "physical_ms": 1001, "raw_wall_ms": 1001},
    }
    assert effect_at_commit([first], duplicate, fixture["owner_id"]) == (
        "no_op",
        "duplicate_target",
    )


def test_set_order_shared_fixture_matches_and_stale_bucket_guard_is_noop():
    fixture_path = FIXTURE.with_name("reducer-v1-set-order.json")
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    for operations in permutations(fixture["operations"]):
        projection, _ = replay(operations, fixture["owner_id"])
        assert projection == fixture["expected_projection"]
    _, outcomes = replay(fixture["operations"], fixture["owner_id"])
    assert [outcome["effect"] for outcome in outcomes] == fixture["expected_effects"]

    stale = json.loads(json.dumps(fixture["operations"]))
    command = stale[-1]["commands"][0]
    command["precondition"]["expected_bucket"]["order_hash"] = "0" * 64
    projection, outcomes = replay(stale, fixture["owner_id"])
    assert projection == fixture["initial_projection"]
    assert outcomes[-1]["effect"] == "no_op"
    assert outcomes[-1]["reason"] == "precondition_failed"

    phantom = json.loads(json.dumps(fixture["operations"][1]))
    phantom["operation_id"] = "88888888-8888-4888-8888-888888888888"
    phantom["device_sequence"] = "4"
    phantom["edit_time"] = {**phantom["edit_time"], "physical_ms": 3000, "raw_wall_ms": 3000}
    phantom["dependencies"] = [fixture["operations"][2]["operation_id"]]
    phantom["commands"][0]["root"]["id"] = "77777777-7777-4777-8777-777777777777"
    phantom["commands"][0]["payload"]["data"] = {
        **phantom["commands"][0]["payload"]["data"],
        "title": "Phantom insert",
        "order_key": "30",
    }
    with_phantom, outcomes = replay(
        [*fixture["operations"][:-1], phantom, fixture["operations"][-1]], fixture["owner_id"]
    )
    without_rebalance, _ = replay([*fixture["operations"][:-1], phantom], fixture["owner_id"])
    assert outcomes[-1]["effect"] == "no_op"
    assert outcomes[-1]["reason"] == "precondition_failed"
    assert with_phantom == without_rebalance
    assert with_phantom["roots"]["work_item:aaaaaaaa-bbbb-4aaa-8bbb-cccccccccccc"]["single"]["order_key"] == "20"


def test_set_order_requires_both_root_and_bucket_guards():
    fixture_path = FIXTURE.with_name("reducer-v1-set-order.json")
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    operation = json.loads(json.dumps(fixture["operations"][-1]))
    operation["commands"][0]["precondition"].pop("expected_bucket")
    with pytest.raises(ReducerValidationError, match="set_order_bucket_precondition_required"):
        replay([*fixture["operations"][:-1], operation], fixture["owner_id"])


def test_set_order_rejects_rank_above_signed_int64():
    fixture_path = FIXTURE.with_name("reducer-v1-set-order.json")
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    operation = json.loads(json.dumps(fixture["operations"][-1]))
    operation["commands"][0]["payload"]["order_key"] = "9223372036854775808"
    with pytest.raises(ReducerValidationError, match="set_order_order_key"):
        replay([*fixture["operations"][:-1], operation], fixture["owner_id"])


def test_uuid_byte_tiebreaks_match_the_shared_fixture_for_all_arrivals():
    fixture_path = FIXTURE.with_name("reducer-v1-k-tiebreak.json")
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    for scenario in fixture["scenarios"]:
        for operations in permutations(scenario["operations"]):
            projection, outcomes = replay(operations, fixture["owner_id"])
            assert projection == scenario["expected_projection"]
            assert all(outcome["reason"] is None for outcome in outcomes)


def test_remaining_v1_action_fixtures_match_the_independent_projection_for_all_arrivals():
    fixture_path = FIXTURE.with_name("reducer-v1-actions.json")
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    covered_actions = set()
    for scenario in fixture["scenarios"]:
        covered_actions.update(
            command["action"] for operation in scenario["operations"] for command in operation["commands"]
        )
        for operations in permutations(scenario["operations"]):
            projection, outcomes = replay(operations, fixture["owner_id"])
            assert projection == scenario["expected_projection"], scenario["name"]
            assert all(outcome["reason"] is None for outcome in outcomes)

    all_fixture_actions = set()
    for path in FIXTURE.parent.glob("reducer-v1-*.json"):
        shared_fixture = json.loads(path.read_text(encoding="utf-8"))
        scenarios = shared_fixture.get("scenarios", [shared_fixture])
        for item in scenarios:
            all_fixture_actions.update(
                command["action"] for operation in item["operations"] for command in operation["commands"]
            )
    expected_actions = {
        "plan.create",
        "plan.replace",
        "milestone.create",
        "milestone.replace",
        "milestone.delete",
        "work_item.create_single",
        "work_item.create_recurrence",
        "work_item.enable_recurrence",
        "single.replace",
        "single.delete",
        "occurrence.replace",
        "occurrence.delete",
        "detached.replace",
        "detached.delete",
        "series.edit_future",
        "series.stop_future",
        "set_order",
        "undo",
    }
    assert covered_actions <= expected_actions
    assert all_fixture_actions == expected_actions


def test_late_event_makes_original_create_undo_a_safe_noop():
    fixture_path = FIXTURE.with_name("reducer-v1-undo-late.json")
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    root_key = "work_item:55555555-5555-4555-8555-555555555555"
    for operations in permutations(fixture["operations"]):
        projection, outcomes = replay(operations, fixture["owner_id"])
        assert projection == fixture["expected_projection"]
        assert projection["roots"][root_key]["single"]["title"] == "Updated before undo"
        assert len(outcomes) == len(fixture["operations"])
    _, outcomes = replay(fixture["operations"], fixture["owner_id"])
    assert [outcome["effect"] for outcome in outcomes] == fixture["expected_effects"]
    assert [outcome["reason"] for outcome in outcomes] == fixture["expected_reasons"]
