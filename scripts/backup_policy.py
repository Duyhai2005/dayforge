"""Secret-safe policy loading for encrypted MySQL backup jobs."""

from __future__ import annotations

import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path

_FIELDS = frozenset(
    {
        "repository_file",
        "password_file",
        "credentials_file",
        "workspace_root",
        "keep_daily",
        "keep_weekly",
        "keep_monthly",
        "max_success_age_hours",
    }
)
_ENV_KEY = re.compile(r"[A-Z][A-Z0-9_]{0,63}\Z")


class BackupPolicyError(ValueError):
    """Safe backup configuration error that never includes values or paths."""


@dataclass(frozen=True, slots=True)
class BackupPolicy:
    repository_file: Path
    password_file: Path
    credentials_file: Path
    workspace_root: Path
    keep_daily: int = 7
    keep_weekly: int = 4
    keep_monthly: int = 3
    max_success_age_hours: int = 26


def _absolute_path(raw: object, field: str) -> Path:
    if not isinstance(raw, str) or not raw or "\x00" in raw:
        raise BackupPolicyError(field)
    try:
        path = Path(raw).expanduser()
        if not path.is_absolute():
            raise BackupPolicyError(field)
        return path.resolve(strict=False)
    except (OSError, RuntimeError, ValueError):
        raise BackupPolicyError(field) from None


def _positive_integer(raw: object, field: str, maximum: int) -> int:
    if type(raw) is not int or not 1 <= raw <= maximum:
        raise BackupPolicyError(field)
    return raw


def load_backup_policy(path: Path) -> BackupPolicy:
    """Read a strict, secret-free JSON policy document."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise BackupPolicyError("policy_file") from None
    if not isinstance(raw, dict) or set(raw) != _FIELDS:
        raise BackupPolicyError("policy_fields")
    return BackupPolicy(
        repository_file=_absolute_path(raw["repository_file"], "repository_file"),
        password_file=_absolute_path(raw["password_file"], "password_file"),
        credentials_file=_absolute_path(raw["credentials_file"], "credentials_file"),
        workspace_root=_absolute_path(raw["workspace_root"], "workspace_root"),
        keep_daily=_positive_integer(raw["keep_daily"], "keep_daily", 365),
        keep_weekly=_positive_integer(raw["keep_weekly"], "keep_weekly", 104),
        keep_monthly=_positive_integer(raw["keep_monthly"], "keep_monthly", 120),
        max_success_age_hours=_positive_integer(
            raw["max_success_age_hours"], "max_success_age_hours", 24 * 365
        ),
    )


def _private_regular_file(path: Path, field: str) -> None:
    try:
        info = path.lstat()
    except OSError:
        raise BackupPolicyError(field) from None
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise BackupPolicyError(field)
    if os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o077:
        raise BackupPolicyError(field)


def read_restic_environment(policy: BackupPolicy) -> dict[str, str]:
    """Load a small allow-listed restic credential environment file."""
    _private_regular_file(policy.credentials_file, "credentials_file")
    try:
        contents = policy.credentials_file.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        raise BackupPolicyError("credentials_file") from None
    allowed = {
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
        "AWS_ENDPOINT",
        "RESTIC_REST_USERNAME",
        "RESTIC_REST_PASSWORD",
    }
    environment: dict[str, str] = {}
    for line in contents.splitlines():
        if not line or line.lstrip().startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if (
            not separator
            or not _ENV_KEY.fullmatch(key)
            or key not in allowed
            or not value
            or "\x00" in value
            or "\n" in value
            or "\r" in value
            or key in environment
        ):
            raise BackupPolicyError("credentials_file")
        environment[key] = value
    return environment


def validate_restic_files(policy: BackupPolicy) -> str:
    """Validate secret files and return the private repository locator."""
    _private_regular_file(policy.repository_file, "repository_file")
    _private_regular_file(policy.password_file, "password_file")
    try:
        repository = policy.repository_file.read_text(encoding="utf-8").strip()
        password = policy.password_file.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        raise BackupPolicyError("restic_secret_file") from None
    if (
        not repository
        or any(character.isspace() for character in repository)
        or not password.strip()
        or "\x00" in password
    ):
        raise BackupPolicyError("restic_secret_file")
    return repository
