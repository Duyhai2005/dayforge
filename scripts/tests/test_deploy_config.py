import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from scripts.deploy_config import DeployConfigError, assert_environment_isolation, load_deploy_config  # noqa: E402


class DeployConfigTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def config(self, environment, **overrides):
        if environment == "staging":
            project, db_name, edge_alias, subnet = (
                "dayforge-staging",
                "dayforge_staging",
                "staging-web",
                "10.81.10.0/24",
            )
        elif environment == "production":
            project, db_name, edge_alias, subnet = (
                "dayforge-production",
                "dayforge_production",
                "production-web",
                "10.81.20.0/24",
            )
        else:
            restore_id = "a" * 32
            project, db_name, edge_alias, subnet = (
                f"dayforge-restore-{restore_id}",
                f"dayforge_restore_{restore_id}",
                f"restore-{restore_id}",
                "10.81.30.0/24",
            )
        value = {
            "environment": environment,
            "provider": "aws",
            "region": "ap-southeast-1",
            "platform": "linux/amd64",
            "public_origin": f"https://{environment}.example.test",
            "compose_project": project,
            "db_name": db_name,
            "secrets_dir": str(self.root / environment / "secrets"),
            "state_dir": str(self.root / environment / "state"),
            "edge_alias": edge_alias,
            "app_subnet": subnet,
        }
        value.update(overrides)
        return value

    def load(self, value):
        target = self.root / "target.json"
        target.write_text(json.dumps(value), encoding="utf-8")
        return load_deploy_config(target)

    def test_loads_known_staging_production_and_restore_targets(self):
        staging = self.load(self.config("staging"))
        production = self.load(self.config("production"))
        restore = self.load(self.config("restore"))

        assert_environment_isolation([staging, production, restore])
        self.assertEqual(staging.db_name, "dayforge_staging")
        self.assertTrue(staging.secrets_dir.is_absolute())
        self.assertEqual(restore.environment, "restore")

    def test_rejects_ambiguous_or_unsafe_origin(self):
        for origin in (
            "http://stage.example.test",
            "https://user:password@stage.example.test",
            "https://stage.example.test/path",
            "https://stage.example.test?owner=1",
            "https://stage.example.test#token",
            "https://stage.example.test:443",
            "https://stage.example.test/ ",
        ):
            with self.subTest(origin=origin), self.assertRaises(DeployConfigError):
                self.load(self.config("staging", public_origin=origin))

    def test_rejects_unknown_fields_and_malformed_values_without_echo(self):
        secret_sentinel = "local-private-secret-value"
        value = self.config("staging", unsupported=secret_sentinel, provider={"aws": True})
        with self.assertRaises(DeployConfigError) as caught:
            self.load(value)
        self.assertIn("unsupported", str(caught.exception))
        self.assertIn("provider", str(caught.exception))
        self.assertNotIn(secret_sentinel, str(caught.exception))

    def test_rejects_mismatched_environment_resource_identity(self):
        for field, value in (
            ("compose_project", "dayforge-production"),
            ("db_name", "dayforge_dev"),
            ("edge_alias", "production-web"),
            ("platform", "linux/arm/v7"),
            ("region", "../../production"),
            ("app_subnet", "10.81.10.1/24"),
            ("app_subnet", "2001:db8::/64"),
        ):
            with self.subTest(field=field, value=value), self.assertRaises(DeployConfigError):
                self.load(self.config("staging", **{field: value}))

    def test_rejects_duplicate_environment_boundary_and_overlapping_subnets(self):
        staging = self.load(self.config("staging"))
        duplicate_origin = self.load(
            self.config("production", public_origin=staging.public_origin, app_subnet="10.82.20.0/24")
        )
        with self.assertRaises(DeployConfigError) as caught:
            assert_environment_isolation([staging, duplicate_origin])
        self.assertIn("public_origin", str(caught.exception))

        overlapping_subnet = self.load(self.config("production", app_subnet="10.81.10.128/25"))
        with self.assertRaises(DeployConfigError) as caught:
            assert_environment_isolation([staging, overlapping_subnet])
        self.assertIn("app_subnet", str(caught.exception))

    def test_rejects_parent_child_overlap_between_managed_directories(self):
        value = self.config("staging", state_dir=str(self.root / "staging"))
        with self.assertRaises(DeployConfigError) as caught:
            self.load(value)
        self.assertIn("state_dir", str(caught.exception))

    def test_malformed_config_file_never_echoes_its_contents(self):
        target = self.root / "malformed.json"
        target.write_text('{"smtp_password":"private sentinel"', encoding="utf-8")
        with self.assertRaises(DeployConfigError) as caught:
            load_deploy_config(target)
        self.assertNotIn("private sentinel", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
