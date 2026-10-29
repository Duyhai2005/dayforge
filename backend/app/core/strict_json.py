"""Validate strict JSON before routing, then replay the original UTF-8 bytes."""

import json
import math
import re
from typing import Any

from starlette.datastructures import Headers
from starlette.requests import Request
from starlette.types import ASGIApp, Receive, Scope, Send

from app.core.errors import ProblemHTTPException, make_problem


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("invalid_json")
        result[key] = value
    return result


def _reject_constant(_value: str) -> None:
    raise ValueError("invalid_json")


def _validate_value(value: Any) -> None:
    if isinstance(value, str):
        if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
            raise ValueError("invalid_json")
    elif type(value) is int:
        if not -9007199254740991 <= value <= 9007199254740991:
            raise ValueError("invalid_json")
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("invalid_json")
    elif isinstance(value, list):
        for item in value:
            _validate_value(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            _validate_value(key)
            _validate_value(item)


def parse_json_bytes(data: bytes) -> Any:
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=_object, parse_constant=_reject_constant)
        _validate_value(value)
        return value
    except (ValueError, OverflowError, RecursionError):
        raise ProblemHTTPException(status_code=400, code="malformed_request") from None


def _is_json(content_type: str) -> bool:
    media_type, *parameters = content_type.split(";")
    return media_type.strip().lower() == "application/json" and all(
        re.fullmatch(r'charset[ \t]*=[ \t]*(?:utf-8|"utf-8")', parameter.strip(), re.IGNORECASE)
        for parameter in parameters
    )


class StrictJSONMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (scope["type"] != "http" or scope.get("method") not in ("POST", "PUT", "PATCH")
                or not scope.get("path", "").startswith("/api/v1/")):
            await self.app(scope, receive, send)
            return
        request = Request(scope, receive)

        async def problem(status: int, code: str) -> None:
            await make_problem(request, status_code=status, code=code)(scope, receive, send)

        headers = Headers(scope=scope)
        if not _is_json(headers.get("content-type", "")):
            await problem(415, "unsupported_media_type")
            return
        limit = 16384 if scope["path"].startswith("/api/v1/auth/") else 8388608
        length = headers.get("content-length", "")
        if length.isascii() and length.isdecimal():
            # Compare digit strings first to avoid unbounded integer conversion.
            significant = length.lstrip("0") or "0"
            if len(significant) > len(str(limit)) or (len(significant) == len(str(limit)) and significant > str(limit)):
                await problem(413, "payload_too_large")
                return
        buffered = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if len(buffered) + len(chunk) > limit:
                await problem(413, "payload_too_large")
                return
            buffered.extend(chunk)
            if not message.get("more_body", False):
                break
        body = bytes(buffered)
        try:
            parse_json_bytes(body)
        except ProblemHTTPException:
            await problem(400, "malformed_request")
            return

        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)
