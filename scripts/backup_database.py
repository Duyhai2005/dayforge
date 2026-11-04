"""Create a consistent, encrypted, secret-safe Dayforge database snapshot."""

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
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

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
    Runner,
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
_KEY_FILES = (
    "local_key_kek_b64",
    "logout_ticket_key_b64",
    "logout_ticket_previous_keys_b64",
    "auth_rate_limit_key_b64",
    "auth_email_outbox_key_b64",
    "sync_page_token_key_b64",
)


class BackupError(RuntimeError):
    """Safe backup failure containing only a stable error code."""


@dataclass(frozen=True, slots=True)
class BackupResult:
    snapshot_id: str
    completed_at: str
    dump_sha256: str
    source_revision: str


PopenFactory = Callable[..., subprocess.Popen[bytes]]


def _utc_text(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise BackupError("backup_clock_invalid")
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _secure_source_file(path: Path, *, required: bool = True) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        if required:
            raise BackupError("restore_secret_missing") from None
        return False
    except OSError:
        raise BackupError("restore_secret_unavailable") from None
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise BackupError("restore_secret_invalid")
    if os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o077:
        raise BackupError("restore_secret_permissions_invalid")
    return True


def _ensure_private_workspace(config: DeployConfig, policy: BackupPolicy) -> Path:
    root = policy.workspace_root
    state_dir = config.state_dir.resolve(strict=False)
    if root == state_dir or state_dir not in root.parents:
        raise BackupError("workspace_outside_state_directory")
    current = state_dir
    if not current.is_dir() or current.is_symlink():
        raise BackupError("state_directory_unavailable")
    for part in root.relative_to(state_dir).parts:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            try:
                current.mkdir(mode=0o700)
            except OSError:
                raise BackupError("workspace_directory_unavailable") from None
            info = current.lstat()
        except OSError:
            raise BackupError("workspace_directory_unavailable") from None
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise BackupError("workspace_directory_invalid")
        if os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o077:
            raise BackupError("workspace_permissions_invalid")
    return root


def _acquire_operation_lock(state_dir: Path) -> Path:
    lock_path = state_dir / "operation.lock"
    try:
        descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise BackupError("operation_already_running_or_lock_stale") from None
    except OSError:
        raise BackupError("operation_lock_unavailable") from None
    try:
        os.write(descriptor, f"pid={os.getpid()}\n".encode("ascii"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return lock_path


def _read_runtime_config(config: DeployConfig) -> tuple[dict[str, object], int]:
    path = config.secrets_dir.parent / "runtime.env"
    _secure_source_file(path)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        raise BackupError("runtime_configuration_unavailable") from None
    wanted = {"OWNER_EMAIL", "PUBLIC_ORIGIN", "LOCAL_KEY_KEK_VERSION"}
    values: dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator:
            continue
        key = key.strip()
        if key not in wanted:
            continue
        value = value.strip()
        if (
            key in values
            or not value
            or any(ord(character) < 32 for character in value)
        ):
            raise BackupError("runtime_configuration_invalid")
        values[key] = value
    if values.get("PUBLIC_ORIGIN") != config.public_origin:
        raise BackupError("runtime_origin_mismatch")
    owner_email = values.get("OWNER_EMAIL")
    try:
        key_version = int(values.get("LOCAL_KEY_KEK_VERSION", ""))
    except ValueError:
        raise BackupError("runtime_key_version_invalid") from None
    if (
        not owner_email
        or any(character.isspace() for character in owner_email)
        or key_version < 1
    ):
        raise BackupError("runtime_configuration_invalid")
    return (
        {
            "owner_email": owner_email,
            "public_origin": config.public_origin,
            "local_key_kek_version": key_version,
        },
        key_version,
    )


def _copy_restore_material(
    config: DeployConfig, payload: Path
) -> tuple[dict[str, object], int]:
    secret_target = payload / "restore-secrets"
    secret_target.mkdir(mode=0o700)
    for name in _KEY_FILES:
        source = config.secrets_dir / name
        present = _secure_source_file(
            source, required=name != "logout_ticket_previous_keys_b64"
        )
        destination = secret_target / name
        if present:
            shutil.copyfile(source, destination)
        else:
            destination.write_bytes(b"")
        os.chmod(destination, 0o600)
    runtime, key_version = _read_runtime_config(config)
    runtime_path = payload / "restore-runtime.json"
    _write_private_json(runtime_path, runtime)
    return runtime, key_version


def _write_private_json(path: Path, payload: object) -> None:
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
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
    except (OSError, UnicodeError, TypeError, ValueError):
        raise BackupError("private_payload_write_failed") from None


def _mysql_query(
    config: DeployConfig,
    release: ReleaseManifest,
    prefix: Sequence[str],
    environment: Mapping[str, str],
    query: str,
    runner: Runner,
) -> str:
    del config, release
    shell = (
        'set -eu; password="$(cat /run/secrets/mysql_root_password)"; '
        'MYSQL_PWD="$password" mysql --protocol=TCP -h127.0.0.1 -uroot '
        '--database="$MYSQL_DATABASE" --batch --skip-column-names --raw --execute "$1"'
    )
    return _execute(
        runner,
        prefix,
        environment,
        ("exec", "-T", "mysql", "sh", "-ec", shell, "dayforge-backup-query", query),
        "database_query_failed",
    )


def _mysql_engine_mismatches(
    config: DeployConfig,
    release: ReleaseManifest,
    prefix: Sequence[str],
    environment: Mapping[str, str],
    runner: Runner,
) -> int:
    output = _mysql_query(
        config,
        release,
        prefix,
        environment,
        "SELECT COUNT(*) FROM information_schema.tables "
        "WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' "
        "AND engine <> 'InnoDB'",
        runner,
    )
    if not re.fullmatch(r"[0-9]{1,9}", output):
        raise BackupError("database_engine_check_failed")
    return int(output)


def _mysql_version(
    config: DeployConfig,
    release: ReleaseManifest,
    prefix: Sequence[str],
    environment: Mapping[str, str],
    runner: Runner,
) -> str:
    version = _mysql_query(
        config, release, prefix, environment, "SELECT VERSION()", runner
    )
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?", version):
        raise BackupError("database_version_invalid")
    return version


def _mysqldump_script() -> str:
    return """set -eu
umask 077
defaults_file="$(mktemp /tmp/dayforge-mysqldump.XXXXXX)"
trap 'rm -f "$defaults_file"' EXIT HUP INT TERM
{ printf '[client]\\nuser=root\\npassword='; cat /run/secrets/mysql_root_password; printf '\\n'; } > "$defaults_file"
chmod 600 "$defaults_file"
mysqldump --defaults-extra-file="$defaults_file" --protocol=TCP --host=127.0.0.1 --single-transaction --quick --hex-blob --no-tablespaces --set-gtid-purged=OFF --skip-lock-tables "$MYSQL_DATABASE"
"""


def _write_dump(
    prefix: Sequence[str],
    environment: Mapping[str, str],
    destination: Path,
    *,
    popen_factory: PopenFactory,
) -> str:
    arguments = [
        *prefix,
        "exec",
        "-T",
        "mysql",
        "sh",
        "-ec",
        _mysqldump_script(),
        "dayforge-mysqldump",
    ]
    try:
        process = popen_factory(
            arguments,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=dict(environment),
        )
    except OSError:
        raise BackupError("mysqldump_unavailable") from None
    if process.stdout is None:
        process.kill()
        raise BackupError("mysqldump_output_unavailable")
    try:
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as raw:
            with gzip.GzipFile(
                fileobj=raw, mode="wb", filename="", mtime=0
            ) as compressed:
                while True:
                    chunk = process.stdout.read(1024 * 1024)
                    if not chunk:
                        break
                    compressed.write(chunk)
            raw.flush()
            os.fsync(raw.fileno())
        return_code = process.wait(timeout=1800)
    except (OSError, subprocess.TimeoutExpired):
        try:
            process.kill()
            process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            pass
        raise BackupError("mysqldump_failed") from None
    finally:
        try:
            process.stdout.close()
        except OSError:
            pass
    if return_code != 0 or destination.stat().st_size == 0:
        raise BackupError("mysqldump_failed")
    digest = hashlib.sha256()
    try:
        with destination.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        raise BackupError("dump_checksum_failed") from None
    return digest.hexdigest()


def _restic_image() -> str:
    path = Path(__file__).resolve().parents[1] / "deploy" / "images.lock.json"
    try:
        lock = json.loads(path.read_text(encoding="utf-8"))
        image = lock["images"]["restic"]
    except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError):
        raise BackupError("restic_image_lock_invalid") from None
    if not isinstance(image, str) or not re.fullmatch(
        r"[^\s@]+@sha256:[a-f0-9]{64}", image
    ):
        raise BackupError("restic_image_lock_invalid")
    return image


def _restic_command(
    policy: BackupPolicy,
    payload: Path,
    arguments: Sequence[str],
    *,
    repository: str,
    credentials: Mapping[str, str],
    workspace_read_only: bool = True,
) -> tuple[list[str], dict[str, str]]:
    if payload != policy.workspace_root / "payload" or not payload.is_dir():
        raise BackupError("workspace_payload_invalid")
    command = [
        "docker",
        "run",
        "--rm",
        "--read-only",
        "--user",
        "0:0",
        "--security-opt",
        "no-new-privileges:true",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=32m",
        "--env",
        "RESTIC_CACHE_DIR=/tmp/restic-cache",
        "--mount",
        f"type=bind,source={policy.workspace_root},target=/backup-work"
        + (",readonly" if workspace_read_only else ""),
        "--mount",
        f"type=bind,source={policy.password_file},target=/run/secrets/restic-password,readonly",
    ]
    restic_repository = repository
    if repository.startswith("local:"):
        host_path = Path(repository.removeprefix("local:")).resolve(strict=False)
        if (
            not host_path.is_absolute()
            or "," in str(host_path)
            or host_path == policy.workspace_root
            or policy.workspace_root in host_path.parents
            or host_path in policy.workspace_root.parents
        ):
            raise BackupError("local_repository_path_invalid")
        if not host_path.is_dir():
            raise BackupError("local_repository_unavailable")
        command.extend(
            ("--mount", f"type=bind,source={host_path},target=/backup-repository")
        )
        restic_repository = "/backup-repository"
    for key in credentials:
        command.extend(("--env", key))
    command.extend(
        (
            _restic_image(),
            "--repo",
            restic_repository,
            "--password-file",
            "/run/secrets/restic-password",
            *arguments,
        )
    )
    host_environment = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", ""),
        **credentials,
    }
    return command, host_environment


def _restic_run(
    runner: Runner,
    policy: BackupPolicy,
    payload: Path,
    arguments: Sequence[str],
    *,
    repository: str,
    credentials: Mapping[str, str],
    error_code: str,
    workspace_read_only: bool = True,
) -> subprocess.CompletedProcess[str]:
    command, environment = _restic_command(
        policy,
        payload,
        arguments,
        repository=repository,
        credentials=credentials,
        workspace_read_only=workspace_read_only,
    )
    try:
        if runner is _run:
            result = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=4 * 60 * 60,
                env=environment,
            )
        else:
            result = runner(command, environment)
    except (OSError, subprocess.SubprocessError):
        raise BackupError(error_code) from None
    if result.returncode != 0:
        raise BackupError(error_code)
    return result


def _summary_snapshot_id(output: str) -> str:
    try:
        summaries = [
            item
            for line in output.splitlines()
            if (item := json.loads(line)).get("message_type") == "summary"
        ]
        snapshot_id = summaries[-1]["snapshot_id"]
    except (json.JSONDecodeError, KeyError, TypeError, IndexError, AttributeError):
        raise BackupError("restic_snapshot_unconfirmed") from None
    if not isinstance(snapshot_id, str) or not _SNAPSHOT_ID.fullmatch(snapshot_id):
        raise BackupError("restic_snapshot_unconfirmed")
    return snapshot_id


def _verify_snapshot(
    runner: Runner,
    policy: BackupPolicy,
    payload: Path,
    *,
    repository: str,
    credentials: Mapping[str, str],
    snapshot_id: str,
    environment: str,
    release: ReleaseManifest,
) -> None:
    result = _restic_run(
        runner,
        policy,
        payload,
        ("snapshots", "--json", snapshot_id),
        repository=repository,
        credentials=credentials,
        error_code="restic_snapshot_lookup_failed",
    )
    try:
        records = json.loads(result.stdout)
        match = next(item for item in records if item.get("id") == snapshot_id)
        tags = set(match["tags"])
    except (json.JSONDecodeError, TypeError, KeyError, StopIteration):
        raise BackupError("restic_snapshot_lookup_failed") from None
    expected = {
        f"environment:{environment}",
        "kind:database",
        f"release:{release.release_id}",
        f"build:{release.build_id}",
    }
    if not expected.issubset(tags):
        raise BackupError("restic_snapshot_metadata_mismatch")


def _remove_payload(path: Path) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    except OSError:
        raise BackupError("workspace_cleanup_failed") from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise BackupError("workspace_cleanup_invalid")
    try:
        shutil.rmtree(path)
    except OSError:
        raise BackupError("workspace_cleanup_failed") from None


def _write_success_marker(
    state_dir: Path, result: BackupResult, release: ReleaseManifest, environment: str
) -> None:
    payload = {
        "completed_at": result.completed_at,
        "snapshot_id": result.snapshot_id,
        "dump_sha256": result.dump_sha256,
        "source_revision": result.source_revision,
        "release_id": release.release_id,
        "build_id": release.build_id,
        "environment": environment,
    }
    temporary = state_dir / f".last-backup-{uuid4().hex}.tmp"
    marker = state_dir / "last-backup.json"
    try:
        enabled = state_dir / "backup.enabled"
        if not enabled.exists():
            descriptor = os.open(enabled, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(descriptor)
        _write_private_json(temporary, payload)
        os.replace(temporary, marker)
        if os.name != "nt":
            descriptor = os.open(state_dir, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    except BackupError:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    except OSError:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise BackupError("success_marker_write_failed") from None


def create_backup(
    config: DeployConfig,
    release: ReleaseManifest,
    policy: BackupPolicy,
    *,
    env_file: Path | None = None,
    compose_file: Path | None = None,
    runner: Runner = _run,
    popen_factory: PopenFactory = subprocess.Popen,
    now: datetime | None = None,
) -> BackupResult:
    """Dump one source environment and publish only a verified restic snapshot."""
    if config.environment not in {"staging", "production"}:
        raise BackupError("backup_environment_not_allowed")
    if release.platform != config.platform:
        raise BackupError("release_platform_mismatch")
    if not config.state_dir.is_dir():
        raise BackupError("state_directory_unavailable")
    workspace = _ensure_private_workspace(config, policy)
    repository = validate_restic_files(policy)
    credentials = read_restic_environment(policy)
    if config.environment == "production" and repository.startswith("local:"):
        raise BackupError("production_repository_must_be_off_host")
    payload = workspace / "payload"
    lock_path = _acquire_operation_lock(config.state_dir)
    try:
        _remove_payload(payload)
        payload.mkdir(mode=0o700)
        secret_payload = payload / "restore-secrets"
        started = now or datetime.now(UTC)
        started_text = _utc_text(started)
        _, kek_version = _copy_restore_material(config, payload)
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
            raise BackupError("runtime_configuration_unavailable") from None
        try:
            revision_before = _current_revision(
                runner, prefix, environment, allow_uninitialized=False
            )
        except DeploymentError:
            raise BackupError("source_revision_unavailable") from None
        if revision_before is None or not _REVISION.fullmatch(revision_before):
            raise BackupError("source_revision_invalid")
        if _mysql_engine_mismatches(config, release, prefix, environment, runner):
            raise BackupError("database_contains_non_innodb_table")
        mysql_version = _mysql_version(config, release, prefix, environment, runner)
        dump_path = payload / "database.sql.gz"
        dump_sha256 = _write_dump(
            prefix, environment, dump_path, popen_factory=popen_factory
        )
        dumped_at = datetime.now(UTC)
        try:
            revision_after = _current_revision(
                runner, prefix, environment, allow_uninitialized=False
            )
        except DeploymentError:
            raise BackupError("source_revision_recheck_failed") from None
        if revision_after != revision_before:
            raise BackupError("source_revision_changed_during_dump")
        manifest = {
            "format_version": 1,
            "source_environment": config.environment,
            "release_id": release.release_id,
            "build_id": release.build_id,
            "git_sha": release.git_sha,
            "mysql_version": mysql_version,
            "alembic_revision": revision_before,
            "dump_started_at": started_text,
            "dump_completed_at": _utc_text(dumped_at),
            "dump_sha256": dump_sha256,
            "key_versions": {
                "local_key_kek": kek_version,
                "auth_email_outbox": 1,
            },
            "restore_secret_files": list(_KEY_FILES),
            "runtime_config_file": "restore-runtime.json",
        }
        _write_private_json(payload / "backup-manifest.json", manifest)
        if not secret_payload.is_dir():
            raise BackupError("restore_payload_invalid")

        restic_tags = (
            "backup",
            "--json",
            "--host",
            f"dayforge-{config.environment}",
            "--tag",
            f"environment:{config.environment}",
            "--tag",
            "kind:database",
            "--tag",
            f"release:{release.release_id}",
            "--tag",
            f"build:{release.build_id}",
            "/backup-work/payload",
        )
        result = _restic_run(
            runner,
            policy,
            payload,
            restic_tags,
            repository=repository,
            credentials=credentials,
            error_code="restic_backup_failed",
        )
        snapshot_id = _summary_snapshot_id(result.stdout)
        _verify_snapshot(
            runner,
            policy,
            payload,
            repository=repository,
            credentials=credentials,
            snapshot_id=snapshot_id,
            environment=config.environment,
            release=release,
        )
        _remove_payload(payload)
        completed_at = _utc_text(datetime.now(UTC))
        backup_result = BackupResult(
            snapshot_id=snapshot_id,
            completed_at=completed_at,
            dump_sha256=dump_sha256,
            source_revision=revision_before,
        )
        _write_success_marker(
            config.state_dir, backup_result, release, config.environment
        )
        return backup_result
    finally:
        try:
            _remove_payload(payload)
        finally:
            try:
                lock_path.unlink(missing_ok=True)
            except OSError:
                pass


def maintain_backup_repository(
    config: DeployConfig,
    policy: BackupPolicy,
    *,
    runner: Runner = _run,
) -> None:
    """Check a repository before pruning only this environment's tagged backups."""
    if config.environment not in {"staging", "production"}:
        raise BackupError("backup_environment_not_allowed")
    workspace = _ensure_private_workspace(config, policy)
    repository = validate_restic_files(policy)
    credentials = read_restic_environment(policy)
    if config.environment == "production" and repository.startswith("local:"):
        raise BackupError("production_repository_must_be_off_host")
    payload = workspace / "payload"
    lock_path = _acquire_operation_lock(config.state_dir)
    try:
        _remove_payload(payload)
        payload.mkdir(mode=0o700)
        snapshots = _restic_run(
            runner,
            policy,
            payload,
            ("snapshots", "--json"),
            repository=repository,
            credentials=credentials,
            error_code="restic_snapshots_unavailable",
        )
        try:
            records = json.loads(snapshots.stdout)
        except (json.JSONDecodeError, TypeError):
            raise BackupError("restic_snapshots_unavailable") from None
        required_tags = {f"environment:{config.environment}", "kind:database"}
        if not isinstance(records, list) or not any(
            isinstance(item, dict)
            and isinstance(item.get("tags"), list)
            and required_tags.issubset(set(item["tags"]))
            for item in records
        ):
            raise BackupError("restic_environment_snapshot_missing")
        check = _restic_run(
            runner,
            policy,
            payload,
            ("check", "--json", "--read-data-subset=1/50"),
            repository=repository,
            credentials=credentials,
            error_code="restic_repository_check_failed",
        )
        try:
            summaries = [
                item
                for line in check.stdout.splitlines()
                if (item := json.loads(line)).get("message_type") == "summary"
            ]
            error_count = summaries[-1]["num_errors"]
        except (json.JSONDecodeError, TypeError, KeyError, IndexError, AttributeError):
            raise BackupError("restic_repository_check_unconfirmed") from None
        if type(error_count) is not int or error_count != 0:
            raise BackupError("restic_repository_check_failed")
        tag_filter = f"environment:{config.environment},kind:database"
        retention = (
            "--group-by",
            "host,paths",
            "--tag",
            tag_filter,
            "--keep-daily",
            str(policy.keep_daily),
            "--keep-weekly",
            str(policy.keep_weekly),
            "--keep-monthly",
            str(policy.keep_monthly),
        )
        preview = _restic_run(
            runner,
            policy,
            payload,
            ("forget", "--json", "--dry-run", *retention),
            repository=repository,
            credentials=credentials,
            error_code="restic_retention_preview_failed",
        )
        required_tags = set(tag_filter.split(","))
        try:
            groups = json.loads(preview.stdout)
            if not isinstance(groups, list) or not groups:
                raise ValueError
            for group in groups:
                if (
                    not isinstance(group, dict)
                    or not isinstance(group.get("tags"), list)
                    or not required_tags.issubset(set(group["tags"]))
                    or not isinstance(group.get("keep"), list)
                    or not isinstance(group.get("remove"), list)
                ):
                    raise ValueError
        except (json.JSONDecodeError, TypeError, ValueError):
            raise BackupError("restic_retention_preview_unconfirmed") from None
        _restic_run(
            runner,
            policy,
            payload,
            (
                "forget",
                *retention,
                "--prune",
            ),
            repository=repository,
            credentials=credentials,
            error_code="restic_retention_failed",
        )
    finally:
        try:
            _remove_payload(payload)
        finally:
            try:
                lock_path.unlink(missing_ok=True)
            except OSError:
                pass


def initialize_backup_repository(
    config: DeployConfig,
    policy: BackupPolicy,
    *,
    runner: Runner = _run,
) -> None:
    """Initialize an empty encrypted repository once; never reset an existing one."""
    if config.environment not in {"staging", "production"}:
        raise BackupError("backup_environment_not_allowed")
    workspace = _ensure_private_workspace(config, policy)
    repository = validate_restic_files(policy)
    credentials = read_restic_environment(policy)
    if config.environment == "production" and repository.startswith("local:"):
        raise BackupError("production_repository_must_be_off_host")
    payload = workspace / "payload"
    lock_path = _acquire_operation_lock(config.state_dir)
    try:
        _remove_payload(payload)
        payload.mkdir(mode=0o700)
        _restic_run(
            runner,
            policy,
            payload,
            ("init",),
            repository=repository,
            credentials=credentials,
            error_code="restic_repository_init_failed",
        )
    finally:
        try:
            _remove_payload(payload)
        finally:
            try:
                lock_path.unlink(missing_ok=True)
            except OSError:
                pass


def _current_release_manifest(config: DeployConfig) -> Path:
    record_path = config.state_dir / "current-release.json"
    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
        release_id = record["release_id"]
    except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError):
        raise BackupError("current_release_unavailable") from None
    if not isinstance(release_id, str) or not re.fullmatch(
        r"[A-Za-z0-9._-]{1,128}", release_id
    ):
        raise BackupError("current_release_invalid")
    if len(config.state_dir.parents) < 2:
        raise BackupError("release_directory_invalid")
    return config.state_dir.parents[1] / "releases" / release_id / "release.json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--release", type=Path)
    parser.add_argument("--policy", type=Path, required=True)
    repository_action = parser.add_mutually_exclusive_group()
    repository_action.add_argument("--check-repository", action="store_true")
    repository_action.add_argument("--initialize-repository", action="store_true")
    args = parser.parse_args(argv)
    try:
        config = load_deploy_config(args.config)
        policy = load_backup_policy(args.policy)
        if args.check_repository:
            maintain_backup_repository(config, policy)
            print("backup_repository_ok")
            return 0
        if args.initialize_repository:
            initialize_backup_repository(config, policy)
            print("backup_repository_initialized")
            return 0
        release = load_release_manifest(
            args.release or _current_release_manifest(config)
        )
        result = create_backup(config, release, policy)
    except (
        BackupError,
        BackupPolicyError,
        DeployConfigError,
        ReleaseManifestError,
        OSError,
        ValueError,
    ):
        print("backup_failed", file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "status": "backup_ok",
                "snapshot_id": result.snapshot_id,
                "completed_at": result.completed_at,
                "dump_sha256": result.dump_sha256,
                "source_revision": result.source_revision,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
