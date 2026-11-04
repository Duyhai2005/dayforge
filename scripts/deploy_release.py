"""Sequence a staging/restore release with explicit migration and smoke gates."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from scripts.check_release_compatibility import (
    RuntimeCompatibility,
    RuntimeCompatibilityError,
    check_release_compatibility,
    load_runtime_compatibility,
)
from scripts.deploy_config import DeployConfig, DeployConfigError, load_deploy_config
from scripts.release_manifest import (
    ReleaseManifest,
    ReleaseManifestError,
    load_release_manifest,
)
from scripts.smoke_deploy import SmokeDeploymentError, smoke_deployment

_REVISION_LINE = re.compile(r"(?m)^([A-Za-z0-9_-]{1,64})(?:\s+\(head\))?\s*$")
_BACKUP_MAX_AGE = timedelta(hours=26)


class DeploymentError(RuntimeError):
    """A safe deployment failure containing only a fixed stage/error code."""


@dataclass(frozen=True, slots=True)
class DeploymentResult:
    release_id: str
    migrated_revision: str
    healthy: bool


Runner = Callable[[Sequence[str], Mapping[str, str]], subprocess.CompletedProcess[str]]


def _run(
    arguments: Sequence[str], environment: Mapping[str, str]
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            list(arguments),
            check=False,
            capture_output=True,
            text=True,
            timeout=300,
            env=dict(environment),
        )
    except OSError, subprocess.TimeoutExpired:
        raise DeploymentError("command_unavailable_or_timed_out") from None


def _docker_environment(
    manifest: ReleaseManifest,
    previous_web_image: str | None = None,
) -> dict[str, str]:
    allowed = {
        key: os.environ[key]
        for key in (
            "PATH",
            "HOME",
            "DOCKER_CONFIG",
            "DOCKER_HOST",
            "DOCKER_CONTEXT",
            "SSH_AUTH_SOCK",
            "XDG_RUNTIME_DIR",
        )
        if key in os.environ
    }
    allowed.update(
        WEB_IMAGE=manifest.web_image,
        API_IMAGE=manifest.api_image,
        MYSQL_IMAGE=manifest.mysql_image,
    )
    if previous_web_image is not None:
        allowed.update(
            WEB_PREVIOUS_IMAGE=previous_web_image,
            COMPOSE_PROFILES="previous-static",
        )
    return allowed


def _compose_prefix(
    config: DeployConfig,
    manifest: ReleaseManifest,
    env_file: Path,
    compose_file: Path,
    *,
    previous_web_image: str | None = None,
) -> tuple[list[str], dict[str, str]]:
    if not env_file.is_file() or not compose_file.is_file():
        raise DeploymentError("runtime_configuration_missing")
    environment = _docker_environment(manifest, previous_web_image)
    environment.update(
        COMPOSE_PROJECT=config.compose_project,
        DEPLOYMENT_ENV=config.environment,
        APP_ENV="production",
        PUBLIC_ORIGIN=config.public_origin,
        DB_NAME=config.db_name,
        SECRETS_DIR=str(config.secrets_dir),
        APP_SUBNET=config.app_subnet,
        EDGE_ALIAS=config.edge_alias,
    )
    return (
        [
            "docker",
            "compose",
            "--env-file",
            str(env_file),
            "--file",
            str(compose_file),
            "--project-name",
            config.compose_project,
        ],
        environment,
    )


def _execute(
    runner: Runner,
    prefix: Sequence[str],
    environment: Mapping[str, str],
    arguments: Sequence[str],
    error_code: str,
) -> str:
    result = runner([*prefix, *arguments], environment)
    if result.returncode:
        raise DeploymentError(error_code)
    return result.stdout.strip()


def _database_table_count(
    runner: Runner,
    prefix: Sequence[str],
    environment: Mapping[str, str],
) -> int:
    # The password remains in the mounted secret and is read inside the MySQL container.
    shell = (
        'export MYSQL_PWD="$(cat /run/secrets/mysql_root_password)"; '
        'exec mysql --protocol=TCP -h127.0.0.1 -uroot --database="$MYSQL_DATABASE" '
        '--batch --skip-column-names --execute="SELECT COUNT(*) FROM information_schema.tables '
        'WHERE table_schema = DATABASE()"'
    )
    output = _execute(
        runner,
        prefix,
        environment,
        ("exec", "-T", "mysql", "sh", "-c", shell),
        "database_identity_check_failed",
    )
    if not re.fullmatch(r"[0-9]{1,9}", output):
        raise DeploymentError("database_identity_check_failed")
    return int(output)


def _current_revision(
    runner: Runner,
    prefix: Sequence[str],
    environment: Mapping[str, str],
    *,
    allow_uninitialized: bool,
) -> str | None:
    try:
        output = _execute(
            runner,
            prefix,
            environment,
            ("run", "--rm", "--no-deps", "migrate", "current"),
            "database_revision_check_failed",
        )
    except DeploymentError:
        if allow_uninitialized:
            return None
        raise
    revisions = _REVISION_LINE.findall(output)
    if not revisions:
        return None
    if len(set(revisions)) != 1:
        raise DeploymentError("database_revision_ambiguous")
    return revisions[0]


def _backup_is_recent(state_dir: Path, now: datetime) -> bool:
    if not (state_dir / "backup.enabled").is_file():
        return False
    try:
        record = json.loads(
            (state_dir / "last-backup.json").read_text(encoding="utf-8")
        )
        timestamp = datetime.fromisoformat(
            record["completed_at"].replace("Z", "+00:00")
        )
        if timestamp.tzinfo is None:
            return False
    except (
        OSError,
        UnicodeError,
        json.JSONDecodeError,
        KeyError,
        TypeError,
        AttributeError,
        ValueError,
    ):
        return False
    age = now.astimezone(timezone.utc) - timestamp.astimezone(timezone.utc)
    return timedelta(0) <= age <= _BACKUP_MAX_AGE


def _write_current_release(
    state_dir: Path, manifest: ReleaseManifest, revision: str
) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    destination = state_dir / "current-release.json"
    temporary = state_dir / f".current-release-{os.getpid()}.tmp"
    payload = {
        "release_id": manifest.release_id,
        "git_sha": manifest.git_sha,
        "build_id": manifest.build_id,
        "database_revision": revision,
        "recorded_at": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
    }
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    except OSError:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise DeploymentError("release_record_write_failed") from None


def _set_maintenance(directory: Path, enabled: bool) -> None:
    marker = directory / "on"
    try:
        if enabled:
            descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT, 0o644)
            os.close(descriptor)
        else:
            marker.unlink(missing_ok=True)
    except OSError:
        raise DeploymentError("maintenance_gate_unavailable") from None


def _internal_smoke(
    runner: Runner,
    prefix: Sequence[str],
    environment: Mapping[str, str],
    build_id: str,
) -> None:
    script = (
        "const paths=['/work','/milestones','/sw.js','/dayforge-build.json','/api/v1/health','/api/v1/version'];"
        "const expected=process.argv[1];"
        "const check=async()=>{for(const path of paths){const r=await fetch('http://127.0.0.1:3000'+path,"
        "{redirect:'manual',cache:'no-store'});if(r.status!==200)throw Error('status');"
        "if(path.startsWith('/api/')){const d=await r.json();"
        "if(path.endsWith('/health')&&d.status!=='ok')throw Error('health');"
        "if(path.endsWith('/version')&&(JSON.stringify(d.protocol_versions)!=='[1]'||JSON.stringify(d.reducer_versions)!=='[1]'))throw Error('version');"
        "}else if(r.headers.get('x-dayforge-build')!==expected)throw Error('build');"
        "if(path==='/dayforge-build.json'){const d=await r.json();if(d.build_id!==expected||d.protocol_version!==1)throw Error('manifest');}}};"
        "check().then(()=>process.stdout.write('internal_smoke_ok')).catch(()=>process.exit(1));"
    )
    _execute(
        runner,
        prefix,
        environment,
        ("exec", "-T", "web", "node", "-e", script, "--", build_id),
        "candidate_internal_smoke_failed",
    )


def deploy_release(
    config: DeployConfig,
    release: ReleaseManifest,
    *,
    initialize: bool = False,
    previous_release: ReleaseManifest | None = None,
    env_file: Path | None = None,
    compose_file: Path | None = None,
    runner: Runner = _run,
    now: datetime | None = None,
    smoke: Callable[[str, str], object] | None = None,
) -> DeploymentResult:
    """Deploy an immutable image set to an isolated staging or restore target."""
    if config.environment not in {"staging", "restore"}:
        raise DeploymentError("environment_not_allowed")
    if release.platform != config.platform:
        raise DeploymentError("release_platform_mismatch")
    if release.required_db_revision not in release.supported_db_revisions:
        raise DeploymentError("release_database_contract_invalid")
    if previous_release is not None and (
        previous_release.platform != config.platform
        or previous_release.release_id == release.release_id
        or previous_release.mysql_image != release.mysql_image
    ):
        raise DeploymentError("previous_release_invalid")
    if initialize and config.environment not in {"staging", "restore"}:
        raise DeploymentError("initialize_environment_not_allowed")
    state_dir = config.state_dir
    if not state_dir.is_dir():
        raise DeploymentError("state_directory_missing")
    maintenance_dir = state_dir / "edge-maintenance"
    if not maintenance_dir.is_dir():
        raise DeploymentError("maintenance_gate_unavailable")
    env_path = env_file or config.secrets_dir.parent / "runtime.env"
    compose_path = (
        compose_file
        or Path(__file__).resolve().parents[1] / "deploy" / "compose.app.yaml"
    )
    prefix, environment = _compose_prefix(
        config,
        release,
        env_path,
        compose_path,
        previous_web_image=previous_release.web_image if previous_release else None,
    )

    lock_path = state_dir / "operation.lock"
    try:
        lock_descriptor = os.open(
            lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
        )
    except FileExistsError:
        raise DeploymentError("deployment_already_running_or_lock_stale") from None
    except OSError:
        raise DeploymentError("operation_lock_unavailable") from None

    try:
        current_record = state_dir / "current-release.json"
        instant = now or datetime.now(timezone.utc)
        if instant.tzinfo is None or instant.utcoffset() is None:
            raise DeploymentError("deployment_clock_invalid")
        existing_tables: int | None = None
        # Pull only the three services pinned by the release manifest.
        _execute(
            runner,
            prefix,
            environment,
            (
                "pull",
                "mysql",
                "api",
                "web",
                *(("web_previous",) if previous_release else ()),
            ),
            "image_pull_failed",
        )
        _execute(
            runner,
            prefix,
            environment,
            ("up", "-d", "--wait", "--wait-timeout", "180", "mysql"),
            "database_start_failed",
        )
        _execute(
            runner,
            prefix,
            environment,
            ("run", "--rm", "--no-deps", "provision-users"),
            "database_principal_setup_failed",
        )
        existing_tables = _database_table_count(runner, prefix, environment)
        current = _current_revision(
            runner,
            prefix,
            environment,
            allow_uninitialized=initialize and existing_tables == 0,
        )

        if initialize:
            if current_record.exists() or existing_tables != 0 or current is not None:
                raise DeploymentError("initialize_requires_empty_unmanaged_target")
        else:
            if current_record.is_file() is False:
                raise DeploymentError("existing_target_record_missing")
            if (
                existing_tables == 0
                or current is None
                or current not in release.supported_db_revisions
            ):
                raise DeploymentError("database_revision_unsupported")
            if not _backup_is_recent(state_dir, instant):
                raise DeploymentError("recent_backup_required")

        _set_maintenance(maintenance_dir, True)
        _execute(runner, prefix, environment, ("stop", "api"), "api_stop_failed")
        _execute(
            runner,
            prefix,
            environment,
            ("run", "--rm", "--no-deps", "migrate", "upgrade", "head"),
            "migration_failed",
        )
        migrated = _current_revision(
            runner, prefix, environment, allow_uninitialized=False
        )
        if migrated != release.required_db_revision:
            raise DeploymentError("database_revision_mismatch")
        _execute(
            runner,
            prefix,
            environment,
            ("up", "-d", "--wait", "--wait-timeout", "180", "api", "web"),
            "runtime_start_failed",
        )
        _internal_smoke(runner, prefix, environment, release.build_id)
        _set_maintenance(maintenance_dir, False)
        try:
            (smoke or smoke_deployment)(config.public_origin, release.build_id)
        except SmokeDeploymentError, OSError, TimeoutError, ValueError:
            _set_maintenance(maintenance_dir, True)
            raise DeploymentError("post_deploy_smoke_failed") from None
        try:
            _write_current_release(state_dir, release, migrated)
        except DeploymentError:
            _set_maintenance(maintenance_dir, True)
            raise
        return DeploymentResult(
            release_id=release.release_id, migrated_revision=migrated, healthy=True
        )
    finally:
        os.close(lock_descriptor)
        try:
            lock_path.unlink(missing_ok=True)
        except OSError:
            pass


def rollback_release(
    config: DeployConfig,
    current_release: ReleaseManifest,
    target_release: ReleaseManifest,
    runtime: RuntimeCompatibility,
    *,
    env_file: Path | None = None,
    compose_file: Path | None = None,
    runner: Runner = _run,
    now: datetime | None = None,
    smoke: Callable[[str, str], object] | None = None,
) -> DeploymentResult:
    """Switch back to a compatible binary release without changing the database."""
    if config.environment not in {"staging", "restore"}:
        raise DeploymentError("environment_not_allowed")
    if (
        current_release.platform != config.platform
        or target_release.platform != config.platform
    ):
        raise DeploymentError("release_platform_mismatch")
    if current_release.release_id == target_release.release_id:
        raise DeploymentError("rollback_release_unchanged")
    if target_release.required_db_revision not in target_release.supported_db_revisions:
        raise DeploymentError("release_database_contract_invalid")
    if not check_release_compatibility(target_release, runtime).allowed:
        raise DeploymentError("rollback_incompatible")

    state_dir = config.state_dir
    if not state_dir.is_dir():
        raise DeploymentError("state_directory_missing")
    maintenance_dir = state_dir / "edge-maintenance"
    if not maintenance_dir.is_dir():
        raise DeploymentError("maintenance_gate_unavailable")
    env_path = env_file or config.secrets_dir.parent / "runtime.env"
    compose_path = (
        compose_file
        or Path(__file__).resolve().parents[1] / "deploy" / "compose.app.yaml"
    )
    if not env_path.is_file() or not compose_path.is_file():
        raise DeploymentError("runtime_configuration_missing")

    current_record = state_dir / "current-release.json"
    try:
        recorded = json.loads(current_record.read_text(encoding="utf-8"))
    except OSError, UnicodeError, json.JSONDecodeError:
        raise DeploymentError("existing_target_record_invalid") from None
    if not isinstance(recorded, dict) or any(
        recorded.get(field) != getattr(current_release, field)
        for field in ("release_id", "git_sha", "build_id")
    ):
        raise DeploymentError("current_release_record_mismatch")

    instant = now or datetime.now(timezone.utc)
    if instant.tzinfo is None or instant.utcoffset() is None:
        raise DeploymentError("deployment_clock_invalid")
    if not _backup_is_recent(state_dir, instant):
        raise DeploymentError("recent_backup_required")

    current_prefix, current_environment = _compose_prefix(
        config, current_release, env_path, compose_path
    )
    target_prefix, target_environment = _compose_prefix(
        config,
        target_release,
        env_path,
        compose_path,
        previous_web_image=current_release.web_image,
    )
    # Keep the database server binary at the version already running with B.
    target_environment["MYSQL_IMAGE"] = current_release.mysql_image

    lock_path = state_dir / "operation.lock"
    try:
        lock_descriptor = os.open(
            lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
        )
    except FileExistsError:
        raise DeploymentError("deployment_already_running_or_lock_stale") from None
    except OSError:
        raise DeploymentError("operation_lock_unavailable") from None

    maintenance_started = False
    try:
        _execute(
            runner,
            current_prefix,
            current_environment,
            ("up", "-d", "--wait", "--wait-timeout", "180", "mysql"),
            "database_start_failed",
        )
        if _database_table_count(runner, current_prefix, current_environment) == 0:
            raise DeploymentError("database_identity_check_failed")
        actual_revision = _current_revision(
            runner,
            current_prefix,
            current_environment,
            allow_uninitialized=False,
        )
        if actual_revision is None or actual_revision != runtime.db_revision:
            raise DeploymentError("runtime_database_revision_mismatch")
        if actual_revision not in current_release.supported_db_revisions:
            raise DeploymentError("current_database_revision_unsupported")
        if actual_revision not in target_release.supported_db_revisions:
            raise DeploymentError("rollback_incompatible")

        _execute(
            runner,
            target_prefix,
            target_environment,
            ("pull", "api", "web", "web_previous"),
            "image_pull_failed",
        )
        _set_maintenance(maintenance_dir, True)
        maintenance_started = True
        try:
            _execute(
                runner,
                current_prefix,
                current_environment,
                ("stop", "api"),
                "api_stop_failed",
            )
            _execute(
                runner,
                target_prefix,
                target_environment,
                ("up", "-d", "--wait", "--wait-timeout", "180", "api", "web"),
                "runtime_start_failed",
            )
            _internal_smoke(
                runner, target_prefix, target_environment, target_release.build_id
            )
            _set_maintenance(maintenance_dir, False)
            maintenance_started = False
            try:
                (smoke or smoke_deployment)(
                    config.public_origin, target_release.build_id
                )
            except SmokeDeploymentError, OSError, TimeoutError, ValueError:
                _set_maintenance(maintenance_dir, True)
                maintenance_started = True
                raise DeploymentError("post_deploy_smoke_failed") from None
            _write_current_release(state_dir, target_release, actual_revision)
            return DeploymentResult(
                release_id=target_release.release_id,
                migrated_revision=actual_revision,
                healthy=True,
            )
        except (
            DeploymentError,
            SmokeDeploymentError,
            OSError,
            TimeoutError,
            ValueError,
        ):
            if not maintenance_started:
                _set_maintenance(maintenance_dir, True)
                maintenance_started = True
            try:
                _execute(
                    runner,
                    current_prefix,
                    current_environment,
                    ("up", "-d", "--wait", "--wait-timeout", "180", "api", "web"),
                    "previous_release_restore_failed",
                )
                _internal_smoke(
                    runner,
                    current_prefix,
                    current_environment,
                    current_release.build_id,
                )
                (smoke or smoke_deployment)(
                    config.public_origin, current_release.build_id
                )
                _set_maintenance(maintenance_dir, False)
                maintenance_started = False
            except (
                DeploymentError,
                SmokeDeploymentError,
                OSError,
                TimeoutError,
                ValueError,
            ):
                if not maintenance_started:
                    _set_maintenance(maintenance_dir, True)
                raise DeploymentError("rollback_failed_maintenance_required") from None
            raise DeploymentError(
                "rollback_candidate_failed_previous_restored"
            ) from None
    finally:
        os.close(lock_descriptor)
        try:
            lock_path.unlink(missing_ok=True)
        except OSError:
            pass


def activate_restored_release(
    config: DeployConfig,
    release: ReleaseManifest,
    *,
    snapshot_id: str,
    env_file: Path | None = None,
    compose_file: Path | None = None,
    runner: Runner = _run,
    now: datetime | None = None,
    smoke: Callable[[str, str], object] | None = None,
) -> DeploymentResult:
    """Start a verified restore without running migrations or changing its DB."""
    if config.environment != "restore":
        raise DeploymentError("restore_environment_required")
    if release.platform != config.platform:
        raise DeploymentError("release_platform_mismatch")
    if not re.fullmatch(r"[a-f0-9]{64}", snapshot_id):
        raise DeploymentError("restore_snapshot_id_invalid")
    state_dir = config.state_dir
    ready_path = state_dir / "restore-ready.json"
    try:
        ready_info = ready_path.lstat()
        if not ready_info or ready_path.is_symlink() or not ready_path.is_file():
            raise DeploymentError("restore_ready_record_invalid")
        ready = json.loads(ready_path.read_text(encoding="utf-8"))
    except DeploymentError:
        raise
    except OSError, UnicodeError, json.JSONDecodeError:
        raise DeploymentError("restore_ready_record_invalid") from None
    if (
        not isinstance(ready, dict)
        or ready.get("snapshot_id") != snapshot_id
        or ready.get("restored_revision") != release.required_db_revision
        or ready.get("restored_revision") not in release.supported_db_revisions
        or not re.fullmatch(r"[a-f0-9]{64}", str(ready.get("verified_dump_sha256", "")))
    ):
        raise DeploymentError("restore_ready_record_mismatch")
    if (state_dir / "current-release.json").exists() or (
        state_dir / "current-release.json"
    ).is_symlink():
        raise DeploymentError("restore_target_already_activated")
    maintenance_dir = state_dir / "edge-maintenance"
    if not maintenance_dir.is_dir() or maintenance_dir.is_symlink():
        raise DeploymentError("maintenance_gate_unavailable")
    instant = now or datetime.now(timezone.utc)
    if instant.tzinfo is None or instant.utcoffset() is None:
        raise DeploymentError("deployment_clock_invalid")
    env_path = env_file or config.secrets_dir.parent / "runtime.env"
    compose_path = (
        compose_file
        or Path(__file__).resolve().parents[1] / "deploy" / "compose.app.yaml"
    )
    prefix, environment = _compose_prefix(config, release, env_path, compose_path)
    lock_path = state_dir / "operation.lock"
    try:
        lock_descriptor = os.open(
            lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
        )
    except FileExistsError:
        raise DeploymentError("deployment_already_running_or_lock_stale") from None
    except OSError:
        raise DeploymentError("operation_lock_unavailable") from None
    try:
        _execute(
            runner,
            prefix,
            environment,
            ("up", "-d", "--wait", "--wait-timeout", "180", "mysql"),
            "database_start_failed",
        )
        revision = _current_revision(
            runner, prefix, environment, allow_uninitialized=False
        )
        if revision != release.required_db_revision:
            raise DeploymentError("restored_database_revision_mismatch")
        if _database_table_count(runner, prefix, environment) == 0:
            raise DeploymentError("restored_database_empty")
        _execute(
            runner, prefix, environment, ("pull", "api", "web"), "image_pull_failed"
        )
        _set_maintenance(maintenance_dir, True)
        try:
            _execute(
                runner,
                prefix,
                environment,
                ("up", "-d", "--wait", "--wait-timeout", "180", "api", "web"),
                "runtime_start_failed",
            )
            _internal_smoke(runner, prefix, environment, release.build_id)
            _set_maintenance(maintenance_dir, False)
            try:
                (smoke or smoke_deployment)(config.public_origin, release.build_id)
            except SmokeDeploymentError, OSError, TimeoutError, ValueError:
                _set_maintenance(maintenance_dir, True)
                raise DeploymentError("post_deploy_smoke_failed") from None
            _write_current_release(state_dir, release, revision)
            return DeploymentResult(
                release_id=release.release_id, migrated_revision=revision, healthy=True
            )
        except (
            DeploymentError,
            SmokeDeploymentError,
            OSError,
            TimeoutError,
            ValueError,
        ):
            _set_maintenance(maintenance_dir, True)
            raise
    finally:
        os.close(lock_descriptor)
        try:
            lock_path.unlink(missing_ok=True)
        except OSError:
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--compose-file", type=Path)
    parser.add_argument("--initialize", action="store_true")
    parser.add_argument("--rollback", action="store_true")
    parser.add_argument("--skip-migration", action="store_true")
    parser.add_argument("--current-release", type=Path)
    parser.add_argument("--runtime", type=Path)
    args = parser.parse_args(argv)
    try:
        config = load_deploy_config(args.config)
        release = load_release_manifest(args.release)
        if args.rollback:
            if (
                args.initialize
                or not args.skip_migration
                or not args.current_release
                or not args.runtime
            ):
                raise DeploymentError("rollback_arguments_invalid")
            current_release = load_release_manifest(args.current_release)
            runtime = load_runtime_compatibility(args.runtime)
            result = rollback_release(
                config,
                current_release,
                release,
                runtime,
                env_file=args.env_file,
                compose_file=args.compose_file,
            )
        else:
            if args.skip_migration or args.current_release or args.runtime:
                raise DeploymentError("rollback_arguments_require_rollback")
            result = deploy_release(
                config,
                release,
                initialize=args.initialize,
                env_file=args.env_file,
                compose_file=args.compose_file,
            )
    except (
        DeployConfigError,
        ReleaseManifestError,
        RuntimeCompatibilityError,
        DeploymentError,
    ) as exc:
        print(f"deployment_failed: {exc}", file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "status": "deployment_healthy",
                "release_id": result.release_id,
                "database_revision": result.migrated_revision,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
