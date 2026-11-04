"""Encrypted email outbox and a small SMTP delivery worker."""

import asyncio
import json
import logging
import secrets
import smtplib
import ssl
import struct
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from functools import partial
from typing import Literal
from uuid import UUID, uuid4

import anyio
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import and_, delete, or_, select, update
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import Settings
from app.models.auth import EmailDeliveryJob

_LOGGER = logging.getLogger("dayforge.auth.email")
_OUTBOX_VERSION = 1
_OUTBOX_AAD = b"dayforge-auth-email-outbox-v1\0"
_DELIVERY_LEASE = timedelta(seconds=120)


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


def _message(settings: Settings, payload: dict[str, str], job_id: UUID | None = None) -> EmailMessage:
    kind = payload["kind"]
    recipient = payload["recipient"]
    message = EmailMessage()
    message["From"] = settings.email_from
    message["To"] = recipient
    if job_id is not None:
        message["Message-ID"] = f"<{job_id.hex}@dayforge.local>"
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


def smtp_send_message(
    host: str,
    port: int,
    message: EmailMessage,
    *,
    tls: Literal["none", "starttls", "implicit"] = "none",
    username: str | None = None,
    password: str | None = None,
    timeout_seconds: int = 10,
) -> None:
    if tls not in {"none", "starttls", "implicit"}:
        raise ValueError("smtp_tls_mode_invalid")
    if (username is None) != (password is None):
        raise ValueError("smtp_credentials_incomplete")
    if tls == "none" and username is not None:
        raise ValueError("smtp_auth_requires_tls")
    if tls == "implicit":
        with smtplib.SMTP_SSL(host, port, timeout=timeout_seconds, context=ssl.create_default_context()) as connection:
            if username is not None:
                assert password is not None
                connection.login(username, password)
            connection.send_message(message)
        return
    with smtplib.SMTP(host, port, timeout=timeout_seconds) as connection:
        if tls == "starttls":
            connection.ehlo()
            connection.starttls(context=ssl.create_default_context())
            connection.ehlo()
        if username is not None:
            assert password is not None
            connection.login(username, password)
        connection.send_message(message)


async def deliver_pending_jobs(
    database,
    settings: Settings,
    *,
    now: datetime | None = None,
    clock: Callable[[], datetime] | None = None,
    send_message: Callable[[str, int, EmailMessage], None] | None = None,
    limit: int = 20,
) -> int:
    instant = now or datetime.now(timezone.utc)
    if instant.tzinfo is None:
        raise ValueError("email_clock_invalid")
    instant = instant.astimezone(timezone.utc)
    instant = instant.replace(microsecond=(instant.microsecond // 1000) * 1000)

    def current_time() -> datetime:
        value = clock() if clock is not None else (datetime.now(timezone.utc) if now is None else instant)
        if value.tzinfo is None:
            raise ValueError("email_clock_invalid")
        return value.astimezone(timezone.utc).replace(microsecond=(value.microsecond // 1000) * 1000)

    limit = min(20, max(1, limit))
    key = settings.secret_key("auth_email_outbox_key_b64")
    sender = send_message or partial(
        smtp_send_message,
        tls=settings.email_smtp_tls,
        username=settings.email_smtp_username.get_secret_value() if settings.email_smtp_username else None,
        password=settings.email_smtp_password.get_secret_value() if settings.email_smtp_password else None,
        timeout_seconds=settings.email_smtp_timeout_seconds,
    )
    claimed: list[tuple[UUID, bytes, int, int, datetime, UUID]] = []
    async with database.sessions() as db:
        async with db.begin():
            jobs = (
                (
                    await db.execute(
                        select(EmailDeliveryJob)
                        .where(
                            EmailDeliveryJob.sent_at.is_(None),
                            EmailDeliveryJob.available_at <= instant,
                            EmailDeliveryJob.expires_at > instant,
                            or_(
                                EmailDeliveryJob.claim_token.is_(None),
                                EmailDeliveryJob.claim_expires_at <= instant,
                            ),
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
                claim_token = uuid4()
                job.claim_token = claim_token
                job.claim_expires_at = instant + _DELIVERY_LEASE
                claimed.append(
                    (
                        job.id,
                        bytes(job.payload_ciphertext),
                        job.outbox_key_version,
                        int(job.attempt_count),
                        job.expires_at,
                        claim_token,
                    )
                )

    delivered = 0
    for job_id, ciphertext, key_version, attempt_count, expires_at, claim_token in claimed:
        failed = False
        try:
            payload = decrypt_delivery_payload(job_id, ciphertext, key, key_version)
            message = _message(settings, payload, job_id)
        except Exception:
            failed = True
        else:
            if not await _renew_delivery_claim(database, job_id, claim_token, current_time()):
                continue
            try:
                await _send_with_delivery_lease(
                    database,
                    job_id,
                    claim_token,
                    current_time,
                    sender,
                    settings.email_smtp_host,
                    settings.email_smtp_port,
                    message,
                )
            except Exception:
                failed = True

        async with database.sessions() as db:
            async with db.begin():
                predicate = and_(EmailDeliveryJob.id == job_id, EmailDeliveryJob.claim_token == claim_token)
                finalized_at = current_time()
                if not failed:
                    result = await db.execute(delete(EmailDeliveryJob).where(predicate))
                    if result.rowcount == 1:
                        delivered += 1
                elif finalized_at >= expires_at:
                    await db.execute(delete(EmailDeliveryJob).where(predicate))
                else:
                    next_attempt = min(255, attempt_count + 1)
                    delay = min(3600, 2 ** min(10, next_attempt))
                    await db.execute(
                        update(EmailDeliveryJob)
                        .where(predicate)
                        .values(
                            attempt_count=next_attempt,
                            last_error_code="smtp_delivery_failed",
                            available_at=min(finalized_at + timedelta(seconds=delay), expires_at),
                            claim_token=None,
                            claim_expires_at=None,
                        )
                    )
    return delivered


async def _renew_delivery_claim(database, job_id: UUID, claim_token: UUID, now: datetime) -> bool:
    async with database.sessions() as db:
        async with db.begin():
            result = await db.execute(
                update(EmailDeliveryJob)
                .where(
                    EmailDeliveryJob.id == job_id,
                    EmailDeliveryJob.claim_token == claim_token,
                    EmailDeliveryJob.claim_expires_at > now,
                    EmailDeliveryJob.expires_at > now,
                    EmailDeliveryJob.sent_at.is_(None),
                )
                .values(claim_expires_at=now + _DELIVERY_LEASE)
            )
            return result.rowcount == 1


async def _send_with_delivery_lease(
    database,
    job_id: UUID,
    claim_token: UUID,
    current_time: Callable[[], datetime],
    send_message: Callable[[str, int, EmailMessage], None],
    host: str,
    port: int,
    message: EmailMessage,
) -> None:
    stop_heartbeat = asyncio.Event()
    interval = max(0.05, _DELIVERY_LEASE.total_seconds() / 3)

    async def heartbeat() -> None:
        while True:
            try:
                await asyncio.wait_for(stop_heartbeat.wait(), timeout=interval)
                return
            except TimeoutError:
                pass
            try:
                renewed = await _renew_delivery_claim(database, job_id, claim_token, current_time())
            except SQLAlchemyError:
                _LOGGER.warning("email_delivery_lease_renewal_failed")
                continue
            if not renewed:
                return

    heartbeat_task = asyncio.create_task(heartbeat())
    try:
        await anyio.to_thread.run_sync(send_message, host, port, message)
    finally:
        stop_heartbeat.set()
        await heartbeat_task


async def run_delivery_worker(database, settings: Settings) -> None:
    while True:
        try:
            await deliver_pending_jobs(database, settings)
        except SQLAlchemyError:
            _LOGGER.warning("email_delivery_store_unavailable")
        await asyncio.sleep(2)
