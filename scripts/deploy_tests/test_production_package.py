"""Docker-backed production image smoke test; run only in a disposable CI project."""

from __future__ import annotations

import base64
import json
import os
import re
import secrets
import socket
import subprocess
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
PROJECT_PATTERN = re.compile(r"dayforge-package-test-[a-f0-9]{32}\Z")


class ProductionPackageSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.web_image = os.environ.get("DAYFORGE_PACKAGE_WEB_IMAGE", "")
        cls.api_image = os.environ.get("DAYFORGE_PACKAGE_API_IMAGE", "")
        cls.mysql_image = os.environ.get("DAYFORGE_PACKAGE_MYSQL_IMAGE", "")
        cls.build_id = os.environ.get("DAYFORGE_PACKAGE_BUILD_ID", "")
        if not all((cls.web_image, cls.api_image, cls.mysql_image)) or not re.fullmatch(
            r"[A-Za-z0-9._-]{1,128}", cls.build_id
        ):
            raise RuntimeError("Package smoke requires image references and a build ID")

    def setUp(self):
        self.run_id = uuid4().hex
        self.project = f"dayforge-package-test-{self.run_id}"
        self.ingress_network = f"{self.project}-ingress"
        self.assertRegex(self.project, PROJECT_PATTERN)
        self.temporary = tempfile.TemporaryDirectory(prefix="dayforge-package-")
        self.root = Path(self.temporary.name)
        self.secrets_dir = self.root / "secrets"
        self.secrets_dir.mkdir()
        self.secret_values = {}
        for name in (
            "mysql_root_password",
            "db_password",
            "db_migrator_password",
            "email_smtp_password",
        ):
            value = secrets.token_urlsafe(32)
            self.secret_values[name] = value
            (self.secrets_dir / name).write_text(value, encoding="utf-8")
        for name in (
            "local_key_kek_b64",
            "logout_ticket_key_b64",
            "auth_rate_limit_key_b64",
            "auth_email_outbox_key_b64",
            "sync_page_token_key_b64",
        ):
            value = (
                base64.urlsafe_b64encode(secrets.token_bytes(32))
                .decode("ascii")
                .rstrip("=")
            )
            self.secret_values[name] = value
            (self.secrets_dir / name).write_text(value, encoding="utf-8")
        (self.secrets_dir / "logout_ticket_previous_keys_b64").write_text(
            "", encoding="utf-8"
        )
        (self.secrets_dir / "email_smtp_username").write_text(
            "package-test-user", encoding="utf-8"
        )
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        self.subnet_octet = secrets.randbelow(200) + 20
        self.subnet = f"10.242.{self.subnet_octet}.0/24"
        self.env_file = self.root / "package.env"
        self.env_file.write_text(
            "\n".join(
                (
                    f"COMPOSE_PROJECT={self.project}",
                    "DEPLOYMENT_ENV=staging",
                    "APP_ENV=production",
                    "PUBLIC_ORIGIN=https://staging.example.test",
                    "DB_NAME=dayforge_staging",
                    "OWNER_EMAIL=owner@example.test",
                    "LOCAL_KEY_KEK_VERSION=1",
                    "EMAIL_SMTP_HOST=smtp.example.test",
                    "EMAIL_SMTP_PORT=587",
                    "EMAIL_FROM=dayforge@example.test",
                    "EMAIL_SMTP_TLS=starttls",
                    "EMAIL_SMTP_TIMEOUT_SECONDS=10",
                    f"APP_SUBNET={self.subnet}",
                    "EDGE_ALIAS=staging-web",
                    f"SECRETS_DIR={self.secrets_dir.as_posix()}",
                    f"WEB_IMAGE={self.web_image}",
                    f"API_IMAGE={self.api_image}",
                    f"MYSQL_IMAGE={self.mysql_image}",
                )
            )
            + "\n",
            encoding="utf-8",
        )
        self.override_file = self.root / "compose.override.yaml"
        self.override_file.write_text(
            "services:\n  web:\n    ports:\n      - 127.0.0.1:"
            + str(self.port)
            + ":3000\n",
            encoding="utf-8",
        )
        self.compose = [
            "docker",
            "compose",
            "--env-file",
            str(self.env_file),
            "-f",
            str(ROOT / "deploy" / "compose.app.yaml"),
            "-f",
            str(self.override_file),
        ]
        self.network_created = False

    def tearDown(self):
        try:
            if PROJECT_PATTERN.fullmatch(self.project):
                self._run(
                    [*self.compose, "down", "--volumes", "--remove-orphans"],
                    check=False,
                )
            if self.network_created and re.fullmatch(
                r"dayforge-package-test-[a-f0-9]{32}-ingress", self.ingress_network
            ):
                self._run(
                    ["docker", "network", "rm", self.ingress_network], check=False
                )
        finally:
            self.temporary.cleanup()

    def _run(self, command, *, check=True, timeout=240):
        try:
            result = subprocess.run(
                command,
                check=False,
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except OSError, subprocess.TimeoutExpired:
            self.fail("Docker package smoke command was unavailable or timed out")
        if check and result.returncode:
            diagnostics = self._service_diagnostics()
            self.fail(
                "Docker package smoke command failed "
                f"(exit code {result.returncode}); diagnostics: {diagnostics}"
            )
        return result

    def _service_diagnostics(self):
        result = subprocess.run(
            [*self.compose, "ps", "--all", "--format", "json"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        try:
            payload = json.loads(result.stdout)
            rows = payload if isinstance(payload, list) else [payload]
        except json.JSONDecodeError:
            rows = [json.loads(line) for line in result.stdout.splitlines() if line]
        statuses = [
            {
                "service": row.get("Service"),
                "state": row.get("State"),
                "health": row.get("Health"),
                "exit_code": row.get("ExitCode"),
            }
            for row in rows
            if isinstance(row, dict)
        ]
        failures = [
            row["service"]
            for row in statuses
            if row["service"]
            and row["state"] == "exited"
            and row["exit_code"] not in (None, 0, "0")
        ]
        logs = {}
        for service in failures:
            output = subprocess.run(
                [*self.compose, "logs", "--no-color", "--tail", "30", service],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
                timeout=30,
            ).stdout
            for value in self.secret_values.values():
                if value:
                    output = output.replace(value, "<redacted>")
                    output = output.replace(value.encode("utf-8").hex(), "<redacted>")
            logs[service] = output.splitlines()[-30:]
        return {"services": statuses, "failed_service_logs": logs}

    def _status(self, path):
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{self.port}{path}", timeout=8
            ) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code

    def _headers(self, path):
        with urllib.request.urlopen(
            f"http://127.0.0.1:{self.port}{path}", timeout=8
        ) as response:
            return response.headers

    def test_final_image_has_matching_manifest_assets_headers_and_live_api(self):
        network = self._run(["docker", "network", "create", self.ingress_network])
        self.network_created = network.returncode == 0
        self._run(
            [
                *self.compose,
                "up",
                "--detach",
                "--wait",
                "--wait-timeout",
                "180",
                "mysql",
            ],
            timeout=240,
        )
        self._run(
            [*self.compose, "run", "--rm", "--no-deps", "provision-users"],
            timeout=240,
        )
        self._run(
            [*self.compose, "run", "--rm", "--no-deps", "migrate", "upgrade", "head"],
            timeout=240,
        )
        self._run(
            [
                *self.compose,
                "up",
                "--detach",
                "--wait",
                "--wait-timeout",
                "180",
                "api",
                "web",
            ],
            timeout=240,
        )

        manifest_response = urllib.request.urlopen(
            f"http://127.0.0.1:{self.port}/dayforge-build.json", timeout=8
        )
        with manifest_response:
            manifest = json.load(manifest_response)
        self.assertEqual(manifest["build_id"], self.build_id)
        self.assertEqual(manifest["protocol_version"], 1)
        self.assertEqual(manifest["schema_version"], 2)
        self.assertTrue(manifest["assets"])
        self.assertEqual(self._status("/work"), 200)
        self.assertEqual(self._status("/milestones"), 200)
        self.assertEqual(self._status("/api/v1/health"), 200)
        self.assertEqual(self._status("/sync-browser"), 404)
        self.assertEqual(self._status("/offline-update"), 404)
        self.assertIn(
            "no-store", self._headers("/api/v1/health").get("Cache-Control", "").lower()
        )
        self.assertIn(
            "no-store", self._headers("/verify-email").get("Cache-Control", "").lower()
        )
        self.assertEqual(
            self._headers("/verify-email").get("Referrer-Policy"), "no-referrer"
        )
        self.assertIn(
            "no-store", self._headers("/sw.js").get("Cache-Control", "").lower()
        )
        for asset in manifest["assets"]:
            self.assertTrue(asset.startswith("/_next/static/"))
            self.assertEqual(self._status(asset), 200, asset)
        with urllib.request.urlopen(
            f"http://127.0.0.1:{self.port}/work", timeout=8
        ) as response:
            self.assertEqual(response.headers.get("X-Dayforge-Build"), self.build_id)

        resolved = json.loads(
            self._run([*self.compose, "config", "--format", "json"]).stdout
        )
        self.assertNotIn("ports", resolved["services"]["api"])
        self.assertNotIn("ports", resolved["services"]["mysql"])
        self.assertEqual(resolved["services"]["migrate"]["restart"], "no")
        self.assertEqual(
            resolved["volumes"]["mysql-data"]["name"], f"{self.project}-mysql-data"
        )
        for service in ("api", "web"):
            environment = resolved["services"][service].get("environment", {})
            self.assertNotIn("DAYFORGE_SYNC_TEST_HARNESS", environment)
            self.assertNotIn("DAYFORGE_OFFLINE_UPDATE_TEST_HARNESS", environment)
            self.assertNotIn("DAYFORGE_PLAYWRIGHT_MOCK_API", environment)
        for image, expected_user in (
            (self.web_image, "node"),
            (self.api_image, "10001:10001"),
        ):
            actual_user = self._run(
                ["docker", "image", "inspect", "--format", "{{.Config.User}}", image]
            ).stdout.strip()
            self.assertEqual(actual_user, expected_user)


if __name__ == "__main__":
    unittest.main()
