"""Opaque server-side session lifecycle and browser cookie handling."""

import hmac
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.database import get_session
from app.core.errors import ProblemHTTPException
from app.core.values import format_utc_timestamp
from app.models.auth import Session
from app.models.owner import User
from app.services.auth_crypto import (
    decode_key,
    generate_token,
    make_logout_ticket,
    token_digest,
)

SESSION_COOKIE = "__Host-dayforge-session"
IDLE_SECONDS = {False: 30 * 60, True: 7 * 24 * 60 * 60}
ABSOLUTE_SECONDS = {False: 12 * 60 * 60, True: 30 * 24 * 60 * 60}


@dataclass
class SessionContext:
    row: Session
    user: User | None
    settings: Settings
    now: datetime

    @property
    def authenticated(self) -> bool:
        return self.user is not None and self.row.kind == "authenticated"


def _now() -> datetime:
    current = datetime.now(timezone.utc)
    return current.replace(microsecond=(current.microsecond // 1000) * 1000)


def _set_cookie(
    request: Request,
    token: str,
    *,
    remember: bool = False,
    expires_at: datetime | None = None,
) -> None:
    cookie = f"{SESSION_COOKIE}={token}; Path=/; Secure; HttpOnly; SameSite=Lax"
    if remember and expires_at is not None:
        remaining = max(0, int((expires_at - _now()).total_seconds()))
        cookie += f"; Max-Age={remaining}"
    request.scope.setdefault("state", {})["auth_set_cookie"] = cookie


def _clear_cookie(response) -> None:
    response.delete_cookie(
        SESSION_COOKIE, path="/", secure=True, httponly=True, samesite="lax"
    )


async def _insert_anonymous(
    request: Request, db: AsyncSession, now: datetime
) -> SessionContext:
    token = generate_token()
    expires = now + timedelta(minutes=30)
    row = Session(
        id=uuid4(),
        kind="anonymous",
        token_hash=token_digest(token),
        owner_id=None,
        csrf_token=generate_token(),
        auth_version=None,
        password_authenticated_at=None,
        remember_me=False,
        created_at=now,
        last_activity_at=now,
        idle_expires_at=expires,
        absolute_expires_at=expires,
        revoked_at=None,
    )
    db.add(row)
    await db.commit()
    _set_cookie(request, token)
    return SessionContext(
        row=row, user=None, settings=request.app.state.settings, now=now
    )


async def get_session_context(
    request: Request, db: AsyncSession = Depends(get_session)
) -> SessionContext:
    now = _now()
    token = request.cookies.get(SESSION_COOKIE)
    row = None
    if token:
        try:
            digest = token_digest(token)
        except ValueError:
            digest = b""
        if digest:
            row = await db.scalar(select(Session).where(Session.token_hash == digest))
    if (
        row is None
        or row.revoked_at is not None
        or now >= row.idle_expires_at
        or now >= row.absolute_expires_at
    ):
        return await _insert_anonymous(request, db, now)

    user = None
    if row.kind == "authenticated":
        user = await db.get(User, row.owner_id)
        if (
            user is None
            or user.email_verified_at is None
            or row.auth_version != user.auth_version
        ):
            return await _insert_anonymous(request, db, now)
        idle_seconds = IDLE_SECONDS[bool(row.remember_me)]
        row.last_activity_at = now
        row.idle_expires_at = min(
            now + timedelta(seconds=idle_seconds), row.absolute_expires_at
        )
        await db.commit()
    return SessionContext(
        row=row, user=user, settings=request.app.state.settings, now=now
    )


async def create_authenticated_session(
    request: Request,
    db: AsyncSession,
    context: SessionContext,
    user: User,
    remember_me: bool,
    now: datetime | None = None,
) -> SessionContext:
    current = now or _now()
    if context.row.revoked_at is None:
        context.row.revoked_at = current
    token = generate_token()
    absolute = current + timedelta(seconds=ABSOLUTE_SECONDS[remember_me])
    row = Session(
        id=uuid4(),
        kind="authenticated",
        token_hash=token_digest(token),
        owner_id=user.id,
        csrf_token=generate_token(),
        auth_version=user.auth_version,
        password_authenticated_at=current,
        remember_me=remember_me,
        created_at=current,
        last_activity_at=current,
        idle_expires_at=min(
            current + timedelta(seconds=IDLE_SECONDS[remember_me]), absolute
        ),
        absolute_expires_at=absolute,
        revoked_at=None,
    )
    db.add(row)
    await db.commit()
    _set_cookie(request, token, remember=remember_me, expires_at=absolute)
    return SessionContext(
        row=row, user=user, settings=request.app.state.settings, now=current
    )


def make_session_view(context: SessionContext) -> dict:
    row, user = context.row, context.user
    ticket = None
    owner = None
    session_view = None
    if user is not None:
        assert row.password_authenticated_at is not None
        key = decode_key(context.settings.logout_ticket_key_b64.get_secret_value())
        ticket = make_logout_ticket(row.id, key)
        owner = {
            "id": str(user.id),
            "email": user.email_delivery,
            "email_verified_at": format_utc_timestamp(user.email_verified_at),
        }
        session_view = {
            "id": str(row.id),
            "remember_me": bool(row.remember_me),
            "idle_expires_at": format_utc_timestamp(row.idle_expires_at),
            "absolute_expires_at": format_utc_timestamp(row.absolute_expires_at),
            "password_authenticated_at": format_utc_timestamp(
                row.password_authenticated_at
            ),
        }
    return {
        "authenticated": user is not None,
        "owner": owner,
        "session": session_view,
        "csrf_token": row.csrf_token,
        "server_time": format_utc_timestamp(context.now),
        "logout_ticket": ticket,
    }


def require_verified_owner(context: SessionContext) -> User:
    if not context.authenticated or context.user is None:
        raise ProblemHTTPException(status_code=401, code="authentication_required")
    return context.user


def validate_auth_post(
    request: Request, csrf_token: str | None, context: SessionContext
) -> None:
    origin = request.headers.get("origin")
    fetch_site = request.headers.get("sec-fetch-site", "").lower()
    valid_origin = origin == context.settings.public_origin
    if origin is None:
        referer = request.headers.get("referer")
        if referer:
            try:
                parsed = urlsplit(referer)
                referer_origin = f"{parsed.scheme}://{parsed.netloc}"
                valid_origin = (
                    parsed.scheme == "https"
                    and parsed.hostname is not None
                    and parsed.username is None
                    and parsed.password is None
                    and referer_origin == context.settings.public_origin
                )
            except ValueError:
                valid_origin = False
    if not valid_origin or fetch_site == "cross-site":
        raise ProblemHTTPException(status_code=403, code="forbidden")
    try:
        csrf_valid = isinstance(csrf_token, str) and hmac.compare_digest(
            context.row.csrf_token.encode("ascii"), csrf_token.encode("ascii")
        )
    except UnicodeEncodeError:
        csrf_valid = False
    if not csrf_valid:
        raise ProblemHTTPException(status_code=403, code="csrf_failed")


async def csrf_protected_context(
    request: Request,
    context: SessionContext = Depends(get_session_context),
) -> SessionContext:
    validate_auth_post(request, request.headers.get("x-csrf-token"), context)
    return context


def clear_session_cookie(request: Request, response) -> None:
    request.scope.setdefault("state", {}).pop("auth_set_cookie", None)
    _clear_cookie(response)
