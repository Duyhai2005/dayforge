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
from app.models.sync import ChangeLog, OperationReceipt, OwnerSyncState, RecordedOperation

__all__ = [
    "AuthAuditEvent",
    "AuthRateLimit",
    "Base",
    "ChangeLog",
    "EmailDeliveryJob",
    "EmailToken",
    "OwnerLocalKey",
    "OwnerSyncState",
    "OperationReceipt",
    "RecordedOperation",
    "Session",
    "User",
    "WorkspaceSettings",
]
