import json
import os
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path

from scripts.release_manifest import ReleaseManifest, write_release_manifest
from scripts.staging_acceptance import StagingInputError, validate_staging_inputs


class StagingAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.repo_root = self.root / "repo"
        self.repo_root.mkdir()
        self.private = self.root / "private"
        self.private.mkdir()

        self.config_path = self.private / "staging.json"
        self.config_path.write_text(
            json.dumps(
                {
                    "environment": "staging",
                    "provider": "aws",
                    "region": "ap-southeast-1",
                    "platform": "linux/amd64",
                    "public_origin": "https://staging.dayforge.dev",
                    "compose_project": "dayforge-staging",
                    "db_name": "dayforge_staging",
                    "secrets_dir": str(self.private / "secrets"),
                    "state_dir": str(self.private / "state"),
                    "edge_alias": "staging-web",
                    "app_subnet": "10.81.10.0/24",
                }
            ),
            encoding="utf-8",
        )
        self.release_path = self.private / "release.json"
        self.release = ReleaseManifest(
            release_id="staging-candidate-001",
            git_sha="a" * 40,
            build_id="build-staging-001",
            platform="linux/amd64",
            web_image=f"registry.example/dayforge-web@sha256:{'b' * 64}",
            api_image=f"registry.example/dayforge-api@sha256:{'c' * 64}",
            mysql_image=f"mysql@sha256:{'d' * 64}",
            required_db_revision="0004_sync",
            supported_db_revisions=("0004_sync",),
            indexeddb_schema_version=2,
            supported_indexeddb_schema_versions=(2,),
            protocol_versions=(1,),
            reducer_versions=(1,),
            created_at=datetime.now(UTC)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z"),
        )
        write_release_manifest(self.release_path, self.release)

        self.credentials_path = self.private / "credentials.json"
        self.credentials_path.write_text(
            json.dumps(
                {
                    "owner_email": "owner@dayforge.dev",
                    "owner_password": "private-staging-password",
                }
            ),
            encoding="utf-8",
        )
        if os.name != "nt":
            self.credentials_path.chmod(0o600)

    def tearDown(self):
        self.temporary.cleanup()

    def validate(self, **overrides):
        return validate_staging_inputs(
            overrides.get("config_path", self.config_path),
            overrides.get("release_path", self.release_path),
            overrides.get("credentials_path", self.credentials_path),
            overrides.get("output_path", self.root / "artifacts"),
            repo_root=self.repo_root,
        )

    def test_accepts_private_staging_inputs_without_returning_credentials(self):
        result = self.validate()
        self.assertEqual(result["origin"], "https://staging.dayforge.dev")
        self.assertEqual(result["release_id"], self.release.release_id)
        self.assertNotIn("owner@dayforge.dev", json.dumps(result))
        self.assertNotIn("private-staging-password", json.dumps(result))
        self.assertTrue(Path(result["output_path"]).is_dir())

    def test_rejects_production_or_non_public_origins(self):
        config = json.loads(self.config_path.read_text(encoding="utf-8"))
        config["environment"] = "production"
        config["compose_project"] = "dayforge-production"
        config["db_name"] = "dayforge_production"
        config["edge_alias"] = "production-web"
        self.config_path.write_text(json.dumps(config), encoding="utf-8")
        with self.assertRaisesRegex(StagingInputError, "environment"):
            self.validate()

        config["environment"] = "staging"
        config["compose_project"] = "dayforge-staging"
        config["db_name"] = "dayforge_staging"
        config["edge_alias"] = "staging-web"
        config["public_origin"] = "https://staging.example.test"
        self.config_path.write_text(json.dumps(config), encoding="utf-8")
        with self.assertRaisesRegex(StagingInputError, "public_origin"):
            self.validate()

    def test_rejects_credentials_inside_repository_or_with_broad_permissions(self):
        tracked = self.repo_root / "credentials.json"
        tracked.write_text(
            self.credentials_path.read_text(encoding="utf-8"), encoding="utf-8"
        )
        if os.name != "nt":
            tracked.chmod(0o600)
        with self.assertRaisesRegex(StagingInputError, "credentials_file"):
            self.validate(credentials_path=tracked)

        if os.name != "nt":
            self.credentials_path.chmod(0o644)
            with self.assertRaisesRegex(StagingInputError, "credentials_permissions"):
                self.validate()

    def test_rejects_release_platform_mismatch(self):
        raw = json.loads(self.release_path.read_text(encoding="utf-8"))
        raw["platform"] = "linux/arm64"
        self.release_path.write_text(json.dumps(raw), encoding="utf-8")
        with self.assertRaisesRegex(StagingInputError, "release_platform"):
            self.validate()


if __name__ == "__main__":
    unittest.main()
