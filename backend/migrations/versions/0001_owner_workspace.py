"""Empty owner and fixed workspace schema."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

revision = "0001_owner_workspace"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", mysql.BINARY(16), primary_key=True, autoincrement=False, nullable=False),
        sa.Column("owner_slot", mysql.TINYINT(unsigned=True), nullable=False, server_default=sa.text("1")),
        sa.Column("email_canonical", mysql.VARBINARY(254), nullable=False),
        sa.Column("email_delivery", mysql.VARCHAR(254), nullable=False),
        sa.Column("password_hash", mysql.VARCHAR(512, charset="ascii", collation="ascii_bin"), nullable=False),
        sa.Column("email_verified_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("auth_version", mysql.BIGINT(unsigned=True), nullable=False, server_default=sa.text("1")),
        sa.Column("created_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("updated_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.UniqueConstraint("owner_slot", name="uq_users_owner_slot"),
        sa.UniqueConstraint("email_canonical", name="uq_users_email_canonical"),
        sa.CheckConstraint("owner_slot = 1", name=op.f("ck_users_owner_slot_one")),
        sa.CheckConstraint("auth_version >= 1", name=op.f("ck_users_auth_version_positive")),
        mysql_engine="InnoDB", mysql_charset="utf8mb4",
    )
    op.create_table(
        "workspace_settings",
        sa.Column("owner_id", mysql.BINARY(16), primary_key=True, autoincrement=False, nullable=False),
        sa.Column("time_zone", mysql.VARCHAR(64, charset="ascii", collation="ascii_bin"),
                  nullable=False, server_default=sa.text("'Asia/Bangkok'")),
        sa.Column("utc_offset_minutes", mysql.SMALLINT(), nullable=False, server_default=sa.text("420")),
        sa.Column("week_start", mysql.TINYINT(unsigned=True), nullable=False, server_default=sa.text("1")),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], name="fk_workspace_settings_owner_id_users", ondelete="RESTRICT"),
        sa.CheckConstraint("time_zone = 'Asia/Bangkok'", name=op.f("ck_workspace_settings_time_zone_bangkok")),
        sa.CheckConstraint("utc_offset_minutes = 420", name=op.f("ck_workspace_settings_utc_offset_minutes_420")),
        sa.CheckConstraint("week_start = 1", name=op.f("ck_workspace_settings_week_start_monday")),
        mysql_engine="InnoDB", mysql_charset="utf8mb4",
    )


def downgrade() -> None:
    op.drop_table("workspace_settings")
    op.drop_table("users")
