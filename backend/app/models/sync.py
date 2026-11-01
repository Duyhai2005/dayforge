"""Immutable server-side sync log and owner cursor state for T10."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, ForeignKeyConstraint, UniqueConstraint, text
from sqlalchemy.dialects.mysql import BIGINT, BINARY, INTEGER, MEDIUMBLOB, SMALLINT, TINYINT, VARCHAR
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.types import UTCMilliseconds, UUIDBytes


class OwnerSyncState(Base):
    __tablename__ = "owner_sync_states"
    __table_args__ = (
        CheckConstraint("head_cursor >= 0", name="head_cursor_nonnegative"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    owner_id: Mapped[UUID] = mapped_column(
        UUIDBytes(),
        ForeignKey("users.id", name="fk_owner_sync_states_owner_id_users", ondelete="RESTRICT"),
        primary_key=True,
        autoincrement=False,
    )
    epoch: Mapped[UUID] = mapped_column(UUIDBytes())
    head_cursor: Mapped[int] = mapped_column(BIGINT(unsigned=True), server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(UTCMilliseconds())
    updated_at: Mapped[datetime] = mapped_column(UTCMilliseconds())


class RecordedOperation(Base):
    __tablename__ = "recorded_operations"
    __table_args__ = (
        UniqueConstraint("owner_id", "epoch", "commit_cursor", name="uq_recorded_operations_epoch_cursor"),
        UniqueConstraint(
            "owner_id", "operation_id", "epoch", "commit_cursor", name="uq_recorded_operations_receipt_target"
        ),
        CheckConstraint("protocol_version > 0", name="protocol_version_positive"),
        CheckConstraint("reducer_version > 0", name="reducer_version_positive"),
        CheckConstraint("commit_cursor > 0", name="commit_cursor_positive"),
        CheckConstraint("physical_ms >= 0", name="physical_ms_nonnegative"),
        CheckConstraint("logical_clock >= 0", name="logical_clock_nonnegative"),
        CheckConstraint("delete_rank IN (0, 1)", name="delete_rank_boolean"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    owner_id: Mapped[UUID] = mapped_column(
        UUIDBytes(),
        ForeignKey("users.id", name="fk_recorded_operations_owner_id_users", ondelete="RESTRICT"),
        primary_key=True,
        autoincrement=False,
    )
    operation_id: Mapped[UUID] = mapped_column(UUIDBytes(), primary_key=True, autoincrement=False)
    epoch: Mapped[UUID] = mapped_column(UUIDBytes())
    commit_cursor: Mapped[int] = mapped_column(BIGINT(unsigned=True))
    request_hash: Mapped[bytes] = mapped_column(BINARY(32))
    envelope: Mapped[bytes] = mapped_column(MEDIUMBLOB())
    protocol_version: Mapped[int] = mapped_column(SMALLINT(unsigned=True))
    reducer_version: Mapped[int] = mapped_column(SMALLINT(unsigned=True))
    device_id: Mapped[UUID] = mapped_column(UUIDBytes())
    device_sequence: Mapped[int] = mapped_column(BIGINT(unsigned=True))
    physical_ms: Mapped[int] = mapped_column(BIGINT())
    logical_clock: Mapped[int] = mapped_column(INTEGER(unsigned=True))
    delete_rank: Mapped[int] = mapped_column(TINYINT(unsigned=True))
    committed_at: Mapped[datetime] = mapped_column(UTCMilliseconds())


class OperationReceipt(Base):
    __tablename__ = "operation_receipts"
    __table_args__ = (
        ForeignKeyConstraint(
            ["owner_id", "operation_id", "epoch", "commit_cursor"],
            [
                "recorded_operations.owner_id",
                "recorded_operations.operation_id",
                "recorded_operations.epoch",
                "recorded_operations.commit_cursor",
            ],
            name="fk_operation_receipts_recorded_operation",
            ondelete="RESTRICT",
        ),
        CheckConstraint("recorded IN (0, 1)", name="recorded_boolean"),
        CheckConstraint("effect_at_commit IN ('applied', 'superseded', 'no_op')", name="effect_valid"),
        CheckConstraint(
            "reason_at_commit IS NULL OR reason_at_commit IN "
            "('duplicate_target', 'reference_unavailable', 'target_retired', 'precondition_failed', "
            "'undo_not_applicable')",
            name="reason_valid",
        ),
        CheckConstraint(
            "(effect_at_commit = 'no_op' AND reason_at_commit IS NOT NULL) OR "
            "(effect_at_commit <> 'no_op' AND reason_at_commit IS NULL)",
            name="effect_reason_binding",
        ),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    owner_id: Mapped[UUID] = mapped_column(UUIDBytes(), primary_key=True, autoincrement=False)
    operation_id: Mapped[UUID] = mapped_column(UUIDBytes(), primary_key=True, autoincrement=False)
    epoch: Mapped[UUID] = mapped_column(UUIDBytes())
    request_hash: Mapped[bytes] = mapped_column(BINARY(32))
    recorded: Mapped[bool] = mapped_column(TINYINT(unsigned=True), server_default=text("1"))
    commit_cursor: Mapped[int] = mapped_column(BIGINT(unsigned=True))
    effect_at_commit: Mapped[str] = mapped_column(VARCHAR(16, charset="ascii", collation="ascii_bin"))
    reason_at_commit: Mapped[str | None] = mapped_column(VARCHAR(32, charset="ascii", collation="ascii_bin"))


class ChangeLog(Base):
    __tablename__ = "change_log"
    __table_args__ = (
        ForeignKeyConstraint(
            ["owner_id", "epoch", "cursor"],
            ["recorded_operations.owner_id", "recorded_operations.epoch", "recorded_operations.commit_cursor"],
            name="fk_change_log_recorded_operation_cursor",
            ondelete="RESTRICT",
        ),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    owner_id: Mapped[UUID] = mapped_column(UUIDBytes(), primary_key=True, autoincrement=False)
    epoch: Mapped[UUID] = mapped_column(UUIDBytes(), primary_key=True, autoincrement=False)
    cursor: Mapped[int] = mapped_column(BIGINT(unsigned=True), primary_key=True, autoincrement=False)
    committed_at: Mapped[datetime] = mapped_column(UTCMilliseconds())
