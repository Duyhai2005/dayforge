import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from scripts.release_manifest import (  # noqa: E402
    ReleaseManifestError,
    load_release_manifest,
    write_release_manifest,
)


class ReleaseManifestTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.path = self.root / "release.json"

    def tearDown(self):
        self.temporary.cleanup()

    def valid(self):
        return {
            "format_version": 1,
            "release_id": "release-20261104-a1b2c3d4",
            "git_sha": "a" * 40,
            "build_id": "a1b2c3d4",
            "platform": "linux/amd64",
            "web_image": f"ghcr.io/dayforge/web@sha256:{'b' * 64}",
            "api_image": f"ghcr.io/dayforge/api@sha256:{'c' * 64}",
            "mysql_image": f"mysql@sha256:{'d' * 64}",
            "required_db_revision": "0004_sync",
            "supported_db_revisions": ["0004_sync"],
            "indexeddb_schema_version": 2,
            "supported_indexeddb_schema_versions": [1, 2],
            "protocol_versions": [1],
            "reducer_versions": [1],
            "created_at": "2026-11-04T04:00:00Z",
            "test_harness": False,
        }

    def write(self, value):
        self.path.write_text(json.dumps(value), encoding="utf-8")

    def test_valid_manifest_round_trips_and_matches_the_json_schema(self):
        from jsonschema import Draft202012Validator, FormatChecker

        value = self.valid()
        self.write(value)
        loaded = load_release_manifest(self.path)
        schema = json.loads((REPO_ROOT / "deploy/release.schema.json").read_text(encoding="utf-8"))

        self.assertEqual(loaded.git_sha, value["git_sha"])
        self.assertEqual(loaded.supported_db_revisions, ("0004_sync",))
        self.assertEqual(loaded.supported_indexeddb_schema_versions, (1, 2))
        self.assertEqual(list(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(value)), [])

    def test_write_emits_a_valid_round_trip(self):
        from scripts.release_manifest import ReleaseManifest

        value = self.valid()
        manifest = ReleaseManifest(
            release_id=value["release_id"],
            git_sha=value["git_sha"],
            build_id=value["build_id"],
            platform=value["platform"],
            web_image=value["web_image"],
            api_image=value["api_image"],
            mysql_image=value["mysql_image"],
            required_db_revision=value["required_db_revision"],
            supported_db_revisions=("0004_sync",),
            indexeddb_schema_version=2,
            supported_indexeddb_schema_versions=(1, 2),
            protocol_versions=(1,),
            reducer_versions=(1,),
            created_at=value["created_at"],
        )

        write_release_manifest(self.path, manifest)

        self.assertEqual(load_release_manifest(self.path), manifest)

    def test_rejects_mutable_image_tags(self):
        for field in ("web_image", "api_image", "mysql_image"):
            value = self.valid()
            value[field] = "ghcr.io/dayforge/image:latest"
            self.write(value)
            with self.subTest(field=field), self.assertRaises(ReleaseManifestError) as caught:
                load_release_manifest(self.path)
            self.assertIn(field, str(caught.exception))

    def test_rejects_short_sha_and_noncanonical_build_ids(self):
        for field, invalid in (("git_sha", "a" * 39), ("build_id", "../unsafe")):
            value = self.valid()
            value[field] = invalid
            self.write(value)
            with self.subTest(field=field), self.assertRaises(ReleaseManifestError) as caught:
                load_release_manifest(self.path)
            self.assertIn(field, str(caught.exception))

    def test_rejects_platform_and_version_contract_mismatch(self):
        for field, invalid in (
            ("platform", "linux/arm/v7"),
            ("supported_db_revisions", ["0003_auth_lifecycle_hardening"]),
            ("supported_indexeddb_schema_versions", [1]),
            ("protocol_versions", [True]),
        ):
            value = self.valid()
            value[field] = invalid
            self.write(value)
            with self.subTest(field=field), self.assertRaises(ReleaseManifestError) as caught:
                load_release_manifest(self.path)
            self.assertIn(field, str(caught.exception))

    def test_rejects_harness_and_unknown_fields_without_echoing_values(self):
        sentinel = "private-test-registry-password"
        value = self.valid()
        value["test_harness"] = True
        value["credential"] = sentinel
        self.write(value)

        with self.assertRaises(ReleaseManifestError) as caught:
            load_release_manifest(self.path)

        self.assertIn("credential", str(caught.exception))
        self.assertIn("test_harness", str(caught.exception))
        self.assertNotIn(sentinel, str(caught.exception))

    def test_malformed_or_missing_file_has_a_safe_error(self):
        self.path.write_text('{"secret":"private-test-value"', encoding="utf-8")
        with self.assertRaises(ReleaseManifestError) as caught:
            load_release_manifest(self.path)
        self.assertEqual(str(caught.exception), "manifest_file")
        self.assertNotIn("private-test-value", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
