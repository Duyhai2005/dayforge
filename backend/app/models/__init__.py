"""Import all mapped tables before configuring migrations."""

from app.models.auth import (
    AuthAuditEvent,
    AuthRateLimit,
    EmailDeliveryJob,
    EmailToken,
    OwnerLocalKey,
    Session,
)
from app.models.base import Base
from app.models.owner import User, WorkspaceSettings

__all__ = [
    "AuthAuditEvent",
    "AuthRateLimit",
    "Base",
    "EmailDeliveryJob",
    "EmailToken",
    "OwnerLocalKey",
    "Session",
    "User",
    "WorkspaceSettings",
]
