"""Strict parsing and writing for immutable production release metadata."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal

_FIELDS = frozenset(
    {
        "format_version",
        "release_id",
        "git_sha",
        "build_id",
        "platform",
        "web_image",
        "api_image",
        "mysql_image",
        "required_db_revision",
        "supported_db_revisions",
        "indexeddb_schema_version",
        "supported_indexeddb_schema_versions",
        "protocol_versions",
        "reducer_versions",
        "created_at",
        "test_harness",
    }
)
_RELEASE_ID = re.compile(r"[A-Za-z0-9._-]{1,128}\Z")
_IMAGE_DIGEST = re.compile(r"[^\s@]+@sha256:[a-f0-9]{64}\Z")
_REVISION = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")


class ReleaseManifestError(ValueError):
    """A safe error that names invalid manifest fields without echoing values."""


@dataclass(frozen=True, slots=True)
class ReleaseManifest:
    release_id: str
    git_sha: str
    build_id: str
    platform: Literal["linux/amd64", "linux/arm64"]
    web_image: str
    api_image: str
    mysql_image: str
    required_db_revision: str
    supported_db_revisions: tuple[str, ...]
    indexeddb_schema_version: int
    supported_indexeddb_schema_versions: tuple[int, ...]
    protocol_versions: tuple[int, ...]
    reducer_versions: tuple[int, ...]
    created_at: str
    test_harness: Literal[False] = False
    format_version: Literal[1] = 1


def _positive_version_list(value: object) -> bool:
    return (
        isinstance(value, list)
        and bool(value)
        and all(type(item) is int and item >= 1 for item in value)
        and len(set(value)) == len(value)
    )


def _valid_timestamp(value: object) -> bool:
    if not isinstance(value, str) or not value.endswith("Z"):
        return False
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return parsed.utcoffset() is not None and parsed.utcoffset().total_seconds() == 0


def _invalid_fields(raw: object) -> set[str]:
    if not isinstance(raw, dict):
        return {"manifest"}
    invalid = set(raw) - _FIELDS
    invalid.update(_FIELDS - set(raw))
    if raw.get("format_version") != 1 or type(raw.get("format_version")) is not int:
        invalid.add("format_version")
    for field in ("release_id", "build_id"):
        if not isinstance(raw.get(field), str) or not _RELEASE_ID.fullmatch(raw[field]):
            invalid.add(field)
    if not isinstance(raw.get("git_sha"), str) or not re.fullmatch(r"[a-f0-9]{40}", raw["git_sha"]):
        invalid.add("git_sha")
    if not isinstance(raw.get("platform"), str) or raw["platform"] not in {
        "linux/amd64",
        "linux/arm64",
    }:
        invalid.add("platform")
    for field in ("web_image", "api_image", "mysql_image"):
        if not isinstance(raw.get(field), str) or not _IMAGE_DIGEST.fullmatch(raw[field]):
            invalid.add(field)
    revision = raw.get("required_db_revision")
    if not isinstance(revision, str) or not _REVISION.fullmatch(revision):
        invalid.add("required_db_revision")
    supported_revisions = raw.get("supported_db_revisions")
    if (
        not isinstance(supported_revisions, list)
        or not supported_revisions
        or not all(isinstance(item, str) and _REVISION.fullmatch(item) for item in supported_revisions)
        or len(set(supported_revisions)) != len(supported_revisions)
    ):
        invalid.add("supported_db_revisions")
    elif revision not in supported_revisions:
        invalid.add("supported_db_revisions")
    schema_version = raw.get("indexeddb_schema_version")
    if type(schema_version) is not int or schema_version < 1:
        invalid.add("indexeddb_schema_version")
    for field in (
        "supported_indexeddb_schema_versions",
        "protocol_versions",
        "reducer_versions",
    ):
        if not _positive_version_list(raw.get(field)):
            invalid.add(field)
    supported_schema_versions = raw.get("supported_indexeddb_schema_versions")
    if (
        type(schema_version) is int
        and isinstance(supported_schema_versions, list)
        and schema_version not in supported_schema_versions
    ):
        invalid.add("supported_indexeddb_schema_versions")
    if not _valid_timestamp(raw.get("created_at")):
        invalid.add("created_at")
    if raw.get("test_harness") is not False:
        invalid.add("test_harness")
    return invalid


def _from_dict(raw: dict[str, object]) -> ReleaseManifest:
    issues = _invalid_fields(raw)
    if issues:
        raise ReleaseManifestError(", ".join(sorted(issues)))
    return ReleaseManifest(
        release_id=raw["release_id"],
        git_sha=raw["git_sha"],
        build_id=raw["build_id"],
        platform=raw["platform"],
        web_image=raw["web_image"],
        api_image=raw["api_image"],
        mysql_image=raw["mysql_image"],
        required_db_revision=raw["required_db_revision"],
        supported_db_revisions=tuple(raw["supported_db_revisions"]),
        indexeddb_schema_version=raw["indexeddb_schema_version"],
        supported_indexeddb_schema_versions=tuple(raw["supported_indexeddb_schema_versions"]),
        protocol_versions=tuple(raw["protocol_versions"]),
        reducer_versions=tuple(raw["reducer_versions"]),
        created_at=raw["created_at"],
        test_harness=False,
        format_version=1,
    )


def load_release_manifest(path: Path) -> ReleaseManifest:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError, UnicodeError, json.JSONDecodeError:
        raise ReleaseManifestError("manifest_file") from None
    if not isinstance(raw, dict):
        raise ReleaseManifestError("manifest")
    return _from_dict(raw)


def write_release_manifest(path: Path, manifest: ReleaseManifest) -> None:
    raw = asdict(manifest)
    raw["supported_db_revisions"] = list(manifest.supported_db_revisions)
    raw["supported_indexeddb_schema_versions"] = list(manifest.supported_indexeddb_schema_versions)
    raw["protocol_versions"] = list(manifest.protocol_versions)
    raw["reducer_versions"] = list(manifest.reducer_versions)
    issues = _invalid_fields(raw)
    if issues:
        raise ReleaseManifestError(", ".join(sorted(issues)))
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(raw, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except OSError, UnicodeError:
        raise ReleaseManifestError("manifest_write") from None
