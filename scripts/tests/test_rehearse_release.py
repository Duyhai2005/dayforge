import hashlib
import json
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from scripts.deploy_config import load_deploy_config  # noqa: E402
from scripts.rehearse_release import (  # noqa: E402
    RehearsalError,
    RehearsalInputs,
    _record_migration_case,
    _write_checkpoint,
    switch_release,
    validate_rehearsal_inputs,
    validate_restore_phase,
)
from scripts.release_manifest import load_release_manifest  # noqa: E402


class RehearseReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repository"
        self.repo.mkdir()
        self.private = self.root / "operator-private"
        self.state = self.private / "state"
        self.secrets = self.private / "secrets"
        self.state.mkdir(parents=True)
        self.secrets.mkdir()
        (self.state / "edge-maintenance").mkdir()
        self.config_path = self.repo / "target.json"
        self.config_path.write_text(
            json.dumps(
                {
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
            ),
            encoding="utf-8",
        )
        self.from_path = self.repo / "release-a.json"
        self.to_path = self.repo / "release-b.json"
        self.from_release = self._release("release-a", "a", "b", "c", "d")
        self.to_release = self._release("release-b", "e", "f", "0", "d")
        self.from_path.write_text(json.dumps(self.from_release), encoding="utf-8")
        self.to_path.write_text(json.dumps(self.to_release), encoding="utf-8")
        self.credentials = self.private / "credentials.json"
        self.credentials.write_text(
            json.dumps(
                {
                    "owner_email": "owner@example.test",
                    "owner_password": "local-only-password",
                }
            ),
            encoding="utf-8",
        )
        self.credentials.chmod(0o600)
        self.runtime = self.private / "runtime.json"
        self.runtime.write_text(
            json.dumps(
                {
                    "db_revision": "0004_sync",
                    "indexeddb_schema_version": 2,
                    "protocol_version": 1,
                    "reducer_version": 1,
                }
            ),
            encoding="utf-8",
        )
        self.output = self.private / "evidence"

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def _release(release_id, git, web, api, mysql):
        return {
            "format_version": 1,
            "release_id": release_id,
            "git_sha": git * 40,
            "build_id": f"{release_id}-build",
            "platform": "linux/amd64",
            "web_image": f"registry.example/web@sha256:{web * 64}",
            "api_image": f"registry.example/api@sha256:{api * 64}",
            "mysql_image": f"mysql@sha256:{mysql * 64}",
            "required_db_revision": "0004_sync",
            "supported_db_revisions": ["0004_sync"],
            "indexeddb_schema_version": 2,
            "supported_indexeddb_schema_versions": [1, 2],
            "protocol_versions": [1],
            "reducer_versions": [1],
            "created_at": "2026-11-04T00:00:00Z",
            "test_harness": False,
        }

    def validate(self, scenario="update", **overrides):
        arguments = {
            "config_path": self.config_path,
            "from_path": self.from_path,
            "to_path": self.to_path,
            "credentials_path": self.credentials,
            "output_path": self.output,
            "scenario": scenario,
            "runtime_path": self.runtime,
            "repo_root": self.repo,
        }
        arguments.update(overrides)
        return validate_rehearsal_inputs(**arguments)

    def test_update_inputs_bind_private_paths_and_exact_a_b_manifests(self):
        inputs = self.validate()
        self.assertEqual(inputs.config.public_origin, "https://stage.example.test")
        self.assertEqual(inputs.from_path, self.from_path.resolve())
        self.assertEqual(inputs.to_path, self.to_path.resolve())
        self.assertEqual(inputs.output_dir, self.output.resolve())

    def test_migration_fixture_needs_no_target_or_application_credentials(self):
        inputs = self.validate(
            scenario="migration",
            config_path=None,
            credentials_path=None,
            runtime_path=None,
        )
        self.assertIsNone(inputs.config)
        self.assertIsNone(inputs.credentials_file)

    def test_migration_fixture_refuses_deploy_target_inputs(self):
        with self.assertRaisesRegex(
            RehearsalError, "migration_does_not_accept_deploy_target"
        ):
            self.validate(scenario="migration", runtime_path=None)

    def test_migration_roll_forward_case_stays_running_until_fixture_passes(self):
        inputs = self.validate(
            scenario="migration",
            config_path=None,
            credentials_path=None,
            runtime_path=None,
        )
        _record_migration_case(inputs, passed=False)
        results_path = inputs.output_dir / "rehearsal-results.json"
        pending = json.loads(results_path.read_text(encoding="utf-8"))
        self.assertEqual(pending["cases"][0]["status"], "RUNNING")
        _record_migration_case(inputs, passed=True)
        passed = json.loads(results_path.read_text(encoding="utf-8"))
        row = passed["cases"][0]
        self.assertEqual(row["status"], "PASS")
        self.assertEqual(row["case_variants"], ["migration-interruption"])
        self.assertEqual(len(row["evidence_paths"]), 2)
        for path in row["evidence_paths"]:
            self.assertTrue((inputs.output_dir / path).is_file())

    def test_update_refuses_state_or_secret_paths_inside_repository(self):
        value = json.loads(self.config_path.read_text(encoding="utf-8"))
        value["state_dir"] = str(self.repo / "state")
        self.config_path.write_text(json.dumps(value), encoding="utf-8")
        with self.assertRaisesRegex(RehearsalError, "runtime_paths_must_be_private"):
            self.validate()

    def test_switch_rejects_a_record_with_the_right_id_but_wrong_manifest_identity(
        self,
    ):
        self.state.joinpath("current-release.json").write_text(
            json.dumps(
                {
                    "release_id": self.from_release["release_id"],
                    "git_sha": "9" * 40,
                    "build_id": self.from_release["build_id"],
                    "database_revision": "0004_sync",
                }
            ),
            encoding="utf-8",
        )
        inputs = self.validate()
        with self.assertRaisesRegex(RehearsalError, "current_release_not_in_pair"):
            switch_release(inputs, "B")
        self.assertFalse((self.state / "operation.lock").exists())

    def test_checkpoint_updates_existing_run_atomically(self):
        inputs = self.validate()
        _write_checkpoint(inputs, "f" * 32, "running")
        initial = json.loads(
            (self.state / "rehearsal" / f"{'f' * 32}.json").read_text(encoding="utf-8")
        )
        _write_checkpoint(inputs, "f" * 32, "passed")
        checkpoint = json.loads(
            (self.state / "rehearsal" / f"{'f' * 32}.json").read_text(encoding="utf-8")
        )
        self.assertEqual(checkpoint["status"], "passed")
        self.assertEqual(checkpoint["run_id"], "f" * 32)
        self.assertEqual(checkpoint["started_at"], initial["recorded_at"])

    def _restore_inputs(self):
        config_path = self.private / "restore-target.json"
        restore_id = "1" * 32
        config_value = {
            "environment": "restore",
            "provider": "aws",
            "region": "ap-southeast-1",
            "platform": "linux/amd64",
            "public_origin": "https://restore.example.test",
            "compose_project": f"dayforge-restore-{restore_id}",
            "db_name": f"dayforge_restore_{restore_id}",
            "secrets_dir": str(self.private / "restore-secrets"),
            "state_dir": str(self.private / "restore-state"),
            "edge_alias": f"restore-{restore_id}",
            "app_subnet": "10.81.11.0/24",
        }
        Path(config_value["secrets_dir"]).mkdir()
        Path(config_value["state_dir"]).mkdir()
        (Path(config_value["state_dir"]) / "edge-maintenance").mkdir()
        config_path.write_text(json.dumps(config_value), encoding="utf-8")
        config = load_deploy_config(config_path)
        return RehearsalInputs(
            config=config,
            from_release=load_release_manifest(self.from_path),
            to_release=load_release_manifest(self.to_path),
            config_path=config_path,
            from_path=self.from_path,
            to_path=self.to_path,
            output_dir=self.output,
            credentials_file=self.credentials,
            runtime_file=self.runtime,
            policy_file=self.private / "policy.json",
            snapshot_id="a" * 64,
            source_environment="staging",
            scenario="restore",
        )

    def test_restore_seed_requires_a_fresh_private_session_directory(self):
        inputs = self._restore_inputs()
        self.assertIsNone(validate_restore_phase(inputs, "seed"))
        inputs.output_dir.mkdir(parents=True)
        (inputs.output_dir / "restore-state.json").write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(RehearsalError, "restore_session_already_exists"):
            validate_restore_phase(inputs, "seed")

    def test_restore_recover_requires_seeded_matching_snapshot_and_a_new_target(self):
        inputs = self._restore_inputs()
        inputs.output_dir.mkdir(parents=True)
        session = {
            "artifact_type": "dayforge-t33-restore-session",
            "format_version": 1,
            "status": "seeded",
            "snapshot_id": inputs.snapshot_id,
            "source_environment": inputs.source_environment,
            "origin_sha256": hashlib.sha256(
                inputs.config.public_origin.encode()
            ).hexdigest(),
            "from_release_id": inputs.from_release.release_id,
            "from_build_id": inputs.from_release.build_id,
            "from_web_digest": inputs.from_release.web_image.rsplit("@", 1)[1],
            "from_api_digest": inputs.from_release.api_image.rsplit("@", 1)[1],
            "to_release_id": inputs.to_release.release_id,
            "to_build_id": inputs.to_release.build_id,
            "to_web_digest": inputs.to_release.web_image.rsplit("@", 1)[1],
            "to_api_digest": inputs.to_release.api_image.rsplit("@", 1)[1],
            "seed_config_file": str(inputs.config_path),
            "seed_target": {
                "compose_project": inputs.config.compose_project,
                "db_name": inputs.config.db_name,
                "edge_alias": inputs.config.edge_alias,
                "state_dir": str(inputs.config.state_dir),
                "secrets_dir": str(inputs.config.secrets_dir),
                "app_subnet": inputs.config.app_subnet,
            },
            "baseline_operation_ids": ["00000000-0000-4000-8000-000000000001"],
            "acknowledged_operation_ids": [
                "00000000-0000-4000-8000-000000000002",
                "00000000-0000-4000-8000-000000000003",
            ],
            "pending_operation_id": "00000000-0000-4000-8000-000000000004",
            "draft_ciphertext_sha256": "b" * 64,
            "draft_id": "t33-draft-1",
            "profile_a_sha256": hashlib.sha256(
                str(inputs.output_dir / "profiles" / "device-a").encode()
            ).hexdigest(),
            "profile_b_sha256": hashlib.sha256(
                str(inputs.output_dir / "profiles" / "device-b").encode()
            ).hexdigest(),
        }
        (inputs.output_dir / "restore-state.json").write_text(
            json.dumps(session), encoding="utf-8"
        )
        with self.assertRaisesRegex(
            RehearsalError, "restore_recover_requires_new_target"
        ):
            validate_restore_phase(inputs, "recover")
        second_id = "2" * 32
        second_config_path = self.private / "restore-target-2.json"
        second_secrets = self.private / "restore-secrets-2"
        second_state = self.private / "restore-state-2"
        second_secrets.mkdir()
        second_state.mkdir()
        (second_state / "edge-maintenance").mkdir()
        second_config = {
            "environment": "restore",
            "provider": "aws",
            "region": "ap-southeast-1",
            "platform": "linux/amd64",
            "public_origin": inputs.config.public_origin,
            "compose_project": f"dayforge-restore-{second_id}",
            "db_name": f"dayforge_restore_{second_id}",
            "secrets_dir": str(second_secrets),
            "state_dir": str(second_state),
            "edge_alias": f"restore-{second_id}",
            "app_subnet": "10.81.12.0/24",
        }
        second_config_path.write_text(json.dumps(second_config), encoding="utf-8")
        recover_inputs = replace(
            inputs,
            config=load_deploy_config(second_config_path),
            config_path=second_config_path,
        )
        self.assertEqual(validate_restore_phase(recover_inputs, "recover"), session)


if __name__ == "__main__":
    unittest.main()
