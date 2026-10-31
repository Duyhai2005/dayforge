"""Pure ASGI request context and allowlisted completion logging."""

import json
import logging
import sys
from contextvars import ContextVar
from time import perf_counter
from uuid import uuid4

from starlette.datastructures import MutableHeaders
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.errors import make_problem

request_id_context: ContextVar[str | None] = ContextVar("request_id", default=None)
_logger = logging.getLogger("dayforge.requests")


class _StdoutHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        # Resolve stdout at emission time so embedded clients/capture do not retain a closed stream.
        sys.stdout.write(record.getMessage() + "\n")
        sys.stdout.flush()


def configure_logging() -> None:
    if not any(isinstance(handler, _StdoutHandler) for handler in _logger.handlers):
        _logger.addHandler(_StdoutHandler())
    _logger.setLevel(logging.INFO)


class RequestLoggingMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app
        configure_logging()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = str(uuid4())
        state = scope.setdefault("state", {})
        state["request_id"] = request_id
        token = request_id_context.set(request_id)
        started = False
        status_code = 500
        error_code = None
        start_time = perf_counter()

        async def send_response(message: Message) -> None:
            nonlocal started, status_code
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)["X-Request-ID"] = request_id
                started = True
                status_code = message["status"]
            await send(message)

        try:
            try:
                await self.app(scope, receive, send_response)
            except Exception:
                if started:
                    error_code = "response_interrupted"
                else:
                    response = make_problem(
                        Request(scope, receive), status_code=500, code="internal_error"
                    )
                    await response(scope, receive, send_response)
        finally:
            try:
                route = getattr(scope.get("route"), "path", "unmatched")
                method = scope.get("method", "OTHER")
                if method not in {
                    "GET",
                    "HEAD",
                    "POST",
                    "PUT",
                    "PATCH",
                    "DELETE",
                    "OPTIONS",
                    "TRACE",
                    "CONNECT",
                }:
                    method = "OTHER"
                event = {
                    "event": "request_completed",
                    "request_id": request_id,
                    "method": method,
                    "route": route,
                    "status_code": status_code,
                    "duration_ms": round((perf_counter() - start_time) * 1000, 3),
                    "error_code": error_code or state.get("error_code"),
                }
                _logger.info(json.dumps(event, separators=(",", ":")))
            finally:
                request_id_context.reset(token)
