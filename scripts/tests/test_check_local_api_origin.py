import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


class CheckLocalApiOriginTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        (self.root / "scripts").mkdir()
        (self.root / "frontend").mkdir()
        self.script = self.root / "scripts/check-local-api-origin.cjs"
        shutil.copyfile(REPO_ROOT / "scripts/check-local-api-origin.cjs", self.script)
        self.env_file = self.root / "frontend/.env.local"
        self.process_env = os.environ.copy()
        self.process_env.pop("API_INTERNAL_ORIGIN", None)
        self.process_env.pop("__NEXT_PROCESSED_ENV", None)
        # Resolve the real pinned Next.js installation from the isolated fixture.
        self.process_env["NODE_PATH"] = str(REPO_ROOT / "frontend/node_modules")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def run_guard(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["node", str(self.script)],
            cwd=self.root / "frontend",
            env=self.process_env,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_accepts_quoted_origin_from_frontend_env_file(self) -> None:
        for quote in ('"', "'"):
            with self.subTest(quote=quote):
                self.env_file.write_text(
                    f"API_INTERNAL_ORIGIN={quote}http://127.0.0.1:8000{quote}\n",
                    encoding="utf-8",
                )
                result = self.run_guard()
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_origins_outside_exact_allowed_value(self) -> None:
        for origin in (
            "http://localhost:8000",
            "http://127.0.0.1:8000/",
            "https://127.0.0.1:8000",
        ):
            with self.subTest(origin=origin):
                self.env_file.write_text(f'API_INTERNAL_ORIGIN="{origin}"\n')
                result = self.run_guard()
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("API_INTERNAL_ORIGIN must be", result.stderr)


if __name__ == "__main__":
    unittest.main()
