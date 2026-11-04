"""Restore one verified Dayforge snapshot into an isolated empty DB target."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from scripts.backup_database import (
    _KEY_FILES,
    BackupError,
    PopenFactory,
    Runner,
    _acquire_operation_lock,
    _current_release_manifest,
    _ensure_private_workspace,
    _mysql_query,
    _remove_payload,
    _restic_run,
    _utc_text,
    _write_private_json,
)
from scripts.backup_policy import (
    BackupPolicy,
    BackupPolicyError,
    load_backup_policy,
    read_restic_environment,
    validate_restic_files,
)
from scripts.deploy_config import DeployConfig, DeployConfigError, load_deploy_config
from scripts.deploy_release import (
    DeploymentError,
    _compose_prefix,
    _current_revision,
    _execute,
    _run,
)
from scripts.release_manifest import (
    ReleaseManifest,
    ReleaseManifestError,
    load_release_manifest,
)

_SNAPSHOT_ID = re.compile(r"[a-f0-9]{64}\Z")
_REVISION = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
_MYSQL_VERSION = re.compile(r"8\.4\.13(?:-[A-Za-z0-9.]+)?\Z")
_RESTORE_PROJECT = re.compile(r"dayforge-restore-([a-f0-9]{32})\Z")
_RESTORE_DATABASE = re.compile(r"dayforge_restore_([a-f0-9]{32})\Z")
_RESTORE_EDGE = re.compile(r"restore-([a-f0-9]{32})\Z")


class RestoreError(RuntimeError):
    """Safe restore failure containing only a stable error code."""


@dataclass(frozen=True, slots=True)
class RestoreResult:
    snapshot_id: str
    source_environment: str
    restored_revision: str
    verified_dump_sha256: str


def _snapshot_record(
    runner: Runner,
    policy: BackupPolicy,
    payload: Path,
    *,
    repository: str,
    credentials: Mapping[str, str],
    snapshot_id: str,
) -> dict[str, object]:
    if not _SNAPSHOT_ID.fullmatch(snapshot_id):
        raise RestoreError("snapshot_id_invalid")
    result = _restic_run(
        runner,
        policy,
        payload,
        ("snapshots", "--json", snapshot_id),
        repository=repository,
        credentials=credentials,
        error_code="snapshot_lookup_failed",
    )
    try:
        snapshots = json.loads(result.stdout)
        record = next(item for item in snapshots if item.get("id") == snapshot_id)
        tags = record.get("tags")
    except (json.JSONDecodeError, TypeError, AttributeError, KeyError, StopIteration):
        raise RestoreError("snapshot_lookup_failed") from None
    if not isinstance(tags, list) or not all(isinstance(item, str) for item in tags):
        raise RestoreError("snapshot_metadata_invalid")
    record["tags"] = tags
    return record


def _verify_snapshot_tags(
    record: Mapping[str, object], source_environment: str | None
) -> str:
    tags = set(record["tags"])
    environments = {
        tag.removeprefix("environment:")
        for tag in tags
        if tag.startswith("environment:")
    }
    if len(environments) != 1:
        raise RestoreError("snapshot_environment_invalid")
    environment = next(iter(environments))
    if environment not in {"staging", "production"}:
        raise RestoreError("snapshot_environment_invalid")
    if source_environment is not None and source_environment != environment:
        raise RestoreError("snapshot_environment_mismatch")
    if "kind:database" not in tags:
        raise RestoreError("snapshot_type_invalid")
    return environment


def _manifest_and_payload(
    payload: Path,
    *,
    source_environment: str,
    release: ReleaseManifest,
) -> tuple[dict[str, object], Path, dict[str, object]]:
    manifest_path = payload / "backup-manifest.json"
    dump_path = payload / "database.sql.gz"
    runtime_path = payload / "restore-runtime.json"
    secrets_path = payload / "restore-secrets"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise RestoreError("snapshot_payload_unreadable") from None
    required_fields = {
        "format_version",
        "source_environment",
        "release_id",
        "build_id",
        "git_sha",
        "mysql_version",
        "alembic_revision",
        "dump_started_at",
        "dump_completed_at",
        "dump_sha256",
        "key_versions",
        "restore_secret_files",
        "runtime_config_file",
    }
    if not isinstance(manifest, dict) or set(manifest) != required_fields:
        raise RestoreError("snapshot_manifest_invalid")
    if (
        manifest["format_version"] != 1
        or manifest["source_environment"] != source_environment
    ):
        raise RestoreError("snapshot_manifest_mismatch")
    if not isinstance(manifest["alembic_revision"], str) or not _REVISION.fullmatch(
        manifest["alembic_revision"]
    ):
        raise RestoreError("snapshot_revision_invalid")
    if (
        not isinstance(manifest["release_id"], str)
        or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", manifest["release_id"])
        or not isinstance(manifest["build_id"], str)
        or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", manifest["build_id"])
        or not isinstance(manifest["git_sha"], str)
        or not re.fullmatch(r"[a-f0-9]{40,64}", manifest["git_sha"])
    ):
        raise RestoreError("snapshot_source_identity_invalid")
    if manifest["alembic_revision"] not in release.supported_db_revisions:
        raise RestoreError("release_does_not_support_snapshot_revision")
    if not isinstance(manifest["mysql_version"], str) or not _MYSQL_VERSION.fullmatch(
        manifest["mysql_version"]
    ):
        raise RestoreError("snapshot_mysql_version_unsupported")
    if not isinstance(manifest["dump_sha256"], str) or not re.fullmatch(
        r"[a-f0-9]{64}", manifest["dump_sha256"]
    ):
        raise RestoreError("snapshot_checksum_invalid")
    if not dump_path.is_file() or dump_path.is_symlink():
        raise RestoreError("snapshot_dump_missing")
    digest = hashlib.sha256()
    try:
        with dump_path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        with gzip.open(dump_path, "rb") as stream:
            for _ in iter(lambda: stream.read(1024 * 1024), b""):
                pass
    except (OSError, EOFError, gzip.BadGzipFile):
        raise RestoreError("snapshot_dump_invalid") from None
    if digest.hexdigest() != manifest["dump_sha256"]:
        raise RestoreError("snapshot_checksum_mismatch")
    key_versions = manifest["key_versions"]
    if (
        not isinstance(key_versions, dict)
        or type(key_versions.get("local_key_kek")) is not int
    ):
        raise RestoreError("snapshot_key_version_missing")
    if not isinstance(runtime, dict) or set(runtime) != {
        "owner_email",
        "public_origin",
        "local_key_kek_version",
    }:
        raise RestoreError("snapshot_runtime_config_invalid")
    if (
        not isinstance(runtime["owner_email"], str)
        or not runtime["owner_email"]
        or any(character.isspace() for character in runtime["owner_email"])
        or type(runtime["local_key_kek_version"]) is not int
        or runtime["local_key_kek_version"] != key_versions["local_key_kek"]
        or not isinstance(runtime["public_origin"], str)
        or not runtime["public_origin"].startswith("https://")
    ):
        raise RestoreError("snapshot_runtime_config_invalid")
    if (
        manifest["restore_secret_files"] != list(_KEY_FILES)
        or manifest["runtime_config_file"] != "restore-runtime.json"
    ):
        raise RestoreError("snapshot_key_manifest_invalid")
    if not secrets_path.is_dir() or secrets_path.is_symlink():
        raise RestoreError("snapshot_keys_missing")
    for name in _KEY_FILES:
        secret = secrets_path / name
        if not secret.is_file() or secret.is_symlink():
            if name == "logout_ticket_previous_keys_b64":
                continue
            raise RestoreError("snapshot_keys_missing")
        try:
            info = secret.lstat()
            if os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o077:
                raise RestoreError("snapshot_key_permissions_invalid")
            if (
                name != "logout_ticket_previous_keys_b64"
                and not secret.read_bytes().strip()
            ):
                raise RestoreError("snapshot_keys_missing")
        except OSError:
            raise RestoreError("snapshot_keys_unreadable") from None
    return manifest, dump_path, runtime


def _target_runtime(config: DeployConfig) -> tuple[str, int]:
    path = config.secrets_dir.parent / "runtime.env"
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise RestoreError("restore_runtime_invalid")
        if os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o077:
            raise RestoreError("restore_runtime_permissions_invalid")
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        raise RestoreError("restore_runtime_unavailable") from None
    values: dict[str, str] = {}
    for line in lines:
        key, separator, value = line.partition("=")
        if separator and key.strip() in {
            "OWNER_EMAIL",
            "PUBLIC_ORIGIN",
            "LOCAL_KEY_KEK_VERSION",
        }:
            field = key.strip()
            if field in values:
                raise RestoreError("restore_runtime_invalid")
            values[field] = value.strip()
    if values.get("PUBLIC_ORIGIN") != config.public_origin:
        raise RestoreError("restore_runtime_origin_mismatch")
    try:
        version = int(values.get("LOCAL_KEY_KEK_VERSION", ""))
    except ValueError:
        raise RestoreError("restore_runtime_key_version_invalid") from None
    owner_email = values.get("OWNER_EMAIL", "")
    if (
        not owner_email
        or any(character.isspace() for character in owner_email)
        or version < 1
    ):
        raise RestoreError("restore_runtime_invalid")
    return owner_email, version


def _install_source_keys(config: DeployConfig, payload: Path) -> None:
    source = payload / "restore-secrets"
    for name in _KEY_FILES:
        source_file = source / name
        target = config.secrets_dir / name
        expected = source_file.read_bytes() if source_file.exists() else b""
        if target.exists():
            if target.is_symlink() or not target.is_file():
                raise RestoreError("restore_secret_target_invalid")
            try:
                actual = target.read_bytes()
            except OSError:
                raise RestoreError("restore_secret_target_unreadable") from None
            if actual != expected:
                raise RestoreError("restore_secret_target_mismatch")
            continue
        if name != "logout_ticket_previous_keys_b64" and not expected.strip():
            raise RestoreError("snapshot_keys_missing")
        try:
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(expected)
                stream.flush()
                os.fsync(stream.fileno())
        except OSError:
            raise RestoreError("restore_secret_install_failed") from None


def _import_sql(
    prefix: Sequence[str],
    environment: Mapping[str, str],
    dump_path: Path,
    *,
    popen_factory: PopenFactory,
) -> None:
    script = (
        'set -eu; password="$(cat /run/secrets/mysql_root_password)"; '
        'MYSQL_PWD="$password" exec mysql --protocol=TCP -h127.0.0.1 -uroot '
        '--database="$MYSQL_DATABASE" --binary-mode=1'
    )
    arguments = [
        *prefix,
        "exec",
        "-T",
        "mysql",
        "sh",
        "-ec",
        script,
        "dayforge-mysql-import",
    ]
    try:
        process = popen_factory(
            arguments,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=dict(environment),
        )
    except OSError:
        raise RestoreError("mysql_import_unavailable") from None
    if process.stdin is None:
        process.kill()
        raise RestoreError("mysql_import_unavailable")
    try:
        with gzip.open(dump_path, "rb") as source:
            shutil.copyfileobj(source, process.stdin, length=1024 * 1024)
        process.stdin.close()
        return_code = process.wait(timeout=4 * 60 * 60)
    except (OSError, EOFError, gzip.BadGzipFile, subprocess.TimeoutExpired):
        try:
            process.kill()
            process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            pass
        raise RestoreError("mysql_import_failed") from None
    finally:
        try:
            process.stdin.close()
        except OSError:
            pass
    if return_code != 0:
        raise RestoreError("mysql_import_failed")


def restore_database(
    config: DeployConfig,
    release: ReleaseManifest,
    policy: BackupPolicy,
    *,
    snapshot_id: str,
    source_environment: str | None = None,
    env_file: Path | None = None,
    compose_file: Path | None = None,
    runner: Runner = _run,
    popen_factory: PopenFactory = subprocess.Popen,
    now: datetime | None = None,
) -> RestoreResult:
    """Restore and verify a selected snapshot in a new isolated restore DB."""
    if config.environment != "restore":
        raise RestoreError("restore_environment_required")
    project_match = _RESTORE_PROJECT.fullmatch(config.compose_project)
    database_match = _RESTORE_DATABASE.fullmatch(config.db_name)
    edge_match = _RESTORE_EDGE.fullmatch(config.edge_alias)
    if (
        project_match is None
        or database_match is None
        or edge_match is None
        or len({project_match.group(1), database_match.group(1), edge_match.group(1)})
        != 1
    ):
        raise RestoreError("restore_target_identity_invalid")
    if release.platform != config.platform:
        raise RestoreError("release_platform_mismatch")
    if not _SNAPSHOT_ID.fullmatch(snapshot_id):
        raise RestoreError("snapshot_id_invalid")
    workspace = _ensure_private_workspace(config, policy)
    repository = validate_restic_files(policy)
    credentials = read_restic_environment(policy)
    lock_path = _acquire_operation_lock(config.state_dir)
    payload = workspace / "payload"
    restore_output = workspace / "restore-output"
    try:
        _remove_payload(payload)
        _remove_payload(restore_output)
        payload.mkdir(mode=0o700)
        env_path = env_file or config.secrets_dir.parent / "runtime.env"
        compose_path = (
            compose_file
            or Path(__file__).resolve().parents[1] / "deploy" / "compose.app.yaml"
        )
        try:
            prefix, environment = _compose_prefix(
                config, release, env_path, compose_path
            )
        except DeploymentError:
            raise RestoreError("restore_runtime_unavailable") from None
        _execute(
            runner,
            prefix,
            environment,
            ("pull", "mysql"),
            "restore_mysql_image_pull_failed",
        )
        _execute(
            runner,
            prefix,
            environment,
            ("up", "--detach", "--wait", "--wait-timeout", "180", "mysql"),
            "restore_mysql_start_failed",
        )
        table_count = _mysql_query(
            config,
            release,
            prefix,
            environment,
            "SELECT COUNT(*) FROM information_schema.tables "
            "WHERE table_schema = DATABASE()",
            runner,
        )
        if not re.fullmatch(r"[0-9]{1,9}", table_count) or int(table_count) != 0:
            raise RestoreError("restore_database_not_empty")
        target_mysql_version = _mysql_query(
            config, release, prefix, environment, "SELECT VERSION()", runner
        )
        if not _MYSQL_VERSION.fullmatch(target_mysql_version):
            raise RestoreError("restore_mysql_version_unsupported")
        snapshot = _snapshot_record(
            runner,
            policy,
            payload,
            repository=repository,
            credentials=credentials,
            snapshot_id=snapshot_id,
        )
        source = _verify_snapshot_tags(snapshot, source_environment)
        _restic_run(
            runner,
            policy,
            payload,
            ("restore", snapshot_id, "--target", "/backup-work/restore-output"),
            repository=repository,
            credentials=credentials,
            error_code="snapshot_restore_download_failed",
            workspace_read_only=False,
        )
        restored_payload = restore_output / "backup-work" / "payload"
        manifest, dump_path, source_runtime = _manifest_and_payload(
            restored_payload,
            source_environment=source,
            release=release,
        )
        snapshot_tags = set(snapshot["tags"])
        if (
            f"release:{manifest['release_id']}" not in snapshot_tags
            or f"build:{manifest['build_id']}" not in snapshot_tags
        ):
            raise RestoreError("snapshot_source_identity_mismatch")
        if (
            target_mysql_version.split("-")[0]
            != str(manifest["mysql_version"]).split("-")[0]
        ):
            raise RestoreError("restore_mysql_version_mismatch")
        owner_email, kek_version = _target_runtime(config)
        if (
            owner_email.casefold() != str(source_runtime["owner_email"]).casefold()
            or kek_version != int(source_runtime["local_key_kek_version"])
            or config.public_origin == source_runtime["public_origin"]
        ):
            raise RestoreError("restore_owner_or_key_version_mismatch")
        _install_source_keys(config, restored_payload)
        _import_sql(
            prefix,
            environment,
            dump_path,
            popen_factory=popen_factory,
        )
        _execute(
            runner,
            prefix,
            environment,
            ("run", "--rm", "--no-deps", "provision-users"),
            "restore_database_users_unavailable",
        )
        try:
            restored_revision = _current_revision(
                runner, prefix, environment, allow_uninitialized=False
            )
        except DeploymentError:
            raise RestoreError("restored_revision_unavailable") from None
        if restored_revision != manifest["alembic_revision"]:
            raise RestoreError("restored_revision_mismatch")
        completed = _utc_text(now or datetime.now(UTC))
        result = RestoreResult(
            snapshot_id=snapshot_id,
            source_environment=source,
            restored_revision=restored_revision,
            verified_dump_sha256=str(manifest["dump_sha256"]),
        )
        _write_private_json(
            config.state_dir / "restore-ready.json",
            {
                "snapshot_id": result.snapshot_id,
                "source_environment": result.source_environment,
                "restored_revision": result.restored_revision,
                "verified_dump_sha256": result.verified_dump_sha256,
                "completed_at": completed,
            },
        )
        return result
    except (BackupError, DeploymentError, OSError):
        raise RestoreError("restore_operation_failed") from None
    finally:
        try:
            _remove_payload(payload)
            _remove_payload(restore_output)
        finally:
            try:
                lock_path.unlink(missing_ok=True)
            except OSError:
                pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--release", type=Path)
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument(
        "--source-environment", choices=("staging", "production"), required=True
    )
    args = parser.parse_args(argv)
    try:
        config = load_deploy_config(args.config)
        release = load_release_manifest(
            args.release or _current_release_manifest(config)
        )
        policy = load_backup_policy(args.policy)
        result = restore_database(
            config,
            release,
            policy,
            snapshot_id=args.snapshot,
            source_environment=args.source_environment,
        )
    except (
        BackupError,
        BackupPolicyError,
        DeployConfigError,
        ReleaseManifestError,
        RestoreError,
        OSError,
        ValueError,
    ):
        print("restore_failed", file=sys.stderr)
        return 2
    print(
        json.dumps(
            {
                "status": "restore_imported",
                "snapshot_id": result.snapshot_id,
                "source_environment": result.source_environment,
                "restored_revision": result.restored_revision,
                "verified_dump_sha256": result.verified_dump_sha256,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
