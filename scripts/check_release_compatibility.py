"""Check a release manifest against an observed database/client runtime."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

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

_RUNTIME_FIELDS = {
    "db_revision",
    "indexeddb_schema_version",
    "protocol_version",
    "reducer_version",
}
_REVISION = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")


class RuntimeCompatibilityError(ValueError):
    """A fixed-code error for malformed observed runtime metadata."""


@dataclass(frozen=True, slots=True)
class RuntimeCompatibility:
    db_revision: str
    indexeddb_schema_version: int
    protocol_version: int
    reducer_version: int


@dataclass(frozen=True, slots=True)
class CompatibilityDecision:
    allowed: bool
    reasons: tuple[str, ...]


def _load_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise RuntimeCompatibilityError("runtime_manifest_invalid") from None


def load_runtime_compatibility(path: Path) -> RuntimeCompatibility:
    """Read the four observed version fields from a strict JSON file."""
    raw = _load_json(path)
    version_fields = (
        "indexeddb_schema_version",
        "protocol_version",
        "reducer_version",
    )
    if (
        not isinstance(raw, dict)
        or set(raw) != _RUNTIME_FIELDS
        or not isinstance(raw.get("db_revision"), str)
        or not _REVISION.fullmatch(raw["db_revision"])
        or any(
            type(raw.get(field)) is not int or raw[field] < 1
            for field in version_fields
        )
    ):
        raise RuntimeCompatibilityError("runtime_manifest_invalid")
    return RuntimeCompatibility(
        db_revision=raw["db_revision"],
        indexeddb_schema_version=raw["indexeddb_schema_version"],
        protocol_version=raw["protocol_version"],
        reducer_version=raw["reducer_version"],
    )


def check_release_compatibility(
    release: ReleaseManifest, runtime: RuntimeCompatibility
) -> CompatibilityDecision:
    """Require exact support-set membership; numeric ordering is not enough."""
    reasons: list[str] = []
    if runtime.db_revision not in release.supported_db_revisions:
        reasons.append("db_revision_unsupported")
    if (
        type(runtime.indexeddb_schema_version) is not int
        or runtime.indexeddb_schema_version
        not in release.supported_indexeddb_schema_versions
    ):
        reasons.append("local_schema_unsupported")
    if (
        type(runtime.protocol_version) is not int
        or runtime.protocol_version not in release.protocol_versions
    ):
        reasons.append("protocol_unsupported")
    if (
        type(runtime.reducer_version) is not int
        or runtime.reducer_version not in release.reducer_versions
    ):
        reasons.append("reducer_unsupported")
    return CompatibilityDecision(allowed=not reasons, reasons=tuple(reasons))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        release = load_release_manifest(args.release)
        runtime = load_runtime_compatibility(args.runtime)
    except (ReleaseManifestError, RuntimeCompatibilityError):
        print("compatibility_check_failed: manifest_invalid", file=sys.stderr)
        return 1
    decision = check_release_compatibility(release, runtime)
    if not decision.allowed:
        print(
            json.dumps(
                {
                    "allowed": False,
                    "reasons": list(decision.reasons),
                    "status": "release_incompatible",
                },
                sort_keys=True,
            )
        )
        return 2
    print(json.dumps({"allowed": True, "reasons": [], "status": "compatible"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
