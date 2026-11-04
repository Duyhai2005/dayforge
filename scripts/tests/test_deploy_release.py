import json
import subprocess
import sys
import tempfile
import unittest
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from scripts.check_release_compatibility import RuntimeCompatibility  # noqa: E402
from scripts.deploy_config import load_deploy_config  # noqa: E402
from scripts.deploy_release import (  # noqa: E402
    DeploymentError,
    activate_restored_release,
    deploy_release,
    rollback_release,
)
from scripts.release_manifest import ReleaseManifest  # noqa: E402


class FakeRunner:
    def __init__(self, fail_on=None, table_count=0, current_revision=None):
        self.events = []
        self.fail_on = fail_on
        self.migrated = False
        self.table_count = table_count
        self.current_revision = current_revision

    def __call__(self, arguments, environment):
        args = list(arguments)
        event = args[args.index("compose") + 1 :]
        self.events.append((event, dict(environment)))
        if self.fail_on and self.fail_on in event:
            return subprocess.CompletedProcess(
                args, 1, "private secret sentinel", "private sentinel"
            )
        if any("SELECT COUNT(*)" in item for item in event):
            stdout = f"{self.table_count}\n"
        elif "upgrade" in event:
            self.migrated = True
            self.current_revision = "0004_sync"
            stdout = ""
        elif event[-1:] == ["current"]:
            stdout = (
                f"{self.current_revision} (head)\n" if self.current_revision else ""
            )
        else:
            stdout = ""
        return subprocess.CompletedProcess(args, 0, stdout, "")


class DeployReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state = self.root / "staging" / "state"
        self.state.mkdir(parents=True)
        (self.state / "edge-maintenance").mkdir()
        self.secrets = self.root / "staging" / "secrets"
        self.secrets.mkdir(parents=True)
        self.env_file = self.secrets.parent / "runtime.env"
        self.env_file.write_text("OWNER_EMAIL=owner@example.test\n", encoding="utf-8")
        self.compose_file = self.root / "compose.app.yaml"
        self.compose_file.write_text("services: {}\n", encoding="utf-8")
        target = {
            "environment": "staging",
            "provider": "aws",
            "region": "ap-southeast-1",
            "platform": "linux/amd64",
            "public_origin": "https://stage.example.test",
            "compose_project": "dayforge-staging",
            "db_name": "dayforge_staging",
            "secrets_dir": str(self.secrets),
            "state_dir": str(self.state),
            "edge_alias": "staging-web",
            "app_subnet": "10.81.10.0/24",
        }
        self.target_path = self.root / "target.json"
        self.target_path.write_text(json.dumps(target), encoding="utf-8")
        self.config = load_deploy_config(self.target_path)
        self.release = ReleaseManifest(
            release_id="release-20261104-a1b2c3d4",
            git_sha="a" * 40,
            build_id="build-123",
            platform="linux/amd64",
            web_image=f"ghcr.io/dayforge/web@sha256:{'b' * 64}",
            api_image=f"ghcr.io/dayforge/api@sha256:{'c' * 64}",
            mysql_image=f"mysql@sha256:{'d' * 64}",
            required_db_revision="0004_sync",
            supported_db_revisions=("0004_sync",),
            indexeddb_schema_version=2,
            supported_indexeddb_schema_versions=(1, 2),
            protocol_versions=(1,),
            reducer_versions=(1,),
            created_at="2026-11-04T04:00:00Z",
        )

    def tearDown(self):
        self.temporary.cleanup()

    def deploy(self, runner, **kwargs):
        return deploy_release(
            self.config,
            self.release,
            env_file=self.env_file,
            compose_file=self.compose_file,
            runner=runner,
            smoke=lambda origin, build_id: {"ok": True},
            now=datetime(2026, 11, 4, 12, tzinfo=timezone.utc),
            **kwargs,
        )

    def rollback(self, runner, current_release, target_release=None, **kwargs):
        return rollback_release(
            self.config,
            current_release,
            target_release or self.release,
            RuntimeCompatibility("0004_sync", 2, 1, 1),
            env_file=self.env_file,
            compose_file=self.compose_file,
            runner=runner,
            smoke=lambda origin, build_id: {"ok": True},
            now=datetime(2026, 11, 4, 12, tzinfo=timezone.utc),
            **kwargs,
        )

    def current_release(self):
        return replace(
            self.release,
            release_id="release-20261104-b5c6d7e8",
            build_id="build-456",
            web_image=f"ghcr.io/dayforge/web@sha256:{'e' * 64}",
            api_image=f"ghcr.io/dayforge/api@sha256:{'f' * 64}",
            created_at="2026-11-04T05:00:00Z",
        )

    def prepare_rollback(self, current_release):
        (self.state / "current-release.json").write_text(
            json.dumps(
                {
                    "release_id": current_release.release_id,
                    "git_sha": current_release.git_sha,
                    "build_id": current_release.build_id,
                    "database_revision": "0004_sync",
                    "recorded_at": "2026-11-04T11:00:00Z",
                }
            ),
            encoding="utf-8",
        )
        (self.state / "backup.enabled").touch()
        (self.state / "last-backup.json").write_text(
            json.dumps({"completed_at": "2026-11-04T11:00:00Z"}),
            encoding="utf-8",
        )

    def test_initializes_only_empty_staging_and_starts_after_migration(self):
        runner = FakeRunner()
        result = self.deploy(runner, initialize=True)
        self.assertEqual(result.migrated_revision, "0004_sync")
        self.assertTrue(result.healthy)
        self.assertTrue((self.state / "current-release.json").is_file())
        events = [event for event, _ in runner.events]
        migration_index = next(
            index for index, event in enumerate(events) if "upgrade" in event
        )
        start_index = next(
            index
            for index, event in enumerate(events)
            if "api" in event and "web" in event and "up" in event
        )
        internal_smoke_index = next(
            index
            for index, event in enumerate(events)
            if "node" in event and "-e" in event
        )
        self.assertLess(migration_index, start_index)
        self.assertLess(start_index, internal_smoke_index)
        self.assertIn("--no-deps", events[migration_index])
        self.assertFalse((self.state / "operation.lock").exists())
        self.assertFalse((self.state / "edge-maintenance" / "on").exists())

    def _restore_config(self):
        restore_id = "a" * 32
        target = {
            "environment": "restore",
            "provider": "aws",
            "region": "ap-southeast-1",
            "platform": "linux/amd64",
            "public_origin": "https://restore.example.test",
            "compose_project": f"dayforge-restore-{restore_id}",
            "db_name": f"dayforge_restore_{restore_id}",
            "secrets_dir": str(self.secrets),
            "state_dir": str(self.state),
            "edge_alias": f"restore-{restore_id}",
            "app_subnet": "10.81.10.0/24",
        }
        target_path = self.root / "restore-target.json"
        target_path.write_text(json.dumps(target), encoding="utf-8")
        return load_deploy_config(target_path)

    def _write_restore_ready(self, snapshot_id):
        (self.state / "restore-ready.json").write_text(
            json.dumps(
                {
                    "snapshot_id": snapshot_id,
                    "source_environment": "staging",
                    "restored_revision": "0004_sync",
                    "verified_dump_sha256": "f" * 64,
                    "completed_at": "2026-11-04T11:00:00Z",
                }
            ),
            encoding="utf-8",
        )

    def test_restored_release_starts_without_migration(self):
        config = self._restore_config()
        snapshot_id = "e" * 64
        self._write_restore_ready(snapshot_id)
        runner = FakeRunner(table_count=12, current_revision="0004_sync")

        result = activate_restored_release(
            config,
            self.release,
            snapshot_id=snapshot_id,
            env_file=self.env_file,
            compose_file=self.compose_file,
            runner=runner,
            now=datetime(2026, 11, 4, 12, tzinfo=timezone.utc),
            smoke=lambda origin, build_id: {"ok": True},
        )

        events = [event for event, _ in runner.events]
        self.assertTrue(result.healthy)
        self.assertEqual(result.migrated_revision, "0004_sync")
        self.assertTrue((self.state / "current-release.json").is_file())
        self.assertFalse(any("upgrade" in event for event in events))
        self.assertFalse(any("restore_database" in event for event in events))

    def test_restored_release_rejects_wrong_snapshot_before_commands(self):
        config = self._restore_config()
        self._write_restore_ready("e" * 64)
        runner = FakeRunner(table_count=12, current_revision="0004_sync")

        with self.assertRaisesRegex(DeploymentError, "restore_ready_record_mismatch"):
            activate_restored_release(
                config,
                self.release,
                snapshot_id="d" * 64,
                env_file=self.env_file,
                compose_file=self.compose_file,
                runner=runner,
                smoke=lambda origin, build_id: {"ok": True},
            )
        self.assertEqual(runner.events, [])

    def test_migration_failure_does_not_start_candidate_or_echo_output(self):
        runner = FakeRunner(fail_on="upgrade")
        with self.assertRaises(DeploymentError) as caught:
            self.deploy(runner, initialize=True)
        self.assertEqual(str(caught.exception), "migration_failed")
        self.assertNotIn("private secret sentinel", str(caught.exception))
        self.assertFalse(
            any(
                "api" in event and "web" in event and "up" in event
                for event, _ in runner.events
            )
        )
        self.assertTrue((self.state / "edge-maintenance" / "on").is_file())

    def test_failed_smoke_does_not_write_current_release(self):
        runner = FakeRunner()
        with self.assertRaises(DeploymentError) as caught:
            deploy_release(
                self.config,
                self.release,
                initialize=True,
                env_file=self.env_file,
                compose_file=self.compose_file,
                runner=runner,
                now=datetime(2026, 11, 4, 12, tzinfo=timezone.utc),
                smoke=lambda origin, build_id: (_ for _ in ()).throw(
                    ValueError("private sentinel")
                ),
            )
        self.assertEqual(str(caught.exception), "post_deploy_smoke_failed")
        self.assertFalse((self.state / "current-release.json").exists())
        self.assertTrue((self.state / "edge-maintenance" / "on").is_file())

    def test_concurrent_lock_and_platform_mismatch_stop_before_commands(self):
        lock = self.state / "operation.lock"
        lock.touch()
        runner = FakeRunner()
        with self.assertRaisesRegex(DeploymentError, "already_running"):
            self.deploy(runner, initialize=True)
        self.assertEqual(runner.events, [])
        lock.unlink()
        bad = replace(self.release, platform="linux/arm64")
        with self.assertRaisesRegex(DeploymentError, "platform_mismatch"):
            deploy_release(self.config, bad, runner=runner, initialize=True)
        self.assertEqual(runner.events, [])

    def test_missing_maintenance_gate_refuses_before_database_commands(self):
        (self.state / "edge-maintenance").rmdir()
        runner = FakeRunner()
        with self.assertRaisesRegex(DeploymentError, "maintenance_gate_unavailable"):
            self.deploy(runner, initialize=True)
        self.assertEqual(runner.events, [])

    def test_upgrade_requires_recent_backup_before_maintenance_or_migration(self):
        (self.state / "current-release.json").write_text("{}", encoding="utf-8")
        runner = FakeRunner(table_count=1, current_revision="0004_sync")
        with self.assertRaisesRegex(DeploymentError, "recent_backup_required"):
            self.deploy(runner)
        events = [event for event, _ in runner.events]
        self.assertNotIn(
            "upgrade", [argument for event in events for argument in event]
        )
        self.assertFalse((self.state / "edge-maintenance" / "on").exists())

    def test_upgrade_runs_after_recent_backup_and_clears_maintenance(self):
        (self.state / "current-release.json").write_text("{}", encoding="utf-8")
        (self.state / "backup.enabled").touch()
        (self.state / "last-backup.json").write_text(
            json.dumps({"completed_at": "2026-11-04T11:00:00Z"}), encoding="utf-8"
        )
        runner = FakeRunner(table_count=1, current_revision="0004_sync")
        result = self.deploy(runner)
        self.assertTrue(result.healthy)
        self.assertFalse((self.state / "edge-maintenance" / "on").exists())

    def test_production_target_is_refused_before_any_command(self):
        raw = json.loads(self.target_path.read_text(encoding="utf-8"))
        raw.update(
            environment="production",
            compose_project="dayforge-production",
            db_name="dayforge_production",
            edge_alias="production-web",
            app_subnet="10.81.20.0/24",
        )
        self.target_path.write_text(json.dumps(raw), encoding="utf-8")
        from scripts.deploy_config import load_deploy_config

        production = load_deploy_config(self.target_path)
        runner = FakeRunner()
        with self.assertRaisesRegex(DeploymentError, "environment_not_allowed"):
            deploy_release(production, self.release, runner=runner, initialize=True)
        self.assertEqual(runner.events, [])

    def test_incompatible_rollback_is_refused_before_any_command(self):
        current = self.current_release()
        self.prepare_rollback(current)
        runner = FakeRunner(table_count=1, current_revision="0005_rehearsal")

        with self.assertRaisesRegex(DeploymentError, "rollback_incompatible"):
            rollback_release(
                self.config,
                current,
                self.release,
                RuntimeCompatibility("0005_rehearsal", 2, 1, 1),
                env_file=self.env_file,
                compose_file=self.compose_file,
                runner=runner,
            )

        self.assertEqual(runner.events, [])
        self.assertFalse((self.state / "edge-maintenance" / "on").exists())

    def test_compatible_binary_rollback_keeps_database_and_never_migrates(self):
        current = self.current_release()
        self.prepare_rollback(current)
        runner = FakeRunner(table_count=1, current_revision="0004_sync")

        result = self.rollback(runner, current)

        self.assertTrue(result.healthy)
        self.assertEqual(result.migrated_revision, "0004_sync")
        events = [event for event, _ in runner.events]
        self.assertFalse(
            any("upgrade" in event or "downgrade" in event for event in events)
        )
        self.assertFalse(any("restore_database" in event for event in events))
        self.assertTrue(any(event[-2:] == ["api", "web"] for event in events))
        self.assertTrue(
            all(
                env["COMPOSE_PROJECT"] == "dayforge-staging" for _, env in runner.events
            )
        )
        self.assertTrue(
            all(env["MYSQL_IMAGE"] == current.mysql_image for _, env in runner.events)
        )
        recorded = json.loads(
            (self.state / "current-release.json").read_text(encoding="utf-8")
        )
        self.assertEqual(recorded["release_id"], self.release.release_id)
        self.assertEqual(recorded["database_revision"], "0004_sync")
        self.assertFalse((self.state / "edge-maintenance" / "on").exists())

    def test_failed_candidate_smoke_restores_the_current_release(self):
        current = self.current_release()
        self.prepare_rollback(current)
        runner = FakeRunner(table_count=1, current_revision="0004_sync")
        smoke_calls = []

        def smoke(origin, build_id):
            smoke_calls.append(build_id)
            if build_id == self.release.build_id:
                raise ValueError("private smoke detail")
            return {"ok": True}

        with self.assertRaisesRegex(
            DeploymentError, "rollback_candidate_failed_previous_restored"
        ):
            rollback_release(
                self.config,
                current,
                self.release,
                RuntimeCompatibility("0004_sync", 2, 1, 1),
                env_file=self.env_file,
                compose_file=self.compose_file,
                runner=runner,
                smoke=smoke,
                now=datetime(2026, 11, 4, 12, tzinfo=timezone.utc),
            )

        self.assertEqual(smoke_calls, [self.release.build_id, current.build_id])
        recorded = json.loads(
            (self.state / "current-release.json").read_text(encoding="utf-8")
        )
        self.assertEqual(recorded["release_id"], current.release_id)
        self.assertFalse((self.state / "edge-maintenance" / "on").exists())


if __name__ == "__main__":
    unittest.main()
