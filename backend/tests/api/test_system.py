from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine

from app.main import create_app


def test_version_matches_contract_without_database(system_client, contract_validator, monkeypatch):
    def unexpected_connection(*args, **kwargs):
        raise AssertionError("version must not contact the database")
    monkeypatch.setattr(AsyncEngine, "connect", unexpected_connection)
    response = system_client.get("/api/v1/version")
    assert response.status_code == 200
    body = response.json()
    contract_validator("VersionInfo").validate(body)
    assert body["api_major"] == 1
    assert body["protocol_versions"] == [1]
    assert body["reducer_versions"] == [1]
    assert body["limits"] == {
        "push_operations": 100, "push_request_bytes": 8388608,
        "operation_bytes": 2097152, "commands_per_operation": 1000,
        "page_operations": 200, "page_bytes": 8388608, "page_token_ttl_seconds": 1800,
    }
    assert set(body) == {"api_major", "protocol_versions", "reducer_versions", "server_time", "limits"}
    assert response.headers["cache-control"] == "no-store"
    assert "set-cookie" not in response.headers


def test_health_success_dto_is_exact(system_client, monkeypatch):
    monkeypatch.setattr("app.api.system.check_readiness", AsyncMock(return_value=True))
    response = system_client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["cache-control"] == "no-store"
    assert "set-cookie" not in response.headers


def test_health_unavailable_is_problem(system_client, contract_validator, monkeypatch):
    monkeypatch.setattr("app.api.system.check_readiness", AsyncMock(return_value=False))
    response = system_client.get("/api/v1/health")
    assert response.status_code == 503
    body = response.json()
    contract_validator("Problem").validate(body)
    assert body["code"] == "service_unavailable"
    assert body["retryable"] is True
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-request-id"] == body["request_id"]
    assert "set-cookie" not in response.headers


def test_development_openapi_contains_valid_system_routes(system_client):
    response = system_client.get("/api/v1/openapi.json")
    assert response.status_code == 200
    assert set(response.json()["paths"]) == {"/api/v1/health", "/api/v1/version"}


def test_production_hides_openapi(settings_factory):
    import warnings
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message="Using `httpx` with `starlette.testclient` is deprecated.*")
        from fastapi.testclient import TestClient
    with TestClient(create_app(settings_factory(app_env="production"))) as client:
        assert client.get("/api/v1/openapi.json").status_code == 404
        assert client.get("/docs").status_code == 404
        assert client.get("/redoc").status_code == 404


def test_required_revision_is_discovered_from_packaged_scripts():
    from pathlib import Path
    from alembic.script import ScriptDirectory
    from app.services.readiness import required_schema_revision
    scripts = ScriptDirectory(str(Path(__file__).resolve().parents[2] / "migrations"))
    head, = scripts.get_heads()
    assert required_schema_revision() == head


@pytest.mark.parametrize("revisions", [[], ["first", "second"], None])
def test_invalid_packaged_schema_is_a_sanitized_configuration_error(tmp_path, monkeypatch, revisions):
    from app.services import readiness
    config = tmp_path / "alembic.ini"
    if revisions is not None:
        versions = tmp_path / "migrations" / "versions"
        versions.mkdir(parents=True)
        config.write_text("[alembic]\nscript_location = " + str(versions.parent), encoding="utf-8")
        for revision in revisions:
            (versions / (revision + ".py")).write_text(
                f"revision = '{revision}'\ndown_revision = None\n", encoding="utf-8")
    monkeypatch.setattr(readiness, "ALEMBIC_CONFIG", config)
    with pytest.raises(ValueError, match="^invalid_schema_configuration$"):
        readiness.required_schema_revision()


def test_required_revision_is_not_hardcoded(tmp_path, monkeypatch):
    from app.services import readiness
    versions = tmp_path / "migrations" / "versions"
    versions.mkdir(parents=True)
    (versions / "future.py").write_text("revision = 'future_head'\ndown_revision = None\n", encoding="utf-8")
    config = tmp_path / "alembic.ini"
    config.write_text("[alembic]\nscript_location = " + str(versions.parent), encoding="utf-8")
    monkeypatch.setattr(readiness, "ALEMBIC_CONFIG", config)
    assert readiness.required_schema_revision() == "future_head"


def test_version_timestamp_is_created_for_each_response(system_client, monkeypatch):
    from datetime import datetime, timezone
    instants = iter([datetime(2026, 10, 29, 1, 2, 3, 456000, tzinfo=timezone.utc),
                     datetime(2026, 10, 29, 1, 2, 4, 789000, tzinfo=timezone.utc)])
    class Clock:
        @staticmethod
        def now(time_zone):
            return next(instants)
    monkeypatch.setattr("app.api.system.datetime", Clock)
    assert system_client.get("/api/v1/version").json()["server_time"] == "2026-10-29T01:02:03.456Z"
    assert system_client.get("/api/v1/version").json()["server_time"] == "2026-10-29T01:02:04.789Z"


@pytest.mark.parametrize("values", [{"api_major": True}, {"api_major": 1.0},
    {"protocol_versions": [True]}, {"protocol_versions": [1, 1]}, {"reducer_versions": [2]},
    {"limits": {"push_operations": "100"}}, {"limits": {"page_bytes": 1}}])
def test_system_models_reject_noncontract_constants(values):
    from app.schemas.system import VersionInfo, VersionLimits
    from pydantic import ValidationError
    body = dict(protocol_versions=[1], reducer_versions=[1],
                server_time="2026-10-29T01:02:03.456Z", limits=VersionLimits())
    body.update(values)
    with pytest.raises(ValidationError):
        VersionInfo(**body)
