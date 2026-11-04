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
_rehearsal_results = importlib.import_module("scripts.validate_rehearsal_results")
ReleaseManifest = _release_manifest.ReleaseManifest
validate_rehearsal_results = _rehearsal_results.validate_rehearsal_results
release_fingerprint = _rehearsal_results.release_fingerprint

CASE_IDS = (
    "UP-01",
    "UP-02",
    "UP-03",
    "UP-04",
    "UP-05",
    "UP-06",
    "RB-01",
    "RB-02",
    "RF-01",
    "DR-01",
)


class RehearsalResultsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.results_path = self.root / "docs/tasks/t33/rehearsal-results.json"
        self.results_path.parent.mkdir(parents=True)
        self.evidence_dir = self.root / "docs/tasks/t33/evidence"
        self.evidence_dir.mkdir(parents=True)
        self.from_release = self.release("release-a", "a", "b", "c", "d")
        self.to_release = self.release("release-b", "e", "f", "0", "1")
        self.tested_at = (
            datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
        )
        self.results = self.valid_results()
        self.write_evidence()
        self.write_results()

    def tearDown(self):
        self.temporary.cleanup()

    def release(self, release_id, git, web, api, mysql):
        return ReleaseManifest(
            release_id=release_id,
            git_sha=git * 40,
            build_id=f"{release_id}-build",
            platform="linux/amd64",
            web_image=f"registry.example/dayforge-web@sha256:{web * 64}",
            api_image=f"registry.example/dayforge-api@sha256:{api * 64}",
            mysql_image=f"mysql@sha256:{mysql * 64}",
            required_db_revision="0004_sync",
            supported_db_revisions=("0004_sync",),
            indexeddb_schema_version=2,
            supported_indexeddb_schema_versions=(1, 2),
            protocol_versions=(1,),
            reducer_versions=(1,),
            created_at="2026-11-04T00:00:00Z",
        )

    def valid_results(self):
        return {
            "format_version": 1,
            "from_release_id": self.from_release.release_id,
            "to_release_id": self.to_release.release_id,
            "cases": [
                {
                    "case_id": case_id,
                    "status": "PASS",
                    "case_variants": (
                        ["late-flight", "previous-static"]
                        if case_id == "UP-06"
                        else ["restore-union"]
                        if case_id == "DR-01"
                        else ["migration-interruption"]
                        if case_id == "RF-01"
                        else ["default"]
                    ),
                    "expected_action": f"expected {case_id}",
                    "actual_status": f"verified {case_id}",
                    "evidence_paths": [
                        f"docs/tasks/t33/evidence/{case_id}.json",
                        f"docs/tasks/t33/evidence/{case_id}.txt",
                    ],
                    "from_digest": release_fingerprint(self.from_release),
                    "to_digest": release_fingerprint(self.to_release),
                    "same_origin": None if case_id == "RF-01" else True,
                    "same_profile": None if case_id == "RF-01" else True,
                    "origin_sha256": "a" * 64 if case_id == "DR-01" else None,
                    "profile_a_sha256": "b" * 64 if case_id == "DR-01" else None,
                    "profile_b_sha256": "c" * 64 if case_id == "DR-01" else None,
                    "snapshot_id": "d" * 64 if case_id == "DR-01" else None,
                }
                for case_id in CASE_IDS
            ],
        }

    def write_evidence(self):
        for row in self.results["cases"]:
            evidence = {
                "artifact_type": "dayforge-release-rehearsal-evidence",
                "format_version": 1,
                "case_id": row["case_id"],
                "tested_at": self.tested_at,
                "from_release_id": self.from_release.release_id,
                "from_git_sha": self.from_release.git_sha,
                "from_build_id": self.from_release.build_id,
                "from_web_digest": self.from_release.web_image.rsplit("@", 1)[1],
                "from_api_digest": self.from_release.api_image.rsplit("@", 1)[1],
                "from_mysql_digest": self.from_release.mysql_image.rsplit("@", 1)[1],
                "to_release_id": self.to_release.release_id,
                "to_git_sha": self.to_release.git_sha,
                "to_build_id": self.to_release.build_id,
                "to_web_digest": self.to_release.web_image.rsplit("@", 1)[1],
                "to_api_digest": self.to_release.api_image.rsplit("@", 1)[1],
                "to_mysql_digest": self.to_release.mysql_image.rsplit("@", 1)[1],
                "same_origin": row["same_origin"],
                "same_profile": row["same_profile"],
                "origin_sha256": row["origin_sha256"],
                "profile_a_sha256": row["profile_a_sha256"],
                "profile_b_sha256": row["profile_b_sha256"],
                "snapshot_id": row["snapshot_id"],
            }
            (self.evidence_dir / f"{row['case_id']}.json").write_text(
                json.dumps(evidence), encoding="utf-8"
            )
            (self.evidence_dir / f"{row['case_id']}.txt").write_text(
                f"Case-specific evidence for {row['case_id']}\n", encoding="utf-8"
            )

    def write_results(self):
        self.results_path.write_text(json.dumps(self.results), encoding="utf-8")

    def validate(self):
        return validate_rehearsal_results(
            self.results_path,
            self.from_release,
            self.to_release,
            evidence_root=self.root,
        )

    def test_accepts_all_ten_cases_with_candidate_bound_evidence(self):
        self.assertEqual(self.validate(), [])

    def test_rejects_missing_and_duplicate_case_ids(self):
        self.results["cases"].pop()
        duplicate = dict(self.results["cases"][0])
        duplicate["case_id"] = "UP-01"
        self.results["cases"].append(duplicate)
        self.write_results()
        issues = self.validate()
        self.assertIn("DR-01_missing", issues)
        self.assertIn("UP-01_duplicate", issues)

    def test_rejects_wrong_digest_and_missing_case_evidence(self):
        self.results["cases"][0]["from_digest"] = "sha256:" + "0" * 64
        self.results["cases"][1]["evidence_paths"] = []
        self.write_results()
        issues = self.validate()
        self.assertIn("UP-01_from_digest_mismatch", issues)
        self.assertIn("UP-02_evidence_missing", issues)

    def test_restore_case_requires_snapshot_identity(self):
        self.results["cases"][-1]["snapshot_id"] = "snapshot-t33-001"
        self.write_results()
        self.assertIn("DR-01_snapshot_id_missing", self.validate())

    def test_restore_case_requires_origin_and_persistent_profile_bindings(self):
        self.results["cases"][-1]["profile_a_sha256"] = None
        self.write_results()
        self.assertIn("DR-01_profile_a_sha256_missing", self.validate())

    def test_update_static_and_flight_case_requires_both_subcases(self):
        up06 = next(row for row in self.results["cases"] if row["case_id"] == "UP-06")
        up06["case_variants"] = ["late-flight"]
        self.write_results()
        self.assertIn("UP-06_required_variants_missing", self.validate())

    def test_rejects_evidence_from_a_different_candidate(self):
        evidence_path = self.evidence_dir / "UP-01.json"
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
        evidence["to_api_digest"] = "sha256:" + "9" * 64
        evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
        self.assertIn("UP-01_candidate_evidence_manifest_missing", self.validate())

    def test_pending_case_keeps_report_incomplete(self):
        self.results["cases"][0]["status"] = "TARGET_PENDING"
        self.write_results()
        self.assertIn("UP-01_target_pending", self.validate())

    def test_rejects_evidence_symlink_even_when_target_is_inside_root(self):
        source = self.evidence_dir / "UP-01.txt"
        linked = self.evidence_dir / "linked.txt"
        try:
            linked.symlink_to(source)
        except OSError:
            self.skipTest("symlink creation is unavailable on this platform")
        self.results["cases"][0]["evidence_paths"][1] = (
            "docs/tasks/t33/evidence/linked.txt"
        )
        self.write_results()
        self.assertIn("UP-01_case_evidence_missing", self.validate())


if __name__ == "__main__":
    unittest.main()
