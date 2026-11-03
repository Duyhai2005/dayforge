"""Persistence acceptance for the verified-owner flow."""

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select, text

from app.core.database import create_database
from app.models.auth import EmailDeliveryJob, EmailToken, OwnerLocalKey, Session
from app.models.owner import User, WorkspaceSettings
from app.services.auth_crypto import decode_key

pytestmark = pytest.mark.mysql
BACKEND = Path(__file__).resolve().parents[2]


def _alembic(*arguments: str) -> None:
    result = subprocess.run(
        [sys.executable, "-m", "alembic", *arguments],
        cwd=BACKEND,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, "Alembic command failed (output suppressed)"


@pytest.fixture
def auth_database(mysql_test_settings):
    _alembic("downgrade", "base")
    _alembic("upgrade", "head")
    try:
        yield mysql_test_settings
    finally:
        _alembic("downgrade", "base")


class AuthClient:
    def __init__(self, client, origin: str):
        self.client = client
        self.origin = origin
        session = client.get("/api/v1/auth/session")
        assert session.status_code == 200
        self.csrf = session.json()["csrf_token"]

    def post(self, path: str, *, json_body: dict):
        response = self.client.post(
            "/api/v1/auth/" + path,
            json=json_body,
            headers={"origin": self.origin, "x-csrf-token": self.csrf},
        )
        if response.headers.get("content-type", "").startswith("application/json"):
            self.csrf = response.json().get("csrf_token", self.csrf)
        return response


@pytest.fixture
def auth_client(auth_database):
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(
        create_app(auth_database), base_url=auth_database.public_origin
    ) as client:
        yield AuthClient(client, auth_database.public_origin)


async def _payloads(settings) -> list[dict[str, str]]:
    database = create_database(settings)
    try:
        async with database.sessions() as session:
            jobs = (
                await session.scalars(
                    select(EmailDeliveryJob).order_by(EmailDeliveryJob.created_at)
                )
            ).all()
            key = decode_key(settings.auth_email_outbox_key_b64.get_secret_value())
            return [
                json.loads(AESGCM(key).decrypt(job.iv, job.ciphertext, job.id.bytes))
                for job in jobs
            ]
    finally:
        await database.engine.dispose()


def _run(coro):
    return asyncio.run(coro)


def _token(payload: dict[str, str]) -> str:
    return urlsplit(payload["link"]).fragment.removeprefix("token=")


def _register_and_verify(auth_client, settings):
    response = auth_client.post(
        "register", json_body={"email": settings.owner_email.get_secret_value()}
    )
    assert response.status_code == 202
    payload = _run(_payloads(settings))[0]
    assert set(payload) == {"to", "subject", "link"}
    assert payload["to"] == settings.owner_email.get_secret_value()
    assert "#token=" in payload["link"]
    assert "?token=" not in payload["link"]
    return auth_client.post(
        "verification/confirm",
        json_body={
            "token": _token(payload),
            "password": "A sufficiently long password for Dayforge",
        },
    )


def test_register_is_neutral_for_non_allowlisted_email(auth_client, auth_database):
    response = auth_client.post("register", json_body={"email": "other@example.net"})
    assert response.status_code == 202
    assert response.json() == {"status": "accepted", "resend_after_seconds": 60}

    async def counts():
        database = create_database(auth_database)
        try:
            async with database.engine.connect() as connection:
                result = await connection.execute(
                    text(
                        "SELECT (SELECT COUNT(*) FROM users), (SELECT COUNT(*) FROM auth_email_tokens), "
                        "(SELECT COUNT(*) FROM auth_email_delivery_jobs)"
                    )
                )
                return result.one()
        finally:
            await database.engine.dispose()

    assert _run(counts()) == (0, 0, 0)


def test_verify_creates_owner_workspace_and_wrapped_key_atomically(
    auth_client, auth_database
):
    response = _register_and_verify(auth_client, auth_database)
    assert response.status_code == 200
    assert response.json() == {"status": "verified"}

    async def read_state():
        database = create_database(auth_database)
        try:
            async with database.sessions() as session:
                owner = await session.scalar(select(User))
                workspace = await session.get(WorkspaceSettings, owner.id)
                key = await session.get(OwnerLocalKey, owner.id)
                tokens = (await session.scalars(select(EmailToken))).all()
                return owner, workspace, key, tokens
        finally:
            await database.engine.dispose()

    owner, workspace, key, tokens = _run(read_state())
    assert owner.email_canonical == auth_database.owner_email.get_secret_value().encode(
        "ascii"
    )
    assert owner.auth_version == 1
    assert workspace.time_zone == "Asia/Bangkok"
    assert (workspace.utc_offset_minutes, workspace.week_start) == (420, 1)
    assert key.algorithm == "A256GCM"
    assert len(key.wrapped_key) == 60
    assert tokens[0].consumed_at is not None


def test_login_rotates_session_and_local_key_requires_recent_password(auth_database):
    from fastapi.testclient import TestClient

    from app.main import create_app

    app = create_app(auth_database)
    with TestClient(app, base_url=auth_database.public_origin) as browser:
        first = AuthClient(browser, auth_database.public_origin)
        verified = _register_and_verify(first, auth_database)
        assert verified.status_code == 200
        anon_cookie = browser.cookies.get("__Host-dayforge-session")
        login = first.post(
            "login",
            json_body={
                "email": auth_database.owner_email.get_secret_value(),
                "password": "A sufficiently long password for Dayforge",
                "remember_me": True,
            },
        )
        assert login.status_code == 200
        body = login.json()
        assert body["authenticated"] is True
        assert body["logout_ticket"] and len(body["logout_ticket"]) == 64
        assert body["session"]["remember_me"] is True
        assert "max-age=" in login.headers["set-cookie"].lower()
        assert "secure" in login.headers["set-cookie"].lower()
        assert browser.cookies.get("__Host-dayforge-session") != anon_cookie
        key_response = browser.get("/api/v1/auth/local-key")
        assert key_response.status_code == 200
        assert len(key_response.json()["key_base64url"]) == 43
        assert key_response.headers["cache-control"] == "private, no-store"

    async def count_sessions():
        database = create_database(auth_database)
        try:
            async with database.sessions() as session:
                rows = (await session.scalars(select(Session))).all()
                return rows
        finally:
            await database.engine.dispose()

    sessions = _run(count_sessions())
    assert len(sessions) == 2
    assert sum(row.revoked_at is not None for row in sessions) == 1
