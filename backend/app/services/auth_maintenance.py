"""Bounded retention cleanup for authentication storage."""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, delete, or_, select, tuple_
from sqlalchemy.exc import SQLAlchemyError

from app.models.auth import AuthAuditEvent, AuthRateLimit, EmailDeliveryJob, EmailToken
from app.models.auth import Session as AuthSession

_LOGGER = logging.getLogger("dayforge.auth.maintenance")
_TOKEN_RETENTION = timedelta(days=7)
_REVOKED_SESSION_RETENTION = timedelta(days=7)
_AUDIT_RETENTION = timedelta(days=30)
_RATE_LIMIT_RETENTION = timedelta(hours=48)
_BATCH_LIMIT = 500


def _normalize(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("auth_maintenance_clock_invalid")
    value = value.astimezone(timezone.utc)
    return value.replace(microsecond=(value.microsecond // 1000) * 1000)


async def _delete_ids(database, model, id_column, predicate, *, limit: int) -> int:
    async with database.sessions() as db:
        async with db.begin():
            ids = list(
                (
                    await db.execute(
                        select(id_column)
                        .where(predicate)
                        .order_by(id_column)
                        .limit(limit)
                        .with_for_update(skip_locked=True)
                    )
                ).scalars()
            )
            if not ids:
                return 0
            result = await db.execute(delete(model).where(id_column.in_(ids), predicate))
            return int(result.rowcount or 0)


async def cleanup_auth_storage(database, *, now: datetime | None = None, limit: int = _BATCH_LIMIT) -> dict[str, int]:
    instant = _normalize(now or datetime.now(timezone.utc))
    batch = min(_BATCH_LIMIT, max(1, limit))
    revoked_cutoff = instant - _REVOKED_SESSION_RETENTION
    sessions_ready = or_(
        and_(
            AuthSession.revoked_at.is_(None),
            or_(AuthSession.idle_expires_at <= instant, AuthSession.absolute_expires_at <= instant),
        ),
        AuthSession.revoked_at <= revoked_cutoff,
    )
    tokens_ready = or_(
        EmailToken.consumed_at <= instant - _TOKEN_RETENTION,
        EmailToken.invalidated_at <= instant - _TOKEN_RETENTION,
        and_(
            EmailToken.consumed_at.is_(None),
            EmailToken.invalidated_at.is_(None),
            EmailToken.expires_at <= instant - _TOKEN_RETENTION,
        ),
    )
    jobs_ready = and_(
        EmailDeliveryJob.expires_at <= instant,
        or_(EmailDeliveryJob.claim_token.is_(None), EmailDeliveryJob.claim_expires_at <= instant),
    )
    audit_ready = AuthAuditEvent.created_at < instant - _AUDIT_RETENTION
    rate_ready = AuthRateLimit.expires_at <= instant

    return {
        "sessions": await _delete_ids(database, AuthSession, AuthSession.id, sessions_ready, limit=batch),
        "email_tokens": await _delete_ids(database, EmailToken, EmailToken.id, tokens_ready, limit=batch),
        "email_delivery_jobs": await _delete_ids(
            database, EmailDeliveryJob, EmailDeliveryJob.id, jobs_ready, limit=batch
        ),
        "auth_audit_events": await _delete_ids(database, AuthAuditEvent, AuthAuditEvent.id, audit_ready, limit=batch),
        "auth_rate_limits": await _delete_rate_limits(database, rate_ready, limit=batch),
    }


async def _delete_rate_limits(database, predicate, *, limit: int) -> int:
    async with database.sessions() as db:
        async with db.begin():
            keys = [
                tuple(row)
                for row in (
                    await db.execute(
                        select(AuthRateLimit.action, AuthRateLimit.subject_kind, AuthRateLimit.subject_digest)
                        .where(predicate)
                        .order_by(AuthRateLimit.action, AuthRateLimit.subject_kind, AuthRateLimit.subject_digest)
                        .limit(limit)
                        .with_for_update(skip_locked=True)
                    )
                ).all()
            ]
            if not keys:
                return 0
            result = await db.execute(
                delete(AuthRateLimit).where(
                    tuple_(AuthRateLimit.action, AuthRateLimit.subject_kind, AuthRateLimit.subject_digest).in_(keys),
                    predicate,
                )
            )
            return int(result.rowcount or 0)


async def run_auth_maintenance(database) -> None:
    while True:
        try:
            await cleanup_auth_storage(database)
        except SQLAlchemyError:
            _LOGGER.warning("auth_maintenance_store_unavailable")
        await asyncio.sleep(60)
