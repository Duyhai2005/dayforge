from __future__ import annotations

import io
import json
import os
import subprocess
import tempfile
import unittest
from collections.abc import Mapping, Sequence
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

from scripts.backup_database import (
    BackupError,
    create_backup,
    initialize_backup_repository,
    maintain_backup_repository,
)
from scripts.backup_policy import BackupPolicy
from scripts.deploy_config import DeployConfig
from scripts.release_manifest import ReleaseManifest

_SNAPSHOT = "a" * 64


class FakeProcess:
    def __init__(
        self, payload: bytes = b"-- valid sql dump\n", return_code: int = 0
    ) -> None:
        self.stdout = io.BytesIO(payload)
        self.return_code = return_code
        self.killed = False

    def wait(self, timeout: float | None = None) -> int:
        return self.return_code

    def kill(self) -> None:
        self.killed = True


class FakeRunner:
    def __init__(self) -> None:
        self.events: list[tuple[list[str], Mapping[str, str]]] = []
        self.fail_command: str | None = None
        self.invalid_retention_preview = False

    def __call__(self, arguments: Sequence[str], environment: Mapping[str, str]):
        command = list(arguments)
        self.events.append((command, dict(environment)))
        if self.fail_command and self.fail_command in command:
            return subprocess.CompletedProcess(command, 1, "", "secret-sentinel")
        if "migrate" in command and "current" in command:
            return subprocess.CompletedProcess(command, 0, "abc123 (head)\n", "")
        if "mysql" in command and "dayforge-backup-query" in command:
            query = command[-1]
            output = "8.4.13\n" if "VERSION()" in query else "0\n"
            return subprocess.CompletedProcess(command, 0, output, "")
        if "backup" in command:
            return subprocess.CompletedProcess(
                command,
                0,
                json.dumps({"message_type": "summary", "snapshot_id": _SNAPSHOT})
                + "\n",
                "",
            )
        if "snapshots" in command:
            tags = [
                "environment:staging",
                "kind:database",
                "release:release-1",
                "build:build-1",
            ]
            return subprocess.CompletedProcess(
                command, 0, json.dumps([{"id": _SNAPSHOT, "tags": tags}]), ""
            )
        if "check" in command:
            return subprocess.CompletedProcess(
                command,
                0,
                json.dumps({"message_type": "summary", "num_errors": 0}) + "\n",
                "",
            )
        if "forget" in command and "--dry-run" in command:
            tags = ["environment:staging", "kind:database"]
            if self.invalid_retention_preview:
                tags = ["environment:production", "kind:database"]
            preview = [
                {
                    "tags": tags,
                    "keep": [{"id": _SNAPSHOT}],
                    "remove": [],
                }
            ]
            return subprocess.CompletedProcess(command, 0, json.dumps(preview), "")
        return subprocess.CompletedProcess(command, 0, "", "")


class BackupDatabaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.secrets = self.root / "secrets"
        self.secrets.mkdir(mode=0o700)
        self.runtime = self.root / "runtime.env"
        self.runtime.write_text(
            "OWNER_EMAIL=owner@example.test\n"
            "PUBLIC_ORIGIN=https://staging.example.test\n"
            "LOCAL_KEY_KEK_VERSION=4\n"
            "EMAIL_SMTP_PASSWORD=old-smtp-secret\n",
            encoding="utf-8",
        )
        self.repository_file = self.root / "repository"
        self.password_file = self.root / "restic-password"
        self.credentials_file = self.root / "restic-credentials"
        self.repository_file.write_text(
            "local:" + str(self.root / "repo") + "\n", encoding="utf-8"
        )
        self.password_file.write_text("restic-password-sentinel\n", encoding="utf-8")
        self.credentials_file.write_text("AWS_REGION=us-east-1\n", encoding="utf-8")
        (self.root / "repo").mkdir()
        for name in (
            "local_key_kek_b64",
            "logout_ticket_key_b64",
            "auth_rate_limit_key_b64",
            "auth_email_outbox_key_b64",
            "sync_page_token_key_b64",
        ):
            (self.secrets / name).write_text(
                f"{name}-secret-sentinel\n", encoding="utf-8"
            )
        (self.secrets / "logout_ticket_previous_keys_b64").write_text(
            "", encoding="utf-8"
        )
        self.compose_file = self.root / "compose.yaml"
        self.compose_file.write_text("services: {}\n", encoding="utf-8")
        if os.name != "nt":
            for path in (
                self.runtime,
                self.repository_file,
                self.password_file,
                self.credentials_file,
            ):
                path.chmod(0o600)
            for path in self.secrets.iterdir():
                path.chmod(0o600)
        self.config = DeployConfig(
            environment="staging",
            provider="aws",
            region="us-east-1",
            platform="linux/amd64",
            public_origin="https://staging.example.test",
            compose_project="dayforge-staging",
            db_name="dayforge_staging",
            secrets_dir=self.secrets,
            state_dir=self.state,
            edge_alias="staging-web",
            app_subnet="10.81.10.0/24",
        )
        self.release = ReleaseManifest(
            release_id="release-1",
            git_sha="1" * 40,
            build_id="build-1",
            platform="linux/amd64",
            web_image="registry.example.test/web@sha256:" + "a" * 64,
            api_image="registry.example.test/api@sha256:" + "b" * 64,
            mysql_image="mysql@sha256:" + "c" * 64,
            required_db_revision="abc123",
            supported_db_revisions=("abc123",),
            indexeddb_schema_version=1,
            supported_indexeddb_schema_versions=(1,),
            protocol_versions=(1,),
            reducer_versions=(1,),
            created_at="2026-11-04T00:00:00Z",
        )
        self.policy = BackupPolicy(
            repository_file=self.repository_file,
            password_file=self.password_file,
            credentials_file=self.credentials_file,
            workspace_root=self.state / "backup-work",
        )
        self.runner = FakeRunner()
        self.popen_calls: list[list[str]] = []
        self.popen_return_code = 0

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def popen_factory(self, arguments, **kwargs):
        self.popen_calls.append(list(arguments))
        return FakeProcess(return_code=self.popen_return_code)

    def backup(self):
        return create_backup(
            self.config,
            self.release,
            self.policy,
            env_file=self.runtime,
            compose_file=self.compose_file,
            runner=self.runner,
            popen_factory=self.popen_factory,
            now=datetime(2026, 11, 4, tzinfo=UTC),
        )

    def test_success_publishes_marker_only_after_snapshot_and_cleans_workspace(
        self,
    ) -> None:
        result = self.backup()
        marker = json.loads(
            (self.state / "last-backup.json").read_text(encoding="utf-8")
        )
        self.assertEqual(result.snapshot_id, _SNAPSHOT)
        self.assertEqual(marker["snapshot_id"], _SNAPSHOT)
        self.assertEqual(marker["source_revision"], "abc123")
        self.assertTrue((self.state / "backup.enabled").is_file())
        self.assertFalse((self.policy.workspace_root / "payload").exists())
        self.assertFalse((self.state / "operation.lock").exists())
        dump_command = self.popen_calls[0]
        shell_script = dump_command[dump_command.index("-ec") + 1]
        for option in (
            "--single-transaction",
            "--quick",
            "--hex-blob",
            "--no-tablespaces",
            "--set-gtid-purged=OFF",
            "--skip-lock-tables",
        ):
            self.assertIn(option, shell_script)
        self.assertNotIn("--all-databases", shell_script)
        self.assertNotIn("EMAIL_SMTP_PASSWORD", json.dumps(marker))
        self.assertTrue(any("backup" in command for command, _ in self.runner.events))

    def test_upload_failure_does_not_advance_last_success(self) -> None:
        previous = {"completed_at": "2026-11-03T00:00:00Z", "snapshot_id": "old"}
        (self.state / "last-backup.json").write_text(
            json.dumps(previous), encoding="utf-8"
        )
        self.runner.fail_command = "backup"
        with self.assertRaisesRegex(BackupError, "restic_backup_failed"):
            self.backup()
        self.assertEqual(
            json.loads((self.state / "last-backup.json").read_text()), previous
        )
        self.assertFalse((self.policy.workspace_root / "payload").exists())

    def test_dump_failure_never_publishes_a_snapshot(self) -> None:
        (self.state / "last-backup.json").write_text(
            '{"snapshot_id":"old"}\n', encoding="utf-8"
        )
        self.popen_return_code = 1
        with self.assertRaisesRegex(BackupError, "mysqldump_failed"):
            self.backup()
        self.assertFalse(any("backup" in command for command, _ in self.runner.events))
        self.assertEqual(
            json.loads((self.state / "last-backup.json").read_text())["snapshot_id"],
            "old",
        )
        self.assertFalse((self.policy.workspace_root / "payload").exists())

    def test_existing_operation_lock_blocks_backup_without_external_calls(self) -> None:
        (self.state / "operation.lock").write_text("deployment\n", encoding="ascii")
        with self.assertRaisesRegex(
            BackupError, "operation_already_running_or_lock_stale"
        ):
            self.backup()
        self.assertEqual(self.runner.events, [])
        self.assertEqual(self.popen_calls, [])

    def test_workspace_outside_managed_state_is_rejected(self) -> None:
        self.policy = BackupPolicy(
            self.repository_file,
            self.password_file,
            self.credentials_file,
            self.root / "outside-workspace",
        )
        with self.assertRaisesRegex(BackupError, "workspace_outside_state_directory"):
            self.backup()
        self.assertEqual(self.runner.events, [])

    def test_snapshot_lookup_failure_does_not_advance_marker_or_retain_payload(
        self,
    ) -> None:
        previous = {"snapshot_id": "old"}
        (self.state / "last-backup.json").write_text(
            json.dumps(previous), encoding="utf-8"
        )
        self.runner.fail_command = "snapshots"
        with self.assertRaisesRegex(BackupError, "restic_snapshot_lookup_failed"):
            self.backup()
        self.assertEqual(
            json.loads((self.state / "last-backup.json").read_text()), previous
        )
        self.assertFalse((self.policy.workspace_root / "payload").exists())

    def test_retention_runs_only_after_matching_snapshot_and_repository_check(
        self,
    ) -> None:
        maintain_backup_repository(self.config, self.policy, runner=self.runner)
        actions = [
            next(
                (
                    action
                    for action in ("snapshots", "check", "forget")
                    if action in command
                ),
                "",
            )
            for command, _ in self.runner.events
        ]
        self.assertEqual(
            [action for action in actions if action],
            ["snapshots", "check", "forget", "forget"],
        )
        forget = [command for command, _ in self.runner.events if "forget" in command]
        self.assertIn("environment:staging,kind:database", forget[0])
        self.assertIn("host,paths", forget[0])
        self.assertNotIn("host,tags,paths", forget[0])
        self.assertIn("--dry-run", forget[0])
        self.assertIn("--prune", forget[1])
        self.assertFalse((self.policy.workspace_root / "payload").exists())
        self.assertFalse((self.state / "operation.lock").exists())

    def test_repository_check_failure_prevents_retention(self) -> None:
        self.runner.fail_command = "check"
        with self.assertRaisesRegex(BackupError, "restic_repository_check_failed"):
            maintain_backup_repository(self.config, self.policy, runner=self.runner)
        self.assertFalse(any("forget" in command for command, _ in self.runner.events))

    def test_unconfirmed_retention_preview_prevents_pruning(self) -> None:
        self.runner.invalid_retention_preview = True
        with self.assertRaisesRegex(
            BackupError, "restic_retention_preview_unconfirmed"
        ):
            maintain_backup_repository(self.config, self.policy, runner=self.runner)
        forget_commands = [
            command for command, _ in self.runner.events if "forget" in command
        ]
        self.assertEqual(len(forget_commands), 1)
        self.assertIn("--dry-run", forget_commands[0])
        self.assertFalse((self.state / "operation.lock").exists())

    def test_repository_initialization_uses_pinned_restic_without_exposing_password(
        self,
    ) -> None:
        initialize_backup_repository(self.config, self.policy, runner=self.runner)
        command, environment = self.runner.events[0]
        self.assertIn("init", command)
        self.assertTrue(
            any("restic/restic:" in item and "@sha256:" in item for item in command)
        )
        self.assertNotIn("restic-password-sentinel", json.dumps(command))
        self.assertNotIn("restic-password-sentinel", json.dumps(environment))
        self.assertFalse((self.state / "operation.lock").exists())
        self.assertFalse((self.policy.workspace_root / "payload").exists())

    def test_production_repository_initialization_rejects_local_repository(
        self,
    ) -> None:
        production = replace(self.config, environment="production")
        with self.assertRaisesRegex(
            BackupError, "production_repository_must_be_off_host"
        ):
            initialize_backup_repository(production, self.policy, runner=self.runner)
        self.assertEqual(self.runner.events, [])


if __name__ == "__main__":
    unittest.main()
