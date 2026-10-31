from datetime import datetime
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, UniqueConstraint, text
from sqlalchemy.dialects.mysql import BIGINT, SMALLINT, TINYINT, VARBINARY, VARCHAR
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.types import UTCMilliseconds, UUIDBytes


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("owner_slot", name="uq_users_owner_slot"),
        UniqueConstraint("email_canonical", name="uq_users_email_canonical"),
        CheckConstraint("owner_slot = 1", name="owner_slot_one"),
        CheckConstraint("auth_version >= 1", name="auth_version_positive"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[UUID] = mapped_column(UUIDBytes(), primary_key=True, autoincrement=False)
    owner_slot: Mapped[int] = mapped_column(
        TINYINT(unsigned=True), server_default=text("1")
    )
    email_canonical: Mapped[bytes] = mapped_column(VARBINARY(254))
    email_delivery: Mapped[str] = mapped_column(VARCHAR(254))
    password_hash: Mapped[str] = mapped_column(
        VARCHAR(512, charset="ascii", collation="ascii_bin")
    )
    email_verified_at: Mapped[datetime] = mapped_column(UTCMilliseconds())
    auth_version: Mapped[int] = mapped_column(
        BIGINT(unsigned=True), server_default=text("1")
    )
    created_at: Mapped[datetime] = mapped_column(UTCMilliseconds())
    updated_at: Mapped[datetime] = mapped_column(UTCMilliseconds())


class WorkspaceSettings(Base):
    __tablename__ = "workspace_settings"
    __table_args__ = (
        CheckConstraint("time_zone = 'Asia/Bangkok'", name="time_zone_bangkok"),
        CheckConstraint("utc_offset_minutes = 420", name="utc_offset_minutes_420"),
        CheckConstraint("week_start = 1", name="week_start_monday"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    owner_id: Mapped[UUID] = mapped_column(
        UUIDBytes(),
        ForeignKey(
            "users.id", name="fk_workspace_settings_owner_id_users", ondelete="RESTRICT"
        ),
        primary_key=True,
        autoincrement=False,
    )
    time_zone: Mapped[str] = mapped_column(
        VARCHAR(64, charset="ascii", collation="ascii_bin"),
        server_default=text("'Asia/Bangkok'"),
    )
    utc_offset_minutes: Mapped[int] = mapped_column(
        SMALLINT(), server_default=text("420")
    )
    week_start: Mapped[int] = mapped_column(
        TINYINT(unsigned=True), server_default=text("1")
    )
