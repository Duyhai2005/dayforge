"""Authentication sessions, email tokens and wrapped local owner keys."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0002_authentication"
down_revision = "0001_owner_workspace"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sessions",
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
        sa.Column("csrf_token", mysql.BINARY(32), nullable=False),
        sa.Column("auth_version", mysql.BIGINT(unsigned=True), nullable=True),
        sa.Column("password_authenticated_at", mysql.DATETIME(fsp=3), nullable=True),
        sa.Column(
            "remember_me",
            mysql.TINYINT(unsigned=True),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("created_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("last_activity_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("idle_expires_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("absolute_expires_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("revoked_at", mysql.DATETIME(fsp=3), nullable=True),
        sa.ForeignKeyConstraint(
            ["owner_id"],
            ["users.id"],
            name="fk_sessions_owner_id_users",
            ondelete="RESTRICT",
        ),
        sa.UniqueConstraint("token_hash", name="uq_sessions_token_hash"),
        sa.CheckConstraint(
            "kind IN ('anonymous', 'authenticated')",
            name=op.f("ck_sessions_kind_valid"),
        ),
        sa.CheckConstraint(
            "remember_me IN (0, 1)",
            name=op.f("ck_sessions_remember_me_boolean"),
        ),
        sa.CheckConstraint(
            "(kind = 'anonymous' AND owner_id IS NULL AND auth_version IS NULL AND password_authenticated_at IS NULL AND remember_me = 0) OR (kind = 'authenticated' AND owner_id IS NOT NULL AND auth_version IS NOT NULL AND auth_version >= 1 AND password_authenticated_at IS NOT NULL)",
            name=op.f("ck_sessions_kind_owner_binding"),
        ),
        sa.CheckConstraint(
            "idle_expires_at <= absolute_expires_at",
            name=op.f("ck_sessions_expiry_order"),
        ),
        sa.Index("ix_sessions_owner_revoked", "owner_id", "revoked_at"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_table(
        "email_tokens",
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
            name="fk_email_tokens_owner_id_users",
            ondelete="RESTRICT",
        ),
        sa.UniqueConstraint("token_hash", name="uq_email_tokens_token_hash"),
        sa.CheckConstraint(
            "purpose IN ('verify_email', 'password_reset')",
            name=op.f("ck_email_tokens_purpose_valid"),
        ),
        sa.CheckConstraint(
            "expires_at > created_at", name=op.f("ck_email_tokens_expiry_order")
        ),
        sa.CheckConstraint(
            "consumed_at IS NULL OR consumed_at >= created_at",
            name=op.f("ck_email_tokens_consume_order"),
        ),
        sa.Index("ix_email_tokens_email_purpose", "email_canonical", "purpose"),
        sa.Index("ix_email_tokens_owner_purpose", "owner_id", "purpose"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
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
            server_default=sa.text("'A256GCM'"),
        ),
        sa.Column("wrapped_key", mysql.VARBINARY(128), nullable=False),
        sa.Column("kek_version", mysql.SMALLINT(unsigned=True), nullable=False),
        sa.Column("created_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.ForeignKeyConstraint(
            ["owner_id"],
            ["users.id"],
            name="fk_owner_local_keys_owner_id_users",
            ondelete="RESTRICT",
        ),
        sa.UniqueConstraint("key_id", name="uq_owner_local_keys_key_id"),
        sa.CheckConstraint(
            "algorithm = 'A256GCM'", name=op.f("ck_owner_local_keys_algorithm_a256gcm")
        ),
        sa.CheckConstraint(
            "kek_version >= 1", name=op.f("ck_owner_local_keys_kek_version_positive")
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_table(
        "auth_rate_limits",
        sa.Column(
            "action",
            mysql.VARCHAR(32, charset="ascii", collation="ascii_bin"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "subject_kind",
            mysql.VARCHAR(16, charset="ascii", collation="ascii_bin"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column("subject_digest", mysql.BINARY(32), primary_key=True, nullable=False),
        sa.Column("window_seconds", mysql.BIGINT(unsigned=True), nullable=False),
        sa.Column(
            "request_count",
            mysql.BIGINT(unsigned=True),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("event_timestamps", mysql.JSON(), nullable=False),
        sa.Column("updated_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("expires_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.CheckConstraint(
            "window_seconds > 0", name=op.f("ck_auth_rate_limits_window_positive")
        ),
        sa.CheckConstraint(
            "request_count >= 0",
            name=op.f("ck_auth_rate_limits_request_count_nonnegative"),
        ),
        sa.Index("ix_auth_rate_limits_expires_at", "expires_at"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_table(
        "email_delivery_jobs",
        sa.Column(
            "id",
            mysql.BINARY(16),
            primary_key=True,
            autoincrement=False,
            nullable=False,
        ),
        sa.Column("payload_ciphertext", mysql.VARBINARY(4096), nullable=False),
        sa.Column("outbox_key_version", mysql.SMALLINT(unsigned=True), nullable=False),
        sa.Column("created_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("available_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("expires_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column(
            "attempt_count",
            mysql.TINYINT(unsigned=True),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("sent_at", mysql.DATETIME(fsp=3), nullable=True),
        sa.Column(
            "last_error_code",
            mysql.VARCHAR(64, charset="ascii", collation="ascii_bin"),
            nullable=True,
        ),
        sa.CheckConstraint(
            "outbox_key_version >= 1",
            name=op.f("ck_email_delivery_jobs_key_version_positive"),
        ),
        sa.CheckConstraint(
            "attempt_count >= 0",
            name=op.f("ck_email_delivery_jobs_attempt_count_nonnegative"),
        ),
        sa.CheckConstraint(
            "expires_at > created_at", name=op.f("ck_email_delivery_jobs_expiry_order")
        ),
        sa.Index(
            "ix_email_delivery_jobs_ready", "sent_at", "available_at", "expires_at"
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )


def downgrade() -> None:
    op.drop_table("email_delivery_jobs")
    op.drop_table("auth_rate_limits")
    op.drop_table("owner_local_keys")
    op.drop_table("email_tokens")
    op.drop_table("sessions")
