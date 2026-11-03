"""Transactional account, verification, login and password-reset flows."""

import logging
import secrets
import unicodedata
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi import Request
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import ProblemHTTPException
from app.models.auth import EmailToken, OwnerLocalKey, Session
from app.models.owner import User, WorkspaceSettings
from app.services.auth_crypto import (
    decode_key,
    generate_token,
    token_digest,
    wrap_owner_key,
)
from app.services.auth_rate_limits import consume_bucket
from app.services.email_address import (
    CanonicalEmail,
    EmailAddressError,
    canonicalize_email,
)
from app.services.email_delivery import enqueue_email, enqueue_payload
from app.services.passwords import (
    PasswordPolicyError,
    hash_password,
    password_needs_rehash,
    validate_new_password,
    verify_password,
)
from app.services.sessions import SessionContext, create_authenticated_session

_logger = logging.getLogger("dayforge.auth")


def _now() -> datetime:
    current = datetime.now(timezone.utc)
    return current.replace(microsecond=(current.microsecond // 1000) * 1000)


def _configured_email(settings: Settings) -> CanonicalEmail | None:
    configured = settings.owner_email.get_secret_value().strip()
    return canonicalize_email(configured) if configured else None


async def validate_owner_email_binding(database, settings: Settings) -> None:
    """Reject changed allowlist settings after an owner has been established."""
    from sqlalchemy import text

    async with database.engine.connect() as connection:
        stored = (
            await connection.execute(text("SELECT email_canonical FROM users LIMIT 1"))
        ).scalar_one_or_none()
    if stored is None:
        return
    configured = _configured_email(settings)
    if configured is None or stored != configured.canonical:
        raise ValueError("owner_email_binding_mismatch")


def _peer(request: Request) -> str:
    # Forwarded headers are intentionally ignored; only the direct peer is trusted.
    return request.client.host if request.client is not None else "unknown"


def _retry(retry_after: int) -> ProblemHTTPException:
    return ProblemHTTPException(
        status_code=429, code="rate_limited", retry_after_seconds=max(1, retry_after)
    )


async def _consume(
    db: AsyncSession,
    settings: Settings,
    *,
    action: str,
    identity: bytes | str,
    limit: int,
    window: int,
    now: datetime,
) -> None:
    key = decode_key(settings.auth_rate_limit_key_b64.get_secret_value())
    result = await consume_bucket(
        db,
        key=key,
        action=action,
        identity=identity,
        limit=limit,
        window_seconds=window,
        now=now,
    )
    if not result.allowed:
        raise _retry(result.retry_after_seconds)


async def _email_request_limits(
    db: AsyncSession,
    settings: Settings,
    request: Request,
    email_identity: bytes | str,
    now: datetime,
) -> None:
    for action, identity, limit, window in (
        ("email_60", email_identity, 1, 60),
        ("email_hour", email_identity, 5, 3600),
        ("email_day", email_identity, 10, 86400),
        ("ip_email_hour", _peer(request), 30, 3600),
        ("ip_email_day", _peer(request), 100, 86400),
    ):
        await _consume(
            db,
            settings,
            action=action,
            identity=identity,
            limit=limit,
            window=window,
            now=now,
        )


async def _token_limits(
    db: AsyncSession, settings: Settings, request: Request, token: str, now: datetime
) -> None:
    digest = token_digest(token)
    await _consume(
        db,
        settings,
        action="token_minute",
        identity=digest,
        limit=10,
        window=60,
        now=now,
    )
    await _consume(
        db,
        settings,
        action="ip_token_minute",
        identity=_peer(request),
        limit=60,
        window=60,
        now=now,
    )


def _canonical_or_identity(value: str) -> tuple[CanonicalEmail | None, bytes | str]:
    try:
        canonical = canonicalize_email(value)
        return canonical, canonical.canonical
    except EmailAddressError:
        return None, value.encode("utf-8", errors="replace")[:4096]


async def request_verification(
    db: AsyncSession, settings: Settings, request: Request, email: str
) -> dict:
    now = _now()
    canonical, identity = _canonical_or_identity(email)
    await _email_request_limits(db, settings, request, identity, now)
    allowed = _configured_email(settings)
    if (
        canonical is not None
        and allowed is not None
        and canonical.canonical == allowed.canonical
    ):
        existing = await db.scalar(
            select(User.id).where(User.email_canonical == canonical.canonical)
        )
        if existing is None:
            token = generate_token()
            db.add(
                EmailToken(
                    id=uuid4(),
                    purpose="verify_email",
                    token_hash=token_digest(token),
                    email_canonical=canonical.canonical,
                    owner_id=None,
                    created_at=now,
                    expires_at=now + timedelta(hours=24),
                    consumed_at=None,
                    invalidated_at=None,
                )
            )
            enqueue_email(
                db,
                settings,
                recipient=allowed.delivery,
                purpose="verify_email",
                token=token,
                now=now,
            )
            await db.commit()
    return {"status": "accepted", "resend_after_seconds": 60}


async def request_password_reset(
    db: AsyncSession, settings: Settings, request: Request, email: str
) -> dict:
    now = _now()
    canonical, identity = _canonical_or_identity(email)
    await _email_request_limits(db, settings, request, identity, now)
    allowed = _configured_email(settings)
    if (
        canonical is not None
        and allowed is not None
        and canonical.canonical == allowed.canonical
    ):
        user = await db.scalar(
            select(User).where(User.email_canonical == canonical.canonical)
        )
        if user is not None:
            if user.email_verified_at is None:
                user = None
        if user is not None:
            token = generate_token()
            db.add(
                EmailToken(
                    id=uuid4(),
                    purpose="password_reset",
                    token_hash=token_digest(token),
                    email_canonical=canonical.canonical,
                    owner_id=user.id,
                    created_at=now,
                    expires_at=now + timedelta(minutes=30),
                    consumed_at=None,
                    invalidated_at=None,
                )
            )
            enqueue_email(
                db,
                settings,
                recipient=user.email_delivery,
                purpose="password_reset",
                token=token,
                now=now,
            )
            await db.commit()
    return {"status": "accepted", "resend_after_seconds": 60}


async def confirm_verification(
    db: AsyncSession, settings: Settings, request: Request, token: str, password: str
) -> dict:
    now = _now()
    try:
        await _token_limits(db, settings, request, token, now)
        digest = token_digest(token)
    except ValueError:
        raise ProblemHTTPException(
            status_code=400, code="email_token_invalid"
        ) from None
    email_token = await db.scalar(
        select(EmailToken).where(EmailToken.token_hash == digest).with_for_update()
    )
    if (
        email_token is None
        or email_token.purpose != "verify_email"
        or email_token.invalidated_at is not None
    ):
        raise ProblemHTTPException(status_code=400, code="email_token_invalid")
    if email_token.consumed_at is not None:
        raise ProblemHTTPException(status_code=409, code="email_token_used")
    if now >= email_token.expires_at:
        raise ProblemHTTPException(status_code=410, code="email_token_expired")
    configured = _configured_email(settings)
    if configured is None or email_token.email_canonical != configured.canonical:
        raise ProblemHTTPException(status_code=400, code="email_token_invalid")
    try:
        normalized_password = validate_new_password(password, configured.delivery)
    except PasswordPolicyError as error:
        code = (
            "password_blocklisted"
            if error.code == "password_blocklisted"
            else "password_policy_violation"
        )
        raise ProblemHTTPException(status_code=422, code=code) from None
    existing = await db.scalar(
        select(User.id)
        .where(User.email_canonical == configured.canonical)
        .with_for_update()
    )
    if existing is not None:
        raise ProblemHTTPException(status_code=409, code="email_token_used")
    owner_id = uuid4()
    raw_key = secrets.token_bytes(32)
    key_id = uuid4()
    key_version = int(settings.local_key_kek_version)
    wrapped = wrap_owner_key(
        owner_id,
        key_id,
        raw_key,
        decode_key(settings.local_key_kek_b64.get_secret_value()),
        key_version,
    )
    db.add(
        User(
            id=owner_id,
            owner_slot=1,
            email_canonical=configured.canonical,
            email_delivery=configured.delivery,
            password_hash=hash_password(normalized_password),
            email_verified_at=now,
            auth_version=1,
            created_at=now,
            updated_at=now,
        )
    )
    # Sessions are configured with autoflush disabled; explicitly persist the
    # FK parent before queuing its workspace and wrapped local key.
    await db.flush()
    db.add(
        WorkspaceSettings(
            owner_id=owner_id,
            time_zone="Asia/Bangkok",
            utc_offset_minutes=420,
            week_start=1,
        )
    )
    db.add(
        OwnerLocalKey(
            owner_id=owner_id,
            key_id=key_id,
            algorithm=wrapped.algorithm,
            wrapped_key=wrapped.wrapped_key,
            kek_version=wrapped.kek_version,
            created_at=now,
        )
    )
    email_token.consumed_at = now
    await db.execute(
        update(EmailToken)
        .where(
            EmailToken.email_canonical == configured.canonical,
            EmailToken.purpose == "verify_email",
            EmailToken.id != email_token.id,
            EmailToken.invalidated_at.is_(None),
        )
        .values(invalidated_at=now)
    )
    try:
        await db.commit()
    except IntegrityError as error:
        await db.rollback()
        original_error = error.orig
        database_code = (
            original_error.args[0]
            if original_error is not None and original_error.args
            else "unknown"
        )
        _logger.warning("auth_verification_commit_conflict code=%s", database_code)
        if database_code == 1062:
            raise ProblemHTTPException(
                status_code=409, code="email_token_used"
            ) from None
        raise ProblemHTTPException(
            status_code=503, code="service_unavailable"
        ) from None
    return {"status": "verified"}


async def login(
    db: AsyncSession,
    settings: Settings,
    request: Request,
    context: SessionContext,
    email: str,
    password: str,
    remember_me: bool,
) -> dict:
    now = _now()
    canonical, identity = _canonical_or_identity(email)
    allowed = _configured_email(settings)
    user = None
    if canonical is not None:
        user = await db.scalar(
            select(User).where(User.email_canonical == canonical.canonical)
        )
    encoded_hash = (
        user.password_hash
        if user is not None and user.email_verified_at is not None
        else None
    )
    normalized_password = unicodedata.normalize("NFC", password)
    valid_password = verify_password(normalized_password, encoded_hash)
    valid_user = (
        user is not None
        and user.email_verified_at is not None
        and allowed is not None
        and canonical is not None
        and canonical.canonical == allowed.canonical
        and valid_password
    )
    if not valid_user:
        for action, ident in (("login_email", identity), ("login_ip", _peer(request))):
            await _consume(
                db,
                settings,
                action=action,
                identity=ident,
                limit=5 if action == "login_email" else 30,
                window=900,
                now=now,
            )
        raise ProblemHTTPException(status_code=401, code="invalid_credentials")
    assert user is not None
    await _consume_session_limits(db, settings, request, context, now)
    if password_needs_rehash(user.password_hash):
        user.password_hash = hash_password(normalized_password)
        user.updated_at = now
    new_context = await create_authenticated_session(
        request, db, context, user, remember_me, now
    )
    return _session_view(new_context)


async def _consume_session_limits(
    db: AsyncSession,
    settings: Settings,
    request: Request,
    context: SessionContext,
    now: datetime,
) -> None:
    for action, identity, limit in (
        ("session_minute", str(context.row.id), 60),
        ("ip_session_minute", _peer(request), 120),
    ):
        await _consume(
            db,
            settings,
            action=action,
            identity=identity,
            limit=limit,
            window=60,
            now=now,
        )


def _session_view(context: SessionContext) -> dict:
    from app.services.sessions import make_session_view

    return make_session_view(context)


async def reset_password(
    db: AsyncSession, settings: Settings, request: Request, token: str, password: str
) -> dict:
    now = _now()
    try:
        await _token_limits(db, settings, request, token, now)
        digest = token_digest(token)
    except ValueError:
        raise ProblemHTTPException(
            status_code=400, code="email_token_invalid"
        ) from None
    email_token = await db.scalar(
        select(EmailToken).where(EmailToken.token_hash == digest).with_for_update()
    )
    if (
        email_token is None
        or email_token.purpose != "password_reset"
        or email_token.invalidated_at is not None
    ):
        raise ProblemHTTPException(status_code=400, code="email_token_invalid")
    if email_token.consumed_at is not None:
        raise ProblemHTTPException(status_code=409, code="email_token_used")
    if now >= email_token.expires_at:
        raise ProblemHTTPException(status_code=410, code="email_token_expired")
    user = await db.scalar(
        select(User).where(User.id == email_token.owner_id).with_for_update()
    )
    if user is None or user.email_canonical != email_token.email_canonical:
        raise ProblemHTTPException(status_code=400, code="email_token_invalid")
    try:
        normalized_password = validate_new_password(password, user.email_delivery)
    except PasswordPolicyError as error:
        code = (
            "password_blocklisted"
            if error.code == "password_blocklisted"
            else "password_policy_violation"
        )
        raise ProblemHTTPException(status_code=422, code=code) from None
    user.password_hash = hash_password(normalized_password)
    user.auth_version += 1
    user.updated_at = now
    email_token.consumed_at = now
    await db.execute(
        update(Session)
        .where(
            Session.owner_id == user.id,
            Session.kind == "authenticated",
            Session.revoked_at.is_(None),
        )
        .values(revoked_at=now)
    )
    await db.execute(
        update(EmailToken)
        .where(
            EmailToken.owner_id == user.id,
            EmailToken.purpose == "password_reset",
            EmailToken.id != email_token.id,
            EmailToken.invalidated_at.is_(None),
        )
        .values(invalidated_at=now)
    )
    enqueue_payload(
        db,
        settings,
        recipient=user.email_delivery,
        subject="Dayforge: password changed",
        body="Your Dayforge password was changed. If this was not you, contact the account owner immediately.",
        now=now,
    )
    await db.commit()
    return {"status": "password_reset"}


async def local_key(
    db: AsyncSession, settings: Settings, request: Request, context: SessionContext
) -> dict:
    user = context.user
    if user is None:
        raise ProblemHTTPException(status_code=401, code="authentication_required")
    await _consume_session_limits(db, settings, request, context, context.now)
    authenticated_at = context.row.password_authenticated_at
    if authenticated_at is None or context.now >= authenticated_at + timedelta(
        minutes=5
    ):
        raise ProblemHTTPException(status_code=403, code="reauthentication_required")
    wrapped = await db.get(OwnerLocalKey, user.id)
    if wrapped is None:
        raise ProblemHTTPException(status_code=503, code="service_unavailable")
    from app.services.auth_crypto import encode_token, unwrap_owner_key

    raw_key = unwrap_owner_key(
        user.id,
        wrapped.key_id,
        wrapped.wrapped_key,
        decode_key(settings.local_key_kek_b64.get_secret_value()),
        wrapped.kek_version,
    )
    return {
        "owner_id": str(user.id),
        "key_id": str(wrapped.key_id),
        "algorithm": "A256GCM",
        "key_base64url": encode_token(raw_key),
    }
