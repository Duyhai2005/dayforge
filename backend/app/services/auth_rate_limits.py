"""Atomic, pseudonymous authentication request buckets."""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.auth_crypto import pseudonym


@dataclass(frozen=True)
class RateLimitResult:
    allowed: bool
    retry_after_seconds: int


def _mysql_utc(value: datetime) -> datetime:
    return value.astimezone(timezone.utc).replace(
        tzinfo=None, microsecond=(value.microsecond // 1000) * 1000
    )


async def consume_bucket(
    session: AsyncSession,
    *,
    key: bytes,
    action: str,
    identity: bytes | str,
    limit: int,
    window_seconds: int,
    now: datetime,
) -> RateLimitResult:
    """Consume one fixed rolling window slot using a single MySQL upsert.

    The bucket is anchored at its first request. Concurrent requests serialize
    on the primary key, so counts remain correct across application workers.
    """
    if limit < 1 or not 1 <= window_seconds <= 86400:
        raise ValueError("invalid_rate_limit_policy")
    if now.tzinfo is None:
        raise ValueError("naive_rate_limit_time")
    digest = pseudonym(key, f"auth-rate:{action}", identity)
    current = _mysql_utc(now)
    expires = _mysql_utc(now + timedelta(seconds=window_seconds))
    statement = text(
        "INSERT INTO auth_rate_limits "
        "(bucket_hash, action, window_started_at, window_seconds, count, expires_at) "
        "VALUES (:digest, :action, :now, :window, 1, :expires) "
        "ON DUPLICATE KEY UPDATE "
        "expires_at = IF(window_started_at <= :reset_before, :expires, expires_at), "
        "count = IF(window_started_at <= :reset_before, 1, count + 1), "
        "window_started_at = IF(window_started_at <= :reset_before, :now, window_started_at), "
        "window_seconds = VALUES(window_seconds)"
    )
    await session.execute(
        statement,
        {
            "digest": digest,
            "action": action,
            "now": current,
            "window": window_seconds,
            "expires": expires,
            "reset_before": _mysql_utc(now - timedelta(seconds=window_seconds)),
        },
    )
    count, started = (
        await session.execute(
            text(
                "SELECT count, window_started_at FROM auth_rate_limits WHERE bucket_hash = :digest FOR UPDATE"
            ),
            {"digest": digest},
        )
    ).one()
    retry_after = max(
        1,
        window_seconds
        - int((now - started.replace(tzinfo=timezone.utc)).total_seconds()),
    )
    result = RateLimitResult(allowed=count <= limit, retry_after_seconds=retry_after)
    await session.commit()
    return result
