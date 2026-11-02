import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

from fastapi.testclient import TestClient

from app.main import create_app
from app.schemas.sync import SyncPage, SyncPageGroup
from app.services.sessions import require_verified_owner

OWNER_ID = "11111111-1111-4111-8111-111111111111"
EPOCH = "22222222-2222-4222-8222-222222222222"
EXAMPLES = Path(__file__).resolve().parents[2].parent / "docs" / "tasks" / "t03" / "contract-examples.json"


def _install_verified_owner(application):
    application.dependency_overrides[require_verified_owner] = lambda: SimpleNamespace(
        csrf_token=b"x" * 32,
        user=SimpleNamespace(id=UUID(OWNER_ID)),
    )


def _empty_page(through_cursor="0"):
    return SyncPage(
        epoch=EPOCH,
        through_cursor=through_cursor,
        next_cursor=through_cursor,
        has_more=False,
        next_page_token=None,
        groups=[],
    )


def test_empty_bootstrap_and_pull_responses_match_contract_and_are_no_store(
    settings_factory, monkeypatch, contract_validator
):
    from app.api import sync as sync_api

    settings = settings_factory()
    application = create_app(settings)
    _install_verified_owner(application)
    calls = []

    async def read_page(_database, owner_id, **kwargs):
        calls.append((owner_id, kwargs["endpoint"], kwargs.get("after_cursor"), kwargs.get("request_epoch")))
        return _empty_page("7" if kwargs["endpoint"] == "pull" else "0")

    monkeypatch.setattr(sync_api, "read_sync_page", read_page)
    with TestClient(application, base_url=settings.public_origin) as client:
        bootstrap = client.get("/api/v1/sync/bootstrap")
        pull = client.get("/api/v1/sync/pull", params={"after": "7", "epoch": EPOCH})

    assert bootstrap.status_code == 200
    assert pull.status_code == 200
    contract_validator("SyncPage").validate(bootstrap.json())
    contract_validator("SyncPage").validate(pull.json())
    assert bootstrap.json()["groups"] == []
    assert pull.json()["groups"] == []
    assert bootstrap.json()["next_cursor"] == bootstrap.json()["through_cursor"]
    assert pull.json()["next_cursor"] == pull.json()["through_cursor"]
    assert pull.json()["next_cursor"] == "7"
    assert bootstrap.headers["cache-control"] == "no-store"
    assert pull.headers["cache-control"] == "no-store"
    assert calls == [(UUID(OWNER_ID), "bootstrap", None, None), (UUID(OWNER_ID), "pull", 7, UUID(EPOCH))]


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
    assert response.headers["content-type"].startswith("application/problem+json")


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
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-type"].startswith("application/problem+json")


def test_bootstrap_continuation_preserves_h_and_advances_until_final_page(
    settings_factory, monkeypatch, contract_validator
):
    from app.api import sync as sync_api
    from app.services.sync_tokens import create_page_token

    settings = settings_factory()
    application = create_app(settings)
    _install_verified_owner(application)
    now = int(datetime.now(timezone.utc).timestamp())
    token = create_page_token(
        settings.secret_key("sync_page_token_key_b64"),
        endpoint="bootstrap",
        owner_id=UUID(OWNER_ID),
        epoch=UUID(EPOCH),
        after_cursor=0,
        through_cursor=2,
        position=1,
        now=now,
    )
    example = json.loads(EXAMPLES.read_text(encoding="utf-8"))
    operation = next(
        fixture["value"] for fixture in example["fixtures"] if fixture["name"] == "work-item-create-operation"
    )
    next_operation = json.loads(json.dumps(operation))
    next_operation["operation_id"] = "44444444-4444-4444-8444-444444444444"
    next_operation["device_sequence"] = "2"
    first_page = SyncPage(
        epoch=EPOCH,
        through_cursor="2",
        next_cursor="1",
        has_more=True,
        next_page_token=token,
        groups=[
            SyncPageGroup(
                cursor="1",
                committed_at="2026-11-01T12:00:00.000Z",
                operation=operation,
            )
        ],
    )
    last_page = SyncPage(
        epoch=EPOCH,
        through_cursor="2",
        next_cursor="2",
        has_more=False,
        next_page_token=None,
        groups=[
            SyncPageGroup(
                cursor="2",
                committed_at="2026-11-01T12:00:01.000Z",
                operation=next_operation,
            )
        ],
    )
    calls = []

    async def read_page(_database, owner_id, **kwargs):
        assert owner_id == UUID(OWNER_ID)
        calls.append(kwargs)
        return first_page if kwargs["page_token"] is None else last_page

    monkeypatch.setattr(sync_api, "read_sync_page", read_page)
    with TestClient(application, base_url=settings.public_origin) as client:
        first = client.get("/api/v1/sync/bootstrap")
        second = client.get("/api/v1/sync/bootstrap", params={"page_token": first.json()["next_page_token"]})

    for response in (first, second):
        assert response.status_code == 200
        contract_validator("SyncPage").validate(response.json())
        assert response.headers["cache-control"] == "no-store"
    assert first.json()["through_cursor"] == second.json()["through_cursor"] == "2"
    assert first.json()["next_cursor"] == "1"
    assert first.json()["has_more"] is True
    assert second.json()["next_cursor"] == "2"
    assert second.json()["has_more"] is False
    assert second.json()["next_page_token"] is None
    assert calls[1]["page_token"].through_cursor == 2
