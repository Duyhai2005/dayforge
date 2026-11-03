"""Add owner-scoped sync epochs, events, calibrations and page tokens."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0003_sync_log"
down_revision = "0002_authentication"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sync_owner_state",
        sa.Column("owner_id", mysql.BINARY(16), nullable=False),
        sa.Column("epoch", mysql.BINARY(16), nullable=False),
        sa.Column(
            "head_cursor",
            mysql.BIGINT(unsigned=True),
            nullable=False,
            server_default="0",
        ),
        sa.ForeignKeyConstraint(
            ["owner_id"],
            ["users.id"],
            name="fk_sync_owner_state_owner_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("owner_id"),
        sa.CheckConstraint(
            "head_cursor >= 0", name="ck_sync_owner_state_sync_owner_cursor_nonnegative"
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_table(
        "sync_operations",
        sa.Column("owner_id", mysql.BINARY(16), nullable=False),
        sa.Column("commit_cursor", mysql.BIGINT(unsigned=True), nullable=False),
        sa.Column("operation_id", mysql.BINARY(16), nullable=False),
        sa.Column("request_hash", mysql.BINARY(32), nullable=False),
        sa.Column(
            "canonical_envelope",
            mysql.LONGTEXT(charset="utf8mb4", collation="utf8mb4_bin"),
            nullable=False,
        ),
        sa.Column("committed_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column(
            "effect_at_commit",
            mysql.VARCHAR(16, charset="ascii", collation="ascii_bin"),
            nullable=False,
        ),
        sa.Column(
            "reason_at_commit",
            mysql.VARCHAR(64, charset="ascii", collation="ascii_bin"),
            nullable=True,
        ),
        sa.ForeignKeyConstraint(
            ["owner_id"],
            ["users.id"],
            name="fk_sync_operations_owner_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("owner_id", "commit_cursor"),
        sa.UniqueConstraint(
            "owner_id", "operation_id", name="uq_sync_operations_owner_operation"
        ),
        sa.CheckConstraint(
            "commit_cursor > 0",
            name="ck_sync_operations_sync_operation_cursor_positive",
        ),
        sa.CheckConstraint(
            "effect_at_commit IN ('applied', 'superseded', 'no_op')",
            name="ck_sync_operations_sync_operation_effect",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "ix_sync_operations_owner_cursor",
        "sync_operations",
        ["owner_id", "commit_cursor"],
    )
    op.create_table(
        "sync_calibrations",
        sa.Column("id", mysql.BINARY(16), nullable=False),
        sa.Column("owner_id", mysql.BINARY(16), nullable=False),
        sa.Column("device_id", mysql.BINARY(16), nullable=False),
        sa.Column("server_time_ms", mysql.BIGINT(unsigned=True), nullable=False),
        sa.Column("created_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.ForeignKeyConstraint(
            ["owner_id"],
            ["users.id"],
            name="fk_sync_calibrations_owner_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "ix_sync_calibrations_owner_device",
        "sync_calibrations",
        ["owner_id", "device_id"],
    )
    op.create_table(
        "sync_page_tokens",
        sa.Column("token_hash", mysql.BINARY(32), nullable=False),
        sa.Column("owner_id", mysql.BINARY(16), nullable=False),
        sa.Column("epoch", mysql.BINARY(16), nullable=False),
        sa.Column(
            "scope",
            mysql.VARCHAR(16, charset="ascii", collation="ascii_bin"),
            nullable=False,
        ),
        sa.Column("through_cursor", mysql.BIGINT(unsigned=True), nullable=False),
        sa.Column("next_cursor", mysql.BIGINT(unsigned=True), nullable=False),
        sa.Column("expires_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("created_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.ForeignKeyConstraint(
            ["owner_id"],
            ["users.id"],
            name="fk_sync_page_tokens_owner_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("token_hash"),
        sa.CheckConstraint(
            "scope IN ('bootstrap', 'pull')",
            name="ck_sync_page_tokens_sync_page_token_scope",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index("ix_sync_page_tokens_expiry", "sync_page_tokens", ["expires_at"])


def downgrade() -> None:
    op.drop_table("sync_page_tokens")
    op.drop_table("sync_calibrations")
    op.drop_table("sync_operations")
    op.drop_table("sync_owner_state")
