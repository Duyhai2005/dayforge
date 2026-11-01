"""Allowlisted, privacy-preserving authentication audit records."""

import hmac
import ipaddress
from datetime import datetime, timezone
from uuid import UUID, uuid4

from app.core.config import Settings
from app.models.auth import AuthAuditEvent

AUDIT_ACTIONS = frozenset(
    {
        "session_created",
        "register",
        "verification_resend",
        "email_verified",
        "login",
        "password_forgot",
        "password_reset",
        "logout",
        "local_key",
    }
)
AUDIT_OUTCOMES = frozenset({"success", "accepted", "denied", "noop", "error"})
_AUDIT_DOMAIN = b"auth-audit-v1\0"


def _utc_now() -> datetime:
    value = datetime.now(timezone.utc)
    return value.replace(microsecond=(value.microsecond // 1000) * 1000)


def _pseudonym(settings: Settings, field: bytes, value: bytes | None) -> bytes | None:
    if value is None:
        return None
    key = settings.secret_key("auth_rate_limit_key_b64")
    return hmac.digest(key, _AUDIT_DOMAIN + field + b"\0" + value, "sha256")


def _peer_bytes(peer_ip: str | None) -> bytes | None:
    if not peer_ip:
        return None
    try:
        return ipaddress.ip_address(peer_ip).packed
    except ValueError:
        return b"unknown-peer"


def make_auth_audit_event(
    settings: Settings,
    *,
    action: str,
    outcome: str,
    request_id: str,
    owner_id: UUID | None = None,
    email_canonical: bytes | None = None,
    peer_ip: str | None = None,
    now: datetime | None = None,
) -> AuthAuditEvent:
    if action not in AUDIT_ACTIONS or outcome not in AUDIT_OUTCOMES or not request_id or len(request_id) > 36:
        raise ValueError("auth_audit_event_invalid")
    return AuthAuditEvent(
        id=uuid4(),
        created_at=now or _utc_now(),
        action=action,
        outcome=outcome,
        request_id=request_id,
        owner_id=owner_id,
        email_digest=_pseudonym(settings, b"email", email_canonical),
        peer_digest=_pseudonym(settings, b"peer", _peer_bytes(peer_ip)),
    )


async def record_auth_audit(database, settings: Settings, **values) -> None:
    """Persist a standalone audit event without allowing its failure to alter a denial."""
    async with database.sessions() as db:
        async with db.begin():
            db.add(make_auth_audit_event(settings, **values))
