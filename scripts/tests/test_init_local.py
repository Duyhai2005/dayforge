import shutil
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from scripts.init_local import initialize_local


TEMPLATES = (
    (".env.example", ".env"),
    ("backend/.env.example", "backend/.env"),
    ("frontend/.env.example", "frontend/.env.local"),
)


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.lstrip().startswith("#"):
            continue
        key, value = line.split("=", maxsplit=1)
        values[key] = value
    return values


class InitializeLocalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.copy_templates()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def copy_templates(self) -> None:
        for source_name, _ in TEMPLATES:
            source = REPO_ROOT / source_name
            destination = self.root / source_name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)

    def output_paths(self) -> tuple[Path, Path, Path]:
        return tuple(self.root / destination for _, destination in TEMPLATES)

    def test_creates_matching_database_credentials(self) -> None:
        compose_path, backend_path, frontend_path = initialize_local(self.root)
        compose_env = read_env(compose_path)
        backend_env = read_env(backend_path)
        frontend_env = read_env(frontend_path)

        self.assertEqual(compose_env["MYSQL_PASSWORD"], backend_env["DB_PASSWORD"])
        self.assertGreaterEqual(len(compose_env["MYSQL_PASSWORD"]), 32)
        self.assertNotEqual(compose_env["MYSQL_PASSWORD"], compose_env["MYSQL_ROOT_PASSWORD"])
        self.assertNotIn("MYSQL_ROOT_PASSWORD", backend_env)
        self.assertEqual(frontend_env, {"API_INTERNAL_ORIGIN": "http://127.0.0.1:8000"})

    def test_rerun_preserves_all_existing_bytes(self) -> None:
        paths = initialize_local(self.root)
        before = tuple(path.read_bytes() for path in paths)

        rerun_paths = initialize_local(self.root)

        self.assertEqual(rerun_paths, paths)
        self.assertEqual(tuple(path.read_bytes() for path in paths), before)

    def test_partial_configuration_refuses_without_writing(self) -> None:
        existing = self.root / ".env"
        original_bytes = b"MYSQL_PASSWORD=keep-this-value\n"
        existing.write_bytes(original_bytes)
        missing_backend = self.root / "backend/.env"
        missing_frontend = self.root / "frontend/.env.local"

        with self.assertRaises(FileExistsError) as raised:
            initialize_local(self.root)

        self.assertIn("backend/.env", str(raised.exception))
        self.assertIn("frontend/.env.local", str(raised.exception))
        self.assertEqual(existing.read_bytes(), original_bytes)
        self.assertFalse(missing_backend.exists())
        self.assertFalse(missing_frontend.exists())

    def test_path_with_spaces_and_unicode(self) -> None:
        root_with_spaces = self.root / "Dayforge thử nghiệm"
        root_with_spaces.mkdir()
        self.copy_templates_to(root_with_spaces)

        paths = initialize_local(root_with_spaces)

        self.assertTrue(all(path.is_file() for path in paths))

    def copy_templates_to(self, root: Path) -> None:
        for source_name, _ in TEMPLATES:
            destination = root / source_name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO_ROOT / source_name, destination)

    def test_missing_template_creates_no_output(self) -> None:
        (self.root / "frontend/.env.example").unlink()

        with self.assertRaises(FileNotFoundError):
            initialize_local(self.root)

        self.assertFalse(any(path.exists() for path in self.output_paths()))


if __name__ == "__main__":
    unittest.main()
