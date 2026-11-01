import base64
import warnings
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.sessions import get_session_context


@pytest.fixture
def auth_security_client(settings_factory, monkeypatch):
    csrf = bytes(range(32))
    context = SimpleNamespace(
        session=SimpleNamespace(id=uuid4()),
        user=None,
        csrf_token=csrf,
        cookie_token=None,
    )
    application = create_app(settings_factory())
    application.dependency_overrides[get_session_context] = lambda: context
    from app.api import auth

    monkeypatch.setattr(auth, "revoke_session", AsyncMock())
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="Using `httpx` with `starlette.testclient` is deprecated.*",
        )
        with TestClient(application, base_url="https://localhost:3000") as client:
            client.headers["X-CSRF-Token"] = (
                base64.urlsafe_b64encode(csrf).rstrip(b"=").decode("ascii")
            )
            yield client


def test_auth_posts_reject_untrusted_origin_or_csrf(auth_security_client):
    valid_csrf = auth_security_client.headers["X-CSRF-Token"]
    cases = [
        ({"Origin": "null"}, valid_csrf),
        ({"Origin": "https://localhost:3000.evil"}, valid_csrf),
        ({"Origin": "https://other.example"}, valid_csrf),
        ({}, valid_csrf),
        (
            {"Origin": "https://localhost:3000", "Sec-Fetch-Site": "cross-site"},
            valid_csrf,
        ),
        ({"Origin": "https://localhost:3000"}, "bad-csrf-token"),
    ]

    for origin_headers, csrf in cases:
        headers = {**origin_headers, "X-CSRF-Token": csrf}
        response = auth_security_client.post(
            "/api/v1/auth/logout", json={}, headers=headers
        )
        assert response.status_code == 403
        assert response.json()["code"] == "csrf_failed"


def test_matching_referer_is_only_origin_fallback(auth_security_client):
    response = auth_security_client.post(
        "/api/v1/auth/logout",
        json={},
        headers={
            "Referer": "https://localhost:3000/account?from=mail",
            "Sec-Fetch-Site": "same-origin",
        },
    )

    assert response.status_code == 204


def test_auth_requires_application_json(auth_security_client):
    response = auth_security_client.post(
        "/api/v1/auth/logout",
        content=b"{}",
        headers={
            "Origin": "https://localhost:3000",
            "X-CSRF-Token": auth_security_client.headers["X-CSRF-Token"],
            "Content-Type": "text/plain",
        },
    )

    assert response.status_code == 415
    assert response.json()["code"] == "unsupported_media_type"


def test_auth_response_headers_are_no_store_even_on_rejection(auth_security_client):
    response = auth_security_client.post(
        "/api/v1/auth/logout",
        json={},
        headers={
            "Origin": "https://attacker.example",
            "X-CSRF-Token": auth_security_client.headers["X-CSRF-Token"],
        },
    )

    assert response.status_code == 403
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["pragma"] == "no-cache"
    assert response.headers["vary"] == "Cookie"
