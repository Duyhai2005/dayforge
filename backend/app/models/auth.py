"""Authentication persistence models added by T09."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Index, UniqueConstraint, text
from sqlalchemy.dialects.mysql import (
    BIGINT,
    BINARY,
    JSON,
    SMALLINT,
    TINYINT,
    VARBINARY,
    VARCHAR,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.types import UTCMilliseconds, UUIDBytes


class Session(Base):
    __tablename__ = "sessions"
    __table_args__ = (
        UniqueConstraint("token_hash", name="uq_sessions_token_hash"),
        CheckConstraint("kind IN ('anonymous', 'authenticated')", name="kind_valid"),
        CheckConstraint("remember_me IN (0, 1)", name="remember_me_boolean"),
        CheckConstraint(
            "(kind = 'anonymous' AND owner_id IS NULL AND auth_version IS NULL "
            "AND password_authenticated_at IS NULL AND remember_me = 0) OR "
            "(kind = 'authenticated' AND owner_id IS NOT NULL AND auth_version IS NOT NULL "
            "AND auth_version >= 1 "
            "AND password_authenticated_at IS NOT NULL)",
            name="kind_owner_binding",
        ),
        CheckConstraint("idle_expires_at <= absolute_expires_at", name="expiry_order"),
        Index("ix_sessions_owner_revoked", "owner_id", "revoked_at"),
        Index("ix_sessions_idle_expires_at", "idle_expires_at"),
        Index("ix_sessions_absolute_expires_at", "absolute_expires_at"),
        Index("ix_sessions_revoked_at", "revoked_at"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[UUID] = mapped_column(UUIDBytes(), primary_key=True, autoincrement=False)
    kind: Mapped[str] = mapped_column(VARCHAR(16, charset="ascii", collation="ascii_bin"))
    token_hash: Mapped[bytes] = mapped_column(BINARY(32))
    owner_id: Mapped[UUID | None] = mapped_column(
        UUIDBytes(),
        ForeignKey("users.id", name="fk_sessions_owner_id_users", ondelete="RESTRICT"),
    )
    csrf_token: Mapped[bytes] = mapped_column(BINARY(32))
    auth_version: Mapped[int | None] = mapped_column(BIGINT(unsigned=True))
    password_authenticated_at: Mapped[datetime | None] = mapped_column(UTCMilliseconds())
    remember_me: Mapped[bool] = mapped_column(TINYINT(unsigned=True), server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(UTCMilliseconds())
    last_activity_at: Mapped[datetime] = mapped_column(UTCMilliseconds())
    idle_expires_at: Mapped[datetime] = mapped_column(UTCMilliseconds())
    absolute_expires_at: Mapped[datetime] = mapped_column(UTCMilliseconds())
    revoked_at: Mapped[datetime | None] = mapped_column(UTCMilliseconds())


class EmailToken(Base):
    __tablename__ = "email_tokens"
    __table_args__ = (
        UniqueConstraint("token_hash", name="uq_email_tokens_token_hash"),
        CheckConstraint("purpose IN ('verify_email', 'password_reset')", name="purpose_valid"),
        CheckConstraint("expires_at > created_at", name="expiry_order"),
        CheckConstraint("consumed_at IS NULL OR consumed_at >= created_at", name="consume_order"),
        Index("ix_email_tokens_email_purpose", "email_canonical", "purpose"),
        Index("ix_email_tokens_owner_purpose", "owner_id", "purpose"),
        Index("ix_email_tokens_expires_at", "expires_at"),
        Index("ix_email_tokens_consumed_at", "consumed_at"),
        Index("ix_email_tokens_invalidated_at", "invalidated_at"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[UUID] = mapped_column(UUIDBytes(), primary_key=True, autoincrement=False)
    purpose: Mapped[str] = mapped_column(VARCHAR(24, charset="ascii", collation="ascii_bin"))
    token_hash: Mapped[bytes] = mapped_column(BINARY(32))
    email_canonical: Mapped[bytes] = mapped_column(VARBINARY(254))
    owner_id: Mapped[UUID | None] = mapped_column(
        UUIDBytes(),
        ForeignKey("users.id", name="fk_email_tokens_owner_id_users", ondelete="RESTRICT"),
    )
    created_at: Mapped[datetime] = mapped_column(UTCMilliseconds())
    expires_at: Mapped[datetime] = mapped_column(UTCMilliseconds())
    consumed_at: Mapped[datetime | None] = mapped_column(UTCMilliseconds())
    invalidated_at: Mapped[datetime | None] = mapped_column(UTCMilliseconds())


class OwnerLocalKey(Base):
    __tablename__ = "owner_local_keys"
    __table_args__ = (
        UniqueConstraint("key_id", name="uq_owner_local_keys_key_id"),
        CheckConstraint("algorithm = 'A256GCM'", name="algorithm_a256gcm"),
        CheckConstraint("kek_version >= 1", name="kek_version_positive"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    owner_id: Mapped[UUID] = mapped_column(
        UUIDBytes(),
        ForeignKey("users.id", name="fk_owner_local_keys_owner_id_users", ondelete="RESTRICT"),
        primary_key=True,
        autoincrement=False,
    )
    key_id: Mapped[UUID] = mapped_column(UUIDBytes())
    algorithm: Mapped[str] = mapped_column(
        VARCHAR(16, charset="ascii", collation="ascii_bin"),
        server_default=text("'A256GCM'"),
    )
    wrapped_key: Mapped[bytes] = mapped_column(VARBINARY(128))
    kek_version: Mapped[int] = mapped_column(SMALLINT(unsigned=True))
    created_at: Mapped[datetime] = mapped_column(UTCMilliseconds())


class AuthRateLimit(Base):
    __tablename__ = "auth_rate_limits"
    __table_args__ = (
        CheckConstraint("window_seconds > 0", name="window_positive"),
        CheckConstraint("request_count >= 0", name="request_count_nonnegative"),
        Index("ix_auth_rate_limits_expires_at", "expires_at"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    action: Mapped[str] = mapped_column(VARCHAR(32, charset="ascii", collation="ascii_bin"), primary_key=True)
    subject_kind: Mapped[str] = mapped_column(VARCHAR(16, charset="ascii", collation="ascii_bin"), primary_key=True)
    subject_digest: Mapped[bytes] = mapped_column(BINARY(32), primary_key=True)
    window_seconds: Mapped[int] = mapped_column(BIGINT(unsigned=True))
    request_count: Mapped[int] = mapped_column(BIGINT(unsigned=True), server_default=text("0"))
    event_timestamps: Mapped[list[int]] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(UTCMilliseconds())
    expires_at: Mapped[datetime] = mapped_column(UTCMilliseconds())


class EmailDeliveryJob(Base):
    __tablename__ = "email_delivery_jobs"
    __table_args__ = (
        CheckConstraint("outbox_key_version >= 1", name="key_version_positive"),
        CheckConstraint("attempt_count >= 0", name="attempt_count_nonnegative"),
        CheckConstraint("expires_at > created_at", name="expiry_order"),
        Index("ix_email_delivery_jobs_ready", "sent_at", "available_at", "expires_at"),
        Index("ix_email_delivery_jobs_lease", "claim_expires_at"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[UUID] = mapped_column(UUIDBytes(), primary_key=True, autoincrement=False)
    payload_ciphertext: Mapped[bytes] = mapped_column(VARBINARY(4096))
    outbox_key_version: Mapped[int] = mapped_column(SMALLINT(unsigned=True))
    created_at: Mapped[datetime] = mapped_column(UTCMilliseconds())
    available_at: Mapped[datetime] = mapped_column(UTCMilliseconds())
    expires_at: Mapped[datetime] = mapped_column(UTCMilliseconds())
    attempt_count: Mapped[int] = mapped_column(TINYINT(unsigned=True), server_default=text("0"))
    sent_at: Mapped[datetime | None] = mapped_column(UTCMilliseconds())
    last_error_code: Mapped[str | None] = mapped_column(VARCHAR(64, charset="ascii", collation="ascii_bin"))
    claim_token: Mapped[UUID | None] = mapped_column(UUIDBytes())
    claim_expires_at: Mapped[datetime | None] = mapped_column(UTCMilliseconds())


class AuthAuditEvent(Base):
    __tablename__ = "auth_audit_events"
    __table_args__ = (
        CheckConstraint(
            "action IN ('session_created', 'register', 'verification_resend', 'email_verified', "
            "'login', 'password_forgot', 'password_reset', 'logout', 'local_key')",
            name="action_valid",
        ),
        CheckConstraint("outcome IN ('success', 'accepted', 'denied', 'noop', 'error')", name="outcome_valid"),
        Index("ix_auth_audit_events_created_at", "created_at"),
        Index("ix_auth_audit_events_owner_created", "owner_id", "created_at"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[UUID] = mapped_column(UUIDBytes(), primary_key=True, autoincrement=False)
    created_at: Mapped[datetime] = mapped_column(UTCMilliseconds())
    action: Mapped[str] = mapped_column(VARCHAR(32, charset="ascii", collation="ascii_bin"))
    outcome: Mapped[str] = mapped_column(VARCHAR(16, charset="ascii", collation="ascii_bin"))
    request_id: Mapped[str] = mapped_column(VARCHAR(36, charset="ascii", collation="ascii_bin"))
    owner_id: Mapped[UUID | None] = mapped_column(UUIDBytes())
    email_digest: Mapped[bytes | None] = mapped_column(BINARY(32))
    peer_digest: Mapped[bytes | None] = mapped_column(BINARY(32))
