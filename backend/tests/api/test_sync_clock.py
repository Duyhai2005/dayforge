from fastapi.testclient import TestClient

from app.main import create_app
from app.services.sessions import require_verified_owner

DEVICE_ID = "33333333-3333-4333-8333-333333333333"


def test_sync_clock_requires_verified_owner(auth_client):
    response = auth_client.get("/api/v1/sync/clock", params={"device_id": DEVICE_ID})

    assert response.status_code == 401
    assert response.json()["code"] == "authentication_required"


def test_sync_clock_returns_contract_fields_and_no_store(settings_factory):
    settings = settings_factory()
    application = create_app(settings)
    application.dependency_overrides[require_verified_owner] = lambda: None

    with TestClient(application, base_url=settings.public_origin) as client:
        response = client.get("/api/v1/sync/clock", params={"device_id": DEVICE_ID})

    assert response.status_code == 200
    body = response.json()
    assert body["calibration_id"]
    assert type(body["server_time_ms"]) is int
    assert body["server_time"].endswith("Z")
    assert body["max_future_skew_ms"] == 300000
    assert response.headers["cache-control"] == "no-store"


def test_sync_clock_rejects_noncanonical_device_uuid(auth_client):
    response = auth_client.get("/api/v1/sync/clock", params={"device_id": DEVICE_ID.upper()})

    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")
