from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from collections.abc import Mapping, Sequence
from pathlib import Path
from uuid import uuid4

from scripts.deploy_config import DeployConfig
from scripts.prepare_restore_recovery import (
    RestoreRecoveryLaunchError,
    prepare_restore_recovery,
)
from scripts.release_manifest import ReleaseManifest


class PrepareRestoreRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.secrets = self.root / "secrets"
        self.secrets.mkdir(mode=0o700)
        self.runtime = self.root / "runtime.env"
        self.runtime.write_text(
            "PUBLIC_ORIGIN=https://restore.example.test\n", encoding="utf-8"
        )
        self.compose = self.root / "compose.yaml"
        self.compose.write_text("services: {}\n", encoding="utf-8")
        self.restore_id = uuid4().hex
        self.config = DeployConfig(
            environment="restore",
            provider="aws",
            region="us-east-1",
            platform="linux/amd64",
            public_origin="https://restore.example.test",
            compose_project=f"dayforge-restore-{self.restore_id}",
            db_name=f"dayforge_restore_{self.restore_id}",
            secrets_dir=self.secrets,
            state_dir=self.state,
            edge_alias=f"restore-{self.restore_id}",
            app_subnet="10.82.10.0/24",
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
        self.events: list[tuple[list[str], Mapping[str, str]]] = []

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def runner(self, arguments: Sequence[str], environment: Mapping[str, str]):
        self.events.append((list(arguments), dict(environment)))
        return subprocess.CompletedProcess(
            list(arguments),
            0,
            json.dumps({"status": "restore_prepared", "owner_count": 1}),
            "",
        )

    def test_runs_only_one_shot_restore_cli_with_private_persistent_journal(
        self,
    ) -> None:
        prepare_restore_recovery(
            self.config,
            self.release,
            env_file=self.runtime,
            compose_file=self.compose,
            runner=self.runner,
            container_uid=os.getuid() if hasattr(os, "getuid") else 10001,
            container_gid=os.getgid() if hasattr(os, "getgid") else 10001,
        )
        command, environment = self.events[0]
        self.assertIn("run", command)
        self.assertIn("--no-deps", command)
        self.assertIn("app.cli.prepare_restored_database", command)
        self.assertIn(str(self.config.compose_project), environment["COMPOSE_PROJECT"])
        self.assertFalse(any("up" in call for call, _ in self.events))
        journal_dir = self.state / "restore-recovery"
        self.assertTrue(journal_dir.is_dir())
        if os.name != "nt":
            self.assertEqual(journal_dir.stat().st_mode & 0o777, 0o700)

    def test_rejects_non_restore_target_without_running_compose(self) -> None:
        config = DeployConfig(
            **{
                field: getattr(self.config, field)
                for field in self.config.__dataclass_fields__
                if field != "environment"
            },
            environment="staging",
        )
        with self.assertRaisesRegex(
            RestoreRecoveryLaunchError, "restore_environment_required"
        ):
            prepare_restore_recovery(
                config,
                self.release,
                env_file=self.runtime,
                compose_file=self.compose,
                runner=self.runner,
            )
        self.assertEqual(self.events, [])

    def test_rejects_unconfirmed_cli_result(self) -> None:
        def bad_runner(arguments, environment):
            return subprocess.CompletedProcess(list(arguments), 0, "unexpected", "")

        with self.assertRaisesRegex(
            RestoreRecoveryLaunchError, "restore_preparation_unconfirmed"
        ):
            prepare_restore_recovery(
                self.config,
                self.release,
                env_file=self.runtime,
                compose_file=self.compose,
                runner=bad_runner,
                container_uid=os.getuid() if hasattr(os, "getuid") else 10001,
                container_gid=os.getgid() if hasattr(os, "getgid") else 10001,
            )


if __name__ == "__main__":
    unittest.main()
