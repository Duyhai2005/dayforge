from types import SimpleNamespace
from uuid import UUID

from fastapi.testclient import TestClient

from app.main import create_app
from app.schemas.sync import SyncPage
from app.services.sessions import require_verified_owner

OWNER_ID = "11111111-1111-4111-8111-111111111111"
EPOCH = "22222222-2222-4222-8222-222222222222"


def _install_verified_owner(application):
    application.dependency_overrides[require_verified_owner] = lambda: SimpleNamespace(
        csrf_token=b"x" * 32,
        user=SimpleNamespace(id=UUID(OWNER_ID)),
    )


def _empty_page():
    return SyncPage(
        epoch=EPOCH,
        through_cursor="0",
        next_cursor="0",
        has_more=False,
        next_page_token=None,
        groups=[],
    )


def test_bootstrap_and_pull_success_responses_are_no_store(settings_factory, monkeypatch):
    from app.api import sync as sync_api

    settings = settings_factory()
    application = create_app(settings)
    _install_verified_owner(application)
    calls = []

    async def read_page(_database, owner_id, **kwargs):
        calls.append((owner_id, kwargs["endpoint"], kwargs["after_cursor"], kwargs["request_epoch"]))
        return _empty_page()

    monkeypatch.setattr(sync_api, "read_sync_page", read_page)
    with TestClient(application, base_url=settings.public_origin) as client:
        bootstrap = client.get("/api/v1/sync/bootstrap")
        pull = client.get("/api/v1/sync/pull", params={"after": "0", "epoch": EPOCH})

    assert bootstrap.status_code == 200
    assert pull.status_code == 200
    assert bootstrap.headers["cache-control"] == "no-store"
    assert pull.headers["cache-control"] == "no-store"
    assert calls == [(UUID(OWNER_ID), "bootstrap", None, None), (UUID(OWNER_ID), "pull", 0, UUID(EPOCH))]


def test_page_token_is_verified_before_database_access(settings_factory, monkeypatch):
    from app.api import sync as sync_api

    settings = settings_factory()
    application = create_app(settings)
    _install_verified_owner(application)

    async def unexpected_read(*args, **kwargs):
        raise AssertionError("invalid page token must be rejected before reading the database")

    monkeypatch.setattr(sync_api, "read_sync_page", unexpected_read)
    with TestClient(application, base_url=settings.public_origin) as client:
        response = client.get("/api/v1/sync/bootstrap", params={"page_token": "tampered"})

    assert response.status_code == 400
    assert response.json()["code"] == "malformed_request"
    assert response.headers["cache-control"] == "no-store"


def test_pull_continuation_does_not_accept_new_cursor_parameters(settings_factory, monkeypatch):
    from app.api import sync as sync_api

    settings = settings_factory()
    application = create_app(settings)
    _install_verified_owner(application)

    async def unexpected_read(*args, **kwargs):
        raise AssertionError("mixed continuation and cursor parameters must be rejected before a read")

    monkeypatch.setattr(sync_api, "read_sync_page", unexpected_read)
    with TestClient(application, base_url=settings.public_origin) as client:
        response = client.get(
            "/api/v1/sync/pull",
            params={"page_token": "opaque", "after": "0", "epoch": EPOCH},
        )

    assert response.status_code == 400
    assert response.json()["code"] == "malformed_request"
