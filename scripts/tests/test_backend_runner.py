import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from scripts.test_backend import RunnerError, main  # noqa: E402

CANONICAL_IMAGE = "mysql:8.4.13@sha256:a0225d1ea6631c8bc2385dc4c2faba17bbf1834ecf369e1659a9a382bd8d5dd7"


class BackendRunnerTests(unittest.TestCase):
    def test_case_a_non_mysql_does_not_call_docker(self) -> None:
        with (
            patch("subprocess.run") as mock_run,
            patch("scripts.test_backend._docker") as mock_docker,
        ):
            mock_run.return_value = MagicMock(returncode=0)
            code = main([])
            self.assertEqual(code, 0)
            mock_docker.assert_not_called()
            mock_run.assert_called_once()
            called_cmd = mock_run.call_args[0][0]
            self.assertIn("not mysql", called_cmd)

    def test_case_b_mysql_image_resolution_requires_no_dotenv(self) -> None:
        docker_calls = []

        def fake_docker(args, env):
            docker_calls.append((args, env))
            if "config" in args and "--images" in args:
                # Prove no .env file path was passed in args
                self.assertNotIn(".env", args)
                # Prove probe values exist in env
                self.assertEqual(env.get("MYSQL_DATABASE"), "dayforge_probe")
                self.assertEqual(env.get("MYSQL_USER"), "dayforge_probe")
                self.assertEqual(env.get("MYSQL_PASSWORD"), "probe")
                self.assertEqual(env.get("MYSQL_ROOT_PASSWORD"), "probe")
                return CANONICAL_IMAGE
            if "up" in args:
                return ""
            if "port" in args:
                port = env["DAYFORGE_TEST_MYSQL_PORT"]
                return f"127.0.0.1:{port}"
            if "ps" in args:
                return "112233445566"
            if "down" in args:
                return ""
            return ""

        with (
            patch("scripts.test_backend._docker", side_effect=fake_docker),
            patch("subprocess.run") as mock_run,
        ):
            mock_run.return_value = MagicMock(returncode=0)
            code = main(["--mysql"])
            self.assertEqual(code, 0)

    def test_case_c_non_digest_pinned_mysql_image_fails(self) -> None:
        def fake_docker(args, env):
            if "config" in args and "--images" in args:
                return "mysql:8.4"
            return ""

        with (
            patch("scripts.test_backend._docker", side_effect=fake_docker),
            patch("subprocess.run") as mock_run,
        ):
            code = main(["--mysql"])
            self.assertEqual(code, 1)
            mock_run.assert_not_called()

    def test_case_d_multiple_images_fails_closed(self) -> None:
        def fake_docker(args, env):
            if "config" in args and "--images" in args:
                return f"{CANONICAL_IMAGE}\nredis:alpine"
            return ""

        with (
            patch("scripts.test_backend._docker", side_effect=fake_docker),
            patch("subprocess.run") as mock_run,
        ):
            code = main(["--mysql"])
            self.assertEqual(code, 1)
            mock_run.assert_not_called()

    def test_case_e_invalid_container_id_fails_before_pytest(self) -> None:
        def fake_docker(args, env):
            if "config" in args and "--images" in args:
                return CANONICAL_IMAGE
            if "up" in args:
                return ""
            if "port" in args:
                port = env["DAYFORGE_TEST_MYSQL_PORT"]
                return f"127.0.0.1:{port}"
            if "ps" in args:
                return "not-a-valid-hex-container-id"
            if "down" in args:
                return ""
            return ""

        with (
            patch("scripts.test_backend._docker", side_effect=fake_docker),
            patch("subprocess.run") as mock_run,
        ):
            code = main(["--mysql"])
            self.assertEqual(code, 1)
            mock_run.assert_not_called()

    def test_case_f_project_isolation_guard(self) -> None:
        captured_env = {}

        def fake_docker(args, env):
            if "config" in args and "--images" in args:
                return CANONICAL_IMAGE
            if "up" in args:
                return ""
            if "port" in args:
                port = env["DAYFORGE_TEST_MYSQL_PORT"]
                return f"127.0.0.1:{port}"
            if "ps" in args:
                return "aabbccddeeff"
            if "down" in args:
                return ""
            return ""

        def fake_run(cmd, cwd=None, env=None):
            nonlocal captured_env
            captured_env = env or {}
            return MagicMock(returncode=0)

        with (
            patch("scripts.test_backend._docker", side_effect=fake_docker),
            patch("subprocess.run", side_effect=fake_run),
        ):
            code = main(["--mysql"])
            self.assertEqual(code, 0)
            run_id = captured_env.get("DAYFORGE_TEST_RUN_ID")
            self.assertRegex(run_id, r"^[0-9a-f]{32}$")
            self.assertEqual(
                captured_env.get("DAYFORGE_TEST_PROJECT"), f"dayforge-test-{run_id}"
            )
            self.assertEqual(captured_env.get("DB_NAME"), "dayforge_test")
            self.assertEqual(captured_env.get("DB_USER"), "dayforge_test")

    def test_case_g_pytest_failure_still_executes_cleanup(self) -> None:
        cleanup_called = False

        def fake_docker(args, env):
            nonlocal cleanup_called
            if "config" in args and "--images" in args:
                return CANONICAL_IMAGE
            if "up" in args:
                return ""
            if "port" in args:
                port = env["DAYFORGE_TEST_MYSQL_PORT"]
                return f"127.0.0.1:{port}"
            if "ps" in args:
                return "112233445566"
            if "down" in args:
                cleanup_called = True
                self.assertIn("--volumes", args)
                self.assertIn("--remove-orphans", args)
                return ""
            return ""

        with (
            patch("scripts.test_backend._docker", side_effect=fake_docker),
            patch("subprocess.run") as mock_run,
        ):
            mock_run.return_value = MagicMock(returncode=42)
            code = main(["--mysql"])
            self.assertEqual(code, 42)
            self.assertTrue(cleanup_called)

    def test_case_h_cleanup_failure_fails_overall(self) -> None:
        def fake_docker(args, env):
            if "config" in args and "--images" in args:
                return CANONICAL_IMAGE
            if "up" in args:
                return ""
            if "port" in args:
                port = env["DAYFORGE_TEST_MYSQL_PORT"]
                return f"127.0.0.1:{port}"
            if "ps" in args:
                return "112233445566"
            if "down" in args:
                raise RunnerError("docker down error")
            return ""

        with (
            patch("scripts.test_backend._docker", side_effect=fake_docker),
            patch("subprocess.run") as mock_run,
        ):
            mock_run.return_value = MagicMock(returncode=0)
            code = main(["--mysql"])
            self.assertEqual(code, 1)

    def test_case_i_root_credentials_not_passed_to_pytest(self) -> None:
        passed_env = {}

        def fake_docker(args, env):
            if "config" in args and "--images" in args:
                return CANONICAL_IMAGE
            if "up" in args:
                return ""
            if "port" in args:
                port = env["DAYFORGE_TEST_MYSQL_PORT"]
                return f"127.0.0.1:{port}"
            if "ps" in args:
                return "112233445566"
            if "down" in args:
                return ""
            return ""

        def fake_run(cmd, cwd=None, env=None):
            nonlocal passed_env
            passed_env = env or {}
            return MagicMock(returncode=0)

        with (
            patch("scripts.test_backend._docker", side_effect=fake_docker),
            patch("subprocess.run", side_effect=fake_run),
        ):
            main(["--mysql"])
            self.assertNotIn("DAYFORGE_TEST_MYSQL_ROOT_PASSWORD", passed_env)
            self.assertNotIn("MYSQL_ROOT_PASSWORD", passed_env)

    def test_case_j_cli_passthrough(self) -> None:
        with (
            patch("subprocess.run") as mock_run,
            patch("scripts.test_backend._docker"),
        ):
            mock_run.return_value = MagicMock(returncode=0)
            main(["tests/unit/test_config.py", "-v", "-k", "foo"])
            called_cmd = mock_run.call_args[0][0]
            self.assertIn("tests/unit/test_config.py", called_cmd)
            self.assertIn("-v", called_cmd)
            self.assertIn("-k", called_cmd)
            self.assertIn("foo", called_cmd)


if __name__ == "__main__":
    unittest.main()
