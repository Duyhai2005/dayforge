import asyncio
import json
from pathlib import Path
from uuid import UUID
import warnings

from fastapi import HTTPException
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import Field
import pytest

with warnings.catch_warnings():
    warnings.filterwarnings("ignore", message="Using `httpx` with `starlette.testclient` is deprecated.*")
    from fastapi.testclient import TestClient

from app.core.errors import ProblemHTTPException
from app.main import create_app
from app.schemas.common import ContractModel


class Child(ContractModel):
    value: int = Field(alias="known/~field")


class Payload(ContractModel):
    items: list[Child]
    password: str
    note: str


class Output(ContractModel):
    count: int


@pytest.fixture
def error_app(settings_factory):
    application = create_app(settings_factory())

    @application.post("/api/v1/_test/validation")
    async def validation(payload: Payload):
        return {"ok": True}

    @application.get("/api/v1/_test/unavailable")
    async def unavailable():
        raise ProblemHTTPException(status_code=503, code="service_unavailable")

    @application.get("/api/v1/_test/rate")
    async def rate():
        raise ProblemHTTPException(status_code=429, code="rate_limited", retry_after_seconds=7)

    @application.get("/api/v1/_test/crash")
    async def crash():
        raise RuntimeError("test-only-secret-crash")

    @application.get("/api/v1/_test/bad-response", response_model=Output)
    async def bad_response():
        return {"count": "test-only-secret-response"}

    @application.get("/api/v1/_test/detail")
    async def detail():
        raise HTTPException(status_code=400, detail="test-only-secret-detail")

    @application.get("/api/v1/_test/items/{item_id}")
    async def item(item_id: int, limit: int):
        return {"ok": True}

    return application


@pytest.fixture
def error_client(error_app):
    with TestClient(error_app, raise_server_exceptions=False) as client:
        yield client


def _validate_problem(response):
    schema = json.loads((Path(__file__).resolve().parents[3] / "docs/tasks/t03/contract.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator({"$ref": "#/$defs/Problem", "$defs": schema["$defs"]},
                        format_checker=FormatChecker()).validate(response.json())
    body = response.json()
    assert body["status"] == response.status_code
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-request-id"] == body["request_id"]
    assert UUID(body["request_id"]).version == 4
    assert body["instance"] == f"/api/v1/requests/{body['request_id']}"
    assert body["type"] == f"/api/v1/problems/{body['code']}"
    assert "operation_id" not in body
    return body


def _events(capsys):
    return [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]


def test_validation_problem_matches_t03_schema(error_client):
    response = error_client.post("/api/v1/_test/validation", json={
        "items": [{"known/~field": "test-only-invalid-value", "test-only-nested-key": 1}],
        "password": "test-only-password", "note": "test-only-note", "test-only-private-key": 1,
    })
    body = _validate_problem(response)
    assert response.status_code == 422
    assert body["code"] == "validation_failed"
    assert body["title"] == "Validation failed"
    assert body["detail"] == "One or more fields are invalid."
    assert body["retryable"] is False
    assert {entry["path"] for entry in body["field_errors"]} == {"/items/0/known~1~0field", "/items/0", ""}
    for secret in ["test-only-invalid-value", "test-only-nested-key", "test-only-password", "test-only-note", "test-only-private-key", '"input"', '"ctx"']:
        assert secret not in response.text


def test_query_and_path_validation_pointers(error_client):
    response = error_client.get("/api/v1/_test/items/test-only-id?limit=test-only-limit")
    body = _validate_problem(response)
    assert {entry["path"] for entry in body["field_errors"]} == {"/path/item_id", "/query/limit"}
    assert "test-only-" not in response.text


def test_404_and_405_are_problem_json(error_client):
    missing = error_client.get("/api/v1/_test/test-only-missing")
    assert missing.status_code == 404
    assert _validate_problem(missing)["code"] == "not_found"
    wrong_method = error_client.post("/api/v1/_test/crash")
    assert wrong_method.status_code == 405
    assert _validate_problem(wrong_method)["code"] == "method_not_allowed"
    assert wrong_method.headers["allow"] == "GET"


def test_unavailable_is_retryable(error_client):
    response = error_client.get("/api/v1/_test/unavailable")
    body = _validate_problem(response)
    assert response.status_code == 503
    assert body["code"] == "service_unavailable"
    assert body["retryable"] is True
    assert "retry_after_seconds" not in body
    assert "field_errors" not in body
    assert "retry-after" not in response.headers


def test_rate_limit_retry_after_matches_header(error_client):
    response = error_client.get("/api/v1/_test/rate")
    body = _validate_problem(response)
    assert response.status_code == 429
    assert body["retryable"] is True
    assert body["retry_after_seconds"] == 7
    assert response.headers["retry-after"] == "7"


@pytest.mark.parametrize("raise_server_exceptions", [False, True])
def test_unexpected_error_returns_sanitized_problem(error_app, caplog, capsys, raise_server_exceptions):
    with TestClient(error_app, raise_server_exceptions=raise_server_exceptions) as client:
        response = client.get("/api/v1/_test/crash?token=test-only-query")
    body = _validate_problem(response)
    assert response.status_code == 500
    assert body["code"] == "internal_error"
    assert body["retryable"] is False
    logs = caplog.text + capsys.readouterr().out
    assert "test-only-secret-crash" not in response.text + logs
    assert "test-only-query" not in response.text + logs


def test_response_validation_error_and_http_detail_are_sanitized(error_client, caplog, capsys):
    invalid = error_client.get("/api/v1/_test/bad-response")
    assert invalid.status_code == 500
    assert _validate_problem(invalid)["code"] == "internal_error"
    detail = error_client.get("/api/v1/_test/detail")
    assert detail.status_code == 400
    assert _validate_problem(detail)["code"] == "malformed_request"
    output = invalid.text + detail.text + caplog.text + capsys.readouterr().out
    assert "test-only-secret-response" not in output
    assert "test-only-secret-detail" not in output


def test_request_id_cannot_be_injected(error_client):
    supplied = "11111111-1111-4111-8111-111111111111"
    response = error_client.get("/api/v1/_test/unavailable", headers={"X-Request-ID": supplied})
    body = _validate_problem(response)
    assert body["request_id"] != supplied


def test_sensitive_request_never_enters_logs(error_client, caplog, capsys):
    sentinels = ["test-only-body", "test-only-password", "test-only-note", "test-only-cookie",
                 "test-only-authorization", "test-only-csrf", "test-only-query", "test-only-private-key"]
    response = error_client.post("/api/v1/_test/validation?token=" + sentinels[6],
        json={"items": sentinels[0], "password": sentinels[1], "note": sentinels[2], sentinels[7]: 1},
        headers={"Cookie": "session=" + sentinels[3], "Authorization": "Bearer " + sentinels[4], "X-CSRF-Token": sentinels[5]})
    assert response.status_code == 422
    output = response.text + caplog.text + capsys.readouterr().out
    for secret in sentinels:
        assert secret not in output


def test_request_completion_is_logged_once_even_on_500(error_client, capsys):
    response = error_client.get("/api/v1/_test/crash")
    events = _events(capsys)
    assert len(events) == 1
    assert set(events[0]) == {"event", "request_id", "method", "route", "status_code", "duration_ms", "error_code"}
    assert events[0]["event"] == "request_completed"
    assert events[0]["request_id"] == response.headers["x-request-id"]
    assert events[0]["status_code"] == 500
    assert events[0]["error_code"] == "internal_error"
    assert events[0]["route"] == "/api/v1/_test/crash"
    assert events[0]["duration_ms"] >= 0


def test_logs_use_route_templates_or_unmatched(error_client, capsys):
    response = error_client.get("/api/v1/_test/items/42?limit=1")
    assert response.status_code == 200
    assert UUID(response.headers["x-request-id"]).version == 4
    assert _events(capsys)[0]["route"] == "/api/v1/_test/items/{item_id}"
    error_client.get("/test-only-secret-path?token=test-only-secret-query")
    event = _events(capsys)[0]
    assert event["route"] == "unmatched"
    assert "test-only-secret" not in json.dumps(event)


def test_started_response_is_not_replaced_and_context_resets(capsys):
    from app.core.request_logging import RequestLoggingMiddleware, request_id_context

    async def downstream(scope, receive, send):
        assert request_id_context.get() == scope["state"]["request_id"]
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"partial", "more_body": True})
        raise RuntimeError("test-only-stream-secret")

    async def check():
        sent = []

        async def send(message):
            sent.append(message)

        async def receive():
            return {"type": "http.request", "body": b""}

        middleware = RequestLoggingMiddleware(downstream)
        await middleware({"type": "http", "method": "GET", "path": "/private", "headers": []}, receive, send)
        assert len([message for message in sent if message["type"] == "http.response.start"]) == 1
        assert sent[0]["status"] == 200
        assert request_id_context.get() is None

    asyncio.run(check())
    events = _events(capsys)
    assert len(events) == 1
    assert events[0]["error_code"] == "response_interrupted"
    assert "test-only-stream-secret" not in json.dumps(events)


def test_production_app_has_no_probe_routes(settings_factory):
    assert not any("_test" in getattr(route, "path", "") for route in create_app(settings_factory()).routes)
