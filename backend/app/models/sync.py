"""Durable owner-scoped sync log, epoch and opaque page-token state."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Index, UniqueConstraint, text
from sqlalchemy.dialects.mysql import BIGINT, BINARY, LONGTEXT, VARCHAR
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.types import UTCMilliseconds, UUIDBytes


class SyncOwnerState(Base):
    __tablename__ = "sync_owner_state"
    __table_args__ = (
        CheckConstraint("head_cursor >= 0", name="sync_owner_cursor_nonnegative"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    owner_id: Mapped[UUID] = mapped_column(
        UUIDBytes(),
        ForeignKey(
            "users.id", name="fk_sync_owner_state_owner_id_users", ondelete="CASCADE"
        ),
        primary_key=True,
        autoincrement=False,
    )
    epoch: Mapped[UUID] = mapped_column(UUIDBytes(), nullable=False)
    head_cursor: Mapped[int] = mapped_column(
        BIGINT(unsigned=True), nullable=False, default=0, server_default=text("0")
    )


class SyncOperation(Base):
    __tablename__ = "sync_operations"
    __table_args__ = (
        UniqueConstraint(
            "owner_id", "operation_id", name="uq_sync_operations_owner_operation"
        ),
        CheckConstraint("commit_cursor > 0", name="sync_operation_cursor_positive"),
        CheckConstraint(
            "effect_at_commit IN ('applied', 'superseded', 'no_op')",
            name="sync_operation_effect",
        ),
        Index("ix_sync_operations_owner_cursor", "owner_id", "commit_cursor"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    owner_id: Mapped[UUID] = mapped_column(
        UUIDBytes(),
        ForeignKey(
            "users.id", name="fk_sync_operations_owner_id_users", ondelete="CASCADE"
        ),
        primary_key=True,
        autoincrement=False,
    )
    commit_cursor: Mapped[int] = mapped_column(
        BIGINT(unsigned=True), primary_key=True, autoincrement=False
    )
    operation_id: Mapped[UUID] = mapped_column(UUIDBytes(), nullable=False)
    request_hash: Mapped[bytes] = mapped_column(BINARY(32), nullable=False)
    canonical_envelope: Mapped[str] = mapped_column(
        LONGTEXT(charset="utf8mb4", collation="utf8mb4_bin"), nullable=False
    )
    committed_at: Mapped[datetime] = mapped_column(UTCMilliseconds(), nullable=False)
    effect_at_commit: Mapped[str] = mapped_column(
        VARCHAR(16, charset="ascii", collation="ascii_bin"), nullable=False
    )
    reason_at_commit: Mapped[str | None] = mapped_column(
        VARCHAR(64, charset="ascii", collation="ascii_bin"), nullable=True
    )


class SyncCalibration(Base):
    __tablename__ = "sync_calibrations"
    __table_args__ = (
        Index("ix_sync_calibrations_owner_device", "owner_id", "device_id"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[UUID] = mapped_column(UUIDBytes(), primary_key=True, autoincrement=False)
    owner_id: Mapped[UUID] = mapped_column(
        UUIDBytes(),
        ForeignKey(
            "users.id", name="fk_sync_calibrations_owner_id_users", ondelete="CASCADE"
        ),
        nullable=False,
    )
    device_id: Mapped[UUID] = mapped_column(UUIDBytes(), nullable=False)
    server_time_ms: Mapped[int] = mapped_column(BIGINT(unsigned=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCMilliseconds(), nullable=False)


class SyncPageToken(Base):
    __tablename__ = "sync_page_tokens"
    __table_args__ = (
        Index("ix_sync_page_tokens_expiry", "expires_at"),
        CheckConstraint("scope IN ('bootstrap', 'pull')", name="sync_page_token_scope"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    token_hash: Mapped[bytes] = mapped_column(
        BINARY(32), primary_key=True, autoincrement=False
    )
    owner_id: Mapped[UUID] = mapped_column(
        UUIDBytes(),
        ForeignKey(
            "users.id", name="fk_sync_page_tokens_owner_id_users", ondelete="CASCADE"
        ),
        nullable=False,
    )
    epoch: Mapped[UUID] = mapped_column(UUIDBytes(), nullable=False)
    scope: Mapped[str] = mapped_column(
        VARCHAR(16, charset="ascii", collation="ascii_bin"), nullable=False
    )
    through_cursor: Mapped[int] = mapped_column(BIGINT(unsigned=True), nullable=False)
    next_cursor: Mapped[int] = mapped_column(BIGINT(unsigned=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(UTCMilliseconds(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCMilliseconds(), nullable=False)
