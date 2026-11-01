"""Encrypted email outbox and a small SMTP delivery worker."""

import asyncio
import json
import logging
import secrets
import smtplib
import struct
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from uuid import UUID, uuid4

import anyio
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import and_, delete, or_, select
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import Settings
from app.models.auth import AuthRateLimit, EmailDeliveryJob, EmailToken

_LOGGER = logging.getLogger("dayforge.auth.email")
_OUTBOX_VERSION = 1
_OUTBOX_AAD = b"dayforge-auth-email-outbox-v1\0"
_TOKEN_RETENTION = timedelta(days=7)
_RATE_LIMIT_RETENTION = timedelta(hours=48)


def encrypt_delivery_payload(job_id: UUID, payload: bytes, key: bytes, version: int = _OUTBOX_VERSION) -> bytes:
    if not isinstance(job_id, UUID) or not isinstance(payload, bytes):
        raise ValueError("email_payload_invalid")
    if not isinstance(key, bytes) or len(key) != 32 or version != _OUTBOX_VERSION:
        raise ValueError("email_outbox_key_invalid")
    nonce = secrets.token_bytes(12)
    aad = _OUTBOX_AAD + job_id.bytes + struct.pack(">H", version)
    return nonce + AESGCM(key).encrypt(nonce, payload, aad)


def decrypt_delivery_payload(job_id: UUID, ciphertext: bytes, key: bytes, version: int) -> dict[str, str]:
    if (
        not isinstance(job_id, UUID)
        or not isinstance(ciphertext, bytes)
        or len(ciphertext) < 29
        or not isinstance(key, bytes)
        or len(key) != 32
        or version != _OUTBOX_VERSION
    ):
        raise ValueError("email_payload_invalid")
    nonce, body = ciphertext[:12], ciphertext[12:]
    aad = _OUTBOX_AAD + job_id.bytes + struct.pack(">H", version)
    try:
        plaintext = AESGCM(key).decrypt(nonce, body, aad)
        value = json.loads(plaintext.decode("utf-8"))
    except InvalidTag, UnicodeDecodeError, ValueError, json.JSONDecodeError:
        raise ValueError("email_payload_invalid") from None
    if (
        not isinstance(value, dict)
        or set(value) - {"recipient", "kind", "token"}
        or not isinstance(value.get("recipient"), str)
        or not isinstance(value.get("kind"), str)
        or ("token" in value and not isinstance(value["token"], str))
    ):
        raise ValueError("email_payload_invalid")
    return value


def make_delivery_job(
    settings: Settings,
    *,
    recipient: str,
    kind: str,
    now: datetime,
    expires_at: datetime,
    token: str | None = None,
) -> EmailDeliveryJob:
    if kind not in {"verify_email", "password_reset", "password_reset_notice"}:
        raise ValueError("email_kind_invalid")
    job_id = uuid4()
    values = {"recipient": recipient, "kind": kind}
    if token is not None:
        values["token"] = token
    plaintext = json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    version = _OUTBOX_VERSION
    return EmailDeliveryJob(
        id=job_id,
        payload_ciphertext=encrypt_delivery_payload(
            job_id,
            plaintext,
            settings.secret_key("auth_email_outbox_key_b64"),
            version,
        ),
        outbox_key_version=version,
        created_at=now,
        available_at=now,
        expires_at=expires_at,
        attempt_count=0,
        sent_at=None,
        last_error_code=None,
    )


def _message(settings: Settings, payload: dict[str, str]) -> EmailMessage:
    kind = payload["kind"]
    recipient = payload["recipient"]
    message = EmailMessage()
    message["From"] = settings.email_from
    message["To"] = recipient
    if kind == "verify_email":
        message["Subject"] = "Xác minh địa chỉ email DAYFORGE"
        link = f"{settings.public_origin}/verify-email#token={payload['token']}"
        message.set_content(
            "Mở DAYFORGE và xác nhận yêu cầu tạo chủ sở hữu bằng liên kết sau:\n\n"
            f"{link}\n\nLiên kết có hiệu lực trong 24 giờ."
        )
    elif kind == "password_reset":
        message["Subject"] = "Đặt lại mật khẩu DAYFORGE"
        link = f"{settings.public_origin}/reset-password#token={payload['token']}"
        message.set_content(
            "Mở DAYFORGE và xác nhận đặt lại mật khẩu bằng liên kết sau:\n\n"
            f"{link}\n\nLiên kết có hiệu lực trong 30 phút."
        )
    elif kind == "password_reset_notice":
        message["Subject"] = "Mật khẩu DAYFORGE đã được đặt lại"
        message.set_content(
            "Mật khẩu tài khoản DAYFORGE vừa được đặt lại. Nếu bạn không thực hiện "
            "thay đổi này, hãy liên hệ người quản lý hệ thống."
        )
    else:
        raise ValueError("email_kind_invalid")
    return message


def smtp_send_message(host: str, port: int, message: EmailMessage) -> None:
    with smtplib.SMTP(host, port, timeout=5) as connection:
        connection.send_message(message)


async def deliver_pending_jobs(
    database,
    settings: Settings,
    *,
    now: datetime | None = None,
    send_message=smtp_send_message,
    limit: int = 20,
) -> int:
    instant = now or datetime.now(timezone.utc)
    if instant.tzinfo is None:
        raise ValueError("email_clock_invalid")
    instant = instant.astimezone(timezone.utc)
    instant = instant.replace(microsecond=(instant.microsecond // 1000) * 1000)
    key = settings.secret_key("auth_email_outbox_key_b64")
    delivered = 0
    async with database.sessions() as db:
        async with db.begin():
            await db.execute(delete(EmailDeliveryJob).where(EmailDeliveryJob.expires_at <= instant))
            expired_before = instant - _TOKEN_RETENTION
            await db.execute(
                delete(EmailToken).where(
                    or_(
                        EmailToken.consumed_at <= expired_before,
                        EmailToken.invalidated_at <= expired_before,
                        and_(
                            EmailToken.consumed_at.is_(None),
                            EmailToken.invalidated_at.is_(None),
                            EmailToken.expires_at <= expired_before,
                        ),
                    )
                )
            )
            await db.execute(delete(AuthRateLimit).where(AuthRateLimit.expires_at <= instant))
            jobs = (
                (
                    await db.execute(
                        select(EmailDeliveryJob)
                        .where(
                            EmailDeliveryJob.sent_at.is_(None),
                            EmailDeliveryJob.available_at <= instant,
                            EmailDeliveryJob.expires_at > instant,
                        )
                        .order_by(EmailDeliveryJob.created_at, EmailDeliveryJob.id)
                        .limit(limit)
                        .with_for_update(skip_locked=True)
                    )
                )
                .scalars()
                .all()
            )
            for job in jobs:
                try:
                    payload = decrypt_delivery_payload(
                        job.id,
                        job.payload_ciphertext,
                        key,
                        job.outbox_key_version,
                    )
                    message = _message(settings, payload)
                    await anyio.to_thread.run_sync(
                        send_message,
                        settings.email_smtp_host,
                        settings.email_smtp_port,
                        message,
                    )
                except Exception:
                    job.attempt_count = min(255, int(job.attempt_count) + 1)
                    job.last_error_code = "smtp_delivery_failed"
                    delay = min(3600, 2 ** min(10, int(job.attempt_count)))
                    job.available_at = min(instant + timedelta(seconds=delay), job.expires_at)
                else:
                    await db.delete(job)
                    delivered += 1
    return delivered


async def run_delivery_worker(database, settings: Settings) -> None:
    while True:
        try:
            await deliver_pending_jobs(database, settings)
        except SQLAlchemyError:
            _LOGGER.warning("email_delivery_store_unavailable")
        await asyncio.sleep(2)
