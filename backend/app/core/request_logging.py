"""Pure ASGI request context and allowlisted completion logging."""

import json
import logging
import sys
from contextvars import ContextVar
from time import perf_counter
from uuid import UUID, uuid4

from starlette.datastructures import MutableHeaders
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.errors import make_problem

request_id_context: ContextVar[str | None] = ContextVar("request_id", default=None)
_logger = logging.getLogger("dayforge.requests")
_audit_logger = logging.getLogger("dayforge.auth.audit")


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
                    response = make_problem(Request(scope, receive), status_code=500, code="internal_error")
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


class AuthAuditMiddleware(BaseHTTPMiddleware):
    """Write fixed-outcome records for rejected auth calls after their transactions roll back."""

    _ACTIONS = {
        ("POST", "/api/v1/auth/register"): "register",
        ("POST", "/api/v1/auth/verification/resend"): "verification_resend",
        ("POST", "/api/v1/auth/verification/confirm"): "email_verified",
        ("POST", "/api/v1/auth/login"): "login",
        ("POST", "/api/v1/auth/password/forgot"): "password_forgot",
        ("POST", "/api/v1/auth/password/reset"): "password_reset",
        ("POST", "/api/v1/auth/logout"): "logout",
        ("GET", "/api/v1/auth/local-key"): "local_key",
    }

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        action = self._ACTIONS.get((request.method, request.url.path))
        if action is None or response.status_code < 400:
            return response
        if getattr(request.app.state, "auth_audit_enabled", True) is False:
            return response
        database = getattr(request.app.state, "database", None)
        settings = getattr(request.app.state, "settings", None)
        if database is None or settings is None:
            return response
        owner_id = getattr(request.state, "auth_owner_id", None)
        if not isinstance(owner_id, UUID):
            owner_id = None
        request_id = getattr(request.state, "request_id", None)
        if not isinstance(request_id, str):
            request_id = str(uuid4())
        try:
            from app.services.auth_audit import record_auth_audit

            await record_auth_audit(
                database,
                settings,
                action=action,
                outcome="error" if response.status_code >= 500 else "denied",
                request_id=request_id,
                owner_id=owner_id,
                email_canonical=getattr(request.state, "auth_email_canonical", None),
                peer_ip=None if request.client is None else request.client.host,
            )
        except Exception:
            # A failed denial record never replaces the denial response.
            _audit_logger.warning("auth_denial_audit_unavailable")
        return response
