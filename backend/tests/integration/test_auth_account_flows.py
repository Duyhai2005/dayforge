import asyncio
import hashlib
import re
import subprocess
import sys
import warnings
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.core.database import create_database
from app.core.errors import ProblemHTTPException
from app.main import create_app
from app.models.auth import (
    AuthRateLimit,
    EmailDeliveryJob,
    EmailToken,
    OwnerLocalKey,
)
from app.models.auth import (
    Session as AuthSession,
)
from app.models.owner import User, WorkspaceSettings
from app.services.auth import _apply_limits, _Limit
from app.services.auth_crypto import (
    WrappedKey,
    decode_base64url,
    unwrap_owner_key,
    wrap_owner_key,
)
from app.services.email_delivery import deliver_pending_jobs
from app.services.passwords import hash_password, verify_password

pytestmark = pytest.mark.mysql
BACKEND = Path(__file__).resolve().parents[2]
PASSWORD = "Sundial Maple Crane 7429"
NEW_PASSWORD = "Sundial Cedar Harbor 8153"


def alembic(*arguments):
    result = subprocess.run(
        [sys.executable, "-m", "alembic", *arguments],
        cwd=BACKEND,
        env=__import__("os").environ.copy(),
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


def new_client(settings):
    return TestClient(create_app(settings), base_url=settings.public_origin)


def post_auth(client, settings, path, body):
    session = client.get("/api/v1/auth/session")
    assert session.status_code == 200
    return client.post(
        f"/api/v1/auth/{path}",
        json=body,
        headers={
            "Origin": settings.public_origin,
            "X-CSRF-Token": session.json()["csrf_token"],
        },
    )


def _run_with_database(settings, operation):
    async def run():
        database = create_database(settings)
        try:
            return await operation(database)
        finally:
            await database.engine.dispose()

    return asyncio.run(run())


def _insert_owner(settings, password=PASSWORD):
    owner_id = uuid4()
    key_id = uuid4()
    now = datetime.now(timezone.utc).replace(microsecond=0)
    raw_key = bytes(range(32))
    wrapped = wrap_owner_key(
        owner_id,
        key_id,
        raw_key,
        settings.secret_key("local_key_kek_b64"),
        settings.local_key_kek_version,
    )
    user = User(
        id=owner_id,
        owner_slot=1,
        email_canonical=b"owner@example.test",
        email_delivery="owner@example.test",
        password_hash=hash_password(password),
        email_verified_at=now,
        auth_version=1,
        created_at=now,
        updated_at=now,
    )
    workspace = WorkspaceSettings(owner_id=owner_id)
    local_key = OwnerLocalKey(
        owner_id=owner_id,
        key_id=key_id,
        algorithm=wrapped.algorithm,
        wrapped_key=wrapped.wrapped_key,
        kek_version=wrapped.kek_version,
        created_at=now,
    )

    async def insert(database):
        async with database.sessions() as db:
            async with db.begin():
                db.add(user)
                await db.flush()
                db.add(workspace)
                db.add(local_key)

    _run_with_database(settings, insert)
    return owner_id, key_id, raw_key


def _query_one(settings, statement):
    async def query(database):
        async with database.sessions() as db:
            return (await db.execute(statement)).scalar_one_or_none()

    return _run_with_database(settings, query)


def _query_all(settings, statement):
    async def query(database):
        async with database.sessions() as db:
            return (await db.execute(statement)).scalars().all()

    return _run_with_database(settings, query)


def _capture_pending_email(settings):
    messages: list[EmailMessage] = []

    async def deliver(database):
        return await deliver_pending_jobs(
            database,
            settings,
            send_message=lambda _host, _port, message: messages.append(message),
        )

    delivered = _run_with_database(settings, deliver)
    assert delivered == len(messages)
    return messages


def _token_from_message(message):
    match = re.search(r"#token=([A-Za-z0-9_-]{43})", message.get_content())
    assert match is not None
    return match.group(1)


def _login(client, settings, password=PASSWORD):
    return post_auth(
        client,
        settings,
        "login",
        {"email": "owner@example.test", "password": password, "remember_me": True},
    )


def test_forgot_is_neutral_for_unknown_and_non_allowlisted_email(auth_database, auth_client):
    unknown = post_auth(
        auth_client,
        auth_database,
        "password/forgot",
        {"email": "missing@example.test"},
    )
    non_allowlisted = post_auth(
        auth_client,
        auth_database,
        "password/forgot",
        {"email": "other@example.test"},
    )

    assert unknown.status_code == non_allowlisted.status_code == 202
    assert (
        unknown.json()
        == non_allowlisted.json()
        == {
            "status": "accepted",
            "resend_after_seconds": 60,
        }
    )
    assert not _query_all(auth_database, select(EmailDeliveryJob))


def test_owner_email_binding_mismatch_fails_startup(auth_database):
    from app.core.config import SettingsError

    _insert_owner(auth_database)
    changed = auth_database.model_copy(
        update={
            "app_env": "development",
            "owner_email": "changed@example.test",
        }
    )

    with pytest.raises(SettingsError, match="OWNER_EMAIL"):
        with TestClient(create_app(changed), base_url=changed.public_origin):
            pass


def test_verify_creates_owner_workspace_and_wrapped_key_atomically(auth_database, auth_client):
    requested = post_auth(auth_client, auth_database, "register", {"email": "owner@example.test"})
    assert requested.status_code == 202
    messages = _capture_pending_email(auth_database)
    assert len(messages) == 1
    token = _token_from_message(messages[0])

    confirmed = post_auth(
        auth_client,
        auth_database,
        "verification/confirm",
        {"token": token, "password": PASSWORD},
    )

    assert confirmed.status_code == 200
    assert confirmed.json() == {"status": "verified"}
    owner = _query_one(auth_database, select(User))
    workspace = _query_one(auth_database, select(WorkspaceSettings))
    local_key = _query_one(auth_database, select(OwnerLocalKey))
    assert owner is not None and workspace is not None and local_key is not None
    assert owner.email_verified_at is not None
    assert workspace.owner_id == owner.id
    assert (
        workspace.time_zone,
        workspace.utc_offset_minutes,
        workspace.week_start,
    ) == (
        "Asia/Bangkok",
        420,
        1,
    )
    assert unwrap_owner_key(
        owner.id,
        local_key.key_id,
        WrappedKey(local_key.algorithm, local_key.wrapped_key, local_key.kek_version),
        auth_database.secret_key("local_key_kek_b64"),
        auth_database.local_key_kek_version,
    )
    session = auth_client.get("/api/v1/auth/session")
    assert session.json()["authenticated"] is False


def test_email_get_does_not_consume_token(auth_database, auth_client):
    post_auth(auth_client, auth_database, "register", {"email": "owner@example.test"})
    token = _query_one(auth_database, select(EmailToken))
    assert token is not None

    response = auth_client.get("/api/v1/auth/verification/confirm", params={"token": "redacted"})

    unchanged = _query_one(auth_database, select(EmailToken).where(EmailToken.id == token.id))
    assert response.status_code == 405
    assert unchanged is not None and unchanged.consumed_at is None


def test_used_token_returns_email_token_used_without_reapplying(auth_database, auth_client):
    post_auth(auth_client, auth_database, "register", {"email": "owner@example.test"})
    token = _token_from_message(_capture_pending_email(auth_database)[0])
    first = post_auth(
        auth_client,
        auth_database,
        "verification/confirm",
        {"token": token, "password": PASSWORD},
    )
    second = post_auth(
        auth_client,
        auth_database,
        "verification/confirm",
        {"token": token, "password": NEW_PASSWORD},
    )

    assert first.status_code == 200
    assert second.status_code == 409
    assert second.json()["code"] == "email_token_used"
    assert _query_one(auth_database, select(func.count()).select_from(User)) == 1


def test_expired_token_digest_is_pruned_after_7_days(auth_database):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    token = EmailToken(
        id=uuid4(),
        purpose="verify_email",
        token_hash=hashlib.sha256(b"expired-token-digest").digest(),
        email_canonical=b"owner@example.test",
        owner_id=None,
        created_at=now - timedelta(days=10),
        expires_at=now - timedelta(days=9),
        consumed_at=None,
        invalidated_at=None,
    )

    async def insert(database):
        async with database.sessions() as db:
            async with db.begin():
                db.add(token)

    _run_with_database(auth_database, insert)
    _capture_pending_email(auth_database)

    assert _query_one(auth_database, select(EmailToken).where(EmailToken.id == token.id)) is None


def test_token_expired_at_boundary_and_wrong_purpose_is_rejected(auth_database, auth_client, monkeypatch):
    import app.services.auth as auth_service

    now = datetime.now(timezone.utc).replace(microsecond=0)
    monkeypatch.setattr(auth_service, "utc_now", lambda: now)
    post_auth(auth_client, auth_database, "register", {"email": "owner@example.test"})
    verify_token = _token_from_message(_capture_pending_email(auth_database)[0])
    row = _query_one(auth_database, select(EmailToken))
    assert row is not None

    async def mutate(database):
        async with database.sessions() as db:
            async with db.begin():
                current = await db.get(EmailToken, row.id)
                current.created_at = now - timedelta(days=1)
                current.expires_at = now
                current.purpose = "password_reset"

    _run_with_database(auth_database, mutate)
    wrong_purpose = post_auth(
        auth_client,
        auth_database,
        "verification/confirm",
        {"token": verify_token, "password": PASSWORD},
    )
    assert wrong_purpose.status_code == 400
    assert wrong_purpose.json()["code"] == "email_token_invalid"

    async def restore(database):
        async with database.sessions() as db:
            async with db.begin():
                current = await db.get(EmailToken, row.id)
                current.purpose = "verify_email"

    _run_with_database(auth_database, restore)
    expired = post_auth(
        auth_client,
        auth_database,
        "verification/confirm",
        {"token": verify_token, "password": PASSWORD},
    )
    assert expired.status_code == 410
    assert expired.json()["code"] == "email_token_expired"


def test_verification_race_creates_one_owner(auth_database, auth_client):
    post_auth(auth_client, auth_database, "register", {"email": "owner@example.test"})
    token = _token_from_message(_capture_pending_email(auth_database)[0])
    with new_client(auth_database) as first, new_client(auth_database) as second:

        def confirm(client):
            return post_auth(
                client,
                auth_database,
                "verification/confirm",
                {"token": token, "password": PASSWORD},
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(confirm, (first, second)))

    assert sorted(response.status_code for response in responses) == [200, 409]
    assert _query_one(auth_database, select(func.count()).select_from(User)) == 1
    assert _query_one(auth_database, select(func.count()).select_from(WorkspaceSettings)) == 1


def test_login_rotates_session_and_sets_remembered_cookie(auth_database, auth_client):
    _insert_owner(auth_database)
    anonymous = auth_client.get("/api/v1/auth/session")
    old_cookie = anonymous.cookies.get("__Host-dayforge-session")

    response = _login(auth_client, auth_database)

    assert response.status_code == 200
    assert response.json()["authenticated"] is True
    cookie = response.headers["set-cookie"].lower()
    assert "max-age=" in cookie
    assert "secure" in cookie and "httponly" in cookie and "samesite=lax" in cookie
    assert response.cookies.get("__Host-dayforge-session") != old_cookie
    sessions = _query_all(auth_database, select(AuthSession).order_by(AuthSession.created_at))
    assert len(sessions) == 2
    assert sessions[0].kind == "anonymous" and sessions[0].revoked_at is not None
    assert sessions[1].kind == "authenticated" and bool(sessions[1].remember_me)


def test_two_devices_get_distinct_sessions_for_same_owner_and_stable_key(auth_database, auth_client):
    owner_id, key_id, raw_key = _insert_owner(auth_database)
    with new_client(auth_database) as second:
        one = _login(auth_client, auth_database)
        two = _login(second, auth_database)
        assert one.status_code == two.status_code == 200
        assert one.json()["session"]["id"] != two.json()["session"]["id"]
        one_key = auth_client.get("/api/v1/auth/local-key")
        two_key = second.get("/api/v1/auth/local-key")

    assert one_key.status_code == two_key.status_code == 200
    assert one_key.json() == two_key.json()
    assert one_key.json()["owner_id"] == str(owner_id)
    assert one_key.json()["key_id"] == str(key_id)
    assert decode_base64url(one_key.json()["key_base64url"], 32) == raw_key


def test_unknown_user_uses_dummy_argon2_and_same_credentials_error(auth_database, auth_client, monkeypatch):
    import app.services.auth as auth_service
    from app.services.passwords import DUMMY_PASSWORD_HASH

    _insert_owner(auth_database)
    calls = []
    real_verify = verify_password

    def capture(password, password_hash):
        calls.append(password_hash)
        return real_verify(password, password_hash)

    monkeypatch.setattr(auth_service, "verify_password", capture)
    wrong_password = post_auth(
        auth_client,
        auth_database,
        "login",
        {
            "email": "owner@example.test",
            "password": "wrong password value",
            "remember_me": True,
        },
    )
    unknown_user = post_auth(
        auth_client,
        auth_database,
        "login",
        {
            "email": "missing@example.test",
            "password": "wrong password value",
            "remember_me": True,
        },
    )

    assert wrong_password.status_code == unknown_user.status_code == 401
    assert wrong_password.json()["code"] == unknown_user.json()["code"] == "invalid_credentials"
    assert calls[0] != DUMMY_PASSWORD_HASH
    assert calls[1] == DUMMY_PASSWORD_HASH


def test_reset_revokes_sessions_but_preserves_owner_key(auth_database, auth_client):
    owner_id, key_id, raw_key = _insert_owner(auth_database)
    with new_client(auth_database) as second:
        assert _login(auth_client, auth_database).status_code == 200
        assert _login(second, auth_database).status_code == 200
        assert (
            post_auth(
                auth_client,
                auth_database,
                "password/forgot",
                {"email": "owner@example.test"},
            ).status_code
            == 202
        )
        token = _token_from_message(_capture_pending_email(auth_database)[0])
        reset = post_auth(
            auth_client,
            auth_database,
            "password/reset",
            {"token": token, "password": NEW_PASSWORD},
        )
        assert reset.status_code == 200
        old_session = auth_client.get("/api/v1/auth/session")
        other_session = second.get("/api/v1/auth/session")
        new_login = _login(auth_client, auth_database, NEW_PASSWORD)

    assert reset.json() == {"status": "password_reset"}
    assert old_session.json()["authenticated"] is False
    assert other_session.json()["authenticated"] is False
    assert new_login.status_code == 200
    stored_user = _query_one(auth_database, select(User).where(User.id == owner_id))
    local_key = _query_one(auth_database, select(OwnerLocalKey).where(OwnerLocalKey.owner_id == owner_id))
    assert stored_user is not None and stored_user.auth_version == 2
    assert local_key is not None and local_key.key_id == key_id
    assert (
        unwrap_owner_key(
            owner_id,
            local_key.key_id,
            WrappedKey(local_key.algorithm, local_key.wrapped_key, local_key.kek_version),
            auth_database.secret_key("local_key_kek_b64"),
            auth_database.local_key_kek_version,
        )
        == raw_key
    )


def test_reset_race_revokes_once(auth_database, auth_client):
    owner_id, _, _ = _insert_owner(auth_database)
    post_auth(
        auth_client,
        auth_database,
        "password/forgot",
        {"email": "owner@example.test"},
    )
    token = _token_from_message(_capture_pending_email(auth_database)[0])
    with new_client(auth_database) as first, new_client(auth_database) as second:

        def reset(client):
            return post_auth(
                client,
                auth_database,
                "password/reset",
                {"token": token, "password": NEW_PASSWORD},
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(reset, (first, second)))

    assert sorted(response.status_code for response in responses) == [200, 409]
    stored_user = _query_one(auth_database, select(User).where(User.id == owner_id))
    assert stored_user is not None and stored_user.auth_version == 2


def test_local_key_requires_recent_password(auth_database, auth_client, monkeypatch):
    import app.services.auth as auth_service
    import app.services.sessions as sessions

    _insert_owner(auth_database)
    login = _login(auth_client, auth_database)
    assert login.status_code == 200
    password_time = datetime.fromisoformat(login.json()["session"]["password_authenticated_at"].replace("Z", "+00:00"))
    monkeypatch.setattr(auth_service, "utc_now", lambda: password_time + timedelta(minutes=5))
    monkeypatch.setattr(sessions, "utc_now", lambda: password_time + timedelta(minutes=5))

    response = auth_client.get("/api/v1/auth/local-key")
    polled = auth_client.get("/api/v1/auth/session")
    stored = _query_one(auth_database, select(AuthSession).where(AuthSession.kind == "authenticated"))

    assert response.status_code == 403
    assert response.json()["code"] == "reauthentication_required"
    assert polled.status_code == 200
    assert stored is not None and stored.password_authenticated_at == password_time


def test_delivery_job_stores_ciphertext_only_and_sends_fragment_link(auth_database, auth_client):
    post_auth(auth_client, auth_database, "register", {"email": "owner@example.test"})
    job = _query_one(auth_database, select(EmailDeliveryJob))
    tokens = _query_all(auth_database, select(EmailToken))
    assert job is not None and len(tokens) == 1
    assert b"owner@example.test" not in job.payload_ciphertext
    messages = _capture_pending_email(auth_database)

    assert len(messages) == 1
    content = messages[0].get_content()
    assert messages[0]["To"] == "owner@example.test"
    assert "https://localhost:3000/verify-email#token=" in content
    assert "?token=" not in content and "&token=" not in content
    assert _query_one(auth_database, select(EmailDeliveryJob)) is None
    assert tokens[0].token_hash == hashlib.sha256(decode_base64url(_token_from_message(messages[0]), 32)).digest()


def test_owner_email_is_trimmed_for_delivery_and_owner_storage(auth_database):
    settings = auth_database.model_copy(update={"owner_email": " owner@example.test "})
    with new_client(settings) as client:
        requested = post_auth(client, settings, "register", {"email": "owner@example.test"})
        assert requested.status_code == 202
        messages = _capture_pending_email(settings)
        assert messages[0]["To"] == "owner@example.test"
        token = _token_from_message(messages[0])
        confirmed = post_auth(
            client,
            settings,
            "verification/confirm",
            {"token": token, "password": PASSWORD},
        )
        assert confirmed.status_code == 200
    owner = _query_one(settings, select(User))
    assert owner is not None
    assert owner.email_delivery == "owner@example.test"


def test_auth_limits_are_atomic_across_email_and_ip_buckets(auth_database, auth_client):
    first = post_auth(auth_client, auth_database, "register", {"email": "one@example.test"})
    same_email = post_auth(
        auth_client,
        auth_database,
        "verification/resend",
        {"email": "one@example.test"},
    )
    assert first.status_code == 202
    assert same_email.status_code == 429
    assert same_email.headers["retry-after"] == "60"
    assert same_email.json()["retry_after_seconds"] == 60

    accepted = 0
    for index in range(29):
        response = post_auth(
            auth_client,
            auth_database,
            "password/forgot",
            {"email": f"user-{index}@example.test"},
        )
        accepted += response.status_code == 202
    denied = post_auth(
        auth_client,
        auth_database,
        "register",
        {"email": "last@example.test"},
    )
    assert accepted == 29
    assert denied.status_code == 429
    assert denied.headers["retry-after"]
    assert _query_one(auth_database, select(func.count()).select_from(AuthRateLimit)) >= 7


def test_rate_limit_keeps_newer_committed_event_for_older_request(auth_database):
    request_started = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(seconds=2)
    newer_event_ms = int((request_started + timedelta(seconds=1)).timestamp() * 1000)
    action = "test-ordering"
    subject_kind = "email"
    subject_digest = hashlib.sha256(b"rate-limit-ordering").digest()
    limit = _Limit(action, subject_kind, subject_digest, 60, 1)

    async def exercise(database):
        async with database.sessions() as db:
            async with db.begin():
                db.add(
                    AuthRateLimit(
                        action=action,
                        subject_kind=subject_kind,
                        subject_digest=subject_digest,
                        window_seconds=60,
                        request_count=1,
                        event_timestamps=[newer_event_ms],
                        updated_at=request_started + timedelta(seconds=1),
                        expires_at=request_started + timedelta(hours=48),
                    )
                )

        with pytest.raises(ProblemHTTPException) as error:
            await _apply_limits(database, (limit,), request_started, record_event=True)
        assert error.value.code == "rate_limited"

        async with database.sessions() as db:
            row = (
                await db.execute(
                    select(AuthRateLimit).where(
                        AuthRateLimit.action == action,
                        AuthRateLimit.subject_kind == subject_kind,
                        AuthRateLimit.subject_digest == subject_digest,
                    )
                )
            ).scalar_one()
            return row.event_timestamps

    assert _run_with_database(auth_database, exercise) == [newer_event_ms]


def test_session_and_local_key_share_a_session_rate_limit(auth_database, auth_client):
    _insert_owner(auth_database)
    assert _login(auth_client, auth_database).status_code == 200

    for _ in range(60):
        response = auth_client.get("/api/v1/auth/session")
        assert response.status_code == 200

    limited = auth_client.get("/api/v1/auth/local-key")
    assert limited.status_code == 429
    assert limited.json()["code"] == "rate_limited"
