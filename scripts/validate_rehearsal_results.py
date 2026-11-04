"""Validate T33 rehearsal coverage and immutable A/B provenance."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
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

CASE_IDS = (
    "UP-01",
    "UP-02",
    "UP-03",
    "UP-04",
    "UP-05",
    "UP-06",
    "RB-01",
    "RB-02",
    "RF-01",
    "DR-01",
)
_RESULT_FIELDS = {"format_version", "from_release_id", "to_release_id", "cases"}
_CASE_FIELDS = {
    "case_id",
    "status",
    "case_variants",
    "expected_action",
    "actual_status",
    "evidence_paths",
    "from_digest",
    "to_digest",
    "same_origin",
    "same_profile",
    "origin_sha256",
    "profile_a_sha256",
    "profile_b_sha256",
    "snapshot_id",
}
_EVIDENCE_FIELDS = {
    "artifact_type",
    "format_version",
    "case_id",
    "tested_at",
    "from_release_id",
    "from_git_sha",
    "from_build_id",
    "from_web_digest",
    "from_api_digest",
    "from_mysql_digest",
    "to_release_id",
    "to_git_sha",
    "to_build_id",
    "to_web_digest",
    "to_api_digest",
    "to_mysql_digest",
    "same_origin",
    "same_profile",
    "origin_sha256",
    "profile_a_sha256",
    "profile_b_sha256",
    "snapshot_id",
}


def _timestamp_is_utc(value: object) -> bool:
    if not isinstance(value, str) or not value.endswith("Z"):
        return False
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return False
    return parsed.utcoffset() is not None and parsed.utcoffset().total_seconds() == 0


def _image_digest(image: str) -> str:
    return image.rsplit("@", 1)[1]


def release_fingerprint(release: ReleaseManifest) -> str:
    """Bind the case ledger to all release identity, data, and image fields."""
    identity = {
        "release_id": release.release_id,
        "git_sha": release.git_sha,
        "build_id": release.build_id,
        "platform": release.platform,
        "web_digest": _image_digest(release.web_image),
        "api_digest": _image_digest(release.api_image),
        "mysql_digest": _image_digest(release.mysql_image),
        "required_db_revision": release.required_db_revision,
        "supported_db_revisions": sorted(release.supported_db_revisions),
        "indexeddb_schema_version": release.indexeddb_schema_version,
        "supported_indexeddb_schema_versions": sorted(
            release.supported_indexeddb_schema_versions
        ),
        "protocol_versions": sorted(release.protocol_versions),
        "reducer_versions": sorted(release.reducer_versions),
    }
    encoded = json.dumps(identity, separators=(",", ":"), sort_keys=True).encode()
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _load_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None


def _evidence_matches(
    evidence_path: Path,
    case_id: str,
    row: dict[str, Any],
    from_release: ReleaseManifest,
    to_release: ReleaseManifest,
) -> bool:
    raw = _load_json(evidence_path)
    if not isinstance(raw, dict):
        return False
    expected = {
        "artifact_type": "dayforge-release-rehearsal-evidence",
        "format_version": 1,
        "case_id": case_id,
        "from_release_id": from_release.release_id,
        "from_git_sha": from_release.git_sha,
        "from_build_id": from_release.build_id,
        "from_web_digest": _image_digest(from_release.web_image),
        "from_api_digest": _image_digest(from_release.api_image),
        "from_mysql_digest": _image_digest(from_release.mysql_image),
        "to_release_id": to_release.release_id,
        "to_git_sha": to_release.git_sha,
        "to_build_id": to_release.build_id,
        "to_web_digest": _image_digest(to_release.web_image),
        "to_api_digest": _image_digest(to_release.api_image),
        "to_mysql_digest": _image_digest(to_release.mysql_image),
        "same_origin": row.get("same_origin"),
        "same_profile": row.get("same_profile"),
        "origin_sha256": row.get("origin_sha256"),
        "profile_a_sha256": row.get("profile_a_sha256"),
        "profile_b_sha256": row.get("profile_b_sha256"),
        "snapshot_id": row.get("snapshot_id"),
    }
    return (
        set(raw) == _EVIDENCE_FIELDS
        and all(raw.get(field) == value for field, value in expected.items())
        and _timestamp_is_utc(raw.get("tested_at"))
    )


def validate_rehearsal_results(
    path: Path,
    from_release: ReleaseManifest,
    to_release: ReleaseManifest,
    *,
    evidence_root: Path,
) -> list[str]:
    """Return stable issue codes for incomplete, stale, or unsupported cases."""
    try:
        evidence_base = evidence_root.resolve(strict=True)
        root_info = evidence_root.lstat()
    except OSError:
        return ["evidence_root_invalid"]
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):
        return ["evidence_root_invalid"]
    repository = Path(__file__).resolve().parents[1]
    if (
        evidence_base == repository
        or repository in evidence_base.parents
        or evidence_base in repository.parents
    ):
        return ["evidence_root_must_be_private"]
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
    if raw.get("from_release_id") != from_release.release_id:
        issues.append("from_release_id_mismatch")
    if raw.get("to_release_id") != to_release.release_id:
        issues.append("to_release_id_mismatch")
    cases = raw.get("cases")
    if not isinstance(cases, list):
        return list(dict.fromkeys([*issues, "cases_invalid"]))

    by_id: dict[str, dict[str, Any]] = {}
    for row in cases:
        if not isinstance(row, dict):
            issues.append("case_invalid")
            continue
        case_id = row.get("case_id")
        if not isinstance(case_id, str) or case_id not in CASE_IDS:
            issues.append("case_id_invalid")
            continue
        if case_id in by_id:
            issues.append(f"{case_id}_duplicate")
            continue
        by_id[case_id] = row
        if set(row) != _CASE_FIELDS:
            issues.append(f"{case_id}_schema_invalid")
        status = row.get("status")
        if status != "PASS":
            label = status.lower() if isinstance(status, str) else "status_invalid"
            issues.append(f"{case_id}_{label}")
        for field in ("expected_action", "actual_status"):
            if not isinstance(row.get(field), str) or not row[field].strip():
                issues.append(f"{case_id}_{field}_missing")
        if row.get("from_digest") != release_fingerprint(from_release):
            issues.append(f"{case_id}_from_digest_mismatch")
        if row.get("to_digest") != release_fingerprint(to_release):
            issues.append(f"{case_id}_to_digest_mismatch")
        variants = row.get("case_variants")
        if (
            not isinstance(variants, list)
            or not variants
            or not all(isinstance(value, str) and value.strip() for value in variants)
            or len(set(variants)) != len(variants)
        ):
            issues.append(f"{case_id}_case_variants_invalid")
        elif case_id == "UP-06" and not {"late-flight", "previous-static"}.issubset(
            variants
        ):
            issues.append("UP-06_required_variants_missing")
        elif case_id == "DR-01" and "restore-union" not in variants:
            issues.append("DR-01_required_variant_missing")
        if case_id == "RF-01":
            if (
                row.get("same_origin") is not None
                or row.get("same_profile") is not None
            ):
                issues.append("RF-01_browser_context_not_applicable")
            if any(
                row.get(field) is not None
                for field in ("origin_sha256", "profile_a_sha256", "profile_b_sha256")
            ):
                issues.append("RF-01_profile_binding_not_applicable")
        else:
            if row.get("same_origin") is not True:
                issues.append(f"{case_id}_same_origin_required")
            if row.get("same_profile") is not True:
                issues.append(f"{case_id}_same_profile_required")
        if case_id == "DR-01":
            if not isinstance(row.get("snapshot_id"), str) or not re.fullmatch(
                r"[a-f0-9]{64}", row["snapshot_id"]
            ):
                issues.append("DR-01_snapshot_id_missing")
            for field in ("origin_sha256", "profile_a_sha256", "profile_b_sha256"):
                if not isinstance(row.get(field), str) or not re.fullmatch(
                    r"[a-f0-9]{64}", row[field]
                ):
                    issues.append(f"DR-01_{field}_missing")
        elif any(
            row.get(field) is not None
            for field in ("origin_sha256", "profile_a_sha256", "profile_b_sha256")
        ):
            issues.append(f"{case_id}_unexpected_profile_binding")

        evidence = row.get("evidence_paths")
        if not isinstance(evidence, list) or not evidence:
            issues.append(f"{case_id}_evidence_missing")
            continue
        manifests: list[Path] = []
        case_evidence: list[Path] = []
        for item in evidence:
            if not isinstance(item, str) or not item or "\\" in item:
                issues.append(f"{case_id}_evidence_path_invalid")
                continue
            relative = Path(item)
            if relative.is_absolute() or ".." in relative.parts:
                issues.append(f"{case_id}_evidence_path_invalid")
                continue
            candidate = evidence_base / relative
            try:
                resolved = candidate.resolve(strict=True)
                resolved.relative_to(evidence_base)
                cursor = candidate
                while cursor != evidence_base:
                    if cursor.is_symlink():
                        raise ValueError("symlink")
                    cursor = cursor.parent
            except (OSError, ValueError):
                issues.append(f"{case_id}_evidence_file_missing")
                continue
            if not resolved.is_file():
                issues.append(f"{case_id}_evidence_file_missing")
                continue
            if resolved.suffix.lower() == ".json":
                manifests.append(resolved)
            else:
                case_evidence.append(resolved)
        if not any(
            _evidence_matches(item, case_id, row, from_release, to_release)
            for item in manifests
        ):
            issues.append(f"{case_id}_candidate_evidence_manifest_missing")
        if not case_evidence:
            issues.append(f"{case_id}_case_evidence_missing")

    for case_id in CASE_IDS:
        if case_id not in by_id:
            issues.append(f"{case_id}_missing")
    return list(dict.fromkeys(issues))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--from", dest="from_release", type=Path, required=True)
    parser.add_argument("--to", dest="to_release", type=Path, required=True)
    parser.add_argument("--evidence-root", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        from_release = load_release_manifest(args.from_release)
        to_release = load_release_manifest(args.to_release)
    except (ReleaseManifestError, OSError):
        print("rehearsal_release_manifest_invalid", file=sys.stderr)
        return 1
    issues = validate_rehearsal_results(
        args.results,
        from_release,
        to_release,
        evidence_root=args.evidence_root,
    )
    if issues:
        print(f"release rehearsal incomplete: {len(issues)} issues")
        for issue in issues:
            print(issue)
        return 1
    print("10 rehearsal cases verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
