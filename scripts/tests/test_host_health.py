import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from scripts.check_host_health import HealthReport, check_host_health  # noqa: E402
from scripts.deploy_config import load_deploy_config  # noqa: E402


class HostHealthTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.config_path = self.root / "target.json"
        self.state = self.root / "staging" / "state"
        value = {
            "environment": "staging",
            "provider": "aws",
            "region": "ap-southeast-1",
            "platform": "linux/amd64",
            "public_origin": "https://stage.example.test",
            "compose_project": "dayforge-staging",
            "db_name": "dayforge_staging",
            "secrets_dir": str(self.root / "staging" / "secrets"),
            "state_dir": str(self.state),
            "edge_alias": "staging-web",
            "app_subnet": "10.81.10.0/24",
        }
        self.config_path.write_text(json.dumps(value), encoding="utf-8")
        self.config = load_deploy_config(self.config_path)
        self.now = datetime(2026, 11, 4, 12, tzinfo=timezone.utc)
        self.statuses = {"/api/v1/health": 200, "/work": 200}

    def tearDown(self):
        self.temporary.cleanup()

    def check(self, disk_percent=50, clock=True):
        self.state.mkdir(parents=True, exist_ok=True)
        return check_host_health(
            self.config,
            now=self.now,
            http_status=lambda url: next(
                (
                    status
                    for suffix, status in self.statuses.items()
                    if url.endswith(suffix)
                ),
                None,
            ),
            disk_usage=lambda _: SimpleNamespace(total=100, used=disk_percent),
            clock_synchronized=lambda: clock,
        )

    def test_reports_healthy_and_fixed_failure_codes(self):
        report = self.check()
        self.assertEqual(report, HealthReport(True, (), "2026-11-04T12:00:00Z"))
        self.statuses["/api/v1/health"] = 503
        self.assertIn("api_unhealthy", self.check().codes)
        self.assertNotIn("secret sentinel", str(report))

    def test_disk_pressure_starts_at_85_percent_and_clock_is_checked(self):
        self.assertNotIn("disk_pressure", self.check(disk_percent=84).codes)
        self.assertIn("disk_pressure", self.check(disk_percent=85).codes)
        self.assertIn("clock_unsynchronized", self.check(clock=False).codes)

    def test_backup_stale_only_when_enabled_and_after_26_hours(self):
        self.state.mkdir(parents=True, exist_ok=True)
        timestamp = (self.now - timedelta(hours=26)).isoformat().replace("+00:00", "Z")
        (self.state / "last-backup.json").write_text(
            json.dumps({"completed_at": timestamp}), encoding="utf-8"
        )
        self.assertNotIn("backup_stale", self.check().codes)
        (self.state / "backup.enabled").touch()
        self.assertNotIn("backup_stale", self.check().codes)
        timestamp = (
            (self.now - timedelta(hours=26, seconds=1))
            .isoformat()
            .replace("+00:00", "Z")
        )
        (self.state / "last-backup.json").write_text(
            json.dumps({"completed_at": timestamp}), encoding="utf-8"
        )
        self.assertIn("backup_stale", self.check().codes)

    def test_malformed_backup_report_is_fixed_code_not_content(self):
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / "backup.enabled").touch()
        (self.state / "last-backup.json").write_text(
            "private secret sentinel", encoding="utf-8"
        )
        report = self.check()
        self.assertIn("backup_stale", report.codes)
        self.assertNotIn("private secret sentinel", str(report))

    def test_rejects_naive_clock(self):
        with self.assertRaises(ValueError):
            check_host_health(self.config, now=datetime(2026, 11, 4))


if __name__ == "__main__":
    unittest.main()
