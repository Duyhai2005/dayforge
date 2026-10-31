import asyncio
import json
import warnings
from uuid import UUID

import pytest
from fastapi import Request
from pydantic import Field, StrictBool, StrictInt
from starlette.responses import Response

with warnings.catch_warnings():
    warnings.filterwarnings(
        "ignore", message="Using `httpx` with `starlette.testclient` is deprecated.*"
    )
    from fastapi.testclient import TestClient

from app.main import create_app
from app.schemas.common import ContractModel


class Probe(ContractModel):
    duration_minutes: StrictInt | None = Field(alias="known/~field")
    enabled: StrictBool


@pytest.fixture
def strict_app(settings_factory):
    application = create_app(settings_factory())
    application.state.probe_calls = 0

    @application.post("/api/v1/_test/model")
    async def model(payload: Probe):
        application.state.probe_calls += 1
        return {"ok": True}

    async def echo(request: Request):
        application.state.probe_calls += 1
        return Response(await request.body(), media_type="application/json")

    for path in ("/api/v1/_test/echo", "/api/v1/auth/_test/echo", "/outside"):
        application.add_api_route(
            path, echo, methods=["POST", "PUT", "PATCH", "GET", "HEAD"]
        )
    return application


@pytest.fixture
def strict_client(strict_app):
    with TestClient(strict_app) as client:
        yield client


@pytest.mark.parametrize(
    "raw",
    [
        b'{"outer":{"x":1,"x":2}}',
        b'{"x":NaN}',
        b'{"x":Infinity}',
        b'{"x":1e999}',
        b'{"x":"\\ud800"}',
        b'{"\\udfff":1}',
        b'{"x":"\xff"}',
        b"\xef\xbb\xbf{}",
        b'{"x":9007199254740992}',
        b'{"x":-9007199254740992}',
        b'{"private":"test-only-private-json",}',
    ],
)
def test_invalid_json_never_reaches_handler(
    strict_client, strict_app, caplog, capsys, raw
):
    response = strict_client.post(
        "/api/v1/_test/echo?token=test-only-query",
        content=raw,
        headers={"Content-Type": "application/json"},
    )
    body = response.json()
    assert response.status_code == 400
    assert body["code"] == "malformed_request"
    assert response.headers["x-request-id"] == body["request_id"]
    assert UUID(body["request_id"]).version == 4
    assert response.headers["cache-control"] == "no-store"
    assert strict_app.state.probe_calls == 0
    logs = capsys.readouterr().out
    events = [json.loads(line) for line in logs.splitlines()]
    assert len(events) == 1
    assert events[0]["request_id"] == body["request_id"]
    assert events[0]["error_code"] == "malformed_request"
    for sentinel in ("test-only-private-json", "test-only-query"):
        assert sentinel not in response.text + caplog.text + logs


@pytest.mark.parametrize(
    "content_type",
    [
        None,
        "text/plain",
        "application/problem+json",
        "application/json; charset=latin1",
        "application/json; charset=UTF-16",
    ],
)
def test_wrong_content_type_is_rejected(strict_client, strict_app, content_type):
    response = strict_client.post(
        "/api/v1/_test/echo",
        content=b"{}",
        headers={} if content_type is None else {"Content-Type": content_type},
    )
    assert response.status_code == 415
    assert response.json()["code"] == "unsupported_media_type"
    assert strict_app.state.probe_calls == 0


@pytest.mark.parametrize(
    "content_type",
    [
        "application/json",
        "Application/JSON; Charset=UTF-8",
        'application/json; charset="utf-8"',
    ],
)
@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH"])
def test_parser_preserves_original_body_bytes(
    strict_client, strict_app, content_type, method
):
    raw = ' { "z": "é  mật khẩu", "a": [1, true] } \n'.encode()
    response = strict_client.request(
        method,
        "/api/v1/_test/echo",
        content=raw,
        headers={"Content-Type": content_type},
    )
    assert response.status_code == 200
    assert response.content == raw
    assert strict_app.state.probe_calls == 1


def test_field_error_pointer_escapes_known_alias_only(
    strict_client, strict_app, caplog, capsys
):
    response = strict_client.post(
        "/api/v1/_test/model",
        json={
            "known/~field": "test-only-private-value",
            "enabled": True,
            "test-only-private-key": 1,
        },
    )
    assert response.status_code == 422
    assert {item["path"] for item in response.json()["field_errors"]} == {
        "/known~1~0field",
        "",
    }
    assert strict_app.state.probe_calls == 0
    output = response.text + caplog.text + capsys.readouterr().out
    assert "test-only-private-key" not in output
    assert "test-only-private-value" not in output


def _stream(application, path, messages, headers=(), method="POST"):
    async def check():
        sent = []
        read_count = 0

        async def receive():
            nonlocal read_count
            message = messages[read_count]
            read_count += 1
            return message

        async def send(message):
            sent.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "scheme": "http",
            "method": method,
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": list(headers),
            "client": ("127.0.0.1", 1234),
            "server": ("testserver", 80),
        }
        async with application.router.lifespan_context(application):
            await application(scope, receive, send)
        return sent, read_count

    return asyncio.run(check())


@pytest.mark.parametrize(
    "path,limit", [("/api/v1/auth/_test/echo", 16384), ("/api/v1/_test/echo", 8388608)]
)
@pytest.mark.parametrize("length", [None, b"1", b"invalid", b"-1"])
@pytest.mark.parametrize("extra", [0, 1])
def test_streaming_body_limit_counts_actual_bytes(
    strict_app, path, limit, length, extra
):
    raw = b'"' + ("é" * ((limit - 2) // 2)).encode() + b'"' + b" " * extra
    assert len(raw) == limit + extra
    messages = [
        {"type": "http.request", "body": raw[: limit // 2], "more_body": True},
        {"type": "http.request", "body": raw[limit // 2 :], "more_body": extra == 1},
    ]
    headers = [(b"content-type", b"application/json")]
    if length is not None:
        headers.append((b"content-length", length))
    sent, reads = _stream(strict_app, path, messages, headers)
    assert reads == 2
    status = next(
        message["status"]
        for message in sent
        if message["type"] == "http.response.start"
    )
    body = b"".join(
        message.get("body", b"")
        for message in sent
        if message["type"] == "http.response.body"
    )
    if extra:
        assert status == 413
        assert json.loads(body)["code"] == "payload_too_large"
        assert strict_app.state.probe_calls == 0
    else:
        assert status == 200
        assert body == raw
        assert strict_app.state.probe_calls == 1


def test_obviously_oversized_content_length_is_rejected_before_read(strict_app):
    sent, reads = _stream(
        strict_app,
        "/api/v1/auth/_test/echo",
        [],
        [(b"content-type", b"application/json"), (b"content-length", b"16385")],
    )
    assert reads == 0
    assert sent[0]["status"] == 413
    assert strict_app.state.probe_calls == 0


def test_disconnect_does_not_accept_incomplete_body(strict_app):
    sent, reads = _stream(
        strict_app,
        "/api/v1/_test/echo",
        [
            {"type": "http.request", "body": b"{}", "more_body": True},
            {"type": "http.disconnect"},
        ],
        [(b"content-type", b"application/json")],
    )
    assert reads == 2
    assert strict_app.state.probe_calls == 0
    assert not any(message.get("status") == 200 for message in sent)


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/api/v1/_test/echo"),
        ("HEAD", "/api/v1/_test/echo"),
        ("POST", "/outside"),
    ],
)
def test_nonmutation_and_unrelated_paths_bypass_validation(strict_app, method, path):
    sent, _ = _stream(
        strict_app,
        path,
        [{"type": "http.request", "body": b"not-json", "more_body": False}],
        method=method,
    )
    assert sent[0]["status"] == 200
    assert strict_app.state.probe_calls == 1
