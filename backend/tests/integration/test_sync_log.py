"""MySQL persistence and same-origin contract tests for sync transport."""

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from time import time
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select

from app.core.database import create_database
from app.models.auth import EmailDeliveryJob
from app.models.sync import SyncOperation, SyncOwnerState
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
def sync_database(mysql_test_settings):
    _alembic("downgrade", "base")
    _alembic("upgrade", "head")
    try:
        yield mysql_test_settings
    finally:
        _alembic("downgrade", "base")


class SyncClient:
    def __init__(self, client, origin: str):
        self.client = client
        self.origin = origin
        session = client.get("/api/v1/auth/session")
        assert session.status_code == 200
        self.csrf = session.json()["csrf_token"]

    def post(self, path: str, body: dict):
        response = self.client.post(
            "/api/v1/" + path,
            json=body,
            headers={"origin": self.origin, "x-csrf-token": self.csrf},
        )
        if response.headers.get("content-type", "").startswith("application/json"):
            self.csrf = response.json().get("csrf_token", self.csrf)
        return response


def _register_verify_login(settings, client):
    assert client.post("auth/register", {"email": settings.owner_email.get_secret_value()}).status_code == 202
    database = create_database(settings)

    async def fetch_payload():
        try:
            async with database.sessions() as session:
                job = await session.scalar(select(EmailDeliveryJob).order_by(EmailDeliveryJob.created_at))
                key = decode_key(settings.auth_email_outbox_key_b64.get_secret_value())
                return json.loads(AESGCM(key).decrypt(job.iv, job.ciphertext, job.id.bytes))
        finally:
            await database.engine.dispose()

    payload = asyncio.run(fetch_payload())
    token = urlsplit(payload["link"]).fragment.removeprefix("token=")
    assert (
        client.post(
            "auth/verification/confirm",
            {"token": token, "password": "A sufficiently long password for Dayforge"},
        ).status_code
        == 200
    )
    login = client.post(
        "auth/login",
        {
            "email": settings.owner_email.get_secret_value(),
            "password": "A sufficiently long password for Dayforge",
            "remember_me": True,
        },
    )
    assert login.status_code == 200
    client.csrf = login.json()["csrf_token"]
    return login.json()["owner"]["id"]


def _login_registered_owner(settings, client):
    login = client.post(
        "auth/login",
        {
            "email": settings.owner_email.get_secret_value(),
            "password": "A sufficiently long password for Dayforge",
            "remember_me": True,
        },
    )
    assert login.status_code == 200
    client.csrf = login.json()["csrf_token"]
    return login.json()["owner"]["id"]


def test_clock_push_duplicate_and_pull_are_owner_scoped(sync_database):
    from fastapi.testclient import TestClient

    from app.main import create_app

    with (
        TestClient(create_app(sync_database), base_url=sync_database.public_origin) as browser_a,
        TestClient(create_app(sync_database), base_url=sync_database.public_origin) as browser_b,
    ):
        client_a = SyncClient(browser_a, sync_database.public_origin)
        owner_id = _register_verify_login(sync_database, client_a)
        client_b = SyncClient(browser_b, sync_database.public_origin)
        assert _login_registered_owner(sync_database, client_b) == owner_id

        device_a_id = str(uuid4())
        device_b_id = str(uuid4())
        clock_a = browser_a.get("/api/v1/sync/clock", params={"device_id": device_a_id})
        clock_b = browser_b.get("/api/v1/sync/clock", params={"device_id": device_b_id})
        assert clock_a.status_code == clock_b.status_code == 200
        assert clock_a.headers["cache-control"] == clock_b.headers["cache-control"] == "private, no-store"
        bootstrap_a = browser_a.get("/api/v1/sync/bootstrap")
        bootstrap_b = browser_b.get("/api/v1/sync/bootstrap")
        assert bootstrap_a.status_code == bootstrap_b.status_code == 200
        assert bootstrap_a.json()["groups"] == bootstrap_b.json()["groups"] == []
        assert bootstrap_a.json()["epoch"] == bootstrap_b.json()["epoch"]

        operation_id = str(uuid4())
        operation = {
            "protocol_version": 1,
            "reducer_version": 1,
            "operation_id": operation_id,
            "owner_id": owner_id,
            "device_id": device_a_id,
            "device_sequence": "1",
            "edit_time": {
                "physical_ms": int(time() * 1000),
                "logical": 0,
                "calibration_id": clock_a.json()["calibration_id"],
                "raw_wall_ms": int(time() * 1000),
                "quality": "calibrated",
            },
            "dependencies": [],
            "commands": [
                {
                    "root": {"kind": "plan", "id": str(uuid4())},
                    "action": "plan.create",
                    "payload": {"data": {"name": "Kế hoạch", "color_id": "neutral"}},
                    "precondition": None,
                }
            ],
        }
        pushed = client_a.post("sync/push", {"operations": [operation]})
        assert pushed.status_code == 200
        assert pushed.headers["cache-control"] == "private, no-store"
        result = pushed.json()["results"][0]
        assert result["status"] == "recorded"
        cursor = result["receipt"]["commit_cursor"]

        duplicate = client_a.post("sync/push", {"operations": [operation]})
        assert duplicate.status_code == 200
        assert duplicate.json()["results"][0]["status"] == "duplicate"
        assert duplicate.json()["results"][0]["receipt"]["commit_cursor"] == cursor

        conflict = {
            **operation,
            "commands": [
                {
                    **operation["commands"][0],
                    "payload": {"data": {"name": "Khác", "color_id": "neutral"}},
                }
            ],
        }
        reused = client_a.post("sync/push", {"operations": [conflict]})
        assert reused.status_code == 200
        assert reused.json()["results"][0]["problem"]["code"] == "operation_id_reused"

        page = browser_a.get(
            "/api/v1/sync/pull",
            params={"after": "0", "epoch": bootstrap_a.json()["epoch"]},
        )
        assert page.status_code == 200
        assert page.json()["through_cursor"] == cursor
        assert page.json()["groups"][0]["operation"] == operation
        assert page.json()["next_cursor"] == cursor

        device_b_operation_id = str(uuid4())
        work_item_id = str(uuid4())
        from app.services.reducer import semantic_root_hash

        work_item_root = {"kind": "work_item", "id": work_item_id}
        work_item_operation = {
            "protocol_version": 1,
            "reducer_version": 1,
            "operation_id": device_b_operation_id,
            "owner_id": owner_id,
            "device_id": device_b_id,
            "device_sequence": "1",
            "edit_time": {
                "physical_ms": int(time() * 1000) + 1,
                "logical": 0,
                "calibration_id": clock_b.json()["calibration_id"],
                "raw_wall_ms": int(time() * 1000) + 1,
                "quality": "calibrated",
            },
            "dependencies": [operation_id],
            "commands": [
                {
                    "root": work_item_root,
                    "action": "work_item.create_single",
                    "payload": {
                        "data": {
                            "title": "Thiết bị B nhận được plan từ A",
                            "date": "2026-11-02",
                            "period": "morning",
                            "duration_minutes": 30,
                            "plan_id": None,
                            "standalone_color_id": "neutral",
                            "status": "pending",
                            "order_key": "0",
                        }
                    },
                    "precondition": {"expected_root_hash": semantic_root_hash(work_item_root, None)},
                }
            ],
        }
        pulled_on_b = browser_b.get(
            "/api/v1/sync/pull",
            params={"after": "0", "epoch": bootstrap_b.json()["epoch"]},
        )
        assert pulled_on_b.status_code == 200
        assert pulled_on_b.json()["groups"][0]["operation"] == operation
        pushed_from_b = client_b.post("sync/push", {"operations": [work_item_operation]})
        assert pushed_from_b.status_code == 200
        assert pushed_from_b.json()["results"][0]["status"] == "recorded"
        second_cursor = pushed_from_b.json()["results"][0]["receipt"]["commit_cursor"]

        pulled_on_a = browser_a.get(
            "/api/v1/sync/pull",
            params={"after": cursor, "epoch": bootstrap_a.json()["epoch"]},
        )
        assert pulled_on_a.status_code == 200
        assert pulled_on_a.json()["groups"][0]["operation"] == work_item_operation
        assert pulled_on_a.json()["next_cursor"] == second_cursor

    async def persisted_state():
        database = create_database(sync_database)
        try:
            async with database.sessions() as session:
                state = await session.scalar(select(SyncOwnerState).where(SyncOwnerState.owner_id == UUID(owner_id)))
                events = (
                    await session.scalars(select(SyncOperation).where(SyncOperation.owner_id == UUID(owner_id)))
                ).all()
                return state, events
        finally:
            await database.engine.dispose()

    state, events = asyncio.run(persisted_state())
    assert state.head_cursor == 2
    assert len(events) == 2


def test_sync_requires_verified_owner(sync_database):
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app(sync_database), base_url=sync_database.public_origin) as browser:
        response = browser.get("/api/v1/sync/bootstrap")
        assert response.status_code == 401
        assert response.headers["cache-control"] == "private, no-store"


def test_sync_cursor_uint64_max_is_readable_and_exhaustion_is_atomic(sync_database):
    from fastapi.testclient import TestClient

    from app.main import create_app

    uint64_max = (1 << 64) - 1
    with TestClient(create_app(sync_database), base_url=sync_database.public_origin) as browser:
        client = SyncClient(browser, sync_database.public_origin)
        owner_id = _register_verify_login(sync_database, client)
        device_id = str(uuid4())
        calibration = browser.get("/api/v1/sync/clock", params={"device_id": device_id})
        assert calibration.status_code == 200
        bootstrap = browser.get("/api/v1/sync/bootstrap")
        assert bootstrap.status_code == 200

        database = create_database(sync_database)

        async def seed_cursor():
            try:
                async with database.sessions() as session, session.begin():
                    state = await session.scalar(
                        select(SyncOwnerState).where(SyncOwnerState.owner_id == UUID(owner_id)).with_for_update()
                    )
                    assert state is not None
                    state.head_cursor = uint64_max - 1
            finally:
                await database.engine.dispose()

        asyncio.run(seed_cursor())
        physical_ms = int(time() * 1000)
        operation = {
            "protocol_version": 1,
            "reducer_version": 1,
            "operation_id": str(uuid4()),
            "owner_id": owner_id,
            "device_id": device_id,
            "device_sequence": "1",
            "edit_time": {
                "physical_ms": physical_ms,
                "logical": 0,
                "calibration_id": calibration.json()["calibration_id"],
                "raw_wall_ms": physical_ms,
                "quality": "calibrated",
            },
            "dependencies": [],
            "commands": [
                {
                    "root": {"kind": "plan", "id": str(uuid4())},
                    "action": "plan.create",
                    "payload": {"data": {"name": "Cursor biên", "color_id": "neutral"}},
                    "precondition": None,
                }
            ],
        }
        recorded = client.post("sync/push", {"operations": [operation]})
        assert recorded.status_code == 200
        assert recorded.json()["results"][0]["receipt"]["commit_cursor"] == str(uint64_max)

        duplicate = client.post("sync/push", {"operations": [operation]})
        assert duplicate.status_code == 200
        assert duplicate.json()["results"][0]["status"] == "duplicate"
        assert duplicate.json()["results"][0]["receipt"]["commit_cursor"] == str(uint64_max)

        next_operation = {
            **operation,
            "operation_id": str(uuid4()),
            "device_sequence": "2",
            "edit_time": {**operation["edit_time"], "physical_ms": physical_ms + 1},
            "commands": [
                {
                    **operation["commands"][0],
                    "root": {"kind": "plan", "id": str(uuid4())},
                    "payload": {"data": {"name": "Vượt cursor", "color_id": "neutral"}},
                }
            ],
        }
        exhausted = client.post("sync/push", {"operations": [next_operation]})
        assert exhausted.status_code == 503

        pulled = browser.get(
            "/api/v1/sync/pull",
            params={
                "after": str(uint64_max - 1),
                "epoch": bootstrap.json()["epoch"],
            },
        )
        assert pulled.status_code == 200
        assert pulled.json()["next_cursor"] == str(uint64_max)
        assert pulled.json()["groups"][0]["cursor"] == str(uint64_max)

    database = create_database(sync_database)

    async def persisted_state():
        try:
            async with database.sessions() as session:
                state = await session.scalar(select(SyncOwnerState).where(SyncOwnerState.owner_id == UUID(owner_id)))
                events = (
                    await session.scalars(select(SyncOperation).where(SyncOperation.owner_id == UUID(owner_id)))
                ).all()
                return state, events
        finally:
            await database.engine.dispose()

    state, events = asyncio.run(persisted_state())
    assert state is not None and state.head_cursor == uint64_max
    assert len(events) == 1 and events[0].commit_cursor == uint64_max
