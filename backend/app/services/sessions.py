"""Opaque server sessions, anonymous CSRF contexts and targeted logout."""

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from fastapi import Depends, Request, Response
from sqlalchemy import select, update
from sqlalchemy.exc import SQLAlchemyError

from app.core.errors import ProblemHTTPException
from app.models.auth import Session as AuthSession
from app.models.owner import User
from app.services.auth_crypto import encode_base64url

SESSION_COOKIE_NAME = "__Host-dayforge-session"
SESSION_TOKEN_BYTES = 32
CSRF_TOKEN_BYTES = 32
ANONYMOUS_SESSION_TTL = timedelta(minutes=30)
SESSION_IDLE_STANDARD = timedelta(minutes=30)
SESSION_IDLE_REMEMBERED = timedelta(days=7)
SESSION_ABSOLUTE_STANDARD = timedelta(hours=12)
SESSION_ABSOLUTE_REMEMBERED = timedelta(days=30)
RECENT_PASSWORD_WINDOW = timedelta(minutes=5)


def utc_now() -> datetime:
    value = datetime.now(timezone.utc)
    return value.replace(microsecond=(value.microsecond // 1000) * 1000)


@dataclass(frozen=True)
class SessionContext:
    session: AuthSession
    user: User | None
    csrf_token: bytes
    cookie_token: str

    @property
    def authenticated(self) -> bool:
        return self.session.kind == "authenticated" and self.user is not None


async def get_session_context(request: Request) -> SessionContext | None:
    from app.services.auth_crypto import decode_base64url

    cookie = request.cookies.get(SESSION_COOKIE_NAME)
    raw_token = decode_base64url(cookie, SESSION_TOKEN_BYTES)
    if raw_token is None:
        return None
    token_hash = hashlib.sha256(raw_token).digest()
    database = request.app.state.database
    now = utc_now()
    try:
        async with database.sessions() as db:
            record = (
                await db.execute(
                    select(AuthSession).where(AuthSession.token_hash == token_hash)
                )
            ).scalar_one_or_none()
            if (
                record is None
                or record.revoked_at is not None
                or now >= record.idle_expires_at
                or now >= record.absolute_expires_at
                or len(record.csrf_token) != CSRF_TOKEN_BYTES
            ):
                return None
            if record.kind == "anonymous":
                if record.owner_id is not None or record.auth_version is not None:
                    return None
                return SessionContext(
                    record, None, record.csrf_token, encode_base64url(raw_token)
                )
            if record.kind != "authenticated" or record.owner_id is None:
                return None
            user = await db.get(User, record.owner_id)
            if (
                user is None
                or user.email_verified_at is None
                or record.auth_version != user.auth_version
                or record.password_authenticated_at is None
            ):
                return None
            return SessionContext(
                record, user, record.csrf_token, encode_base64url(raw_token)
            )
    except SQLAlchemyError:
        raise ProblemHTTPException(
            status_code=503, code="service_unavailable"
        ) from None


async def create_anonymous_session(request: Request) -> SessionContext:
    now = utc_now()
    raw_token = secrets.token_bytes(SESSION_TOKEN_BYTES)
    csrf_token = secrets.token_bytes(CSRF_TOKEN_BYTES)
    expires_at = now + ANONYMOUS_SESSION_TTL
    record = AuthSession(
        id=uuid4(),
        kind="anonymous",
        token_hash=hashlib.sha256(raw_token).digest(),
        owner_id=None,
        csrf_token=csrf_token,
        auth_version=None,
        password_authenticated_at=None,
        remember_me=False,
        created_at=now,
        last_activity_at=now,
        idle_expires_at=expires_at,
        absolute_expires_at=expires_at,
        revoked_at=None,
    )
    database = request.app.state.database
    try:
        async with database.sessions() as db:
            async with db.begin():
                db.add(record)
    except SQLAlchemyError:
        raise ProblemHTTPException(
            status_code=503, code="service_unavailable"
        ) from None
    return SessionContext(record, None, csrf_token, encode_base64url(raw_token))


async def touch_session(
    request: Request, context: SessionContext
) -> SessionContext | None:
    if not context.authenticated or context.user is None:
        return context
    now = utc_now()
    database = request.app.state.database
    try:
        async with database.sessions() as db:
            async with db.begin():
                record = (
                    await db.execute(
                        select(AuthSession)
                        .where(AuthSession.id == context.session.id)
                        .with_for_update()
                    )
                ).scalar_one_or_none()
                if (
                    record is None
                    or record.revoked_at is not None
                    or now >= record.idle_expires_at
                    or now >= record.absolute_expires_at
                ):
                    return None
                user = await db.get(User, record.owner_id)
                if (
                    user is None
                    or user.email_verified_at is None
                    or record.auth_version != user.auth_version
                ):
                    return None
                idle_duration = (
                    SESSION_IDLE_REMEMBERED
                    if record.remember_me
                    else SESSION_IDLE_STANDARD
                )
                record.last_activity_at = now
                record.idle_expires_at = min(
                    now + idle_duration, record.absolute_expires_at
                )
        return SessionContext(record, user, record.csrf_token, context.cookie_token)
    except SQLAlchemyError:
        raise ProblemHTTPException(
            status_code=503, code="service_unavailable"
        ) from None


def set_session_cookie(response: Response, context: SessionContext) -> None:
    max_age = None
    if context.authenticated and context.session.remember_me:
        max_age = max(
            0,
            int((context.session.absolute_expires_at - utc_now()).total_seconds()),
        )
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=context.cookie_token,
        max_age=max_age,
        secure=True,
        httponly=True,
        samesite="lax",
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        secure=True,
        httponly=True,
        samesite="lax",
    )


async def create_authenticated_session(
    database,
    user: User,
    remember_me: bool,
    previous: SessionContext | None,
    *,
    now: datetime | None = None,
) -> SessionContext:
    instant = now or utc_now()
    raw_token = secrets.token_bytes(SESSION_TOKEN_BYTES)
    csrf_token = secrets.token_bytes(CSRF_TOKEN_BYTES)
    idle_duration = SESSION_IDLE_REMEMBERED if remember_me else SESSION_IDLE_STANDARD
    absolute_duration = (
        SESSION_ABSOLUTE_REMEMBERED if remember_me else SESSION_ABSOLUTE_STANDARD
    )
    absolute_expires_at = instant + absolute_duration
    record = AuthSession(
        id=uuid4(),
        kind="authenticated",
        token_hash=hashlib.sha256(raw_token).digest(),
        owner_id=user.id,
        csrf_token=csrf_token,
        auth_version=user.auth_version,
        password_authenticated_at=instant,
        remember_me=remember_me,
        created_at=instant,
        last_activity_at=instant,
        idle_expires_at=min(instant + idle_duration, absolute_expires_at),
        absolute_expires_at=absolute_expires_at,
        revoked_at=None,
    )
    try:
        async with database.sessions() as db:
            async with db.begin():
                if previous is not None:
                    await db.execute(
                        update(AuthSession)
                        .where(
                            AuthSession.id == previous.session.id,
                            AuthSession.revoked_at.is_(None),
                        )
                        .values(revoked_at=instant)
                    )
                db.add(record)
    except SQLAlchemyError:
        raise ProblemHTTPException(
            status_code=503, code="service_unavailable"
        ) from None
    return SessionContext(record, user, csrf_token, encode_base64url(raw_token))


async def revoke_session(request: Request, session_id: UUID) -> None:
    database = request.app.state.database
    now = utc_now()
    try:
        async with database.sessions() as db:
            async with db.begin():
                await db.execute(
                    update(AuthSession)
                    .where(
                        AuthSession.id == session_id, AuthSession.revoked_at.is_(None)
                    )
                    .values(revoked_at=now)
                )
    except SQLAlchemyError:
        raise ProblemHTTPException(
            status_code=503, code="service_unavailable"
        ) from None


async def require_verified_owner(
    request: Request,
    context: SessionContext | None = Depends(get_session_context),
) -> SessionContext:
    if context is None or not context.authenticated:
        raise ProblemHTTPException(status_code=401, code="authentication_required")
    if context.user is None or context.user.email_verified_at is None:
        raise ProblemHTTPException(status_code=403, code="email_not_verified")
    current = await touch_session(request, context)
    if current is None:
        raise ProblemHTTPException(status_code=401, code="authentication_required")
    return current
