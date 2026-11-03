"""Add server-side authentication state without changing existing owners."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0002_authentication"
down_revision = "0001_owner_workspace"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "auth_sessions",
        sa.Column(
            "id",
            mysql.BINARY(16),
            primary_key=True,
            autoincrement=False,
            nullable=False,
        ),
        sa.Column(
            "kind",
            mysql.VARCHAR(16, charset="ascii", collation="ascii_bin"),
            nullable=False,
        ),
        sa.Column("token_hash", mysql.BINARY(32), nullable=False),
        sa.Column("owner_id", mysql.BINARY(16), nullable=True),
        sa.Column(
            "csrf_token", mysql.VARCHAR(43, collation="ascii_bin"), nullable=False
        ),
        sa.Column("auth_version", mysql.BIGINT(unsigned=True), nullable=True),
        sa.Column("password_authenticated_at", mysql.DATETIME(fsp=3), nullable=True),
        sa.Column(
            "remember_me", sa.Boolean(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column("created_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("last_activity_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("idle_expires_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("absolute_expires_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("revoked_at", mysql.DATETIME(fsp=3), nullable=True),
        sa.ForeignKeyConstraint(
            ["owner_id"],
            ["users.id"],
            name="fk_auth_sessions_owner_id_users",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("token_hash", name="uq_auth_sessions_token_hash"),
        sa.CheckConstraint(
            "(kind = 'anonymous' AND owner_id IS NULL AND auth_version IS NULL AND password_authenticated_at IS NULL) "
            "OR (kind = 'authenticated' AND owner_id IS NOT NULL AND auth_version IS NOT NULL AND password_authenticated_at IS NOT NULL)",
            name=op.f("ck_auth_sessions_session_kind_owner_auth_fields"),
        ),
        sa.CheckConstraint(
            "idle_expires_at <= absolute_expires_at",
            name=op.f("ck_auth_sessions_session_idle_before_absolute"),
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "ix_auth_sessions_owner_revoked", "auth_sessions", ["owner_id", "revoked_at"]
    )
    op.create_index("ix_auth_sessions_expiry", "auth_sessions", ["absolute_expires_at"])

    op.create_table(
        "auth_email_tokens",
        sa.Column(
            "id",
            mysql.BINARY(16),
            primary_key=True,
            autoincrement=False,
            nullable=False,
        ),
        sa.Column(
            "purpose",
            mysql.VARCHAR(24, charset="ascii", collation="ascii_bin"),
            nullable=False,
        ),
        sa.Column("token_hash", mysql.BINARY(32), nullable=False),
        sa.Column("email_canonical", mysql.VARBINARY(254), nullable=False),
        sa.Column("owner_id", mysql.BINARY(16), nullable=True),
        sa.Column("created_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("expires_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("consumed_at", mysql.DATETIME(fsp=3), nullable=True),
        sa.Column("invalidated_at", mysql.DATETIME(fsp=3), nullable=True),
        sa.ForeignKeyConstraint(
            ["owner_id"],
            ["users.id"],
            name="fk_auth_email_tokens_owner_id_users",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("token_hash", name="uq_auth_email_tokens_token_hash"),
        sa.CheckConstraint(
            "purpose IN ('verify_email', 'password_reset')",
            name=op.f("ck_auth_email_tokens_email_token_purpose"),
        ),
        sa.CheckConstraint(
            "(purpose = 'verify_email' AND owner_id IS NULL) OR (purpose = 'password_reset' AND owner_id IS NOT NULL)",
            name=op.f("ck_auth_email_tokens_email_token_owner_by_purpose"),
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "ix_auth_email_tokens_owner_purpose",
        "auth_email_tokens",
        ["owner_id", "purpose"],
    )
    op.create_index("ix_auth_email_tokens_expiry", "auth_email_tokens", ["expires_at"])

    op.create_table(
        "owner_local_keys",
        sa.Column(
            "owner_id",
            mysql.BINARY(16),
            primary_key=True,
            autoincrement=False,
            nullable=False,
        ),
        sa.Column("key_id", mysql.BINARY(16), nullable=False),
        sa.Column(
            "algorithm",
            mysql.VARCHAR(16, charset="ascii", collation="ascii_bin"),
            nullable=False,
        ),
        sa.Column("wrapped_key", mysql.VARBINARY(128), nullable=False),
        sa.Column("kek_version", mysql.SMALLINT(unsigned=True), nullable=False),
        sa.Column("created_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.ForeignKeyConstraint(
            ["owner_id"],
            ["users.id"],
            name="fk_owner_local_keys_owner_id_users",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("key_id", name="uq_owner_local_keys_key_id"),
        sa.CheckConstraint(
            "algorithm = 'A256GCM'",
            name=op.f("ck_owner_local_keys_owner_local_key_algorithm"),
        ),
        sa.CheckConstraint(
            "kek_version >= 1",
            name=op.f("ck_owner_local_keys_owner_local_key_kek_version"),
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )

    op.create_table(
        "auth_rate_limits",
        sa.Column(
            "bucket_hash",
            mysql.BINARY(32),
            primary_key=True,
            autoincrement=False,
            nullable=False,
        ),
        sa.Column(
            "action",
            mysql.VARCHAR(32, charset="ascii", collation="ascii_bin"),
            nullable=False,
        ),
        sa.Column("window_started_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("window_seconds", mysql.INTEGER(unsigned=True), nullable=False),
        sa.Column(
            "count",
            mysql.BIGINT(unsigned=True),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("expires_at", mysql.DATETIME(fsp=3), nullable=False),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index("ix_auth_rate_limits_expiry", "auth_rate_limits", ["expires_at"])

    op.create_table(
        "auth_email_delivery_jobs",
        sa.Column(
            "id",
            mysql.BINARY(16),
            primary_key=True,
            autoincrement=False,
            nullable=False,
        ),
        sa.Column("iv", mysql.BINARY(12), nullable=False),
        sa.Column("ciphertext", mysql.VARBINARY(4096), nullable=False),
        sa.Column(
            "attempts",
            mysql.SMALLINT(unsigned=True),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("next_attempt_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("created_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("expires_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("sent_at", mysql.DATETIME(fsp=3), nullable=True),
        sa.CheckConstraint(
            "attempts >= 0",
            name=op.f(
                "ck_auth_email_delivery_jobs_email_delivery_attempts_nonnegative"
            ),
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "ix_auth_email_delivery_jobs_due",
        "auth_email_delivery_jobs",
        ["sent_at", "next_attempt_at", "expires_at"],
    )


def downgrade() -> None:
    op.drop_table("auth_email_delivery_jobs")
    op.drop_table("auth_rate_limits")
    op.drop_table("owner_local_keys")
    op.drop_table("auth_email_tokens")
    op.drop_table("auth_sessions")
