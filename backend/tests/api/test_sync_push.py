import json
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

from fastapi.testclient import TestClient

from app.main import create_app
from app.services.sessions import require_verified_owner

OWNER_ID = "11111111-1111-4111-8111-111111111111"
CSRF = b"x" * 32
EXAMPLES = Path(__file__).resolve().parents[2].parent / "docs" / "tasks" / "t03" / "contract-examples.json"


def test_sync_push_requires_verified_owner_before_parsing_items(auth_client):
    response = auth_client.post("/api/v1/sync/push", json={"operations": []})

    assert response.status_code == 401
    assert response.json()["code"] == "authentication_required"


def test_sync_push_rejects_untrusted_origin_before_database_access(settings_factory):
    from app.services.auth_crypto import encode_base64url

    settings = settings_factory()
    application = create_app(settings)
    application.dependency_overrides[require_verified_owner] = lambda: SimpleNamespace(
        csrf_token=CSRF,
        user=SimpleNamespace(id=UUID(OWNER_ID)),
    )
    with TestClient(application, base_url=settings.public_origin) as client:
        client.headers["X-CSRF-Token"] = encode_base64url(CSRF)
        response = client.post("/api/v1/sync/push", json={"operations": []}, headers={"Origin": "https://evil.test"})

    assert response.status_code == 403
    assert response.json()["code"] == "csrf_failed"


def test_sync_push_rejects_batch_over_100_before_database_access(settings_factory):
    from app.services.auth_crypto import encode_base64url

    settings = settings_factory()
    application = create_app(settings)
    application.dependency_overrides[require_verified_owner] = lambda: SimpleNamespace(
        csrf_token=CSRF,
        user=SimpleNamespace(id=UUID(OWNER_ID)),
    )
    with TestClient(application, base_url=settings.public_origin) as client:
        response = client.post(
            "/api/v1/sync/push",
            json={"operations": [{} for _ in range(101)]},
            headers={"Origin": settings.public_origin, "X-CSRF-Token": encode_base64url(CSRF)},
        )

    assert response.status_code == 413
    assert response.json()["code"] == "payload_too_large"


def test_sync_push_rejects_single_operation_over_2_mib_before_database_access(settings_factory):
    from app.services.auth_crypto import encode_base64url

    settings = settings_factory()
    application = create_app(settings)
    application.dependency_overrides[require_verified_owner] = lambda: SimpleNamespace(
        csrf_token=CSRF,
        user=SimpleNamespace(id=UUID(OWNER_ID)),
    )
    oversized = {"oversized_padding": "x" * (2 * 1024 * 1024)}
    with TestClient(application, base_url=settings.public_origin) as client:
        response = client.post(
            "/api/v1/sync/push",
            json={"operations": [oversized]},
            headers={"Origin": settings.public_origin, "X-CSRF-Token": encode_base64url(CSRF)},
        )

    assert response.status_code == 413
    assert response.json()["code"] == "payload_too_large"


def test_sync_push_owner_assertion_rejects_entire_batch_before_any_write(settings_factory, monkeypatch):
    from app.api import sync as sync_api
    from app.services.auth_crypto import encode_base64url

    examples = json.loads(EXAMPLES.read_text(encoding="utf-8"))
    operation = next(
        fixture["value"] for fixture in examples["fixtures"] if fixture["name"] == "work-item-create-operation"
    )
    operation["owner_id"] = "22222222-2222-4222-8222-222222222222"
    settings = settings_factory()
    application = create_app(settings)
    application.dependency_overrides[require_verified_owner] = lambda: SimpleNamespace(
        csrf_token=CSRF,
        user=SimpleNamespace(id=UUID(OWNER_ID)),
    )

    async def unexpected_write(*args, **kwargs):
        raise AssertionError("sync write must not run for an owner mismatch")

    monkeypatch.setattr(sync_api, "record_operation", unexpected_write)
    monkeypatch.setattr(sync_api, "read_owner_sync_head", unexpected_write)

    with TestClient(application, base_url=settings.public_origin) as client:
        response = client.post(
            "/api/v1/sync/push",
            json={"operations": [operation]},
            headers={"Origin": settings.public_origin, "X-CSRF-Token": encode_base64url(CSRF)},
        )

    assert response.status_code == 403
    assert response.json()["code"] == "owner_mismatch"
