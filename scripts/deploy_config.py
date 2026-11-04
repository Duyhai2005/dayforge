"""Validated, secret-free deployment target configuration."""

from __future__ import annotations

import ipaddress
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

DeploymentEnvironment = Literal["staging", "production", "restore"]
DeploymentProvider = Literal["aws", "oci"]
DeploymentPlatform = Literal["linux/amd64", "linux/arm64"]

_FIELDS = frozenset(
    {
        "environment",
        "provider",
        "region",
        "platform",
        "public_origin",
        "compose_project",
        "db_name",
        "secrets_dir",
        "state_dir",
        "edge_alias",
        "app_subnet",
    }
)
_RESTORE_ID = re.compile(r"[a-f0-9]{32}\Z")


class DeployConfigError(ValueError):
    """A safe error containing only invalid configuration field names."""


@dataclass(frozen=True, slots=True)
class DeployConfig:
    environment: DeploymentEnvironment
    provider: DeploymentProvider
    region: str
    platform: DeploymentPlatform
    public_origin: str
    compose_project: str
    db_name: str
    secrets_dir: Path
    state_dir: Path
    edge_alias: str
    app_subnet: str


def _safe_origin(value: object) -> bool:
    if not isinstance(value, str) or any(character.isspace() for character in value):
        return False
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
        ):
            return False
        port = parsed.port
    except ValueError:
        return False
    host = parsed.hostname
    if host != host.lower() or value.endswith(":443"):
        return False
    return port is None or 1 <= port <= 65535


def _private_subnet(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        network = ipaddress.ip_network(value, strict=True)
    except ValueError:
        return False
    if not isinstance(network, ipaddress.IPv4Network):
        return False
    return any(
        network.subnet_of(private)
        for private in (
            ipaddress.ip_network("10.0.0.0/8"),
            ipaddress.ip_network("172.16.0.0/12"),
            ipaddress.ip_network("192.168.0.0/16"),
        )
    )


def _resolved_path(value: object, field: str, invalid: set[str]) -> Path:
    if not isinstance(value, str) or not value or "\x00" in value:
        invalid.add(field)
        return Path(".")
    try:
        path = Path(value).expanduser().resolve(strict=False)
    except OSError, RuntimeError, ValueError:
        invalid.add(field)
        return Path(".")
    if not path.is_absolute():
        invalid.add(field)
    return path


def load_deploy_config(path: Path) -> DeployConfig:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError, UnicodeError, json.JSONDecodeError:
        raise DeployConfigError("config_file") from None
    if not isinstance(raw, dict):
        raise DeployConfigError("config_object")

    invalid = set(raw) - _FIELDS
    invalid.update(_FIELDS - set(raw))
    if not isinstance(raw.get("environment"), str) or raw["environment"] not in {
        "staging",
        "production",
        "restore",
    }:
        invalid.add("environment")
    if not isinstance(raw.get("provider"), str) or raw["provider"] not in {"aws", "oci"}:
        invalid.add("provider")
    if not isinstance(raw.get("platform"), str) or raw["platform"] not in {"linux/amd64", "linux/arm64"}:
        invalid.add("platform")
    region = raw.get("region")
    if not isinstance(region, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,62}", region):
        invalid.add("region")
    if not _safe_origin(raw.get("public_origin")):
        invalid.add("public_origin")
    if not _private_subnet(raw.get("app_subnet")):
        invalid.add("app_subnet")

    environment = raw.get("environment")
    project = raw.get("compose_project")
    db_name = raw.get("db_name")
    edge_alias = raw.get("edge_alias")
    if environment == "staging":
        if project != "dayforge-staging":
            invalid.add("compose_project")
        if db_name != "dayforge_staging":
            invalid.add("db_name")
        if edge_alias != "staging-web":
            invalid.add("edge_alias")
    elif environment == "production":
        if project != "dayforge-production":
            invalid.add("compose_project")
        if db_name != "dayforge_production":
            invalid.add("db_name")
        if edge_alias != "production-web":
            invalid.add("edge_alias")
    elif environment == "restore":
        project_id = project.removeprefix("dayforge-restore-") if isinstance(project, str) else ""
        database_id = db_name.removeprefix("dayforge_restore_") if isinstance(db_name, str) else ""
        alias_id = edge_alias.removeprefix("restore-") if isinstance(edge_alias, str) else ""
        if not _RESTORE_ID.fullmatch(project_id):
            invalid.add("compose_project")
        if not _RESTORE_ID.fullmatch(database_id):
            invalid.add("db_name")
        if not _RESTORE_ID.fullmatch(alias_id):
            invalid.add("edge_alias")
        if len({project_id, database_id, alias_id}) != 1:
            invalid.update({"compose_project", "db_name", "edge_alias"})

    secrets_dir = _resolved_path(raw.get("secrets_dir"), "secrets_dir", invalid)
    state_dir = _resolved_path(raw.get("state_dir"), "state_dir", invalid)
    if secrets_dir == state_dir or secrets_dir in state_dir.parents or state_dir in secrets_dir.parents:
        invalid.update({"secrets_dir", "state_dir"})
    if invalid:
        raise DeployConfigError(", ".join(sorted(invalid)))

    return DeployConfig(
        environment=environment,
        provider=raw["provider"],
        region=region,
        platform=raw["platform"],
        public_origin=raw["public_origin"],
        compose_project=project,
        db_name=db_name,
        secrets_dir=secrets_dir,
        state_dir=state_dir,
        edge_alias=edge_alias,
        app_subnet=raw["app_subnet"],
    )


def assert_environment_isolation(configs: list[DeployConfig] | tuple[DeployConfig, ...]) -> None:
    invalid: set[str] = set()
    paths: list[tuple[str, Path]] = []
    subnets: list[ipaddress.IPv4Network] = []
    origins: set[str] = set()
    projects: set[str] = set()
    database_names: set[str] = set()
    aliases: set[str] = set()
    environments: set[str] = set()

    for config in configs:
        for value, seen, field in (
            (config.environment, environments, "environment"),
            (config.public_origin, origins, "public_origin"),
            (config.compose_project, projects, "compose_project"),
            (config.db_name, database_names, "db_name"),
            (config.edge_alias, aliases, "edge_alias"),
        ):
            if value in seen:
                invalid.add(field)
            seen.add(value)
        for field, path in (("secrets_dir", config.secrets_dir), ("state_dir", config.state_dir)):
            for previous_field, previous in paths:
                if path == previous or path in previous.parents or previous in path.parents:
                    invalid.update({field, previous_field})
            paths.append((field, path))
        subnet = ipaddress.ip_network(config.app_subnet, strict=True)
        if not isinstance(subnet, ipaddress.IPv4Network):
            invalid.add("app_subnet")
            continue
        if any(subnet.overlaps(previous) for previous in subnets):
            invalid.add("app_subnet")
        subnets.append(subnet)

    if invalid:
        raise DeployConfigError(", ".join(sorted(invalid)))
