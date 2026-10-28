from __future__ import annotations

import argparse
import http.client
import json
import ssl
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPSHandler, HTTPRedirectHandler, Request, build_opener


DEFAULT_BASE_URL = "https://localhost:3000"
MAX_RESPONSE_BYTES = 1_048_576


class SmokeError(Exception):
    """A safe, concise failure that can be shown in a developer terminal."""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


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
        raise SmokeError(
            f"The local {label} probe returned HTTP {exc.code}."
        ) from None
    except (URLError, OSError, http.client.HTTPException) as exc:
        raise SmokeError(
            f"A local probe could not complete ({exc.__class__.__name__})."
        ) from None


def smoke_local(
    base_url: str, ca_file: Path, timeout_seconds: float = 10.0
) -> None:
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
        opener, origin + "/", "web", timeout_seconds
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
        raise SmokeError("The local API document does not match the bootstrap contract.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify the local HTTPS web/API path.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--ca-file", required=True, type=Path)
    args = parser.parse_args()

    try:
        smoke_local(args.base_url, args.ca_file)
    except SmokeError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1

    print("PASS: local HTTPS web and API bootstrap")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
