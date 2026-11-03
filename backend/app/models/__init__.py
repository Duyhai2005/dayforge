"""Import all mapped tables before configuring migrations."""

from app.models.auth import (
    AuthRateLimit,
    EmailDeliveryJob,
    EmailToken,
    OwnerLocalKey,
    Session,
)
from app.models.base import Base
from app.models.owner import User, WorkspaceSettings
from app.models.sync import (
    SyncCalibration,
    SyncOperation,
    SyncOwnerState,
    SyncPageToken,
)

__all__ = [
    "AuthRateLimit",
    "Base",
    "EmailDeliveryJob",
    "EmailToken",
    "OwnerLocalKey",
    "Session",
    "User",
    "WorkspaceSettings",
    "SyncCalibration",
    "SyncOperation",
    "SyncOwnerState",
    "SyncPageToken",
]
