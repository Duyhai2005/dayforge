"""Create or compare a stable fingerprint for a restored Dayforge database."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from scripts.backup_database import (
    BackupError,
    Runner,
    _compose_prefix,
    _current_release_manifest,
    _mysql_query,
    _run,
)
from scripts.deploy_config import DeployConfig, DeployConfigError, load_deploy_config
from scripts.deploy_release import DeploymentError
from scripts.release_manifest import ReleaseManifestError, load_release_manifest

_TABLE_NAME = re.compile(r"[A-Za-z0-9_]{1,64}\Z")
_EXCLUDED_COUNTS = frozenset(
    {"sessions", "email_tokens", "email_delivery_jobs", "auth_audit_events"}
)
_FINGERPRINT_FIELDS = frozenset(
    {
        "format_version",
        "table_counts",
        "owner_ids",
        "workspace_settings",
        "owner_local_keys",
        "recorded_operation_count",
        "envelope_fingerprint_sha256",
    }
)


class RestoreVerificationError(RuntimeError):
    """Safe fingerprint verification failure."""


@dataclass(frozen=True, slots=True)
class RestoreVerification:
    table_counts: dict[str, int]
    owner_ids: tuple[str, ...]
    workspace_settings: tuple[tuple[str, str, int, int], ...]
    owner_local_keys: tuple[tuple[str, str, int, str], ...]
    recorded_operation_count: int
    envelope_fingerprint_sha256: str
    matches_expected: bool


def _query(
    config: DeployConfig,
    release,
    prefix: list[str],
    environment: Mapping[str, str],
    sql: str,
    runner: Runner,
) -> str:
    try:
        return _mysql_query(config, release, prefix, environment, sql, runner)
    except (BackupError, DeploymentError, OSError, ValueError):
        raise RestoreVerificationError("fingerprint_query_failed") from None


def fingerprint_database(
    config: DeployConfig,
    release,
    *,
    env_file: Path | None = None,
    compose_file: Path | None = None,
    runner: Runner = _run,
) -> dict[str, object]:
    """Fingerprint domain and cryptographic identity fields without volatile auth."""
    if config.environment not in {"restore", "staging", "production"}:
        raise RestoreVerificationError("fingerprint_environment_invalid")
    try:
        prefix, environment = _compose_prefix(
            config,
            release,
            env_file or config.secrets_dir.parent / "runtime.env",
            compose_file
            or Path(__file__).resolve().parents[1] / "deploy" / "compose.app.yaml",
        )
    except (DeploymentError, OSError, ValueError):
        raise RestoreVerificationError("fingerprint_runtime_unavailable") from None
    table_text = _query(
        config,
        release,
        prefix,
        environment,
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' "
        "ORDER BY table_name",
        runner,
    )
    table_names = [line for line in table_text.splitlines() if line]
    if not table_names or any(not _TABLE_NAME.fullmatch(name) for name in table_names):
        raise RestoreVerificationError("fingerprint_schema_invalid")
    table_counts: dict[str, int] = {}
    for name in table_names:
        count_text = _query(
            config,
            release,
            prefix,
            environment,
            f"SELECT COUNT(*) FROM `{name}`",
            runner,
        )
        if not re.fullmatch(r"[0-9]{1,18}", count_text):
            raise RestoreVerificationError("fingerprint_count_invalid")
        table_counts[name] = int(count_text)
    owners_text = _query(
        config,
        release,
        prefix,
        environment,
        "SELECT LOWER(HEX(id)) FROM users ORDER BY id",
        runner,
    )
    owner_ids = tuple(line for line in owners_text.splitlines() if line)
    settings_text = _query(
        config,
        release,
        prefix,
        environment,
        "SELECT LOWER(HEX(owner_id)), time_zone, utc_offset_minutes, week_start "
        "FROM workspace_settings ORDER BY owner_id",
        runner,
    )
    workspace_settings: list[tuple[str, str, int, int]] = []
    for line in settings_text.splitlines():
        parts = line.split("\t")
        if len(parts) != 4 or not parts[2].isdigit() or not parts[3].isdigit():
            raise RestoreVerificationError("fingerprint_settings_invalid")
        workspace_settings.append((parts[0], parts[1], int(parts[2]), int(parts[3])))
    keys_text = _query(
        config,
        release,
        prefix,
        environment,
        "SELECT LOWER(HEX(owner_id)), LOWER(HEX(key_id)), kek_version, "
        "LOWER(SHA2(wrapped_key, 256)) FROM owner_local_keys ORDER BY owner_id, key_id",
        runner,
    )
    owner_local_keys: list[tuple[str, str, int, str]] = []
    for line in keys_text.splitlines():
        parts = line.split("\t")
        if (
            len(parts) != 4
            or not parts[2].isdigit()
            or not re.fullmatch(r"[a-f0-9]{64}", parts[3])
        ):
            raise RestoreVerificationError("fingerprint_key_rows_invalid")
        owner_local_keys.append((parts[0], parts[1], int(parts[2]), parts[3]))
    operations_text = _query(
        config,
        release,
        prefix,
        environment,
        "SELECT LOWER(HEX(owner_id)), LOWER(HEX(operation_id)), "
        "LOWER(SHA2(envelope, 256)) FROM recorded_operations "
        "ORDER BY owner_id, operation_id",
        runner,
    )
    operation_lines = [line for line in operations_text.splitlines() if line]
    operation_hash = hashlib.sha256()
    for line in operation_lines:
        parts = line.split("\t")
        if len(parts) != 3 or not re.fullmatch(r"[a-f0-9]{64}", parts[2]):
            raise RestoreVerificationError("fingerprint_envelopes_invalid")
        operation_hash.update(("\t".join(parts) + "\n").encode("ascii"))
    volatile_counts = sorted(name for name in table_counts if name in _EXCLUDED_COUNTS)
    stable_counts = {
        name: count
        for name, count in table_counts.items()
        if name not in _EXCLUDED_COUNTS
    }
    return {
        "format_version": 1,
        "table_counts": stable_counts,
        "owner_ids": list(owner_ids),
        "workspace_settings": [list(row) for row in workspace_settings],
        "owner_local_keys": [list(row) for row in owner_local_keys],
        "recorded_operation_count": len(operation_lines),
        "envelope_fingerprint_sha256": operation_hash.hexdigest(),
        "excluded_volatile_table_counts": volatile_counts,
    }


def _load_expected(path: Path) -> dict[str, object]:
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise RestoreVerificationError("expected_fingerprint_invalid")
        if os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o077:
            raise RestoreVerificationError("expected_fingerprint_permissions_invalid")
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise RestoreVerificationError("expected_fingerprint_unreadable") from None
    if not isinstance(value, dict) or set(value) != _FINGERPRINT_FIELDS | {
        "excluded_volatile_table_counts"
    }:
        raise RestoreVerificationError("expected_fingerprint_invalid")
    if value.get("format_version") != 1:
        raise RestoreVerificationError("expected_fingerprint_invalid")
    return value


def verify_restored_database(
    config: DeployConfig,
    *,
    expected_fingerprint: Path,
    release=None,
    env_file: Path | None = None,
    compose_file: Path | None = None,
    runner: Runner = _run,
) -> RestoreVerification:
    """Compare restorable DB identity against a private quiesced source fingerprint."""
    expected = _load_expected(expected_fingerprint)
    if release is None:
        from scripts.release_manifest import load_release_manifest

        release = load_release_manifest(_current_release_manifest(config))
    actual = fingerprint_database(
        config,
        release,
        env_file=env_file,
        compose_file=compose_file,
        runner=runner,
    )
    comparison_keys = _FINGERPRINT_FIELDS
    matches = all(actual.get(key) == expected.get(key) for key in comparison_keys)
    return RestoreVerification(
        table_counts=dict(actual["table_counts"]),
        owner_ids=tuple(actual["owner_ids"]),
        workspace_settings=tuple(tuple(row) for row in actual["workspace_settings"]),
        owner_local_keys=tuple(tuple(row) for row in actual["owner_local_keys"]),
        recorded_operation_count=int(actual["recorded_operation_count"]),
        envelope_fingerprint_sha256=str(actual["envelope_fingerprint_sha256"]),
        matches_expected=matches,
    )


def _write_fingerprint(path: Path, payload: dict[str, object]) -> None:
    temporary = path.with_name(f".{path.name}-{uuid4().hex}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(
                payload,
                stream,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    except (OSError, UnicodeError, TypeError, ValueError):
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise RestoreVerificationError("fingerprint_write_failed") from None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--release", type=Path)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--expected-fingerprint", type=Path)
    action.add_argument("--write-fingerprint", type=Path)
    args = parser.parse_args(argv)
    try:
        config = load_deploy_config(args.config)
        release = load_release_manifest(
            args.release or _current_release_manifest(config)
        )
        if args.write_fingerprint is not None:
            payload = fingerprint_database(config, release)
            _write_fingerprint(args.write_fingerprint, payload)
            print(
                json.dumps(
                    {
                        "status": "fingerprint_written",
                        "recorded_operation_count": payload["recorded_operation_count"],
                        "envelope_fingerprint_sha256": payload[
                            "envelope_fingerprint_sha256"
                        ],
                    },
                    sort_keys=True,
                )
            )
            return 0
        report = verify_restored_database(
            config, expected_fingerprint=args.expected_fingerprint, release=release
        )
    except (
        DeployConfigError,
        ReleaseManifestError,
        RestoreVerificationError,
        OSError,
        ValueError,
    ):
        print("restore_verification_failed", file=sys.stderr)
        return 2
    print(
        json.dumps(
            {
                "matches_expected": report.matches_expected,
                "recorded_operation_count": report.recorded_operation_count,
                "envelope_fingerprint_sha256": report.envelope_fingerprint_sha256,
            },
            sort_keys=True,
        )
    )
    return 0 if report.matches_expected else 1


if __name__ == "__main__":
    raise SystemExit(main())
