"""Apply private response headers and deferred session cookies to auth routes."""

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class AuthResponseMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if scope["type"] != "http" or not (
            path.startswith("/api/v1/auth/") or path.startswith("/api/v1/sync/")
        ):
            await self.app(scope, receive, send)
            return

        async def secure_response(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["Cache-Control"] = "private, no-store"
                headers["Pragma"] = "no-cache"
                cookie = scope.get("state", {}).pop("auth_set_cookie", None)
                if cookie:
                    headers.append("Set-Cookie", cookie)
            await send(message)

        await self.app(scope, receive, secure_response)
