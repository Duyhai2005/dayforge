"""Validate staging acceptance provenance against an immutable release manifest."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    from .release_manifest import (
        ReleaseManifest,
        ReleaseManifestError,
        load_release_manifest,
    )
except ImportError:
    from release_manifest import (
        ReleaseManifest,
        ReleaseManifestError,
        load_release_manifest,
    )

_AC_IDS = tuple(f"AC-{number:02d}" for number in range(1, 39))
_STATUSES = {"PASS", "FAIL", "BLOCKED", "TARGET_PENDING"}
_RESULT_FIELDS = {"format_version", "candidate", "rows"}
_ROW_FIELDS = {
    "ac_id",
    "status",
    "scope",
    "release_id",
    "web_digest",
    "api_digest",
    "scenario",
    "evidence_paths",
    "tested_at",
    "production_recheck",
    "limitations",
}


def _timestamp_is_utc(value: object) -> bool:
    if not isinstance(value, str) or not value.endswith("Z"):
        return False
    try:
        return datetime.fromisoformat(value[:-1] + "+00:00").utcoffset() is not None
    except ValueError:
        return False


def _expected_candidate(release: ReleaseManifest) -> dict[str, str]:
    return {
        "release_id": release.release_id,
        "git_sha": release.git_sha,
        "build_id": release.build_id,
        "web_digest": release.web_image.rsplit("@", 1)[1],
        "api_digest": release.api_image.rsplit("@", 1)[1],
    }


def _load_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None


def _evidence_manifest_matches(evidence_path: Path, expected: dict[str, str]) -> bool:
    raw = _load_json(evidence_path)
    return (
        isinstance(raw, dict)
        and raw.get("artifact_type") == "dayforge-staging-evidence"
        and type(raw.get("format_version")) is int
        and raw.get("format_version") == 1
        and raw.get("scope") == "staging"
        and _timestamp_is_utc(raw.get("tested_at"))
        and all(raw.get(field) == value for field, value in expected.items())
    )


def validate_acceptance_results(
    path: Path,
    release: ReleaseManifest,
    *,
    repo_root: Path | None = None,
) -> list[str]:
    """Return issue codes for incomplete, stale, or unsupported evidence rows."""
    root = (repo_root or Path(__file__).resolve().parents[1]).resolve()
    raw = _load_json(path)
    if not isinstance(raw, dict):
        return ["results_file_invalid"]

    issues: list[str] = []
    if (
        set(raw) != _RESULT_FIELDS
        or type(raw.get("format_version")) is not int
        or raw.get("format_version") != 1
    ):
        issues.append("results_schema_invalid")
    expected = _expected_candidate(release)
    candidate = raw.get("candidate")
    if not isinstance(candidate, dict) or set(candidate) != set(expected):
        issues.append("candidate_schema_invalid")
    else:
        for field, value in expected.items():
            if candidate.get(field) != value:
                issues.append(f"candidate_{field}_mismatch")

    rows = raw.get("rows")
    if not isinstance(rows, list):
        return issues + ["rows_invalid"]
    by_id: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            issues.append("row_invalid")
            continue
        ac_id = row.get("ac_id")
        if not isinstance(ac_id, str) or ac_id not in _AC_IDS:
            issues.append("row_id_invalid")
            continue
        if ac_id in by_id:
            issues.append(f"{ac_id}_duplicate")
            continue
        by_id[ac_id] = row
        if set(row) != _ROW_FIELDS:
            issues.append(f"{ac_id}_schema_invalid")
        if row.get("scope") != "staging":
            issues.append(f"{ac_id}_scope_invalid")
        status = row.get("status")
        if not isinstance(status, str) or status not in _STATUSES:
            issues.append(f"{ac_id}_status_invalid")
        if not isinstance(row.get("scenario"), str) or not row["scenario"].strip():
            issues.append(f"{ac_id}_scenario_missing")
        if not isinstance(row.get("limitations"), str):
            issues.append(f"{ac_id}_limitations_invalid")
        if type(row.get("production_recheck")) is not bool:
            issues.append(f"{ac_id}_production_recheck_invalid")
        if status == "PASS":
            if row.get("release_id") != expected["release_id"]:
                issues.append(f"{ac_id}_release_mismatch")
            if row.get("web_digest") != expected["web_digest"]:
                issues.append(f"{ac_id}_web_digest_mismatch")
            if row.get("api_digest") != expected["api_digest"]:
                issues.append(f"{ac_id}_api_digest_mismatch")
            if not _timestamp_is_utc(row.get("tested_at")):
                issues.append(f"{ac_id}_tested_at_invalid")
            if (
                ac_id in {"AC-31", "AC-32", "AC-36"}
                and row.get("production_recheck") is not True
            ):
                issues.append(f"{ac_id}_production_recheck_required")
            evidence = row.get("evidence_paths")
            if not isinstance(evidence, list) or not evidence:
                issues.append(f"{ac_id}_evidence_missing")
                continue
            manifests: list[Path] = []
            case_evidence: list[Path] = []
            for item in evidence:
                if not isinstance(item, str) or not item or "\\" in item:
                    issues.append(f"{ac_id}_evidence_path_invalid")
                    continue
                relative = Path(item)
                if relative.is_absolute() or ".." in relative.parts:
                    issues.append(f"{ac_id}_evidence_path_invalid")
                    continue
                try:
                    resolved = (root / relative).resolve(strict=True)
                    resolved.relative_to(root)
                except (OSError, ValueError):
                    issues.append(f"{ac_id}_evidence_file_missing")
                    continue
                if not resolved.is_file():
                    issues.append(f"{ac_id}_evidence_file_missing")
                    continue
                if resolved.suffix.lower() == ".json":
                    manifests.append(resolved)
                else:
                    case_evidence.append(resolved)
            if not any(
                _evidence_manifest_matches(item, expected) for item in manifests
            ):
                issues.append(f"{ac_id}_candidate_evidence_manifest_missing")
            if not case_evidence:
                issues.append(f"{ac_id}_scenario_evidence_missing")
        else:
            label = status.lower() if isinstance(status, str) else "status_invalid"
            issues.append(f"{ac_id}_{label}")

    for ac_id in _AC_IDS:
        if ac_id not in by_id:
            issues.append(f"{ac_id}_missing")
    return list(dict.fromkeys(issues))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--release", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        release = load_release_manifest(args.release)
    except (ReleaseManifestError, OSError):
        print("acceptance_release_manifest_invalid", file=sys.stderr)
        return 1
    issues = validate_acceptance_results(args.results, release)
    if issues:
        print(f"staging acceptance incomplete: {len(issues)} issues")
        for issue in issues:
            print(issue)
        return 1
    print("38 staging criteria verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
