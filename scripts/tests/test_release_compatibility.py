import importlib
import json
import sys
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

_release_manifest = importlib.import_module("scripts.release_manifest")
_compatibility = importlib.import_module("scripts.check_release_compatibility")
ReleaseManifest = _release_manifest.ReleaseManifest
RuntimeCompatibility = _compatibility.RuntimeCompatibility
check_release_compatibility = _compatibility.check_release_compatibility
load_runtime_compatibility = _compatibility.load_runtime_compatibility


class ReleaseCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.release = ReleaseManifest(
            release_id="release-a",
            git_sha="a" * 40,
            build_id="release-a-build",
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
        self.compatible_runtime = RuntimeCompatibility("0004_sync", 2, 1, 1)

    def test_allows_a_manifest_explicitly_supporting_the_runtime(self):
        decision = check_release_compatibility(self.release, self.compatible_runtime)
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.reasons, ())

    def test_rejects_each_unsupported_data_or_protocol_version(self):
        unsupported = (
            (
                RuntimeCompatibility("0005_rehearsal", 2, 1, 1),
                "db_revision_unsupported",
            ),
            (RuntimeCompatibility("0004_sync", 3, 1, 1), "local_schema_unsupported"),
            (RuntimeCompatibility("0004_sync", 2, 2, 1), "protocol_unsupported"),
            (RuntimeCompatibility("0004_sync", 2, 1, 2), "reducer_unsupported"),
        )
        for runtime, reason in unsupported:
            with self.subTest(reason=reason):
                decision = check_release_compatibility(self.release, runtime)
                self.assertFalse(decision.allowed)
                self.assertEqual(decision.reasons, (reason,))

    def test_numeric_revision_order_does_not_imply_compatibility(self):
        decision = check_release_compatibility(
            self.release, RuntimeCompatibility("0005_rehearsal", 2, 1, 1)
        )
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.reasons, ("db_revision_unsupported",))

    def test_runtime_file_requires_the_exact_typed_schema(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "runtime.json"
            path.write_text(
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
            self.assertEqual(load_runtime_compatibility(path), self.compatible_runtime)
            path.write_text(
                json.dumps(
                    {
                        "db_revision": "0004_sync",
                        "indexeddb_schema_version": True,
                        "protocol_version": 1,
                        "reducer_version": 1,
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "runtime_manifest_invalid"):
                load_runtime_compatibility(path)


if __name__ == "__main__":
    unittest.main()
