import json
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

from fastapi.testclient import TestClient

from app.main import create_app
from app.services.sessions import require_verified_owner

OWNER_ID = "11111111-1111-4111-8111-111111111111"
EPOCH = "22222222-2222-4222-8222-222222222222"
CSRF = b"x" * 32
EXAMPLES = Path(__file__).resolve().parents[2].parent / "docs" / "tasks" / "t03" / "contract-examples.json"


def _verified_owner(application):
    application.dependency_overrides[require_verified_owner] = lambda: SimpleNamespace(
        csrf_token=CSRF,
        user=SimpleNamespace(id=UUID(OWNER_ID)),
    )


def _valid_operation():
    document = json.loads(EXAMPLES.read_text(encoding="utf-8"))
    operation = next(
        fixture["value"] for fixture in document["fixtures"] if fixture["name"] == "work-item-create-operation"
    )
    operation["owner_id"] = OWNER_ID
    operation["commands"][0]["payload"]["data"]["title"] = "test-only-private-sync-payload"
    return operation


def test_push_duplicate_returns_the_same_receipt_and_never_logs_payload(
    settings_factory, monkeypatch, contract_validator, capsys
):
    from app.api import sync as sync_api
    from app.services.auth_crypto import encode_base64url
    from app.services.sync import OperationWriteResult, OwnerSyncHead, ReceiptData

    settings = settings_factory()
    application = create_app(settings)
    _verified_owner(application)
    statuses = iter(("recorded", "duplicate"))
    recorded_operations = []

    async def record(_database, owner_id, operation):
        recorded_operations.append((owner_id, operation))
        receipt = ReceiptData(
            operation_id=operation.operation_id,
            request_hash=operation.request_hash,
            commit_cursor=1,
            effect_at_commit="applied",
            reason_at_commit=None,
        )
        return OperationWriteResult(
            status=next(statuses),
            epoch=UUID(EPOCH),
            head_cursor=1,
            receipt=receipt,
        )

    async def read_head(_database, owner_id):
        assert owner_id == UUID(OWNER_ID)
        return OwnerSyncHead(epoch=UUID(EPOCH), head_cursor=1)

    monkeypatch.setattr(sync_api, "record_operation", record)
    monkeypatch.setattr(sync_api, "read_owner_sync_head", read_head)
    body = {"operations": [_valid_operation(), _valid_operation()]}
    with TestClient(application, base_url=settings.public_origin) as client:
        response = client.post(
            "/api/v1/sync/push",
            json=body,
            headers={"Origin": settings.public_origin, "X-CSRF-Token": encode_base64url(CSRF)},
        )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["cache-control"] == "no-store"
    contract_validator("PushResponse").validate(response.json())
    results = response.json()["results"]
    assert [result["status"] for result in results] == ["recorded", "duplicate"]
    assert results[0]["receipt"] == results[1]["receipt"]
    assert response.json()["head_cursor"] == "1"
    assert len(recorded_operations) == 2
    assert "test-only-private-sync-payload" not in response.text + capsys.readouterr().out


def test_sync_push_rejects_wrong_media_type_with_problem_and_no_store(settings_factory, contract_validator):
    settings = settings_factory()
    application = create_app(settings)
    with TestClient(application, base_url=settings.public_origin) as client:
        response = client.post(
            "/api/v1/sync/push",
            content=b"{}",
            headers={"Content-Type": "text/plain"},
        )

    assert response.status_code == 415
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.headers["cache-control"] == "no-store"
    contract_validator("Problem").validate(response.json())
    assert response.json()["code"] == "unsupported_media_type"


def test_unknown_sync_route_returns_problem_and_no_store(settings_factory, contract_validator):
    settings = settings_factory()
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        response = client.get("/api/v1/sync/not-a-route")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.headers["cache-control"] == "no-store"
    contract_validator("Problem").validate(response.json())
    assert response.json()["code"] == "not_found"


def test_sync_write_failure_returns_sanitized_no_store_problem(settings_factory, monkeypatch, contract_validator):
    from app.api import sync as sync_api
    from app.services.auth_crypto import encode_base64url

    settings = settings_factory()
    application = create_app(settings)
    _verified_owner(application)

    async def fail_write(*_args, **_kwargs):
        raise RuntimeError("test-only-sync-secret")

    monkeypatch.setattr(sync_api, "record_operation", fail_write)
    with TestClient(application, base_url=settings.public_origin, raise_server_exceptions=False) as client:
        response = client.post(
            "/api/v1/sync/push",
            json={"operations": [_valid_operation()]},
            headers={"Origin": settings.public_origin, "X-CSRF-Token": encode_base64url(CSRF)},
        )

    assert response.status_code == 500
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.headers["cache-control"] == "no-store"
    contract_validator("Problem").validate(response.json())
    assert response.json()["code"] == "internal_error"
    assert "test-only-sync-secret" not in response.text
