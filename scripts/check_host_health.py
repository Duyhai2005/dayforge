"""Bounded, secret-free Dayforge host health probes."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Protocol

from scripts.deploy_config import DeployConfig, DeployConfigError, load_deploy_config

_BACKUP_STALE_AFTER = timedelta(hours=26)


@dataclass(frozen=True, slots=True)
class HealthReport:
    healthy: bool
    codes: tuple[str, ...]
    checked_at: str


class DiskUsageInfo(Protocol):
    total: int
    used: int


def _http_status(url: str, timeout_seconds: float = 3.0) -> int | None:
    request = urllib.request.Request(url, method="GET", headers={"Cache-Control": "no-cache"})
    try:
        opener = urllib.request.build_opener(_NoRedirect())
        with opener.open(request, timeout=timeout_seconds) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except (OSError, TimeoutError, urllib.error.URLError, ValueError):
        return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _clock_synchronized() -> bool:
    try:
        result = subprocess.run(
            ["timedatectl", "show", "--property=NTPSynchronized", "--value"],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.TimeoutExpired):
        result = None
    if result is not None and result.returncode == 0:
        return result.stdout.strip().lower() == "yes"
    return Path("/run/systemd/timesync/synchronized").is_file()


def _docker_root_dir() -> Path | None:
    try:
        result = subprocess.run(
            ["docker", "info", "--format", "{{.DockerRootDir}}"],
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0 or not result.stdout.strip():
        return None
    path = Path(result.stdout.strip())
    return path if path.is_absolute() else None


def _backup_is_stale(state_dir: Path, now: datetime) -> bool:
    if not (state_dir / "backup.enabled").is_file():
        return False
    try:
        record = json.loads((state_dir / "last-backup.json").read_text(encoding="utf-8"))
        completed_at = record["completed_at"]
        if not isinstance(completed_at, str):
            return True
        timestamp = datetime.fromisoformat(completed_at.replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            return True
    except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError, ValueError):
        return True
    age = now.astimezone(timezone.utc) - timestamp.astimezone(timezone.utc)
    return age > _BACKUP_STALE_AFTER or age < timedelta(0)


def check_host_health(
    config: DeployConfig,
    *,
    now: datetime,
    http_status: Callable[[str], int | None] = _http_status,
    disk_usage: Callable[[Path], DiskUsageInfo] = shutil.disk_usage,
    clock_synchronized: Callable[[], bool] = _clock_synchronized,
    docker_root: Callable[[], Path | None] = _docker_root_dir,
) -> HealthReport:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("health_clock_invalid")
    instant = now.astimezone(timezone.utc)
    codes: list[str] = []
    origin = config.public_origin
    if http_status(origin + "/api/v1/health") != 200:
        codes.append("api_unhealthy")
    if http_status(origin + "/work") != 200:
        codes.append("web_unhealthy")

    disk_paths = [config.state_dir]
    root_dir = docker_root()
    if root_dir is not None and root_dir not in disk_paths:
        disk_paths.append(root_dir)
    for path in disk_paths:
        try:
            usage = disk_usage(path)
            percent = 100 * (usage.used / usage.total)
            if percent >= 85:
                codes.append("disk_pressure")
                break
        except (OSError, AttributeError, ZeroDivisionError, TypeError):
            codes.append("disk_pressure")
            break

    if _backup_is_stale(config.state_dir, instant):
        codes.append("backup_stale")
    if not clock_synchronized():
        codes.append("clock_unsynchronized")
    return HealthReport(
        healthy=not codes,
        codes=tuple(codes),
        checked_at=instant.isoformat(timespec="seconds").replace("+00:00", "Z"),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        config = load_deploy_config(args.config)
        report = check_host_health(config, now=datetime.now(timezone.utc))
    except (DeployConfigError, OSError, ValueError):
        print(json.dumps({"healthy": False, "codes": ["configuration_invalid"]}), file=sys.stderr)
        return 2
    print(
        json.dumps(
            {"healthy": report.healthy, "codes": list(report.codes), "checked_at": report.checked_at}, sort_keys=True
        )
    )
    return 0 if report.healthy else 1


if __name__ == "__main__":
    raise SystemExit(main())
