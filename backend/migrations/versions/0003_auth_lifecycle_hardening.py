"""Audit events, cleanup indexes, and leased email delivery claims."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0003_auth_lifecycle_hardening"
down_revision = "0002_authentication"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("email_delivery_jobs", sa.Column("claim_token", mysql.BINARY(16), nullable=True))
    op.add_column("email_delivery_jobs", sa.Column("claim_expires_at", mysql.DATETIME(fsp=3), nullable=True))
    op.create_index("ix_email_delivery_jobs_lease", "email_delivery_jobs", ["claim_expires_at"])
    op.create_index("ix_sessions_idle_expires_at", "sessions", ["idle_expires_at"])
    op.create_index("ix_sessions_absolute_expires_at", "sessions", ["absolute_expires_at"])
    op.create_index("ix_sessions_revoked_at", "sessions", ["revoked_at"])
    op.create_index("ix_email_tokens_expires_at", "email_tokens", ["expires_at"])
    op.create_index("ix_email_tokens_consumed_at", "email_tokens", ["consumed_at"])
    op.create_index("ix_email_tokens_invalidated_at", "email_tokens", ["invalidated_at"])
    op.create_table(
        "auth_audit_events",
        sa.Column("id", mysql.BINARY(16), primary_key=True, autoincrement=False, nullable=False),
        sa.Column("created_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("action", mysql.VARCHAR(32, charset="ascii", collation="ascii_bin"), nullable=False),
        sa.Column("outcome", mysql.VARCHAR(16, charset="ascii", collation="ascii_bin"), nullable=False),
        sa.Column("request_id", mysql.VARCHAR(36, charset="ascii", collation="ascii_bin"), nullable=False),
        sa.Column("owner_id", mysql.BINARY(16), nullable=True),
        sa.Column("email_digest", mysql.BINARY(32), nullable=True),
        sa.Column("peer_digest", mysql.BINARY(32), nullable=True),
        sa.CheckConstraint(
            "action IN ('session_created', 'register', 'verification_resend', 'email_verified', "
            "'login', 'password_forgot', 'password_reset', 'logout', 'local_key')",
            name=op.f("ck_auth_audit_events_action_valid"),
        ),
        sa.CheckConstraint(
            "outcome IN ('success', 'accepted', 'denied', 'noop', 'error')",
            name=op.f("ck_auth_audit_events_outcome_valid"),
        ),
        sa.Index("ix_auth_audit_events_created_at", "created_at"),
        sa.Index("ix_auth_audit_events_owner_created", "owner_id", "created_at"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )


def downgrade() -> None:
    op.drop_table("auth_audit_events")
    op.drop_index("ix_email_tokens_invalidated_at", table_name="email_tokens")
    op.drop_index("ix_email_tokens_consumed_at", table_name="email_tokens")
    op.drop_index("ix_email_tokens_expires_at", table_name="email_tokens")
    op.drop_index("ix_sessions_revoked_at", table_name="sessions")
    op.drop_index("ix_sessions_absolute_expires_at", table_name="sessions")
    op.drop_index("ix_sessions_idle_expires_at", table_name="sessions")
    op.drop_index("ix_email_delivery_jobs_lease", table_name="email_delivery_jobs")
    op.drop_column("email_delivery_jobs", "claim_expires_at")
    op.drop_column("email_delivery_jobs", "claim_token")
