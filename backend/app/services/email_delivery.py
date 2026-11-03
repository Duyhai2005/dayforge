"""Encrypted email outbox and SMTP sink adapter for local development."""

import asyncio
import json
import logging
import secrets
import smtplib
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from uuid import uuid4

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.database import Database
from app.models.auth import AuthRateLimit, EmailDeliveryJob, EmailToken
from app.services.auth_crypto import decode_key

_logger = logging.getLogger("dayforge.auth.email")


def enqueue_email(
    session: AsyncSession,
    settings: Settings,
    *,
    recipient: str,
    purpose: str,
    token: str,
    now: datetime,
) -> None:
    if purpose not in ("verify_email", "password_reset"):
        raise ValueError("invalid_email_purpose")
    fragment = "verify-email" if purpose == "verify_email" else "reset-password"
    action = (
        "verify your email address"
        if purpose == "verify_email"
        else "reset your password"
    )
    enqueue_payload(
        session,
        settings,
        recipient=recipient,
        subject="Dayforge: " + action,
        now=now,
        link=f"{settings.public_origin}/{fragment}#token={token}",
    )


def enqueue_payload(
    session: AsyncSession,
    settings: Settings,
    *,
    recipient: str,
    subject: str,
    now: datetime,
    link: str | None = None,
    body: str | None = None,
) -> None:
    if (link is None) == (body is None):
        raise ValueError("invalid_email_payload")
    job_id = uuid4()
    nonce = secrets.token_bytes(12)
    key_name = "link" if link is not None else "body"
    document = json.dumps(
        {"to": recipient, "subject": subject, key_name: link or body},
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    key = decode_key(settings.auth_email_outbox_key_b64.get_secret_value())
    ciphertext = AESGCM(key).encrypt(nonce, document, job_id.bytes)
    session.add(
        EmailDeliveryJob(
            id=job_id,
            iv=nonce,
            ciphertext=ciphertext,
            attempts=0,
            next_attempt_at=now,
            created_at=now,
            expires_at=now + timedelta(hours=24),
            sent_at=None,
        )
    )


def _send(settings: Settings, payload: dict[str, str]) -> None:
    message = EmailMessage()
    message["From"] = settings.email_from
    message["To"] = payload["to"]
    message["Subject"] = payload["subject"]
    content = payload.get("body")
    if content is None:
        content = (
            "Use this link to "
            + payload["subject"].removeprefix("Dayforge: ")
            + ":\n\n"
            + payload["link"]
        )
    message.set_content(content)
    with smtplib.SMTP(
        settings.email_smtp_host, settings.email_smtp_port, timeout=5
    ) as smtp:
        smtp.send_message(message)


async def _process_one(database: Database, settings: Settings, now: datetime) -> bool:
    async with database.sessions() as session:
        job = await session.scalar(
            select(EmailDeliveryJob)
            .where(
                EmailDeliveryJob.sent_at.is_(None),
                EmailDeliveryJob.next_attempt_at <= now,
            )
            .order_by(EmailDeliveryJob.created_at)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        if job is None:
            await session.rollback()
            return False
        if job.expires_at <= now or job.attempts >= 8:
            await session.delete(job)
            await session.commit()
            return True
        try:
            key = decode_key(settings.auth_email_outbox_key_b64.get_secret_value())
            plaintext = AESGCM(key).decrypt(job.iv, job.ciphertext, job.id.bytes)
            payload = json.loads(plaintext)
            if set(payload) not in (
                {"to", "subject", "link"},
                {"to", "subject", "body"},
            ) or any(not isinstance(payload[k], str) for k in payload):
                raise ValueError("invalid_email_job")
        except Exception:
            _logger.warning("auth_email_job_invalid")
            await session.delete(job)
            await session.commit()
            return True
        try:
            await asyncio.to_thread(_send, settings, payload)
        except OSError, smtplib.SMTPException, TimeoutError:
            job.attempts += 1
            delay = min(3600, 30 * (2 ** min(job.attempts, 7)))
            job.next_attempt_at = now + timedelta(seconds=delay)
            await session.commit()
            _logger.warning("auth_email_delivery_retry")
            return True
        await session.delete(job)
        await session.commit()
        return True


async def process_email_queue(database: Database, settings: Settings) -> None:
    now = datetime.now(timezone.utc).replace(microsecond=0)
    while await _process_one(database, settings, now):
        pass
    async with database.sessions() as session:
        cutoff = now - timedelta(days=7)
        await session.execute(
            delete(EmailToken).where(
                (EmailToken.consumed_at <= cutoff)
                | (
                    (EmailToken.consumed_at.is_(None))
                    & (EmailToken.expires_at <= cutoff)
                )
            )
        )
        await session.execute(
            delete(AuthRateLimit).where(AuthRateLimit.expires_at <= now)
        )
        await session.commit()


async def delivery_worker(database: Database, settings: Settings) -> None:
    while True:
        try:
            await process_email_queue(database, settings)
        except Exception:
            # Do not expose or log DB/SMTP exception strings that may contain data.
            _logger.warning("auth_email_worker_error")
        await asyncio.sleep(2)
