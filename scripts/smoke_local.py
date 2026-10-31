from __future__ import annotations

import argparse
import http.client
import json
import re
import ssl
import sys
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

DEFAULT_BASE_URL = "https://localhost:3000"
MAX_RESPONSE_BYTES = 1_048_576
VERSION_LIMITS = {
    "push_operations": 100,
    "push_request_bytes": 8388608,
    "operation_bytes": 2097152,
    "commands_per_operation": 1000,
    "page_operations": 200,
    "page_bytes": 8388608,
    "page_token_ttl_seconds": 1800,
}


class SmokeError(Exception):
    """A safe, concise failure that can be shown in a developer terminal."""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _unique_object(pairs):
    document = {}
    for key, value in pairs:
        if key in document:
            raise ValueError("duplicate_json_key")
        document[key] = value
    return document


def _get_json(opener, url: str, label: str, timeout_seconds: float):
    status, content_type, body = _get(opener, url, label, timeout_seconds)
    if status != 200 or "application/json" not in content_type.lower():
        raise SmokeError(f"The local {label} probe must return HTTP 200 and JSON.")
    try:
        return json.loads(body, object_pairs_hook=_unique_object)
    except ValueError:
        raise SmokeError(f"The local {label} probe returned invalid JSON.") from None


def _validate_version(document) -> None:
    valid = (
        isinstance(document, dict)
        and set(document)
        == {
            "api_major",
            "protocol_versions",
            "reducer_versions",
            "server_time",
            "limits",
        }
        and type(document["api_major"]) is int
        and document["api_major"] == 1
        and all(
            type(document[key]) is list
            and len(document[key]) == 1
            and type(document[key][0]) is int
            and document[key][0] == 1
            for key in ("protocol_versions", "reducer_versions")
        )
        and isinstance(document["limits"], dict)
        and document["limits"] == VERSION_LIMITS
        and all(type(value) is int for value in document["limits"].values())
        and isinstance(document["server_time"], str)
        and re.fullmatch(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z",
            document["server_time"],
        )
    )
    if not valid:
        raise SmokeError("The local version probe does not match the system contract.")
    try:
        timestamp = document["server_time"]
        datetime(
            int(timestamp[0:4]),
            int(timestamp[5:7]),
            int(timestamp[8:10]),
            int(timestamp[11:13]),
            int(timestamp[14:16]),
            int(timestamp[17:19]),
            int(timestamp[20:23]) * 1000,
        )
    except ValueError:
        raise SmokeError(
            "The local version probe has an invalid UTC timestamp."
        ) from None


def _validate_base_url(base_url: str) -> str:
    try:
        parsed = urlsplit(base_url)
        port = parsed.port
    except ValueError as exc:
        raise SmokeError("The local base URL is invalid.") from exc

    if (
        parsed.scheme != "https"
        or parsed.hostname != "localhost"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
        or not parsed.netloc
        or (port is not None and not 1 <= port <= 65535)
    ):
        raise SmokeError("The base URL must be an HTTPS localhost origin only.")

    return base_url


def _get(
    opener, url: str, label: str, timeout_seconds: float
) -> tuple[int, str, bytes]:
    request = Request(url, method="GET", headers={"Accept": "*/*"})
    try:
        with opener.open(request, timeout=timeout_seconds) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                raise SmokeError("A local probe response exceeded the size limit.")
            return response.status, response.headers.get("Content-Type", ""), body
    except HTTPError as exc:
        exc.close()
        raise SmokeError(f"The local {label} probe returned HTTP {exc.code}.") from None
    except (URLError, OSError, http.client.HTTPException) as exc:
        raise SmokeError(
            f"A local probe could not complete ({exc.__class__.__name__})."
        ) from None


def smoke_local(base_url: str, ca_file: Path, timeout_seconds: float = 10.0) -> None:
    origin = _validate_base_url(base_url)
    ca_path = Path(ca_file)
    if not ca_path.is_file():
        raise SmokeError("The specified CA certificate file does not exist.")
    if timeout_seconds <= 0:
        raise SmokeError("The probe timeout must be positive.")

    try:
        tls_context = ssl.create_default_context(cafile=str(ca_path))
    except (OSError, ssl.SSLError) as exc:
        raise SmokeError(
            f"The CA certificate could not be loaded ({exc.__class__.__name__})."
        ) from None

    opener = build_opener(_NoRedirect(), HTTPSHandler(context=tls_context))
    web_status, web_content_type, web_body = _get(
        opener, origin + "/work", "web", timeout_seconds
    )
    if web_status != 200:
        raise SmokeError("The local web probe did not return HTTP 200.")
    if "text/html" not in web_content_type.lower():
        raise SmokeError("The local web probe did not return HTML.")
    if b"DAYFORGE" not in web_body:
        raise SmokeError("The local web page is missing the DAYFORGE heading.")

    api_status, api_content_type, api_body = _get(
        opener, origin + "/api/v1/openapi.json", "API", timeout_seconds
    )
    if api_status != 200:
        raise SmokeError("The local API probe did not return HTTP 200.")
    if "application/json" not in api_content_type.lower():
        raise SmokeError("The local API probe did not return JSON.")
    try:
        api_document = json.loads(api_body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise SmokeError("The local API probe returned invalid JSON.") from None

    if (
        not isinstance(api_document, dict)
        or not isinstance(api_document.get("info"), dict)
        or api_document["info"].get("title") != "DAYFORGE API"
        or not isinstance(api_document.get("paths"), dict)
    ):
        raise SmokeError(
            "The local API document does not match the bootstrap contract."
        )

    health = _get_json(opener, origin + "/api/v1/health", "health", timeout_seconds)
    if health != {"status": "ok"}:
        raise SmokeError("The local health probe does not report MySQL readiness.")
    version = _get_json(opener, origin + "/api/v1/version", "version", timeout_seconds)
    _validate_version(version)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify local HTTPS web/API and MySQL readiness."
    )
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--ca-file", required=True, type=Path)
    args = parser.parse_args()

    try:
        smoke_local(args.base_url, args.ca_file)
    except SmokeError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1

    print("PASS: local HTTPS web, API and MySQL readiness")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
