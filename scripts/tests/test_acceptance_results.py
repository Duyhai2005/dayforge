import json
import sys
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.release_manifest import ReleaseManifest
from scripts.validate_acceptance import validate_acceptance_results


class AcceptanceResultsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.results_path = self.root / "docs/tasks/t32/acceptance-results.json"
        self.results_path.parent.mkdir(parents=True)
        self.evidence_path = self.root / "docs/tasks/t32/evidence/run.json"
        self.evidence_path.parent.mkdir()
        self.case_evidence_paths = {
            f"AC-{number:02d}": self.root
            / f"docs/tasks/t32/evidence/AC-{number:02d}.txt"
            for number in range(1, 39)
        }
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
            created_at="2026-11-04T00:00:00Z",
        )
        self.tested_at = (
            datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
        )
        self.results = self.valid_results()
        self.write_evidence_manifest()
        self.write_results()

    def tearDown(self):
        self.temporary.cleanup()

    @property
    def expected(self):
        return {
            "release_id": self.release.release_id,
            "git_sha": self.release.git_sha,
            "build_id": self.release.build_id,
            "web_digest": self.release.web_image.rsplit("@", 1)[1],
            "api_digest": self.release.api_image.rsplit("@", 1)[1],
        }

    def valid_results(self):
        rows = []
        for number in range(1, 39):
            ac_id = f"AC-{number:02d}"
            rows.append(
                {
                    "ac_id": ac_id,
                    "status": "PASS",
                    "scope": "staging",
                    "release_id": self.release.release_id,
                    "web_digest": self.release.web_image.rsplit("@", 1)[1],
                    "api_digest": self.release.api_image.rsplit("@", 1)[1],
                    "scenario": f"scenario for {ac_id}",
                    "evidence_paths": [
                        "docs/tasks/t32/evidence/run.json",
                        f"docs/tasks/t32/evidence/{ac_id}.txt",
                    ],
                    "tested_at": self.tested_at,
                    "production_recheck": ac_id in {"AC-31", "AC-32", "AC-36"},
                    "limitations": "Production deployment remains separate.",
                }
            )
        return {
            "format_version": 1,
            "candidate": self.expected,
            "rows": rows,
        }

    def write_evidence_manifest(self):
        self.evidence_path.write_text(
            json.dumps(
                {
                    "artifact_type": "dayforge-staging-evidence",
                    "format_version": 1,
                    "scope": "staging",
                    **self.expected,
                    "tested_at": self.tested_at,
                }
            ),
            encoding="utf-8",
        )
        for ac_id, path in self.case_evidence_paths.items():
            path.write_text(f"Evidence for {ac_id}\n", encoding="utf-8")

    def write_results(self):
        self.results_path.write_text(json.dumps(self.results), encoding="utf-8")

    def validate(self):
        return validate_acceptance_results(
            self.results_path,
            self.release,
            repo_root=self.root,
        )

    def test_accepts_exact_38_row_candidate_with_provenance(self):
        self.assertEqual(self.validate(), [])

    def test_rejects_missing_and_duplicate_ids(self):
        self.results["rows"].pop()
        duplicate = dict(self.results["rows"][0])
        duplicate["ac_id"] = "AC-31"
        self.results["rows"].append(duplicate)
        self.write_results()
        issues = self.validate()
        self.assertIn("AC-31_duplicate", issues)
        self.assertIn("AC-38_missing", issues)

    def test_rejects_pass_without_evidence_or_with_old_release_digest(self):
        row = self.results["rows"][0]
        row["evidence_paths"] = []
        self.results["rows"][1]["web_digest"] = "sha256:" + "e" * 64
        self.write_results()
        issues = self.validate()
        self.assertIn("AC-01_evidence_missing", issues)
        self.assertIn("AC-02_web_digest_mismatch", issues)

    def test_rejects_historical_only_evidence(self):
        historical = self.root / "docs/tasks/t28/acceptance-results.json"
        historical.parent.mkdir(parents=True)
        historical.write_text(json.dumps({"status": "PASS"}), encoding="utf-8")
        self.results["rows"][0]["evidence_paths"] = [
            "docs/tasks/t28/acceptance-results.json",
            "docs/tasks/t32/evidence/AC-01.txt",
        ]
        self.write_results()
        self.assertIn("AC-01_candidate_evidence_manifest_missing", self.validate())

    def test_rejects_run_manifest_without_case_specific_evidence(self):
        self.results["rows"][0]["evidence_paths"] = ["docs/tasks/t32/evidence/run.json"]
        self.write_results()
        self.assertIn("AC-01_scenario_evidence_missing", self.validate())

    def test_requires_production_recheck_for_staging_mail_and_host_cases(self):
        self.results["rows"][30]["production_recheck"] = False
        self.results["rows"][31]["production_recheck"] = False
        self.results["rows"][35]["production_recheck"] = False
        self.write_results()
        issues = self.validate()
        self.assertIn("AC-31_production_recheck_required", issues)
        self.assertIn("AC-32_production_recheck_required", issues)
        self.assertIn("AC-36_production_recheck_required", issues)

    def test_pending_rows_keep_acceptance_incomplete(self):
        self.results["rows"][0]["status"] = "TARGET_PENDING"
        self.write_results()
        self.assertIn("AC-01_target_pending", self.validate())


if __name__ == "__main__":
    unittest.main()
