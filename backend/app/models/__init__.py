"""Import all mapped tables before configuring migrations."""

from app.models.base import Base
from app.models.owner import User, WorkspaceSettings

__all__ = ["Base", "User", "WorkspaceSettings"]
