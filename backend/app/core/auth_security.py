"""Same-origin and CSRF checks for every authentication mutation."""

import hmac
from urllib.parse import urlsplit

from fastapi import Request
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.errors import ProblemHTTPException
from app.services.auth_crypto import decode_base64url


class AuthNoStoreMiddleware:
    """Apply private no-store headers to auth responses, including errors."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if scope["type"] != "http" or not (
            path == "/api/v1/auth" or path.startswith("/api/v1/auth/")
        ):
            await self.app(scope, receive, send)
            return

        async def add_no_store(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["Cache-Control"] = "private, no-store"
                headers["Pragma"] = "no-cache"
                vary = headers.get("Vary", "")
                if not any(
                    item.strip().lower() == "cookie" for item in vary.split(",")
                ):
                    headers["Vary"] = f"{vary}, Cookie".strip(", ")
            await send(message)

        await self.app(scope, receive, add_no_store)


def _referer_matches(referer: str | None, configured_origin: str) -> bool:
    if not referer or any(character.isspace() for character in referer):
        return False
    try:
        parsed = urlsplit(referer)
        configured = urlsplit(configured_origin)
        if (
            parsed.scheme.lower() not in ("http", "https")
            or parsed.hostname is None
            or parsed.username is not None
            or parsed.password is not None
            or configured.hostname is None
        ):
            return False
        parsed_port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
        configured_port = configured.port or (
            443 if configured.scheme.lower() == "https" else 80
        )
        return (
            parsed.scheme.lower() == configured.scheme.lower()
            and parsed.hostname.lower() == configured.hostname.lower()
            and parsed_port == configured_port
        )
    except ValueError:
        return False


def validate_auth_post(request: Request, csrf_token: bytes | None) -> None:
    if request.method != "POST":
        raise ProblemHTTPException(status_code=403, code="csrf_failed")
    media_type = (
        request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    )
    if media_type != "application/json":
        raise ProblemHTTPException(status_code=415, code="unsupported_media_type")

    configured_origin = request.app.state.settings.public_origin
    origin = request.headers.get("origin")
    if origin is not None:
        origin_matches = hmac.compare_digest(origin, configured_origin)
    else:
        origin_matches = _referer_matches(
            request.headers.get("referer"), configured_origin
        )
    fetch_site = request.headers.get("sec-fetch-site", "").strip().lower()
    if not origin_matches or fetch_site == "cross-site":
        raise ProblemHTTPException(status_code=403, code="csrf_failed")

    supplied = decode_base64url(request.headers.get("x-csrf-token"), 32)
    if csrf_token is None or len(csrf_token) != 32 or supplied is None:
        raise ProblemHTTPException(status_code=403, code="csrf_failed")
    if not hmac.compare_digest(supplied, csrf_token):
        raise ProblemHTTPException(status_code=403, code="csrf_failed")
