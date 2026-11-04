import os
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
RUNNER = REPO_ROOT / "scripts" / "run_staging_acceptance.cjs"


class StagingRunnerTests(unittest.TestCase):
    def run_runner(self, arguments, environment=None):
        env = os.environ.copy()
        env.pop("DAYFORGE_SYNC_TEST_HARNESS", None)
        env.pop("DAYFORGE_OFFLINE_UPDATE_TEST_HARNESS", None)
        env.pop("DAYFORGE_PLAYWRIGHT_MOCK_API", None)
        env.pop("PLAYWRIGHT_BASE_URL", None)
        if environment:
            env.update(environment)
        return subprocess.run(
            ["node", str(RUNNER), *arguments],
            cwd=REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )

    def test_requires_config_release_output_and_private_credentials_path(self):
        result = self.run_runner([])
        self.assertEqual(result.returncode, 2)
        self.assertIn("staging_arguments_invalid", result.stderr)

        with tempfile.TemporaryDirectory() as temporary:
            result = self.run_runner(
                [
                    "--config",
                    str(Path(temporary) / "staging.json"),
                    "--release",
                    str(Path(temporary) / "release.json"),
                    "--output",
                    str(Path(temporary) / "artifacts"),
                ]
            )
        self.assertEqual(result.returncode, 2)
        self.assertIn("staging_credentials_path_required", result.stderr)

    def test_rejects_inherited_mock_or_product_harness_flags(self):
        for variable in (
            "DAYFORGE_SYNC_TEST_HARNESS",
            "DAYFORGE_OFFLINE_UPDATE_TEST_HARNESS",
            "DAYFORGE_PLAYWRIGHT_MOCK_API",
        ):
            with self.subTest(variable=variable):
                result = self.run_runner(
                    [
                        "--config",
                        "staging.json",
                        "--release",
                        "release.json",
                        "--output",
                        "artifacts",
                    ],
                    {variable: "1"},
                )
                self.assertEqual(result.returncode, 2)
                self.assertIn("staging_harness_environment_detected", result.stderr)

    def test_rejects_playwright_config_override_and_unsupported_flags(self):
        result = self.run_runner(
            [
                "--config",
                "staging.json",
                "--release",
                "release.json",
                "--output",
                "artifacts",
                "--",
                "--config=playwright.production.config.ts",
            ]
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("staging_playwright_arguments_invalid", result.stderr)

    def test_rejects_a_conflicting_inherited_origin(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "staging.json"
            config.write_text(
                '{"public_origin":"https://staging.dayforge.dev"}', encoding="utf-8"
            )
            result = self.run_runner(
                [
                    "--config",
                    str(config),
                    "--release",
                    "release.json",
                    "--output",
                    "artifacts",
                ],
                {"PLAYWRIGHT_BASE_URL": "https://another.dayforge.dev"},
            )
        self.assertEqual(result.returncode, 2)
        self.assertIn("staging_origin_mismatch", result.stderr)


if __name__ == "__main__":
    unittest.main()
