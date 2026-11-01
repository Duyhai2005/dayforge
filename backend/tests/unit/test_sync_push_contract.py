import pytest
from pydantic import ValidationError

from app.schemas.sync import PushRequest, PushResponse
from app.services import sync


def test_push_service_exposes_single_operation_transaction():
    assert hasattr(sync, "record_operation")


def test_push_request_enforces_batch_size_and_closed_wrapper():
    with pytest.raises(ValidationError):
        PushRequest.model_validate({"operations": [{} for _ in range(101)]})

    with pytest.raises(ValidationError):
        PushRequest.model_validate({"operations": [{}], "unexpected": True})


def test_push_response_limits_results_and_requires_receipts_for_acknowledged_items():
    problem = {
        "type": "/api/v1/problems/dependency_missing",
        "title": "Dependency missing",
        "status": 409,
        "detail": "Sync the required operation before retrying this one.",
        "instance": "/api/v1/requests/33333333-3333-4333-8333-333333333333",
        "code": "dependency_missing",
        "request_id": "33333333-3333-4333-8333-333333333333",
        "retryable": True,
        "server_time": "2026-10-28T12:00:00.000Z",
    }
    rejected = {
        "operation_id": "22222222-2222-4222-8222-222222222222",
        "status": "deferred",
        "problem": problem,
    }

    with pytest.raises(ValidationError):
        PushResponse.model_validate(
            {
                "epoch": "11111111-1111-4111-8111-111111111111",
                "head_cursor": "0",
                "results": [{"operation_id": "22222222-2222-4222-8222-222222222222", "status": "recorded"}],
            }
        )

    valid = PushResponse.model_validate(
        {"epoch": "11111111-1111-4111-8111-111111111111", "head_cursor": "0", "results": [rejected]}
    )
    assert valid.results[0].status == "deferred"

    with pytest.raises(ValidationError):
        PushResponse.model_validate(
            {
                "epoch": "11111111-1111-4111-8111-111111111111",
                "head_cursor": "0",
                "results": [rejected] * 101,
            }
        )


def test_recorded_push_wire_omits_unset_problem_but_keeps_null_receipt_reason(contract_validator):
    operation_id = "22222222-2222-4222-8222-222222222222"
    response = PushResponse.model_validate(
        {
            "epoch": "11111111-1111-4111-8111-111111111111",
            "head_cursor": "1",
            "results": [
                {
                    "operation_id": operation_id,
                    "status": "recorded",
                    "receipt": {
                        "operation_id": operation_id,
                        "request_hash": "a" * 64,
                        "recorded": True,
                        "commit_cursor": "1",
                        "effect_at_commit": "applied",
                        "reason_at_commit": None,
                    },
                }
            ],
        }
    )

    wire = response.model_dump(mode="json", exclude_unset=True)
    contract_validator("PushResponse").validate(wire)
    assert "problem" not in wire["results"][0]
    assert wire["results"][0]["receipt"]["reason_at_commit"] is None
