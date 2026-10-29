import copy
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import smoke_local


VERSION = {
    "api_major": 1, "protocol_versions": [1], "reducer_versions": [1],
    "server_time": "2026-10-29T01:02:03.456Z",
    "limits": {
        "push_operations": 100, "push_request_bytes": 8388608,
        "operation_bytes": 2097152, "commands_per_operation": 1000,
        "page_operations": 200, "page_bytes": 8388608, "page_token_ttl_seconds": 1800,
    },
}


class SmokeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ca = Path(self.temp.name) / "ca.pem"
        self.ca.touch()
        self.responses = {
            "/": (200, "text/html", b"<h1>DAYFORGE</h1>"),
            "/api/v1/openapi.json": (200, "application/json", json.dumps({
                "info": {"title": "DAYFORGE API"}, "paths": {}}).encode()),
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
        with patch.object(sys, "argv", ["smoke_local.py", "--ca-file", str(self.ca)]), \
                patch.object(smoke_local.ssl, "create_default_context"), \
                patch.object(smoke_local, "_get", side_effect=get), \
                redirect_stdout(stdout), redirect_stderr(stderr):
            result = smoke_local.main()
        return result, stdout.getvalue(), stderr.getvalue()

    def test_success_requires_all_four_probes(self):
        result, stdout, stderr = self.run_cli()
        self.assertEqual(result, 0)
        self.assertEqual(self.seen, ["/", "/api/v1/openapi.json", "/api/v1/health", "/api/v1/version"])
        self.assertEqual(stdout, "PASS: local HTTPS web, API and MySQL readiness\n")
        self.assertEqual(stderr, "")

    def test_health_failure_never_reports_pass(self):
        for response in [(503, "application/json", b"{}"),
                         (200, "application/json", b'{"status":"wrong"}'),
                         (200, "application/json", b'{"status":"ok","extra":1}'),
                         (200, "text/html", b"<html>DAYFORGE</html>")]:
            with self.subTest(response=response):
                self.responses["/api/v1/health"] = response
                result, stdout, stderr = self.run_cli()
                self.assertEqual(result, 1)
                self.assertNotIn("PASS", stdout)
                self.assertIn("FAIL:", stderr)

    def test_invalid_version_never_reports_pass(self):
        variants = [{"api_major": 2}, {"api_major": True}, {"protocol_versions": [True]},
                    {"protocol_versions": [1, 1]}, {"reducer_versions": [2]},
                    {"server_time": "2026-02-30T01:02:03.456Z"},
                    {"server_time": "2026-10-29T01:02:03.456+00:00"},
                    {"server_time": "2026-10-29T01:02:03Z"}, {"extra": 1}]
        wrong_limit = copy.deepcopy(VERSION)
        wrong_limit["limits"]["push_operations"] = 99
        variants.append(wrong_limit)
        boolean_limit = copy.deepcopy(VERSION)
        boolean_limit["limits"]["push_operations"] = True
        variants.append(boolean_limit)
        for changes in variants:
            with self.subTest(changes=changes):
                body = dict(VERSION, **changes)
                self.responses["/api/v1/version"] = (200, "application/json", json.dumps(body).encode())
                result, stdout, _ = self.run_cli()
                self.assertEqual(result, 1)
                self.assertNotIn("PASS", stdout)

    def test_duplicate_response_keys_never_report_pass_or_echo_payload(self):
        version = json.dumps(VERSION)
        responses = [
            ("/api/v1/health", b'{"status":"private-sentinel","status":"ok"}'),
            ("/api/v1/version", version.replace(
                '"api_major": 1', '"api_major": "private-sentinel", "api_major": 1').encode()),
            ("/api/v1/version", version.replace(
                '"push_operations": 100',
                '"push_operations": "private-sentinel", "push_operations": 100').encode()),
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
                self.assertEqual(stderr, f"FAIL: The local {label} probe returned invalid JSON.\n")
                self.assertNotIn("private-sentinel", stdout + stderr)

    def test_version_rejects_normalized_midnight_timestamp(self):
        body = dict(VERSION, server_time="2026-10-29T24:00:00.000Z")
        self.responses["/api/v1/version"] = (200, "application/json", json.dumps(body).encode())
        result, stdout, stderr = self.run_cli()
        self.assertEqual(result, 1)
        self.assertNotIn("PASS", stdout)
        self.assertEqual(stderr, "FAIL: The local version probe has an invalid UTC timestamp.\n")

    def test_proxy_html_and_invalid_json_never_report_pass(self):
        for path in ["/api/v1/health", "/api/v1/version"]:
            for content_type, body in [("text/html", b"<html>DAYFORGE</html>"),
                                       ("application/json", b"not json")]:
                with self.subTest(path=path, body=body):
                    original = self.responses[path]
                    self.responses[path] = (200, content_type, body)
                    result, stdout, _ = self.run_cli()
                    self.assertEqual(result, 1)
                    self.assertNotIn("PASS", stdout)
                    self.responses[path] = original

    def test_origin_rejects_credentials_and_other_hosts(self):
        for url in ["http://localhost:3000", "https://example.com", "https://a:b@localhost:3000"]:
            with self.subTest(url=url), self.assertRaises(smoke_local.SmokeError):
                smoke_local._validate_base_url(url)

    def test_redirect_is_refused_and_http_error_is_sanitized(self):
        self.assertIsNone(smoke_local._NoRedirect().redirect_request(
            None, None, 302, "redirect", {}, "https://example.com"))
        http_error = HTTPError("https://localhost/private", 503, "private-sentinel", {}, None)
        self.addCleanup(http_error.close)
        class ErrorOpener:
            def open(self, *args, **kwargs):
                raise http_error
        with self.assertRaises(smoke_local.SmokeError) as error:
            smoke_local._get(ErrorOpener(), "https://localhost/", "health", 1)
        self.assertIn("503", str(error.exception))
        self.assertNotIn("private", str(error.exception))


if __name__ == "__main__":
    unittest.main()
