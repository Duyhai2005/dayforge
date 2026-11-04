"""Validate private staging acceptance inputs without displaying credentials."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import stat
import sys
from pathlib import Path
from urllib.parse import urlsplit

try:
    from .deploy_config import DeployConfigError, load_deploy_config
    from .release_manifest import ReleaseManifestError, load_release_manifest
except ImportError:
    from deploy_config import DeployConfigError, load_deploy_config
    from release_manifest import ReleaseManifestError, load_release_manifest

_SECRET_FIELDS = frozenset({"owner_email", "owner_password"})
_SPECIAL_HOST_SUFFIXES = (".test", ".example", ".invalid", ".localhost", ".local")


class StagingInputError(ValueError):
    """Safe staging preflight error containing field names only."""


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _validate_origin(origin: str) -> None:
    try:
        parsed = urlsplit(origin)
        host = parsed.hostname
        port = parsed.port
    except ValueError:
        raise StagingInputError("public_origin") from None
    if (
        parsed.scheme != "https"
        or not host
        or host != host.lower()
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
        or origin.endswith(":443")
        or (port is not None and not 1 <= port <= 65535)
    ):
        raise StagingInputError("public_origin")
    if host == "localhost" or host.endswith(_SPECIAL_HOST_SUFFIXES) or "." not in host:
        raise StagingInputError("public_origin")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return
    raise StagingInputError("public_origin")


def _validate_credentials(path: Path, repo_root: Path) -> None:
    try:
        resolved = path.expanduser().resolve(strict=True)
        metadata = resolved.stat()
        if not stat.S_ISREG(metadata.st_mode) or _inside(resolved, repo_root):
            raise StagingInputError("credentials_file")
        if metadata.st_size > 16_384:
            raise StagingInputError("credentials_file")
        if os.name != "nt" and stat.S_IMODE(metadata.st_mode) & 0o077:
            raise StagingInputError("credentials_permissions")
        raw = json.loads(resolved.read_text(encoding="utf-8"))
    except StagingInputError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise StagingInputError("credentials_file") from None

    if not isinstance(raw, dict) or set(raw) != _SECRET_FIELDS:
        raise StagingInputError("credentials_schema")
    email = raw.get("owner_email")
    password = raw.get("owner_password")
    if (
        not isinstance(email, str)
        or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email)
        or not isinstance(password, str)
        or not 1 <= len(password) <= 1024
    ):
        raise StagingInputError("credentials_schema")


def _prepare_output(path: Path, repo_root: Path) -> Path:
    try:
        resolved = path.expanduser().resolve(strict=False)
        if not resolved.is_absolute() or _inside(resolved, repo_root):
            raise StagingInputError("output_directory")
        resolved.mkdir(parents=True, exist_ok=True, mode=0o700)
        metadata = resolved.stat()
        if not stat.S_ISDIR(metadata.st_mode):
            raise StagingInputError("output_directory")
        if os.name != "nt" and stat.S_IMODE(metadata.st_mode) & 0o077:
            raise StagingInputError("output_permissions")
    except StagingInputError:
        raise
    except OSError:
        raise StagingInputError("output_directory") from None
    return resolved


def validate_staging_inputs(
    config_path: Path,
    release_path: Path,
    credentials_path: Path,
    output_path: Path,
    *,
    repo_root: Path | None = None,
) -> dict[str, object]:
    """Validate target, immutable release, private credentials, and output path."""
    root = (repo_root or Path(__file__).resolve().parents[1]).resolve()
    try:
        config = load_deploy_config(config_path)
    except (DeployConfigError, OSError):
        raise StagingInputError("staging_config") from None
    if config.environment != "staging":
        raise StagingInputError("environment")
    _validate_origin(config.public_origin)

    try:
        release = load_release_manifest(release_path)
    except (ReleaseManifestError, OSError):
        raise StagingInputError("release_manifest") from None
    if release.platform != config.platform or release.test_harness:
        raise StagingInputError("release_platform")

    _validate_credentials(credentials_path, root)
    output = _prepare_output(output_path, root)
    return {
        "origin": config.public_origin,
        "release_path": str(release_path.expanduser().resolve(strict=True)),
        "credentials_path": str(credentials_path.expanduser().resolve(strict=True)),
        "output_path": str(output),
        "release_id": release.release_id,
        "build_id": release.build_id,
        "git_sha": release.git_sha,
        "web_digest": release.web_image.rsplit("@", 1)[1],
        "api_digest": release.api_image.rsplit("@", 1)[1],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--credentials", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        result = validate_staging_inputs(
            args.config,
            args.release,
            args.credentials,
            args.output,
        )
    except StagingInputError as exc:
        print(f"staging_preflight_invalid:{exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
