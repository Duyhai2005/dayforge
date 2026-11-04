from __future__ import annotations

import gzip
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from collections.abc import Mapping, Sequence
from dataclasses import replace
from pathlib import Path

from scripts.backup_database import _KEY_FILES
from scripts.backup_policy import BackupPolicy
from scripts.deploy_config import DeployConfig
from scripts.release_manifest import ReleaseManifest
from scripts.restore_database import (
    RestoreError,
    _manifest_and_payload,
    restore_database,
)

_SNAPSHOT = "b" * 64
_RESTORE_ID = "d" * 32


class ImportSink:
    def __init__(self) -> None:
        self.data = bytearray()

    def write(self, value: bytes) -> int:
        self.data.extend(value)
        return len(value)

    def close(self) -> None:
        pass


class FakeImportProcess:
    def __init__(self) -> None:
        self.stdin = ImportSink()
        self.killed = False

    def wait(self, timeout: float | None = None) -> int:
        return 0

    def kill(self) -> None:
        self.killed = True


class FakeRestoreRunner:
    def __init__(self, workspace: Path, source_payload: Path) -> None:
        self.workspace = workspace
        self.source_payload = source_payload
        self.events: list[list[str]] = []
        self.table_count = "0"
        self.snapshot_environment = "production"
        self.snapshot_release = "release-1"
        self.snapshot_build = "build-1"
        self.import_process: FakeImportProcess | None = None

    def __call__(self, arguments: Sequence[str], environment: Mapping[str, str]):
        del environment
        command = list(arguments)
        self.events.append(command)
        if "snapshots" in command:
            tags = [
                f"environment:{self.snapshot_environment}",
                "kind:database",
                f"release:{self.snapshot_release}",
                f"build:{self.snapshot_build}",
            ]
            return subprocess.CompletedProcess(
                command, 0, json.dumps([{"id": _SNAPSHOT, "tags": tags}]), ""
            )
        if "restore" in command:
            mount = next(
                item for item in command if item.startswith("type=bind,source=")
            )
            root = Path(mount.split("source=", 1)[1].split(",target=", 1)[0])
            destination = root / "restore-output" / "backup-work" / "payload"
            shutil.copytree(self.source_payload, destination)
            return subprocess.CompletedProcess(command, 0, "", "")
        if "migrate" in command and "current" in command:
            return subprocess.CompletedProcess(command, 0, "abc123 (head)\n", "")
        if "dayforge-backup-query" in command:
            query = command[-1]
            if "information_schema.tables" in query:
                output = self.table_count
            elif "VERSION()" in query:
                output = "8.4.13"
            else:
                output = ""
            return subprocess.CompletedProcess(command, 0, output + "\n", "")
        return subprocess.CompletedProcess(command, 0, "", "")


class RestoreDatabaseTests(unittest.TestCase):
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
            "PUBLIC_ORIGIN=https://restore.example.test\n"
            "LOCAL_KEY_KEK_VERSION=4\n",
            encoding="utf-8",
        )
        self.compose_file = self.root / "compose.yaml"
        self.compose_file.write_text("services: {}\n", encoding="utf-8")
        self.repository_file = self.root / "repository"
        self.repository_file.write_text(
            "local:" + str(self.root / "repo") + "\n", encoding="utf-8"
        )
        (self.root / "repo").mkdir()
        self.password_file = self.root / "restic-password"
        self.password_file.write_text("restic-password-sentinel\n", encoding="utf-8")
        self.credentials_file = self.root / "restic-credentials"
        self.credentials_file.write_text("AWS_REGION=us-east-1\n", encoding="utf-8")
        self.workspace = self.state / "restore-work"
        self.policy = BackupPolicy(
            repository_file=self.repository_file,
            password_file=self.password_file,
            credentials_file=self.credentials_file,
            workspace_root=self.workspace,
        )
        if os.name != "nt":
            for path in (
                self.runtime,
                self.repository_file,
                self.password_file,
                self.credentials_file,
            ):
                path.chmod(0o600)

        self.config = DeployConfig(
            environment="restore",
            provider="aws",
            region="us-east-1",
            platform="linux/amd64",
            public_origin="https://restore.example.test",
            compose_project=f"dayforge-restore-{_RESTORE_ID}",
            db_name=f"dayforge_restore_{_RESTORE_ID}",
            secrets_dir=self.secrets,
            state_dir=self.state,
            edge_alias=f"restore-{_RESTORE_ID}",
            app_subnet="10.82.10.0/24",
        )
        self.release = ReleaseManifest(
            release_id="restore-image-1",
            git_sha="1" * 40,
            build_id="restore-build-1",
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
        self.source_payload = self.root / "source-payload"
        self._write_source_payload()
        self.runner = FakeRestoreRunner(self.workspace, self.source_payload)
        self.imports: list[FakeImportProcess] = []

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _write_source_payload(self) -> None:
        self.source_payload.mkdir()
        dump = self.source_payload / "database.sql.gz"
        with gzip.open(dump, "wb") as stream:
            stream.write("-- dữ liệu đã đồng bộ\n".encode())
        digest = hashlib.sha256(dump.read_bytes()).hexdigest()
        (self.source_payload / "restore-runtime.json").write_text(
            json.dumps(
                {
                    "owner_email": "owner@example.test",
                    "public_origin": "https://production.example.test",
                    "local_key_kek_version": 4,
                }
            ),
            encoding="utf-8",
        )
        key_directory = self.source_payload / "restore-secrets"
        key_directory.mkdir(mode=0o700)
        for name in _KEY_FILES:
            (key_directory / name).write_text(
                "" if name == "logout_ticket_previous_keys_b64" else f"{name}-value\n",
                encoding="utf-8",
            )
        (self.source_payload / "backup-manifest.json").write_text(
            json.dumps(
                {
                    "format_version": 1,
                    "source_environment": "production",
                    "release_id": "release-1",
                    "build_id": "build-1",
                    "git_sha": "2" * 40,
                    "mysql_version": "8.4.13",
                    "alembic_revision": "abc123",
                    "dump_started_at": "2026-11-03T00:00:00Z",
                    "dump_completed_at": "2026-11-03T00:01:00Z",
                    "dump_sha256": digest,
                    "key_versions": {"local_key_kek": 4, "auth_email_outbox": 1},
                    "restore_secret_files": list(_KEY_FILES),
                    "runtime_config_file": "restore-runtime.json",
                }
            ),
            encoding="utf-8",
        )
        if os.name != "nt":
            for path in self.source_payload.rglob("*"):
                if path.is_file():
                    path.chmod(0o600)

    def _popen(self, *args, **kwargs) -> FakeImportProcess:
        del args, kwargs
        process = FakeImportProcess()
        self.imports.append(process)
        return process

    def _restore(self, *, source_environment: str = "production"):
        return restore_database(
            self.config,
            self.release,
            self.policy,
            snapshot_id=_SNAPSHOT,
            source_environment=source_environment,
            env_file=self.runtime,
            compose_file=self.compose_file,
            runner=self.runner,
            popen_factory=self._popen,
        )

    def test_restore_imports_verified_snapshot_only_into_empty_target(self) -> None:
        result = self._restore()
        self.assertEqual(result.snapshot_id, _SNAPSHOT)
        self.assertEqual(result.restored_revision, "abc123")
        self.assertEqual(len(self.imports), 1)
        self.assertIn("-- dữ liệu đã đồng bộ\n".encode(), self.imports[0].stdin.data)
        self.assertEqual(
            (self.secrets / "local_key_kek_b64").read_text(),
            "local_key_kek_b64-value\n",
        )
        self.assertTrue(
            any(
                "up" in command and "mysql" in command for command in self.runner.events
            )
        )
        self.assertTrue(
            any("provision-users" in command for command in self.runner.events)
        )
        self.assertFalse(
            any("api" in command or "web" in command for command in self.runner.events)
        )
        ready = json.loads((self.state / "restore-ready.json").read_text())
        self.assertEqual(ready["snapshot_id"], _SNAPSHOT)
        self.assertFalse((self.workspace / "payload").exists())
        self.assertFalse((self.workspace / "restore-output").exists())
        self.assertFalse((self.state / "operation.lock").exists())

    def test_rejects_non_restore_target_before_database_or_repository_calls(
        self,
    ) -> None:
        self.config = replace(self.config, environment="production")
        with self.assertRaisesRegex(RestoreError, "restore_environment_required"):
            self._restore()
        self.assertEqual(self.runner.events, [])

    def test_rejects_nonempty_database_before_snapshot_lookup(self) -> None:
        self.runner.table_count = "1"
        with self.assertRaisesRegex(RestoreError, "restore_database_not_empty"):
            self._restore()
        self.assertFalse(any("snapshots" in command for command in self.runner.events))
        self.assertEqual(self.imports, [])

    def test_rejects_snapshot_source_environment_mismatch_before_download(self) -> None:
        self.runner.snapshot_environment = "staging"
        with self.assertRaisesRegex(RestoreError, "snapshot_environment_mismatch"):
            self._restore()
        self.assertFalse(any("restore" in command for command in self.runner.events))
        self.assertEqual(self.imports, [])

    def test_rejects_manifest_and_snapshot_tag_identity_mismatch(self) -> None:
        self.runner.snapshot_build = "different-build"
        with self.assertRaisesRegex(RestoreError, "snapshot_source_identity_mismatch"):
            self._restore()
        self.assertEqual(self.imports, [])

    def test_rejects_restore_origin_that_matches_source_origin(self) -> None:
        runtime_path = self.source_payload / "restore-runtime.json"
        runtime = json.loads(runtime_path.read_text())
        runtime["public_origin"] = self.config.public_origin
        runtime_path.write_text(json.dumps(runtime), encoding="utf-8")
        with self.assertRaisesRegex(
            RestoreError, "restore_owner_or_key_version_mismatch"
        ):
            self._restore()
        self.assertEqual(self.imports, [])

    def test_rejects_corrupt_dump_before_import_or_installing_keys(self) -> None:
        dump = self.source_payload / "database.sql.gz"
        with gzip.open(dump, "wb") as stream:
            stream.write(b"different but valid gzip payload\n")
        with self.assertRaisesRegex(RestoreError, "snapshot_checksum_mismatch"):
            self._restore()
        self.assertEqual(self.imports, [])
        self.assertFalse((self.secrets / "local_key_kek_b64").exists())

    def test_rejects_missing_kek_version_before_import(self) -> None:
        manifest_path = self.source_payload / "backup-manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["key_versions"] = {"auth_email_outbox": 1}
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(RestoreError, "snapshot_key_version_missing"):
            self._restore()
        self.assertEqual(self.imports, [])

    def test_manifest_checksum_and_secret_validation_is_centralized(self) -> None:
        manifest_path = self.source_payload / "backup-manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["dump_sha256"] = "0" * 64
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(RestoreError, "snapshot_checksum_mismatch"):
            _manifest_and_payload(
                self.source_payload,
                source_environment="production",
                release=self.release,
            )


if __name__ == "__main__":
    unittest.main()
