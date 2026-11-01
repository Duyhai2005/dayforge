"""Verified-owner account lifecycle, rate limits and local-key access."""

import asyncio
import hashlib
import ipaddress
import secrets
import weakref
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from sqlalchemy import and_, or_, select, update
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.exc import IntegrityError, OperationalError, SQLAlchemyError

from app.core.config import Settings, SettingsError
from app.core.errors import ProblemHTTPException
from app.models.auth import (
    AuthRateLimit,
    EmailToken,
    OwnerLocalKey,
)
from app.models.auth import (
    Session as AuthSession,
)
from app.models.owner import User, WorkspaceSettings
from app.schemas.problem import FieldError
from app.services.auth_crypto import (
    CryptoEnvelopeError,
    WrappedKey,
    decode_base64url,
    encode_base64url,
    unwrap_owner_key,
    wrap_owner_key,
)
from app.services.auth_rate_limits import evaluate_rolling_limit, pseudonymize
from app.services.email_address import (
    CanonicalEmail,
    EmailAddressError,
    canonicalize_email,
)
from app.services.email_delivery import make_delivery_job
from app.services.passwords import (
    DUMMY_PASSWORD_HASH,
    PasswordPolicyError,
    hash_password,
    validate_new_password,
    verify_password,
)
from app.services.sessions import (
    RECENT_PASSWORD_WINDOW,
    SessionContext,
    create_authenticated_session,
    utc_now,
)

VERIFY_EMAIL_TOKEN_TTL = timedelta(hours=24)
PASSWORD_RESET_TOKEN_TTL = timedelta(minutes=30)
_RATE_BUCKET_TTL = timedelta(hours=48)
_PASSWORD_WORKERS = 2
_PASSWORD_WAITERS = 4


class _PasswordWorkLimiter:
    def __init__(self):
        self.semaphore = asyncio.Semaphore(_PASSWORD_WORKERS)
        self.guard = asyncio.Lock()
        self.waiters = 0


_PASSWORD_LIMITERS: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, _PasswordWorkLimiter] = (
    weakref.WeakKeyDictionary()
)


@dataclass(frozen=True)
class _Limit:
    action: str
    subject_kind: str
    subject_digest: bytes
    window_seconds: int
    maximum: int


def _rate_limit_error(retry_after: int) -> ProblemHTTPException:
    return ProblemHTTPException(
        status_code=429,
        code="rate_limited",
        retry_after_seconds=retry_after,
    )


def _ip_bytes(value: str | None) -> bytes:
    if not value:
        return b"unknown-peer"
    try:
        return ipaddress.ip_address(value).packed
    except ValueError:
        return b"unknown-peer"


def _bucket(
    settings: Settings,
    action: str,
    subject_kind: str,
    subject: bytes,
    window_seconds: int,
    maximum: int,
) -> _Limit:
    return _Limit(
        action,
        subject_kind,
        pseudonymize(
            settings.secret_key("auth_rate_limit_key_b64"),
            action,
            subject_kind,
            subject,
        ),
        window_seconds,
        maximum,
    )


def _email_request_limits(settings: Settings, email: bytes, peer_ip: str | None) -> tuple[_Limit, ...]:
    peer = _ip_bytes(peer_ip)
    return (
        _bucket(settings, "email-cooldown", "email", email, 60, 1),
        _bucket(settings, "email-hour", "email", email, 3600, 5),
        _bucket(settings, "email-day", "email", email, 86400, 10),
        _bucket(settings, "email-ip-hour", "ip", peer, 3600, 30),
        _bucket(settings, "email-ip-day", "ip", peer, 86400, 100),
    )


def _login_limits(settings: Settings, email_subject: bytes, peer_ip: str | None) -> tuple[_Limit, ...]:
    return (
        _bucket(settings, "login-email", "email", email_subject, 900, 5),
        _bucket(settings, "login-ip", "ip", _ip_bytes(peer_ip), 900, 30),
    )


def _token_limits(
    settings: Settings,
    purpose: str,
    token_digest: bytes,
    peer_ip: str | None,
) -> tuple[_Limit, ...]:
    action = "token-verify" if purpose == "verify_email" else "token-reset"
    return (
        _bucket(settings, action, "token", token_digest, 60, 10),
        _bucket(settings, action, "ip", _ip_bytes(peer_ip), 60, 60),
    )


def _session_limits(settings: Settings, session_id: UUID | None, peer_ip: str | None) -> tuple[_Limit, ...]:
    limits = [_bucket(settings, "session-ip", "ip", _ip_bytes(peer_ip), 60, 120)]
    if session_id is not None:
        limits.append(_bucket(settings, "session-device", "session", session_id.bytes, 60, 60))
    return tuple(limits)


def _event_datetimes(value: object) -> tuple[datetime, ...]:
    if not isinstance(value, list):
        return ()
    events = []
    for item in value:
        if type(item) is int and 0 <= item <= 253402300799999:
            events.append(datetime.fromtimestamp(item / 1000, timezone.utc))
    return tuple(events)


async def _apply_limits_once(
    database,
    ordered: tuple[_Limit, ...],
    now: datetime,
    *,
    record_event: bool,
) -> None:
    async with database.sessions() as db:
        async with db.begin():
            for limit in ordered:
                await db.execute(
                    mysql_insert(AuthRateLimit)
                    .prefix_with("IGNORE")
                    .values(
                        action=limit.action,
                        subject_kind=limit.subject_kind,
                        subject_digest=limit.subject_digest,
                        window_seconds=limit.window_seconds,
                        request_count=0,
                        event_timestamps=[],
                        updated_at=now,
                        expires_at=now + _RATE_BUCKET_TTL,
                    )
                )
            rows = (
                (
                    await db.execute(
                        select(AuthRateLimit)
                        .where(
                            or_(
                                *(
                                    and_(
                                        AuthRateLimit.action == item.action,
                                        AuthRateLimit.subject_kind == item.subject_kind,
                                        AuthRateLimit.subject_digest == item.subject_digest,
                                    )
                                    for item in ordered
                                )
                            )
                        )
                        .order_by(
                            AuthRateLimit.action,
                            AuthRateLimit.subject_kind,
                            AuthRateLimit.subject_digest,
                        )
                        .with_for_update()
                    )
                )
                .scalars()
                .all()
            )
            row_by_key = {(row.action, row.subject_kind, row.subject_digest): row for row in rows}
            decisions = []
            for limit in ordered:
                row = row_by_key.get((limit.action, limit.subject_kind, limit.subject_digest))
                if row is None:
                    raise SQLAlchemyError("rate_limit_row_missing")
                decision = evaluate_rolling_limit(
                    _event_datetimes(row.event_timestamps),
                    now,
                    window_seconds=limit.window_seconds,
                    maximum=limit.maximum,
                )
                decisions.append((limit, row, decision))
            denied = [decision.retry_after_seconds for _, _, decision in decisions if not decision.allowed]
            if denied:
                raise _rate_limit_error(max(denied))
            for limit, row, decision in decisions:
                events = [int(event.timestamp() * 1000) for event in decision.retained_events]
                if record_event:
                    events.append(int(now.timestamp() * 1000))
                row.window_seconds = limit.window_seconds
                row.event_timestamps = events
                row.request_count = len(events)
                row.updated_at = now
                row.expires_at = now + _RATE_BUCKET_TTL


async def _apply_limits(
    database,
    limits: tuple[_Limit, ...],
    now: datetime,
    *,
    record_event: bool,
) -> None:
    ordered = tuple(
        sorted(
            limits,
            key=lambda item: (item.action, item.subject_kind, item.subject_digest),
        )
    )
    for attempt in range(3):
        try:
            await _apply_limits_once(database, ordered, now, record_event=record_event)
            return
        except ProblemHTTPException:
            raise
        except OperationalError as error:
            original = getattr(error, "orig", None)
            arguments = getattr(original, "args", ())
            error_code = arguments[0] if arguments else None
            if error_code not in {1205, 1213} or attempt == 2:
                raise ProblemHTTPException(status_code=503, code="service_unavailable") from None
            await asyncio.sleep(0.01 * (attempt + 1))
        except SQLAlchemyError:
            raise ProblemHTTPException(status_code=503, code="service_unavailable") from None


def _canonical_or_problem(value: str) -> CanonicalEmail:
    try:
        return canonicalize_email(value)
    except EmailAddressError:
        raise ProblemHTTPException(
            status_code=422,
            code="validation_failed",
            field_errors=[FieldError(path="/email", code="invalid_value")],
        ) from None


def _password_problem(error: PasswordPolicyError) -> ProblemHTTPException:
    return ProblemHTTPException(
        status_code=422,
        code=error.code,
        field_errors=[FieldError(path="/password", code=error.code)],
    )


async def _password_work(function, *arguments):
    loop = asyncio.get_running_loop()
    limiter = _PASSWORD_LIMITERS.get(loop)
    if limiter is None:
        limiter = _PasswordWorkLimiter()
        _PASSWORD_LIMITERS[loop] = limiter
    async with limiter.guard:
        queued = limiter.semaphore.locked()
        if queued and limiter.waiters >= _PASSWORD_WAITERS:
            raise ProblemHTTPException(status_code=503, code="service_unavailable")
        if queued:
            limiter.waiters += 1
    try:
        await limiter.semaphore.acquire()
    finally:
        if queued:
            async with limiter.guard:
                limiter.waiters -= 1
    try:
        return await asyncio.to_thread(function, *arguments)
    finally:
        limiter.semaphore.release()


def _email_token_digest(token: str) -> tuple[bytes, bytes]:
    raw = decode_base64url(token, 32)
    if raw is None:
        raise ProblemHTTPException(status_code=400, code="email_token_invalid")
    return raw, hashlib.sha256(raw).digest()


def _token_error(code: str) -> ProblemHTTPException:
    status = {
        "email_token_invalid": 400,
        "email_token_used": 409,
        "email_token_expired": 410,
    }[code]
    return ProblemHTTPException(status_code=status, code=code)


class AuthService:
    def __init__(self, database, settings: Settings):
        self.database = database
        self.settings = settings
        self.owner_email = canonicalize_email(settings.owner_email)

    async def session_request_limit(self, context: SessionContext | None, peer_ip: str | None) -> None:
        session_id = None if context is None else context.session.id
        await _apply_limits(
            self.database,
            _session_limits(self.settings, session_id, peer_ip),
            utc_now(),
            record_event=True,
        )

    async def request_email(self, email: str, purpose: str, peer_ip: str | None) -> None:
        canonical = _canonical_or_problem(email)
        if purpose not in {"verify_email", "password_reset"}:
            raise ValueError("email_purpose_invalid")
        now = utc_now()
        await _apply_limits(
            self.database,
            _email_request_limits(self.settings, canonical.canonical, peer_ip),
            now,
            record_event=True,
        )
        try:
            async with self.database.sessions() as db:
                async with db.begin():
                    user = (
                        await db.execute(
                            select(User).where(User.email_canonical == canonical.canonical).with_for_update()
                        )
                    ).scalar_one_or_none()
                    eligible = canonical.canonical == self.owner_email.canonical
                    recipient = self.owner_email.delivery
                    owner_id = None
                    if purpose == "verify_email":
                        eligible = eligible and user is None
                        ttl = VERIFY_EMAIL_TOKEN_TTL
                    else:
                        eligible = eligible and user is not None and user.email_verified_at is not None
                        ttl = PASSWORD_RESET_TOKEN_TTL
                        if user is not None:
                            recipient = user.email_delivery
                            owner_id = user.id
                    if eligible:
                        raw_token = secrets.token_bytes(32)
                        token_text = encode_base64url(raw_token)
                        record = EmailToken(
                            id=uuid4(),
                            purpose=purpose,
                            token_hash=hashlib.sha256(raw_token).digest(),
                            email_canonical=canonical.canonical,
                            owner_id=owner_id,
                            created_at=now,
                            expires_at=now + ttl,
                            consumed_at=None,
                            invalidated_at=None,
                        )
                        job = make_delivery_job(
                            self.settings,
                            recipient=recipient,
                            kind=purpose,
                            token=token_text,
                            now=now,
                            expires_at=now + ttl,
                        )
                        db.add(record)
                        db.add(job)
        except SQLAlchemyError:
            raise ProblemHTTPException(status_code=503, code="service_unavailable") from None

    async def confirm_email(self, token: str, password: str, peer_ip: str | None) -> None:
        raw_token, digest = _email_token_digest(token)
        now = utc_now()
        await _apply_limits(
            self.database,
            _token_limits(self.settings, "verify_email", digest, peer_ip),
            now,
            record_event=True,
        )
        try:
            async with self.database.sessions() as db:
                async with db.begin():
                    record = (
                        await db.execute(select(EmailToken).where(EmailToken.token_hash == digest).with_for_update())
                    ).scalar_one_or_none()
                    if record is None or record.purpose != "verify_email":
                        raise _token_error("email_token_invalid")
                    if record.consumed_at is not None or record.invalidated_at is not None:
                        raise _token_error("email_token_used")
                    if now >= record.expires_at:
                        raise _token_error("email_token_expired")
                    if record.owner_id is not None or record.email_canonical != self.owner_email.canonical:
                        raise _token_error("email_token_invalid")
                    existing_owner = (
                        await db.execute(select(User).where(User.owner_slot == 1).with_for_update())
                    ).scalar_one_or_none()
                    if existing_owner is not None:
                        raise _token_error("email_token_used")
                    try:
                        normalized = validate_new_password(password, self.owner_email.delivery)
                    except PasswordPolicyError as error:
                        raise _password_problem(error) from None
                    password_hash = await _password_work(hash_password, normalized)
                    owner_id = uuid4()
                    key_id = uuid4()
                    raw_key = secrets.token_bytes(32)
                    wrapped = wrap_owner_key(
                        owner_id,
                        key_id,
                        raw_key,
                        self.settings.secret_key("local_key_kek_b64"),
                        self.settings.local_key_kek_version,
                    )
                    db.add(
                        User(
                            id=owner_id,
                            owner_slot=1,
                            email_canonical=self.owner_email.canonical,
                            email_delivery=self.owner_email.delivery,
                            password_hash=password_hash,
                            email_verified_at=now,
                            auth_version=1,
                            created_at=now,
                            updated_at=now,
                        )
                    )
                    await db.flush()
                    db.add(WorkspaceSettings(owner_id=owner_id))
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
                    record.consumed_at = now
                    await db.execute(
                        update(EmailToken)
                        .where(
                            EmailToken.id != record.id,
                            EmailToken.purpose == "verify_email",
                            EmailToken.email_canonical == record.email_canonical,
                            EmailToken.consumed_at.is_(None),
                            EmailToken.invalidated_at.is_(None),
                        )
                        .values(invalidated_at=now)
                    )
        except ProblemHTTPException:
            raise
        except IntegrityError:
            raise _token_error("email_token_used") from None
        except CryptoEnvelopeError:
            raise ProblemHTTPException(status_code=503, code="service_unavailable") from None
        except SQLAlchemyError:
            raise ProblemHTTPException(status_code=503, code="service_unavailable") from None
        finally:
            del raw_token

    async def login(
        self,
        email: str,
        password: str,
        remember_me: bool,
        previous: SessionContext | None,
        peer_ip: str | None,
    ) -> SessionContext:
        try:
            canonical = canonicalize_email(email)
            email_subject = canonical.canonical
        except EmailAddressError:
            canonical = None
            email_subject = hashlib.sha256(email.encode("utf-8", "replace")).digest()
        now = utc_now()
        limits = _login_limits(self.settings, email_subject, peer_ip)
        await _apply_limits(self.database, limits, now, record_event=False)
        try:
            async with self.database.sessions() as db:
                user = None
                if canonical is not None:
                    user = (
                        await db.execute(select(User).where(User.email_canonical == canonical.canonical))
                    ).scalar_one_or_none()
        except SQLAlchemyError:
            raise ProblemHTTPException(status_code=503, code="service_unavailable") from None
        password_hash = (
            user.password_hash if user is not None and user.email_verified_at is not None else DUMMY_PASSWORD_HASH
        )
        valid = await _password_work(verify_password, password, password_hash)
        allowed_owner = canonical is not None and canonical.canonical == self.owner_email.canonical
        if not valid or user is None or user.email_verified_at is None or not allowed_owner:
            await _apply_limits(self.database, limits, now, record_event=True)
            raise ProblemHTTPException(status_code=401, code="invalid_credentials")
        return await create_authenticated_session(self.database, user, remember_me, previous, now=now)

    async def reset_password(self, token: str, password: str, peer_ip: str | None) -> None:
        _raw_token, digest = _email_token_digest(token)
        now = utc_now()
        await _apply_limits(
            self.database,
            _token_limits(self.settings, "password_reset", digest, peer_ip),
            now,
            record_event=True,
        )
        try:
            async with self.database.sessions() as db:
                async with db.begin():
                    record = (
                        await db.execute(select(EmailToken).where(EmailToken.token_hash == digest).with_for_update())
                    ).scalar_one_or_none()
                    if record is None or record.purpose != "password_reset":
                        raise _token_error("email_token_invalid")
                    if record.consumed_at is not None or record.invalidated_at is not None:
                        raise _token_error("email_token_used")
                    if now >= record.expires_at:
                        raise _token_error("email_token_expired")
                    if record.owner_id is None:
                        raise _token_error("email_token_invalid")
                    user = await db.get(User, record.owner_id, with_for_update=True)
                    if (
                        user is None
                        or user.email_canonical != self.owner_email.canonical
                        or user.email_verified_at is None
                    ):
                        raise _token_error("email_token_invalid")
                    try:
                        normalized = validate_new_password(password, user.email_delivery)
                    except PasswordPolicyError as error:
                        raise _password_problem(error) from None
                    password_hash = await _password_work(hash_password, normalized)
                    user.password_hash = password_hash
                    user.auth_version += 1
                    user.updated_at = now
                    record.consumed_at = now
                    await db.execute(
                        update(EmailToken)
                        .where(
                            EmailToken.owner_id == user.id,
                            EmailToken.purpose == "password_reset",
                            EmailToken.id != record.id,
                            EmailToken.consumed_at.is_(None),
                            EmailToken.invalidated_at.is_(None),
                        )
                        .values(invalidated_at=now)
                    )
                    await db.execute(
                        update(AuthSession)
                        .where(
                            AuthSession.owner_id == user.id,
                            AuthSession.kind == "authenticated",
                            AuthSession.revoked_at.is_(None),
                        )
                        .values(revoked_at=now)
                    )
                    db.add(
                        make_delivery_job(
                            self.settings,
                            recipient=user.email_delivery,
                            kind="password_reset_notice",
                            now=now,
                            expires_at=now + timedelta(days=30),
                        )
                    )
        except ProblemHTTPException:
            raise
        except IntegrityError:
            raise _token_error("email_token_used") from None
        except SQLAlchemyError:
            raise ProblemHTTPException(status_code=503, code="service_unavailable") from None

    async def local_key(self, context: SessionContext, peer_ip: str | None) -> dict[str, str]:
        now = utc_now()
        await _apply_limits(
            self.database,
            _session_limits(self.settings, context.session.id, peer_ip),
            now,
            record_event=True,
        )
        authenticated_at = context.session.password_authenticated_at
        if authenticated_at is None:
            raise ProblemHTTPException(status_code=403, code="reauthentication_required")
        if authenticated_at.tzinfo is None:
            authenticated_at = authenticated_at.replace(tzinfo=timezone.utc)
        if authenticated_at > now or now - authenticated_at >= RECENT_PASSWORD_WINDOW:
            raise ProblemHTTPException(status_code=403, code="reauthentication_required")
        try:
            async with self.database.sessions() as db:
                record = await db.get(OwnerLocalKey, context.session.owner_id)
        except SQLAlchemyError:
            raise ProblemHTTPException(status_code=503, code="service_unavailable") from None
        if record is None:
            raise ProblemHTTPException(status_code=503, code="service_unavailable")
        try:
            raw_key = unwrap_owner_key(
                record.owner_id,
                record.key_id,
                WrappedKey(record.algorithm, record.wrapped_key, record.kek_version),
                self.settings.secret_key("local_key_kek_b64"),
                self.settings.local_key_kek_version,
            )
        except CryptoEnvelopeError:
            raise ProblemHTTPException(status_code=503, code="service_unavailable") from None
        return {
            "owner_id": str(record.owner_id),
            "key_id": str(record.key_id),
            "algorithm": "A256GCM",
            "key_base64url": encode_base64url(raw_key),
        }


async def validate_owner_email_binding(database, settings: Settings) -> None:
    """Fail startup if configured ownership no longer matches the installed owner."""
    configured = canonicalize_email(settings.owner_email).canonical
    try:
        async with database.sessions() as db:
            owner = (await db.execute(select(User).where(User.owner_slot == 1))).scalar_one_or_none()
    except SQLAlchemyError:
        raise RuntimeError("auth_store_unavailable") from None
    if owner is not None and owner.email_canonical != configured:
        raise SettingsError("OWNER_EMAIL")
