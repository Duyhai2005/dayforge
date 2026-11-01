import asyncio
import base64
import hashlib
import os
import subprocess
import sys
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.database import create_database
from app.main import create_app
from app.models.auth import Session as AuthSession
from app.models.owner import User
from app.services.auth_crypto import create_logout_ticket

pytestmark = pytest.mark.mysql
BACKEND = Path(__file__).resolve().parents[2]
COOKIE_NAME = "__Host-dayforge-session"


def alembic(*arguments):
    result = subprocess.run(
        [sys.executable, "-m", "alembic", *arguments],
        cwd=BACKEND,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
    )
    code = result.returncode
    del result
    assert code == 0, "Alembic command failed (output suppressed for secret safety)"


@pytest.fixture
def auth_database(mysql_test_settings):
    alembic("downgrade", "base")
    alembic("upgrade", "head")
    yield mysql_test_settings
    alembic("downgrade", "base")


@pytest.fixture
def auth_client(auth_database):
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="Using `httpx` with `starlette.testclient` is deprecated.*",
        )
        with TestClient(create_app(auth_database), base_url=auth_database.public_origin) as client:
            yield client


def encoded_token(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def insert_owner_and_sessions(settings, session_specs):
    owner_id = uuid4()
    now = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)
    owner = User(
        id=owner_id,
        owner_slot=1,
        email_canonical=b"Owner@example.test",
        email_delivery="Owner@example.test",
        password_hash="$argon2id$v=19$test-session-fixture",
        email_verified_at=now,
        auth_version=1,
        created_at=now,
        updated_at=now,
    )
    records = {}
    for name, values in session_specs.items():
        raw_token = values.pop("raw_token", bytes([len(records) + 1]) * 32)
        identifier = values.pop("id", uuid4())
        csrf = values.pop("csrf_token", bytes([len(records) + 11]) * 32)
        record = AuthSession(
            id=identifier,
            kind="authenticated",
            token_hash=hashlib.sha256(raw_token).digest(),
            owner_id=owner_id,
            csrf_token=csrf,
            auth_version=values.pop("auth_version", 1),
            password_authenticated_at=values.pop("password_authenticated_at", now - timedelta(minutes=1)),
            remember_me=values.pop("remember_me", False),
            created_at=values.pop("created_at", now - timedelta(minutes=2)),
            last_activity_at=values.pop("last_activity_at", now - timedelta(minutes=2)),
            idle_expires_at=values.pop("idle_expires_at", now + timedelta(minutes=30)),
            absolute_expires_at=values.pop("absolute_expires_at", now + timedelta(hours=12)),
            revoked_at=values.pop("revoked_at", None),
        )
        assert not values
        records[name] = (record, raw_token, csrf)

    async def insert():
        database = create_database(settings)
        try:
            async with database.sessions() as db:
                async with db.begin():
                    db.add(owner)
                    await db.flush()
                    db.add_all(record for record, _, _ in records.values())
        finally:
            await database.engine.dispose()

    asyncio.run(insert())
    return owner_id, records


async def database_sessions(settings, identifiers):
    database = create_database(settings)
    try:
        async with database.sessions() as db:
            rows = (await db.execute(select(AuthSession).where(AuthSession.id.in_(identifiers)))).scalars().all()
            return {row.id: row for row in rows}
    finally:
        await database.engine.dispose()


def test_anonymous_session_shares_csrf_across_tabs(auth_database, auth_client):
    first = auth_client.get("/api/v1/auth/session")
    second = auth_client.get("/api/v1/auth/session")

    assert first.status_code == second.status_code == 200
    assert first.json()["authenticated"] is False
    assert first.json()["owner"] is None
    assert first.json()["session"] is None
    assert first.json()["logout_ticket"] is None
    assert first.json()["csrf_token"] == second.json()["csrf_token"]
    cookie = first.headers["set-cookie"].lower()
    assert f"{COOKIE_NAME.lower()}=" in cookie
    assert "httponly" in cookie
    assert "secure" in cookie
    assert "samesite=lax" in cookie
    assert "path=/" in cookie
    assert "domain=" not in cookie
    assert "max-age=" not in cookie
    assert "cache-control" in first.headers
    assert first.headers["cache-control"] == "private, no-store"
    assert first.headers["pragma"] == "no-cache"


def test_authenticated_session_enforces_idle_absolute_and_auth_version(auth_database, auth_client, monkeypatch):
    from app.services import sessions

    now = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(sessions, "utc_now", lambda: now)
    owner_id, records = insert_owner_and_sessions(
        auth_database,
        {
            "valid": {},
            "idle_expired": {"idle_expires_at": now},
            "absolute_expired": {
                "idle_expires_at": now - timedelta(minutes=1),
                "absolute_expires_at": now,
            },
            "version_mismatch": {"auth_version": 2},
        },
    )
    valid, valid_token, _ = records["valid"]
    response = auth_client.get(
        "/api/v1/auth/session",
        headers={"Cookie": f"{COOKIE_NAME}={encoded_token(valid_token)}"},
    )
    assert response.status_code == 200
    assert response.json()["authenticated"] is True
    assert response.json()["owner"]["id"] == str(owner_id)
    assert response.json()["session"]["password_authenticated_at"].endswith("Z")
    assert response.json()["session"]["idle_expires_at"] == "2026-11-01T12:30:00.000Z"

    for name in ("idle_expired", "absolute_expired", "version_mismatch"):
        _, token, _ = records[name]
        rejected = auth_client.get(
            "/api/v1/auth/session",
            headers={"Cookie": f"{COOKIE_NAME}={encoded_token(token)}"},
        )
        assert rejected.status_code == 200
        assert rejected.json()["authenticated"] is False
        assert rejected.json()["owner"] is None
        assert rejected.json()["session"] is None

    stored = asyncio.run(database_sessions(auth_database, [valid.id]))[valid.id]
    assert stored.password_authenticated_at == now - timedelta(minutes=1)


def test_logout_ticket_revokes_only_target_session(auth_database, auth_client, monkeypatch):
    from app.services import sessions

    now = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(sessions, "utc_now", lambda: now)
    _, records = insert_owner_and_sessions(auth_database, {"target": {}, "current": {}})
    target, _, _ = records["target"]
    current, current_token, _ = records["current"]
    session_view = auth_client.get(
        "/api/v1/auth/session",
        headers={"Cookie": f"{COOKIE_NAME}={encoded_token(current_token)}"},
    ).json()
    ticket = create_logout_ticket(target.id, auth_database.secret_key("logout_ticket_key_b64"))
    response = auth_client.post(
        "/api/v1/auth/logout",
        json={"logout_ticket": ticket},
        headers={
            "Cookie": f"{COOKIE_NAME}={encoded_token(current_token)}",
            "Origin": auth_database.public_origin,
            "X-CSRF-Token": session_view["csrf_token"],
        },
    )

    assert response.status_code == 204
    assert "set-cookie" not in response.headers
    stored = asyncio.run(database_sessions(auth_database, [target.id, current.id]))
    assert stored[target.id].revoked_at == now
    assert stored[current.id].revoked_at is None


def test_logout_ticket_survives_key_rotation_until_session_expiry(
    auth_database, auth_client, monkeypatch, settings_factory
):
    from app.services import sessions

    now = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(sessions, "utc_now", lambda: now)
    _, records = insert_owner_and_sessions(auth_database, {"target": {}, "current": {}})
    target, _, _ = records["target"]
    current, current_token, _ = records["current"]
    session_view = auth_client.get(
        "/api/v1/auth/session",
        headers={"Cookie": f"{COOKIE_NAME}={encoded_token(current_token)}"},
    ).json()
    ticket = create_logout_ticket(target.id, auth_database.secret_key("logout_ticket_key_b64"))
    rotated_settings = settings_factory(
        logout_ticket_key_b64=encoded_token(bytes([23]) * 32),
        logout_ticket_previous_keys_b64=(auth_database.logout_ticket_key_b64.get_secret_value()),
    )
    monkeypatch.setattr(auth_client.app.state, "settings", rotated_settings)

    response = auth_client.post(
        "/api/v1/auth/logout",
        json={"logout_ticket": ticket},
        headers={
            "Cookie": f"{COOKIE_NAME}={encoded_token(current_token)}",
            "Origin": auth_database.public_origin,
            "X-CSRF-Token": session_view["csrf_token"],
        },
    )

    assert response.status_code == 204
    stored = asyncio.run(database_sessions(auth_database, [target.id, current.id]))
    assert stored[target.id].revoked_at == now
    assert stored[current.id].revoked_at is None
