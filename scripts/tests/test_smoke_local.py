import copy
import importlib
import io
import json
import ssl
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import build_opener

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))
smoke_local = importlib.import_module("scripts.smoke_local")
from scripts.smoke_local import SmokeError, _get, _NoRedirect  # noqa: E402

VERSION = {
    "api_major": 1,
    "protocol_versions": [1],
    "reducer_versions": [1],
    "server_time": "2026-10-29T01:02:03.456Z",
    "limits": {
        "push_operations": 100,
        "push_request_bytes": 8388608,
        "operation_bytes": 2097152,
        "commands_per_operation": 1000,
        "page_operations": 200,
        "page_bytes": 8388608,
        "page_token_ttl_seconds": 1800,
    },
}


class SmokeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ca = Path(self.temp.name) / "ca.pem"
        self.ca.touch()
        self.responses = {
            "/work": (200, "text/html", b"<h1>DAYFORGE</h1>"),
            "/api/v1/openapi.json": (
                200,
                "application/json",
                json.dumps({"info": {"title": "DAYFORGE API"}, "paths": {}}).encode(),
            ),
            "/api/v1/health": (200, "application/json", b'{"status":"ok"}'),
            "/api/v1/version": (200, "application/json", json.dumps(VERSION).encode()),
        }
        self.seen = []

    def run_cli(self):
        def get(opener, url, label, timeout):
            self.assertTrue(url.startswith("https://localhost:3000/"))
            path = url.removeprefix("https://localhost:3000")
            self.seen.append(path)
            value = self.responses[path]
            if isinstance(value, Exception):
                raise value
            return value

        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(
            sys, "argv", ["smoke_local.py", "--ca-file", str(self.ca)]
        ), patch.object(smoke_local.ssl, "create_default_context"), patch.object(
            smoke_local, "_get", side_effect=get
        ), redirect_stdout(
            stdout
        ), redirect_stderr(
            stderr
        ):
            result = smoke_local.main()
        return result, stdout.getvalue(), stderr.getvalue()

    def test_success_requires_all_four_probes(self):
        result, stdout, stderr = self.run_cli()
        self.assertEqual(result, 0)
        self.assertEqual(
            self.seen,
            ["/work", "/api/v1/openapi.json", "/api/v1/health", "/api/v1/version"],
        )
        self.assertEqual(stdout, "PASS: local HTTPS web, API and MySQL readiness\n")
        self.assertEqual(stderr, "")

    def test_health_failure_never_reports_pass(self):
        for response in [
            (503, "application/json", b"{}"),
            (200, "application/json", b'{"status":"wrong"}'),
            (200, "application/json", b'{"status":"ok","extra":1}'),
            (200, "text/html", b"<html>DAYFORGE</html>"),
        ]:
            with self.subTest(response=response):
                self.responses["/api/v1/health"] = response
                result, stdout, stderr = self.run_cli()
                self.assertEqual(result, 1)
                self.assertNotIn("PASS", stdout)
                self.assertIn("FAIL:", stderr)

    def test_invalid_version_never_reports_pass(self):
        variants = [
            {"api_major": 2},
            {"api_major": True},
            {"protocol_versions": [True]},
            {"protocol_versions": [1, 1]},
            {"reducer_versions": [2]},
            {"server_time": "2026-02-30T01:02:03.456Z"},
            {"server_time": "2026-10-29T01:02:03.456+00:00"},
            {"server_time": "2026-10-29T01:02:03Z"},
            {"extra": 1},
        ]
        wrong_limit = copy.deepcopy(VERSION)
        wrong_limit["limits"]["push_operations"] = 99
        variants.append(wrong_limit)
        boolean_limit = copy.deepcopy(VERSION)
        boolean_limit["limits"]["push_operations"] = True
        variants.append(boolean_limit)
        for changes in variants:
            with self.subTest(changes=changes):
                body = dict(VERSION, **changes)
                self.responses["/api/v1/version"] = (
                    200,
                    "application/json",
                    json.dumps(body).encode(),
                )
                result, stdout, _ = self.run_cli()
                self.assertEqual(result, 1)
                self.assertNotIn("PASS", stdout)

    def test_duplicate_response_keys_never_report_pass_or_echo_payload(self):
        version = json.dumps(VERSION)
        responses = [
            ("/api/v1/health", b'{"status":"private-sentinel","status":"ok"}'),
            (
                "/api/v1/version",
                version.replace(
                    '"api_major": 1', '"api_major": "private-sentinel", "api_major": 1'
                ).encode(),
            ),
            (
                "/api/v1/version",
                version.replace(
                    '"push_operations": 100',
                    '"push_operations": "private-sentinel", "push_operations": 100',
                ).encode(),
            ),
        ]
        for path, body in responses:
            with self.subTest(path=path, body=body):
                original = self.responses[path]
                self.responses[path] = (200, "application/json", body)
                result, stdout, stderr = self.run_cli()
                self.responses[path] = original
                self.assertEqual(result, 1)
                self.assertNotIn("PASS", stdout)
                label = path.rsplit("/", 1)[1]
                self.assertEqual(
                    stderr, f"FAIL: The local {label} probe returned invalid JSON.\n"
                )
                self.assertNotIn("private-sentinel", stdout + stderr)

    def test_version_rejects_normalized_midnight_timestamp(self):
        body = dict(VERSION, server_time="2026-10-29T24:00:00.000Z")
        self.responses["/api/v1/version"] = (
            200,
            "application/json",
            json.dumps(body).encode(),
        )
        result, stdout, stderr = self.run_cli()
        self.assertEqual(result, 1)
        self.assertNotIn("PASS", stdout)
        self.assertEqual(
            stderr, "FAIL: The local version probe has an invalid UTC timestamp.\n"
        )

    def test_proxy_html_and_invalid_json_never_report_pass(self):
        for path in ["/api/v1/health", "/api/v1/version"]:
            for content_type, body in [
                ("text/html", b"<html>DAYFORGE</html>"),
                ("application/json", b"not json"),
            ]:
                with self.subTest(path=path, body=body):
                    original = self.responses[path]
                    self.responses[path] = (200, content_type, body)
                    result, stdout, _ = self.run_cli()
                    self.assertEqual(result, 1)
                    self.assertNotIn("PASS", stdout)
                    self.responses[path] = original

    def test_origin_rejects_credentials_and_other_hosts(self):
        for url in [
            "http://localhost:3000",
            "https://example.com",
            "https://a:b@localhost:3000",
        ]:
            with self.subTest(url=url), self.assertRaises(smoke_local.SmokeError):
                smoke_local._validate_base_url(url)

    def test_redirect_is_refused_and_http_error_is_sanitized(self):
        self.assertIsNone(
            smoke_local._NoRedirect().redirect_request(
                None, None, 302, "redirect", {}, "https://example.com"
            )
        )
        http_error = HTTPError(
            "https://localhost/private", 503, "private-sentinel", {}, None
        )
        self.addCleanup(http_error.close)

        class ErrorOpener:
            def open(self, *args, **kwargs):
                raise http_error

        with self.assertRaises(smoke_local.SmokeError) as error:
            smoke_local._get(ErrorOpener(), "https://localhost/", "health", 1)
        self.assertIn("503", str(error.exception))
        self.assertNotIn("private", str(error.exception))


class FixtureResponse(io.BytesIO):
    def __init__(self, body: bytes, content_type: str, status: int = 200) -> None:
        super().__init__(body)
        self.status = status
        self.headers = {"Content-Type": content_type}


class T06RouteFixture:
    """External transport fixture: root redirects, calendar and API are direct."""

    def open(self, request, timeout):
        path = urlsplit(request.full_url).path
        if path == "/work":
            return FixtureResponse(b"<h1>DAYFORGE</h1>", "text/html")
        if path == "/api/v1/openapi.json":
            document = {"info": {"title": "DAYFORGE API"}, "paths": {}}
            return FixtureResponse(json.dumps(document).encode(), "application/json")
        if path == "/api/v1/health":
            return FixtureResponse(b'{"status":"ok"}', "application/json")
        if path == "/api/v1/version":
            return FixtureResponse(json.dumps(VERSION).encode(), "application/json")
        if path == "/":
            return FixtureResponse(b"Redirect", "text/html", 307)
        return FixtureResponse(b"Not Found", "text/html", 404)


class SmokeLocalTests(unittest.TestCase):
    def test_reads_calendar_route_without_following_root_redirect(self) -> None:
        # TLS loading is outside this path regression; keep real probe validation
        # and replace only the external transport/configuration boundary.
        with tempfile.TemporaryDirectory() as temp_dir:
            ca_file = Path(temp_dir) / "fixture-ca.pem"
            ca_file.write_text("transport fixture", encoding="utf-8")
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            with (
                patch(
                    "scripts.smoke_local.ssl.create_default_context",
                    return_value=context,
                ),
                patch(
                    "scripts.smoke_local.build_opener", return_value=T06RouteFixture()
                ),
            ):
                try:
                    smoke_local.smoke_local("https://localhost:3000", ca_file)
                except SmokeError as error:
                    self.fail(f"The direct calendar/API fixture must pass: {error}")

    def test_rejects_redirect_without_requesting_destination(self) -> None:
        visited: list[str] = []

        class RedirectHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                visited.append(self.path)
                if self.path == "/work":
                    self.send_response(307)
                    self.send_header("Location", "/destination")
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"DAYFORGE")

            def log_message(self, format, *args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler) as server:
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                opener = build_opener(_NoRedirect())
                with self.assertRaisesRegex(SmokeError, "web probe returned HTTP 307"):
                    _get(
                        opener, f"http://127.0.0.1:{server.server_port}/work", "web", 2
                    )
            finally:
                server.shutdown()
                worker.join()
        self.assertEqual(visited, ["/work"])


if __name__ == "__main__":
    unittest.main()
