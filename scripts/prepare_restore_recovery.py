"""Run the restore-only auth and sync preparation CLI in the pinned API image."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
from pathlib import Path
from uuid import UUID

from scripts.deploy_config import DeployConfig, DeployConfigError, load_deploy_config
from scripts.deploy_release import (
    DeploymentError,
    Runner,
    _compose_prefix,
    _execute,
    _run,
)
from scripts.release_manifest import ReleaseManifestError, load_release_manifest

_RESTORE_PROJECT = re.compile(r"dayforge-restore-([a-f0-9]{32})\Z")
_RESTORE_DATABASE = re.compile(r"dayforge_restore_([a-f0-9]{32})\Z")
_RESTORE_EDGE = re.compile(r"restore-([a-f0-9]{32})\Z")


class RestoreRecoveryLaunchError(RuntimeError):
    """Fixed-code launcher failure without paths or runtime values."""


def _prepare_journal_directory(
    config: DeployConfig,
    *,
    container_uid: int,
    container_gid: int,
) -> Path:
    state = config.state_dir
    journal_dir = state / "restore-recovery"
    try:
        root_info = state.lstat()
        if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):
            raise RestoreRecoveryLaunchError("restore_state_directory_invalid")
        if os.name != "nt" and stat.S_IMODE(root_info.st_mode) & 0o077:
            raise RestoreRecoveryLaunchError("restore_state_permissions_invalid")
        if journal_dir.exists() or journal_dir.is_symlink():
            info = journal_dir.lstat()
            if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise RestoreRecoveryLaunchError("restore_journal_directory_invalid")
        else:
            journal_dir.mkdir(mode=0o700)
        if os.name != "nt":
            info = journal_dir.lstat()
            if info.st_uid != container_uid or info.st_gid != container_gid:
                os.chown(journal_dir, container_uid, container_gid)
            journal_dir.chmod(0o700)
    except RestoreRecoveryLaunchError:
        raise
    except OSError:
        raise RestoreRecoveryLaunchError(
            "restore_journal_directory_unavailable"
        ) from None
    return journal_dir


def prepare_restore_recovery(
    config: DeployConfig,
    release,
    *,
    env_file: Path | None = None,
    compose_file: Path | None = None,
    runner: Runner = _run,
    container_uid: int = 10001,
    container_gid: int = 10001,
) -> str:
    """Run the one-shot recovery CLI without starting the API service or edge."""
    if config.environment != "restore":
        raise RestoreRecoveryLaunchError("restore_environment_required")
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
        raise RestoreRecoveryLaunchError("restore_target_identity_invalid")
    if release.platform != config.platform:
        raise RestoreRecoveryLaunchError("release_platform_mismatch")
    journal_dir = _prepare_journal_directory(
        config,
        container_uid=container_uid,
        container_gid=container_gid,
    )
    if "," in str(journal_dir):
        raise RestoreRecoveryLaunchError("restore_journal_mount_invalid")
    runtime_file = env_file or config.secrets_dir.parent / "runtime.env"
    compose_yaml = (
        compose_file
        or Path(__file__).resolve().parents[1] / "deploy" / "compose.app.yaml"
    )
    try:
        prefix, environment = _compose_prefix(
            config, release, runtime_file, compose_yaml
        )
        output = _execute(
            runner,
            prefix,
            environment,
            (
                "run",
                "--rm",
                "--no-deps",
                "-T",
                "--mount",
                f"type=bind,source={journal_dir},target=/run/dayforge",
                "api",
                "python",
                "-m",
                "app.cli.prepare_restored_database",
                "--restore-id",
                str(UUID(project_match.group(1))),
                "--journal-file",
                "/run/dayforge/recovery.json",
            ),
            "restore_preparation_failed",
        )
    except DeploymentError:
        raise RestoreRecoveryLaunchError("restore_preparation_failed") from None
    try:
        result = json.loads(output)
    except json.JSONDecodeError:
        raise RestoreRecoveryLaunchError("restore_preparation_unconfirmed") from None
    if not isinstance(result, dict) or result.get("status") != "restore_prepared":
        raise RestoreRecoveryLaunchError("restore_preparation_unconfirmed")
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--release", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        config = load_deploy_config(args.config)
        release = load_release_manifest(args.release)
        prepare_restore_recovery(config, release)
    except (
        DeployConfigError,
        ReleaseManifestError,
        RestoreRecoveryLaunchError,
        OSError,
        ValueError,
    ):
        print("restore_preparation_failed", file=sys.stderr)
        return 2
    print("restore_prepared")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
