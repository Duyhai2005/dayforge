from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from app.services.sessions import SessionContext, get_session_context


def _context(settings_factory):
    now = datetime(2026, 10, 29, 1, 2, 3, 456000, tzinfo=timezone.utc)
    row = SimpleNamespace(id=uuid4(), csrf_token="A" * 43, kind="anonymous")
    return SessionContext(row=row, user=None, settings=settings_factory(), now=now)


@pytest.mark.parametrize(
    "headers",
    [
        {"origin": "https://evil.example"},
        {"origin": "null"},
        {"origin": ""},
        {"origin": "https://localhost:3000.evil.example"},
        {"origin": "https://localhost:3000", "sec-fetch-site": "cross-site"},
        {"origin": "https://localhost:3000", "x-csrf-token": "wrong"},
        {"origin": "https://localhost:3000"},
        {"x-csrf-token": "A" * 43},
    ],
)
def test_auth_posts_reject_untrusted_origin_or_csrf(settings_factory, headers):
    from fastapi.testclient import TestClient

    from app.main import create_app

    application = create_app(settings_factory())
    context = _context(settings_factory)
    application.dependency_overrides[get_session_context] = lambda: context
    with TestClient(application, base_url="https://localhost:3000") as client:
        response = client.post(
            "/api/v1/auth/register",
            json={"email": "owner@example.com"},
            headers={"content-type": "application/json", **headers},
        )
    assert response.status_code == 403
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["pragma"] == "no-cache"


def test_matching_referer_is_only_origin_fallback(settings_factory, monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import create_app
    from app.services import auth

    application = create_app(settings_factory())
    context = _context(settings_factory)
    application.dependency_overrides[get_session_context] = lambda: context
    monkeypatch.setattr(
        auth,
        "request_verification",
        AsyncMock(return_value={"status": "accepted", "resend_after_seconds": 60}),
    )
    with TestClient(application, base_url="https://localhost:3000") as client:
        response = client.post(
            "/api/v1/auth/register",
            json={"email": "owner@example.com"},
            headers={
                "content-type": "application/json",
                "referer": "https://localhost:3000/account?source=form",
                "x-csrf-token": context.row.csrf_token,
            },
        )
    assert response.status_code == 202
    assert response.json() == {"status": "accepted", "resend_after_seconds": 60}


def test_auth_requires_application_json(system_client):
    response = system_client.post(
        "/api/v1/auth/register", content='{"email":"a@example.com"}'
    )
    assert response.status_code == 415
    assert response.headers["cache-control"] == "private, no-store"


def test_auth_response_headers_are_no_store_even_on_rejection(settings_factory):
    from fastapi.testclient import TestClient

    from app.main import create_app

    application = create_app(settings_factory())
    context = _context(settings_factory)
    application.dependency_overrides[get_session_context] = lambda: context
    with TestClient(application, base_url="https://localhost:3000") as client:
        response = client.post(
            "/api/v1/auth/register",
            json={"email": "owner@example.com"},
            headers={"origin": "https://evil.example", "x-csrf-token": "x"},
        )
    assert response.status_code == 403
    assert response.headers["cache-control"] == "private, no-store"
