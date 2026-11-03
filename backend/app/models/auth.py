"""Server-side session, email-token, owner-key and delivery state."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.mysql import (
    BIGINT,
    BINARY,
    INTEGER,
    SMALLINT,
    VARBINARY,
    VARCHAR,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.types import UTCMilliseconds, UUIDBytes


class Session(Base):
    __tablename__ = "auth_sessions"
    __table_args__ = (
        UniqueConstraint("token_hash", name="uq_auth_sessions_token_hash"),
        CheckConstraint(
            "(kind = 'anonymous' AND owner_id IS NULL AND auth_version IS NULL AND password_authenticated_at IS NULL) "
            "OR (kind = 'authenticated' AND owner_id IS NOT NULL AND auth_version IS NOT NULL AND password_authenticated_at IS NOT NULL)",
            name="session_kind_owner_auth_fields",
        ),
        CheckConstraint(
            "idle_expires_at <= absolute_expires_at",
            name="session_idle_before_absolute",
        ),
        Index("ix_auth_sessions_owner_revoked", "owner_id", "revoked_at"),
        Index("ix_auth_sessions_expiry", "absolute_expires_at"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[UUID] = mapped_column(UUIDBytes(), primary_key=True, autoincrement=False)
    kind: Mapped[str] = mapped_column(
        VARCHAR(16, charset="ascii", collation="ascii_bin"), nullable=False
    )
    token_hash: Mapped[bytes] = mapped_column(BINARY(32), nullable=False)
    owner_id: Mapped[UUID | None] = mapped_column(
        UUIDBytes(),
        ForeignKey(
            "users.id", name="fk_auth_sessions_owner_id_users", ondelete="CASCADE"
        ),
        nullable=True,
    )
    csrf_token: Mapped[str] = mapped_column(
        String(43, collation="ascii_bin"), nullable=False
    )
    auth_version: Mapped[int | None] = mapped_column(
        BIGINT(unsigned=True), nullable=True
    )
    password_authenticated_at: Mapped[datetime | None] = mapped_column(
        UTCMilliseconds(), nullable=True
    )
    remember_me: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("0")
    )
    created_at: Mapped[datetime] = mapped_column(UTCMilliseconds(), nullable=False)
    last_activity_at: Mapped[datetime] = mapped_column(
        UTCMilliseconds(), nullable=False
    )
    idle_expires_at: Mapped[datetime] = mapped_column(UTCMilliseconds(), nullable=False)
    absolute_expires_at: Mapped[datetime] = mapped_column(
        UTCMilliseconds(), nullable=False
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        UTCMilliseconds(), nullable=True
    )


class EmailToken(Base):
    __tablename__ = "auth_email_tokens"
    __table_args__ = (
        UniqueConstraint("token_hash", name="uq_auth_email_tokens_token_hash"),
        CheckConstraint(
            "purpose IN ('verify_email', 'password_reset')", name="email_token_purpose"
        ),
        CheckConstraint(
            "(purpose = 'verify_email' AND owner_id IS NULL) OR (purpose = 'password_reset' AND owner_id IS NOT NULL)",
            name="email_token_owner_by_purpose",
        ),
        Index("ix_auth_email_tokens_owner_purpose", "owner_id", "purpose"),
        Index("ix_auth_email_tokens_expiry", "expires_at"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[UUID] = mapped_column(UUIDBytes(), primary_key=True, autoincrement=False)
    purpose: Mapped[str] = mapped_column(
        VARCHAR(24, charset="ascii", collation="ascii_bin"), nullable=False
    )
    token_hash: Mapped[bytes] = mapped_column(BINARY(32), nullable=False)
    email_canonical: Mapped[bytes] = mapped_column(VARBINARY(254), nullable=False)
    owner_id: Mapped[UUID | None] = mapped_column(
        UUIDBytes(),
        ForeignKey(
            "users.id", name="fk_auth_email_tokens_owner_id_users", ondelete="CASCADE"
        ),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(UTCMilliseconds(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(UTCMilliseconds(), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(
        UTCMilliseconds(), nullable=True
    )
    invalidated_at: Mapped[datetime | None] = mapped_column(
        UTCMilliseconds(), nullable=True
    )


class OwnerLocalKey(Base):
    __tablename__ = "owner_local_keys"
    __table_args__ = (
        CheckConstraint("algorithm = 'A256GCM'", name="owner_local_key_algorithm"),
        CheckConstraint("kek_version >= 1", name="owner_local_key_kek_version"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    owner_id: Mapped[UUID] = mapped_column(
        UUIDBytes(),
        ForeignKey(
            "users.id", name="fk_owner_local_keys_owner_id_users", ondelete="CASCADE"
        ),
        primary_key=True,
        autoincrement=False,
    )
    key_id: Mapped[UUID] = mapped_column(UUIDBytes(), nullable=False, unique=True)
    algorithm: Mapped[str] = mapped_column(
        VARCHAR(16, charset="ascii", collation="ascii_bin"), nullable=False
    )
    wrapped_key: Mapped[bytes] = mapped_column(VARBINARY(128), nullable=False)
    kek_version: Mapped[int] = mapped_column(SMALLINT(unsigned=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCMilliseconds(), nullable=False)


class AuthRateLimit(Base):
    __tablename__ = "auth_rate_limits"
    __table_args__ = (
        Index("ix_auth_rate_limits_expiry", "expires_at"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    bucket_hash: Mapped[bytes] = mapped_column(
        BINARY(32), primary_key=True, autoincrement=False
    )
    action: Mapped[str] = mapped_column(
        VARCHAR(32, charset="ascii", collation="ascii_bin"), nullable=False
    )
    window_started_at: Mapped[datetime] = mapped_column(
        UTCMilliseconds(), nullable=False
    )
    window_seconds: Mapped[int] = mapped_column(INTEGER(unsigned=True), nullable=False)
    count: Mapped[int] = mapped_column(
        BIGINT(unsigned=True), nullable=False, server_default=text("0")
    )
    expires_at: Mapped[datetime] = mapped_column(UTCMilliseconds(), nullable=False)


class EmailDeliveryJob(Base):
    __tablename__ = "auth_email_delivery_jobs"
    __table_args__ = (
        Index(
            "ix_auth_email_delivery_jobs_due",
            "sent_at",
            "next_attempt_at",
            "expires_at",
        ),
        CheckConstraint("attempts >= 0", name="email_delivery_attempts_nonnegative"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[UUID] = mapped_column(UUIDBytes(), primary_key=True, autoincrement=False)
    iv: Mapped[bytes] = mapped_column(BINARY(12), nullable=False)
    ciphertext: Mapped[bytes] = mapped_column(VARBINARY(4096), nullable=False)
    attempts: Mapped[int] = mapped_column(
        SMALLINT(unsigned=True), nullable=False, server_default=text("0")
    )
    next_attempt_at: Mapped[datetime] = mapped_column(UTCMilliseconds(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCMilliseconds(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(UTCMilliseconds(), nullable=False)
    sent_at: Mapped[datetime | None] = mapped_column(UTCMilliseconds(), nullable=True)
