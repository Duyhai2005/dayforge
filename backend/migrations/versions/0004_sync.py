"""Owner-scoped immutable sync log and commit cursors."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0004_sync"
down_revision = "0003_auth_lifecycle_hardening"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "owner_sync_states",
        sa.Column("owner_id", mysql.BINARY(16), primary_key=True, autoincrement=False, nullable=False),
        sa.Column("epoch", mysql.BINARY(16), nullable=False),
        sa.Column("head_cursor", mysql.BIGINT(unsigned=True), nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("updated_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"], name="fk_owner_sync_states_owner_id_users", ondelete="RESTRICT"
        ),
        sa.UniqueConstraint("epoch", name="uq_owner_sync_states_epoch"),
        sa.CheckConstraint("head_cursor >= 0", name=op.f("ck_owner_sync_states_head_cursor_nonnegative")),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_table(
        "recorded_operations",
        sa.Column("owner_id", mysql.BINARY(16), primary_key=True, autoincrement=False, nullable=False),
        sa.Column("operation_id", mysql.BINARY(16), primary_key=True, autoincrement=False, nullable=False),
        sa.Column("epoch", mysql.BINARY(16), nullable=False),
        sa.Column("commit_cursor", mysql.BIGINT(unsigned=True), nullable=False),
        sa.Column("request_hash", mysql.BINARY(32), nullable=False),
        sa.Column("envelope", mysql.MEDIUMBLOB(), nullable=False),
        sa.Column("protocol_version", mysql.SMALLINT(unsigned=True), nullable=False),
        sa.Column("reducer_version", mysql.SMALLINT(unsigned=True), nullable=False),
        sa.Column("device_id", mysql.BINARY(16), nullable=False),
        sa.Column("device_sequence", mysql.BIGINT(unsigned=True), nullable=False),
        sa.Column("physical_ms", mysql.BIGINT(), nullable=False),
        sa.Column("logical_clock", mysql.INTEGER(unsigned=True), nullable=False),
        sa.Column("delete_rank", mysql.TINYINT(unsigned=True), nullable=False),
        sa.Column("committed_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"], name="fk_recorded_operations_owner_id_users", ondelete="RESTRICT"
        ),
        sa.UniqueConstraint("owner_id", "epoch", "commit_cursor", name="uq_recorded_operations_epoch_cursor"),
        sa.UniqueConstraint(
            "owner_id",
            "operation_id",
            "epoch",
            "commit_cursor",
            name="uq_recorded_operations_receipt_target",
        ),
        sa.CheckConstraint("protocol_version > 0", name=op.f("ck_recorded_operations_protocol_version_positive")),
        sa.CheckConstraint("reducer_version > 0", name=op.f("ck_recorded_operations_reducer_version_positive")),
        sa.CheckConstraint("commit_cursor > 0", name=op.f("ck_recorded_operations_commit_cursor_positive")),
        sa.CheckConstraint("physical_ms >= 0", name=op.f("ck_recorded_operations_physical_ms_nonnegative")),
        sa.CheckConstraint("logical_clock >= 0", name=op.f("ck_recorded_operations_logical_clock_nonnegative")),
        sa.CheckConstraint("delete_rank IN (0, 1)", name=op.f("ck_recorded_operations_delete_rank_boolean")),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_table(
        "operation_receipts",
        sa.Column("owner_id", mysql.BINARY(16), primary_key=True, autoincrement=False, nullable=False),
        sa.Column("operation_id", mysql.BINARY(16), primary_key=True, autoincrement=False, nullable=False),
        sa.Column("epoch", mysql.BINARY(16), nullable=False),
        sa.Column("request_hash", mysql.BINARY(32), nullable=False),
        sa.Column("recorded", mysql.TINYINT(unsigned=True), nullable=False, server_default=sa.text("1")),
        sa.Column("commit_cursor", mysql.BIGINT(unsigned=True), nullable=False),
        sa.Column(
            "effect_at_commit",
            mysql.VARCHAR(16, charset="ascii", collation="ascii_bin"),
            nullable=False,
        ),
        sa.Column(
            "reason_at_commit",
            mysql.VARCHAR(32, charset="ascii", collation="ascii_bin"),
            nullable=True,
        ),
        sa.ForeignKeyConstraint(
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
        sa.CheckConstraint("recorded IN (0, 1)", name=op.f("ck_operation_receipts_recorded_boolean")),
        sa.CheckConstraint(
            "effect_at_commit IN ('applied', 'superseded', 'no_op')",
            name=op.f("ck_operation_receipts_effect_valid"),
        ),
        sa.CheckConstraint(
            "reason_at_commit IS NULL OR reason_at_commit IN "
            "('duplicate_target', 'reference_unavailable', 'target_retired', 'precondition_failed', "
            "'undo_not_applicable')",
            name=op.f("ck_operation_receipts_reason_valid"),
        ),
        sa.CheckConstraint(
            "(effect_at_commit = 'no_op' AND reason_at_commit IS NOT NULL) OR "
            "(effect_at_commit <> 'no_op' AND reason_at_commit IS NULL)",
            name=op.f("ck_operation_receipts_effect_reason_binding"),
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_table(
        "change_log",
        sa.Column("owner_id", mysql.BINARY(16), primary_key=True, autoincrement=False, nullable=False),
        sa.Column("epoch", mysql.BINARY(16), primary_key=True, autoincrement=False, nullable=False),
        sa.Column("cursor", mysql.BIGINT(unsigned=True), primary_key=True, autoincrement=False, nullable=False),
        sa.Column("committed_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.ForeignKeyConstraint(
            ["owner_id", "epoch", "cursor"],
            ["recorded_operations.owner_id", "recorded_operations.epoch", "recorded_operations.commit_cursor"],
            name="fk_change_log_recorded_operation_cursor",
            ondelete="RESTRICT",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )


def downgrade() -> None:
    op.drop_table("change_log")
    op.drop_table("operation_receipts")
    op.drop_table("recorded_operations")
    op.drop_table("owner_sync_states")
