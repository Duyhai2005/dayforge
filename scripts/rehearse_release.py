"""Run a guarded A/B release rehearsal on an existing isolated target."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import stat
import subprocess
import sys
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

try:
    from .backup_policy import BackupPolicyError, load_backup_policy
    from .check_release_compatibility import (
        RuntimeCompatibilityError,
        load_runtime_compatibility,
    )
    from .deploy_config import DeployConfig, DeployConfigError, load_deploy_config
    from .deploy_release import (
        DeploymentError,
        DeploymentResult,
        _compose_prefix,
        activate_restored_release,
        deploy_release,
        rollback_release,
    )
    from .release_manifest import (
        ReleaseManifest,
        ReleaseManifestError,
        load_release_manifest,
    )
    from .validate_rehearsal_results import release_fingerprint
except ImportError:
    from backup_policy import BackupPolicyError, load_backup_policy
    from check_release_compatibility import (
        RuntimeCompatibilityError,
        load_runtime_compatibility,
    )
    from deploy_config import DeployConfig, DeployConfigError, load_deploy_config
    from deploy_release import (
        DeploymentError,
        DeploymentResult,
        _compose_prefix,
        activate_restored_release,
        deploy_release,
        rollback_release,
    )
    from release_manifest import (
        ReleaseManifest,
        ReleaseManifestError,
        load_release_manifest,
    )
    from validate_rehearsal_results import release_fingerprint

RehearsalScenario = Literal["update", "rollback", "migration", "restore"]
RestorePhase = Literal["seed", "recover"]
_FORBIDDEN_HARNESS_ENV = (
    "DAYFORGE_SYNC_TEST_HARNESS",
    "DAYFORGE_OFFLINE_UPDATE_TEST_HARNESS",
    "DAYFORGE_PLAYWRIGHT_MOCK_API",
)


class RehearsalError(ValueError):
    """A fixed-code rehearsal input or execution error."""


@dataclass(frozen=True, slots=True)
class RehearsalInputs:
    config: DeployConfig | None
    from_release: ReleaseManifest
    to_release: ReleaseManifest
    config_path: Path | None
    from_path: Path
    to_path: Path
    output_dir: Path
    credentials_file: Path | None
    runtime_file: Path | None
    policy_file: Path | None
    snapshot_id: str | None
    source_environment: str | None
    scenario: RehearsalScenario


def _digest(image: str) -> str:
    return image.rsplit("@", 1)[1]


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _validate_credentials(path: Path, repo_root: Path) -> None:
    try:
        resolved = path.resolve(strict=True)
        info = path.lstat()
    except OSError:
        raise RehearsalError("credentials_file_invalid") from None
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or _is_within(resolved, repo_root)
        or (os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o077)
    ):
        raise RehearsalError("credentials_file_invalid")
    try:
        raw = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise RehearsalError("credentials_file_invalid") from None
    if (
        not isinstance(raw, dict)
        or set(raw) != {"owner_email", "owner_password"}
        or not isinstance(raw.get("owner_email"), str)
        or not raw["owner_email"].strip()
        or any(character.isspace() for character in raw["owner_email"])
        or not isinstance(raw.get("owner_password"), str)
        or not raw["owner_password"]
        or any(character in raw["owner_password"] for character in "\r\n\x00")
    ):
        raise RehearsalError("credentials_file_invalid")


def _private_output(path: Path, repo_root: Path) -> Path:
    try:
        resolved = path.resolve(strict=False)
        resolved.relative_to(repo_root)
    except ValueError:
        pass
    else:
        raise RehearsalError("output_must_be_outside_repository")
    if _is_within(repo_root, resolved):
        raise RehearsalError("output_must_be_outside_repository")
    try:
        resolved.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = resolved.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise RehearsalError("output_directory_invalid")
        if os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o077:
            resolved.chmod(0o700)
    except OSError:
        raise RehearsalError("output_directory_invalid") from None
    return resolved


def validate_rehearsal_inputs(
    config_path: Path | None,
    from_path: Path,
    to_path: Path,
    credentials_path: Path | None,
    output_path: Path,
    scenario: RehearsalScenario,
    *,
    runtime_path: Path | None = None,
    policy_path: Path | None = None,
    snapshot_id: str | None = None,
    source_environment: str | None = None,
    repo_root: Path | None = None,
) -> RehearsalInputs:
    """Validate isolated target, immutable A/B manifests, private inputs, and versions."""
    root = (repo_root or Path(__file__).resolve().parents[1]).resolve()
    try:
        config = load_deploy_config(config_path) if config_path else None
        from_release = load_release_manifest(from_path)
        to_release = load_release_manifest(to_path)
    except (DeployConfigError, ReleaseManifestError, OSError):
        raise RehearsalError("rehearsal_configuration_invalid") from None
    if scenario == "migration":
        if config_path is not None or credentials_path is not None:
            raise RehearsalError("migration_does_not_accept_deploy_target")
    else:
        if config is None or credentials_path is None:
            raise RehearsalError("target_and_credentials_required")
        if config.environment not in {"staging", "restore"}:
            raise RehearsalError("environment_not_allowed")
        for configured_path in (config.state_dir, config.secrets_dir):
            if _is_within(configured_path, root) or _is_within(root, configured_path):
                raise RehearsalError("runtime_paths_must_be_private")
        if (
            from_release.platform != config.platform
            or to_release.platform != config.platform
        ):
            raise RehearsalError("release_platform_mismatch")
    if (
        from_release.release_id == to_release.release_id
        or from_release.build_id == to_release.build_id
        or _digest(from_release.web_image) == _digest(to_release.web_image)
        or _digest(from_release.api_image) == _digest(to_release.api_image)
        or _digest(from_release.mysql_image) != _digest(to_release.mysql_image)
    ):
        raise RehearsalError("release_pair_invalid")
    for supported_old, supported_new in (
        (
            from_release.supported_indexeddb_schema_versions,
            to_release.supported_indexeddb_schema_versions,
        ),
        (from_release.protocol_versions, to_release.protocol_versions),
        (from_release.reducer_versions, to_release.reducer_versions),
    ):
        if not set(supported_old).issubset(supported_new):
            raise RehearsalError("client_contract_dropped")
    if scenario not in {"update", "rollback", "migration", "restore"}:
        raise RehearsalError("scenario_invalid")
    if scenario == "restore" and (config is None or config.environment != "restore"):
        raise RehearsalError("restore_environment_required")
    if scenario in {"update", "rollback", "restore"}:
        if runtime_path is None or not runtime_path.is_file():
            raise RehearsalError("runtime_manifest_required")
        try:
            load_runtime_compatibility(runtime_path)
        except RuntimeCompatibilityError:
            raise RehearsalError("runtime_manifest_invalid") from None
    if scenario == "restore":
        if (
            policy_path is None
            or snapshot_id is None
            or source_environment not in {"staging", "production"}
        ):
            raise RehearsalError("restore_snapshot_and_policy_required")
        if not re.fullmatch(r"[a-f0-9]{64}", snapshot_id):
            raise RehearsalError("snapshot_id_invalid")
        try:
            resolved_policy_path = policy_path.resolve(strict=True)
            info = policy_path.lstat()
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise RehearsalError("backup_policy_invalid")
            resolved_policy_path.relative_to(root)
            raise RehearsalError("backup_policy_must_be_private")
        except ValueError:
            pass
        except OSError:
            raise RehearsalError("backup_policy_invalid") from None
        try:
            policy = load_backup_policy(resolved_policy_path)
        except (BackupPolicyError, OSError):
            raise RehearsalError("backup_policy_invalid") from None
        if _is_within(policy.workspace_root, root) or _is_within(
            root, policy.workspace_root
        ):
            raise RehearsalError("backup_workspace_must_be_private")
    elif (
        policy_path is not None
        or snapshot_id is not None
        or source_environment is not None
    ):
        raise RehearsalError("restore_arguments_require_restore_scenario")
    if credentials_path is not None:
        _validate_credentials(credentials_path, root)
    output_dir = _private_output(output_path, root)
    return RehearsalInputs(
        config=config,
        from_release=from_release,
        to_release=to_release,
        config_path=config_path.resolve(strict=True) if config_path else None,
        from_path=from_path.resolve(strict=True),
        to_path=to_path.resolve(strict=True),
        output_dir=output_dir,
        credentials_file=(
            credentials_path.resolve(strict=True) if credentials_path else None
        ),
        runtime_file=runtime_path.resolve(strict=True) if runtime_path else None,
        policy_file=policy_path.resolve(strict=True) if policy_path else None,
        snapshot_id=snapshot_id,
        source_environment=source_environment,
        scenario=scenario,
    )


def _record_matches_manifest(
    record: dict[str, object], manifest: ReleaseManifest
) -> bool:
    return (
        all(
            record.get(field) == getattr(manifest, field)
            for field in ("release_id", "git_sha", "build_id")
        )
        and record.get("database_revision") in manifest.supported_db_revisions
    )


def switch_release(
    inputs: RehearsalInputs,
    release_name: Literal["A", "B"],
) -> DeploymentResult:
    """Switch A/B through the guarded deploy/rollback paths, preserving DB state."""
    if inputs.config is None:
        raise RehearsalError("deploy_target_required")
    current_path = inputs.config.state_dir / "current-release.json"
    try:
        current = json.loads(current_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise RehearsalError("current_release_record_invalid") from None
    if not isinstance(current, dict):
        raise RehearsalError("current_release_record_invalid")
    selected = inputs.from_release if release_name == "A" else inputs.to_release
    other = inputs.to_release if release_name == "A" else inputs.from_release
    selected_id = selected.release_id
    other_id = other.release_id
    if current.get("release_id") == selected_id:
        if not _record_matches_manifest(current, selected):
            raise RehearsalError("current_release_record_mismatch")
        return DeploymentResult(
            release_id=selected_id,
            migrated_revision=str(current.get("database_revision", "")),
            healthy=True,
        )
    if current.get("release_id") != other_id or not _record_matches_manifest(
        current, other
    ):
        raise RehearsalError("current_release_not_in_pair")
    if release_name == "B":
        return deploy_release(inputs.config, selected, previous_release=other)
    if inputs.runtime_file is None:
        raise RehearsalError("runtime_manifest_required")
    runtime = load_runtime_compatibility(inputs.runtime_file)
    return rollback_release(inputs.config, other, selected, runtime)


def _write_checkpoint(inputs: RehearsalInputs, run_id: str, status: str) -> None:
    if inputs.config is None:
        raise RehearsalError("deploy_target_required")
    directory = inputs.config.state_dir / "rehearsal"
    try:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if os.name != "nt":
            directory.chmod(0o700)
        payload = {
            "artifact_type": "dayforge-release-rehearsal-run",
            "format_version": 1,
            "run_id": run_id,
            "scenario": inputs.scenario,
            "status": status,
            "from_release_id": inputs.from_release.release_id,
            "from_git_sha": inputs.from_release.git_sha,
            "from_build_id": inputs.from_release.build_id,
            "from_web_digest": _digest(inputs.from_release.web_image),
            "from_api_digest": _digest(inputs.from_release.api_image),
            "to_release_id": inputs.to_release.release_id,
            "to_git_sha": inputs.to_release.git_sha,
            "to_build_id": inputs.to_release.build_id,
            "to_web_digest": _digest(inputs.to_release.web_image),
            "to_api_digest": _digest(inputs.to_release.api_image),
            "recorded_at": datetime.now(UTC)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z"),
        }
        if status not in {"running", "passed", "failed"} or not re.fullmatch(
            r"[a-f0-9]{32}", run_id
        ):
            raise RehearsalError("rehearsal_checkpoint_invalid")
        destination = directory / f"{run_id}.json"
        if destination.exists() or destination.is_symlink():
            info = destination.lstat()
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise RehearsalError("rehearsal_checkpoint_invalid")
            try:
                existing = json.loads(destination.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                raise RehearsalError("rehearsal_checkpoint_invalid") from None
            if (
                not isinstance(existing, dict)
                or existing.get("run_id") != run_id
                or existing.get("scenario") != inputs.scenario
                or existing.get("from_release_id") != inputs.from_release.release_id
                or existing.get("to_release_id") != inputs.to_release.release_id
                or existing.get("status") != "running"
            ):
                raise RehearsalError("rehearsal_checkpoint_identity_mismatch")
            payload["started_at"] = existing.get(
                "started_at", existing.get("recorded_at")
            )
        else:
            payload["started_at"] = payload["recorded_at"]
        temporary = directory / f".{run_id}.{uuid.uuid4().hex}.tmp"
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
        if os.name != "nt":
            descriptor = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    except OSError:
        raise RehearsalError("rehearsal_checkpoint_failed") from None


def _restore_target_identity(config: DeployConfig) -> dict[str, str]:
    return {
        "compose_project": config.compose_project,
        "db_name": config.db_name,
        "edge_alias": config.edge_alias,
        "state_dir": str(config.state_dir),
        "secrets_dir": str(config.secrets_dir),
        "app_subnet": config.app_subnet,
    }


def validate_restore_phase(
    inputs: RehearsalInputs, phase: RestorePhase
) -> dict[str, Any] | None:
    """Refuse a restore phase unless the matching two-target session is safe to resume."""
    if (
        inputs.scenario != "restore"
        or inputs.config is None
        or inputs.snapshot_id is None
    ):
        raise RehearsalError("restore_scenario_required")
    if phase not in {"seed", "recover"}:
        raise RehearsalError("restore_phase_invalid")
    state_path = inputs.output_dir / "restore-state.json"
    if phase == "seed":
        if state_path.exists() or state_path.is_symlink():
            raise RehearsalError("restore_session_already_exists")
        return None

    try:
        info = state_path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise RehearsalError("restore_session_invalid")
        session = json.loads(state_path.read_text(encoding="utf-8"))
    except RehearsalError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise RehearsalError("restore_session_missing_or_invalid") from None
    if (
        not isinstance(session, dict)
        or session.get("artifact_type") != "dayforge-t33-restore-session"
        or session.get("format_version") != 1
        or session.get("status") != "seeded"
        or session.get("snapshot_id") != inputs.snapshot_id
        or session.get("source_environment") != inputs.source_environment
        or session.get("from_release_id") != inputs.from_release.release_id
        or session.get("to_release_id") != inputs.to_release.release_id
        or session.get("origin_sha256")
        != hashlib.sha256(inputs.config.public_origin.encode("utf-8")).hexdigest()
    ):
        raise RehearsalError("restore_session_identity_mismatch")
    for release, label in ((inputs.from_release, "from"), (inputs.to_release, "to")):
        for name, value in (
            ("release_id", release.release_id),
            ("build_id", release.build_id),
            ("web_digest", _digest(release.web_image)),
            ("api_digest", _digest(release.api_image)),
        ):
            if session.get(f"{label}_{name}") != value:
                raise RehearsalError("restore_session_candidate_mismatch")
    try:
        seed_config_path = Path(session["seed_config_file"]).resolve(strict=True)
        seed_info = seed_config_path.lstat()
        if not stat.S_ISREG(seed_info.st_mode) or stat.S_ISLNK(seed_info.st_mode):
            raise RehearsalError("restore_seed_configuration_invalid")
        seed_config = load_deploy_config(seed_config_path)
    except RehearsalError:
        raise
    except (KeyError, OSError, DeployConfigError, TypeError):
        raise RehearsalError("restore_seed_configuration_invalid") from None
    expected_seed = _restore_target_identity(seed_config)
    if (
        seed_config.environment != "restore"
        or session.get("seed_target") != expected_seed
        or seed_config.public_origin != inputs.config.public_origin
        or seed_config.provider != inputs.config.provider
        or seed_config.region != inputs.config.region
        or seed_config.platform != inputs.config.platform
    ):
        raise RehearsalError("restore_session_target_mismatch")
    current = _restore_target_identity(inputs.config)
    if any(
        current[field] == expected_seed[field]
        for field in (
            "compose_project",
            "db_name",
            "edge_alias",
            "state_dir",
            "secrets_dir",
        )
    ):
        raise RehearsalError("restore_recover_requires_new_target")
    seed_paths = (seed_config.state_dir, seed_config.secrets_dir)
    current_paths = (inputs.config.state_dir, inputs.config.secrets_dir)
    if any(
        first == second or _is_within(first, second) or _is_within(second, first)
        for first in seed_paths
        for second in current_paths
    ):
        raise RehearsalError("restore_targets_not_isolated")
    try:
        old_subnet = ipaddress.ip_network(seed_config.app_subnet, strict=True)
        new_subnet = ipaddress.ip_network(inputs.config.app_subnet, strict=True)
    except ValueError:
        raise RehearsalError("restore_target_subnet_invalid") from None
    if old_subnet.overlaps(new_subnet):
        raise RehearsalError("restore_targets_not_isolated")
    expected_profiles = {
        "profile_a_sha256": hashlib.sha256(
            str(inputs.output_dir / "profiles" / "device-a").encode("utf-8")
        ).hexdigest(),
        "profile_b_sha256": hashlib.sha256(
            str(inputs.output_dir / "profiles" / "device-b").encode("utf-8")
        ).hexdigest(),
    }
    baseline = session.get("baseline_operation_ids")
    acknowledged = session.get("acknowledged_operation_ids")
    if (
        not isinstance(baseline, list)
        or not baseline
        or not all(
            isinstance(value, str) and re.fullmatch(r"[0-9a-f-]{36}", value)
            for value in baseline
        )
        or not isinstance(acknowledged, list)
        or len(acknowledged) != 2
        or not all(
            isinstance(value, str) and re.fullmatch(r"[0-9a-f-]{36}", value)
            for value in acknowledged
        )
        or len(set(baseline + acknowledged)) != len(baseline) + len(acknowledged)
        or not isinstance(session.get("pending_operation_id"), str)
        or session["pending_operation_id"] in set(baseline + acknowledged)
        or not re.fullmatch(r"[0-9a-f-]{36}", session["pending_operation_id"])
        or not isinstance(session.get("draft_ciphertext_sha256"), str)
        or not re.fullmatch(r"[a-f0-9]{64}", session["draft_ciphertext_sha256"])
        or not isinstance(session.get("draft_id"), str)
        or not session["draft_id"]
        or not isinstance(session.get("profile_a_sha256"), str)
        or not re.fullmatch(r"[a-f0-9]{64}", session["profile_a_sha256"])
        or not isinstance(session.get("profile_b_sha256"), str)
        or not re.fullmatch(r"[a-f0-9]{64}", session["profile_b_sha256"])
        or any(
            session.get(field) != value for field, value in expected_profiles.items()
        )
    ):
        raise RehearsalError("restore_session_evidence_incomplete")
    return session


def _write_restore_target_ready(inputs: RehearsalInputs) -> None:
    if (
        inputs.config is None
        or inputs.config_path is None
        or inputs.snapshot_id is None
    ):
        raise RehearsalError("restore_session_identity_invalid")
    destination = inputs.output_dir / "restore-state.json"
    payload: dict[str, object] = {
        "artifact_type": "dayforge-t33-restore-session",
        "format_version": 1,
        "status": "seed_target_ready",
        "snapshot_id": inputs.snapshot_id,
        "source_environment": inputs.source_environment,
        "origin_sha256": hashlib.sha256(
            inputs.config.public_origin.encode("utf-8")
        ).hexdigest(),
        "seed_config_file": str(inputs.config_path),
        "seed_target": _restore_target_identity(inputs.config),
        "from_release_id": inputs.from_release.release_id,
        "from_build_id": inputs.from_release.build_id,
        "from_web_digest": _digest(inputs.from_release.web_image),
        "from_api_digest": _digest(inputs.from_release.api_image),
        "to_release_id": inputs.to_release.release_id,
        "to_build_id": inputs.to_release.build_id,
        "to_web_digest": _digest(inputs.to_release.web_image),
        "to_api_digest": _digest(inputs.to_release.api_image),
        "baseline_operation_ids": [],
        "acknowledged_operation_ids": [],
        "pending_operation_id": None,
        "draft_ciphertext_sha256": None,
        "draft_id": None,
        "profile_a_sha256": None,
        "profile_b_sha256": None,
    }
    try:
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError:
        raise RehearsalError("restore_session_already_exists") from None
    except OSError:
        raise RehearsalError("restore_session_write_failed") from None


def _stop_seed_restore_target(
    session: dict[str, Any], release: ReleaseManifest
) -> None:
    try:
        seed_config = load_deploy_config(Path(session["seed_config_file"]))
        current_path = seed_config.state_dir / "current-release.json"
        ready_path = seed_config.state_dir / "restore-ready.json"
        for path in (current_path, ready_path):
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise RehearsalError("restore_seed_target_identity_mismatch")
        current = json.loads(current_path.read_text(encoding="utf-8"))
        ready = json.loads(ready_path.read_text(encoding="utf-8"))
        if (
            not isinstance(current, dict)
            or not isinstance(ready, dict)
            or not _record_matches_manifest(current, release)
            or ready.get("snapshot_id") != session["snapshot_id"]
        ):
            raise RehearsalError("restore_seed_target_identity_mismatch")
        prefix, environment = _compose_prefix(
            seed_config,
            release,
            seed_config.secrets_dir.parent / "runtime.env",
            Path(__file__).resolve().parents[1] / "deploy" / "compose.app.yaml",
        )
        result = subprocess.run(
            [*prefix, "stop", "api", "web"],
            check=False,
            capture_output=True,
            text=True,
            timeout=300,
            env=environment,
        )
        if result.returncode:
            raise RehearsalError("restore_seed_target_stop_failed")
    except RehearsalError:
        raise
    except (
        OSError,
        KeyError,
        TypeError,
        json.JSONDecodeError,
        DeployConfigError,
        ReleaseManifestError,
        DeploymentError,
        subprocess.TimeoutExpired,
    ):
        raise RehearsalError("restore_seed_target_stop_failed") from None


def _write_private_document(path: Path, payload: object) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except OSError:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise RehearsalError("rehearsal_evidence_write_failed") from None


def _record_migration_case(inputs: RehearsalInputs, *, passed: bool) -> None:
    """Record RF-01 as pending until the disposable partial-DDL fixture rolls forward."""
    case_id = "RF-01"
    expected = "reject partial migration readiness, repair only the verified disposable fixture, then reach 0004_sync"
    actual = (
        "partial DDL remained unready; the verified fixture repair reached 0004_sync and readiness passed"
        if passed
        else "partial DDL interruption or verified roll-forward did not pass"
    )
    evidence_paths: list[str] = []
    if passed:
        evidence_dir = inputs.output_dir / "evidence"
        try:
            evidence_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            info = evidence_dir.lstat()
            if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise RehearsalError("rehearsal_evidence_directory_invalid")
            if os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o077:
                evidence_dir.chmod(0o700)
        except OSError:
            raise RehearsalError("rehearsal_evidence_directory_invalid") from None
        tested_at = (
            datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
        )
        manifest = {
            "artifact_type": "dayforge-release-rehearsal-evidence",
            "format_version": 1,
            "case_id": case_id,
            "tested_at": tested_at,
            "from_release_id": inputs.from_release.release_id,
            "from_git_sha": inputs.from_release.git_sha,
            "from_build_id": inputs.from_release.build_id,
            "from_web_digest": _digest(inputs.from_release.web_image),
            "from_api_digest": _digest(inputs.from_release.api_image),
            "from_mysql_digest": _digest(inputs.from_release.mysql_image),
            "to_release_id": inputs.to_release.release_id,
            "to_git_sha": inputs.to_release.git_sha,
            "to_build_id": inputs.to_release.build_id,
            "to_web_digest": _digest(inputs.to_release.web_image),
            "to_api_digest": _digest(inputs.to_release.api_image),
            "to_mysql_digest": _digest(inputs.to_release.mysql_image),
            "same_origin": None,
            "same_profile": None,
            "origin_sha256": None,
            "profile_a_sha256": None,
            "profile_b_sha256": None,
            "snapshot_id": None,
        }
        json_path = evidence_dir / "RF-01-migration-interruption.json"
        text_path = evidence_dir / "RF-01-migration-interruption.txt"
        _write_private_document(json_path, manifest)
        try:
            descriptor = os.open(
                text_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600
            )
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(
                    f"Case: {case_id}\nExpected: {expected}\nObserved: {actual}\n"
                )
                stream.flush()
                os.fsync(stream.fileno())
        except OSError:
            raise RehearsalError("rehearsal_evidence_write_failed") from None
        evidence_paths = [
            json_path.relative_to(inputs.output_dir).as_posix(),
            text_path.relative_to(inputs.output_dir).as_posix(),
        ]

    results_path = inputs.output_dir / "rehearsal-results.json"
    previous: dict[str, Any] | None = None
    try:
        if results_path.exists() or results_path.is_symlink():
            info = results_path.lstat()
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise RehearsalError("rehearsal_results_file_invalid")
            results = json.loads(results_path.read_text(encoding="utf-8"))
            if (
                not isinstance(results, dict)
                or results.get("format_version") != 1
                or results.get("from_release_id") != inputs.from_release.release_id
                or results.get("to_release_id") != inputs.to_release.release_id
                or not isinstance(results.get("cases"), list)
            ):
                raise RehearsalError("rehearsal_results_candidate_mismatch")
            previous_rows = [
                row
                for row in results["cases"]
                if isinstance(row, dict) and row.get("case_id") == case_id
            ]
            if len(previous_rows) > 1:
                raise RehearsalError("rehearsal_results_case_duplicate")
            previous = previous_rows[0] if previous_rows else None
            rows = [
                row
                for row in results["cases"]
                if not isinstance(row, dict) or row.get("case_id") != case_id
            ]
        else:
            results = {
                "format_version": 1,
                "from_release_id": inputs.from_release.release_id,
                "to_release_id": inputs.to_release.release_id,
                "cases": [],
            }
            rows = []
        if previous and previous.get("expected_action") != expected:
            raise RehearsalError("rehearsal_results_case_action_mismatch")
        variants = (
            set(previous.get("case_variants", []))
            if previous and isinstance(previous.get("case_variants"), list)
            else set()
        )
        variants.add("migration-interruption")
        prior_evidence = (
            previous.get("evidence_paths", [])
            if previous and isinstance(previous.get("evidence_paths"), list)
            else []
        )
        row = {
            "case_id": case_id,
            "status": "PASS" if passed else "RUNNING",
            "case_variants": sorted(variants),
            "expected_action": expected,
            "actual_status": actual,
            "evidence_paths": list(dict.fromkeys([*prior_evidence, *evidence_paths])),
            "from_digest": release_fingerprint(inputs.from_release),
            "to_digest": release_fingerprint(inputs.to_release),
            "same_origin": None,
            "same_profile": None,
            "origin_sha256": None,
            "profile_a_sha256": None,
            "profile_b_sha256": None,
            "snapshot_id": None,
        }
        results["cases"] = [*rows, row]
        _write_private_document(results_path, results)
    except RehearsalError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError, ValueError):
        raise RehearsalError("rehearsal_results_file_invalid") from None


def _reject_harness_environment() -> None:
    if any(os.environ.get(name) for name in _FORBIDDEN_HARNESS_ENV):
        raise RehearsalError("harness_environment_detected")


def _playwright_command(inputs: RehearsalInputs) -> list[str]:
    suite = {
        "update": "tests/release/update.spec.ts",
        "rollback": "tests/release/rollback.spec.ts",
        "restore": "tests/release/restore.spec.ts",
    }.get(inputs.scenario)
    if suite is None:
        raise RehearsalError("scenario_runner_unavailable")
    return [
        "pnpm",
        "--filter",
        "@dayforge/frontend",
        "exec",
        "playwright",
        "test",
        "--config=playwright.release.config.ts",
        suite,
    ]


def _run_browser_suite(
    inputs: RehearsalInputs, run_id: str, restore_phase: RestorePhase | None
) -> int:
    if (
        inputs.config is None
        or inputs.config_path is None
        or inputs.credentials_file is None
    ):
        raise RehearsalError("target_and_credentials_required")
    run_output = inputs.output_dir / "playwright" / run_id
    profile_a = inputs.output_dir / "profiles" / "device-a"
    profile_b = inputs.output_dir / "profiles" / "device-b"
    for directory in (run_output, profile_a, profile_b):
        try:
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise RehearsalError("private_browser_directory_invalid")
            if os.name != "nt" and stat.S_IMODE(info.st_mode) & 0o077:
                directory.chmod(0o700)
        except OSError:
            raise RehearsalError("private_browser_directory_invalid") from None
    environment = dict(os.environ)
    for name in _FORBIDDEN_HARNESS_ENV:
        environment.pop(name, None)
    environment.update(
        PLAYWRIGHT_BASE_URL=inputs.config.public_origin,
        DAYFORGE_RELEASE_ORIGIN=inputs.config.public_origin,
        DAYFORGE_RELEASE_FROM_FILE=str(inputs.from_path),
        DAYFORGE_RELEASE_TO_FILE=str(inputs.to_path),
        DAYFORGE_RELEASE_CONFIG_FILE=str(inputs.config_path),
        DAYFORGE_RELEASE_CREDENTIALS_FILE=str(inputs.credentials_file),
        DAYFORGE_RELEASE_OUTPUT_DIR=str(run_output),
        DAYFORGE_RELEASE_OUTPUT_ROOT=str(inputs.output_dir),
        DAYFORGE_RELEASE_EVIDENCE_ROOT=str(inputs.output_dir),
        DAYFORGE_RELEASE_RESULTS_FILE=str(inputs.output_dir / "rehearsal-results.json"),
        DAYFORGE_RELEASE_PROFILE_A_DIR=str(profile_a),
        DAYFORGE_RELEASE_PROFILE_B_DIR=str(profile_b),
        DAYFORGE_RELEASE_RUNNER_FILE=str(Path(__file__).resolve()),
        DAYFORGE_RELEASE_PYTHON=sys.executable,
        DAYFORGE_RELEASE_SCENARIO=inputs.scenario,
        DAYFORGE_RELEASE_RUN_ID=run_id,
    )
    if inputs.runtime_file:
        environment["DAYFORGE_RELEASE_RUNTIME_FILE"] = str(inputs.runtime_file)
    if inputs.snapshot_id:
        environment["DAYFORGE_RELEASE_SNAPSHOT_ID"] = inputs.snapshot_id
    if restore_phase:
        environment["DAYFORGE_RELEASE_RESTORE_PHASE"] = restore_phase
        environment["DAYFORGE_RELEASE_RESTORE_STATE_FILE"] = str(
            inputs.output_dir / "restore-state.json"
        )
    result = subprocess.run(
        _playwright_command(inputs),
        cwd=Path(__file__).resolve().parents[1],
        env=environment,
        check=False,
        timeout=4 * 60 * 60,
    )
    return result.returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--from", dest="from_path", type=Path, required=True)
    parser.add_argument("--to", dest="to_path", type=Path, required=True)
    parser.add_argument(
        "--scenario",
        choices=("update", "rollback", "migration", "restore"),
        required=True,
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--credentials", type=Path)
    parser.add_argument("--runtime", type=Path)
    parser.add_argument("--policy", type=Path)
    parser.add_argument("--snapshot-id")
    parser.add_argument("--source-environment", choices=("staging", "production"))
    parser.add_argument("--restore-phase", choices=("seed", "recover"))
    parser.add_argument("--switch-to", choices=("A", "B"))
    args = parser.parse_args(argv)
    run_id: str | None = None
    inputs: RehearsalInputs | None = None
    checkpoint_status = "failed"
    try:
        _reject_harness_environment()
        inputs = validate_rehearsal_inputs(
            args.config,
            args.from_path,
            args.to_path,
            args.credentials,
            args.output,
            args.scenario,
            runtime_path=args.runtime,
            policy_path=args.policy,
            snapshot_id=args.snapshot_id,
            source_environment=args.source_environment,
        )
        if (args.scenario == "restore") != (args.restore_phase is not None):
            raise RehearsalError("restore_phase_required_only_for_restore")
        restore_session = (
            validate_restore_phase(inputs, args.restore_phase)
            if args.restore_phase is not None
            else None
        )
        if args.switch_to:
            switch_release(inputs, args.switch_to)
            return 0
        run_id = uuid.uuid4().hex
        if args.scenario != "migration":
            _write_checkpoint(inputs, run_id, "running")
        try:
            if args.scenario == "migration":
                _record_migration_case(inputs, passed=False)
                command = [
                    sys.executable,
                    str(
                        Path(__file__).resolve().parents[1]
                        / "scripts"
                        / "test_backend.py"
                    ),
                    "--mysql",
                    "tests/integration/test_migration_rehearsal.py",
                ]
                completed = subprocess.run(
                    command,
                    cwd=Path(__file__).resolve().parents[1] / "backend",
                    env=os.environ.copy(),
                    check=False,
                    timeout=4 * 60 * 60,
                )
                if completed.returncode == 0:
                    _record_migration_case(inputs, passed=True)
                checkpoint_status = "passed" if completed.returncode == 0 else "failed"
                return completed.returncode
            if args.scenario == "restore":
                if (
                    inputs.policy_file is None
                    or inputs.snapshot_id is None
                    or inputs.source_environment is None
                    or inputs.config_path is None
                    or inputs.config is None
                ):
                    raise RehearsalError("restore_snapshot_and_policy_required")
                if args.restore_phase == "recover":
                    if restore_session is None:
                        raise RehearsalError("restore_session_missing_or_invalid")
                    _stop_seed_restore_target(restore_session, inputs.to_release)
                restore_command = [
                    sys.executable,
                    str(Path(__file__).resolve().with_name("restore_database.py")),
                    "--config",
                    str(inputs.config_path),
                    "--release",
                    str(inputs.to_path),
                    "--policy",
                    str(inputs.policy_file),
                    "--snapshot",
                    inputs.snapshot_id,
                    "--source-environment",
                    inputs.source_environment,
                ]
                restored = subprocess.run(
                    restore_command,
                    cwd=Path(__file__).resolve().parents[1],
                    env=os.environ.copy(),
                    check=False,
                    timeout=4 * 60 * 60,
                )
                if restored.returncode:
                    return restored.returncode
                prepared = subprocess.run(
                    [
                        sys.executable,
                        str(
                            Path(__file__)
                            .resolve()
                            .with_name("prepare_restore_recovery.py")
                        ),
                        "--config",
                        str(inputs.config_path),
                        "--release",
                        str(inputs.to_path),
                    ],
                    cwd=Path(__file__).resolve().parents[1],
                    env=os.environ.copy(),
                    check=False,
                    timeout=4 * 60 * 60,
                )
                if prepared.returncode:
                    return prepared.returncode
                activate_restored_release(
                    inputs.config,
                    inputs.to_release,
                    snapshot_id=inputs.snapshot_id,
                )
                if args.restore_phase == "seed":
                    _write_restore_target_ready(inputs)
            elif args.scenario == "update":
                switch_release(inputs, "A")
            elif args.scenario == "rollback":
                switch_release(inputs, "B")
            code = _run_browser_suite(inputs, run_id, args.restore_phase)
            checkpoint_status = "passed" if code == 0 else "failed"
            return code
        finally:
            if run_id is not None and args.scenario != "migration":
                _write_checkpoint(inputs, run_id, checkpoint_status)
    except (
        DeployConfigError,
        DeploymentError,
        RehearsalError,
        ReleaseManifestError,
        RuntimeCompatibilityError,
        OSError,
        subprocess.TimeoutExpired,
    ) as exc:
        print(f"release_rehearsal_failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
