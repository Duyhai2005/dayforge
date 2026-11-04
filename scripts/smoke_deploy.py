"""Read-only HTTP checks for a Dayforge release at its public origin."""

from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urlsplit

_BUILD_ID = re.compile(r"[A-Za-z0-9._-]{1,128}\Z")


class SmokeDeploymentError(ValueError):
    """A safe smoke failure that never includes response bodies or URLs."""


@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    headers: dict[str, str]
    body: bytes


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _request(url: str, timeout_seconds: int) -> HttpResponse:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json, text/html, */*", "User-Agent": "dayforge-smoke/1"},
        method="GET",
    )
    try:
        opener = urllib.request.build_opener(_NoRedirect)
        with opener.open(request, timeout=timeout_seconds) as response:
            return HttpResponse(
                response.status,
                {key.lower(): value for key, value in response.headers.items()},
                response.read(2_000_001),
            )
    except OSError, TimeoutError, urllib.error.URLError, ValueError:
        raise SmokeDeploymentError("http_request_failed") from None


def smoke_deployment(
    origin: str,
    expected_build_id: str,
    *,
    timeout_seconds: int = 60,
    request: Callable[[str, int], HttpResponse] = _request,
) -> dict[str, bool]:
    """Check public shell/API endpoints without creating or changing user data."""
    parsed = urlsplit(origin)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.path
        or parsed.query
        or parsed.fragment
        or parsed.username is not None
        or parsed.password is not None
        or not _BUILD_ID.fullmatch(expected_build_id)
        or type(timeout_seconds) is not int
        or not 1 <= timeout_seconds <= 60
    ):
        raise SmokeDeploymentError("smoke_arguments_invalid")

    results: dict[str, bool] = {}
    for path in ("/work", "/milestones", "/sw.js"):
        response = request(origin + path, timeout_seconds)
        results[path] = response.status == 200 and response.headers.get("x-dayforge-build") == expected_build_id

    manifest_response = request(origin + "/dayforge-build.json", timeout_seconds)
    manifest_ok = False
    if (
        manifest_response.status == 200
        and manifest_response.headers.get("x-dayforge-build") == expected_build_id
        and len(manifest_response.body) <= 2_000_000
    ):
        try:
            manifest = json.loads(manifest_response.body)
        except UnicodeError, json.JSONDecodeError:
            manifest = None
        manifest_ok = (
            isinstance(manifest, dict)
            and manifest.get("build_id") == expected_build_id
            and manifest.get("protocol_version") == 1
            and type(manifest.get("schema_version")) is int
            and manifest.get("schema_version", 0) >= 1
            and manifest.get("routes") == ["/work", "/milestones"]
        )
    results["/dayforge-build.json"] = manifest_ok

    for path in ("/api/v1/health", "/api/v1/version"):
        response = request(origin + path, timeout_seconds)
        ok = response.status == 200
        if path.endswith("/health") and ok:
            try:
                payload = json.loads(response.body)
            except UnicodeError, json.JSONDecodeError:
                payload = None
            ok = isinstance(payload, dict) and payload.get("status") == "ok"
        if path.endswith("/version") and ok:
            try:
                payload = json.loads(response.body)
            except UnicodeError, json.JSONDecodeError:
                payload = None
            ok = (
                isinstance(payload, dict)
                and payload.get("protocol_versions") == [1]
                and payload.get("reducer_versions") == [1]
            )
        results[path] = ok

    if not all(results.values()):
        failed = ", ".join(path for path, passed in results.items() if not passed)
        raise SmokeDeploymentError("smoke_checks_failed: " + failed)
    return results


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--build-id", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=60)
    args = parser.parse_args(argv)
    try:
        results = smoke_deployment(args.origin, args.build_id, timeout_seconds=args.timeout_seconds)
    except SmokeDeploymentError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps({"status": "smoke_ok", "checks": results}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
