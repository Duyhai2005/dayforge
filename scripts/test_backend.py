"""Run backend tests, provisioning only a unique disposable MySQL project."""

from collections.abc import Sequence
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import tempfile
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"


class RunnerError(Exception):
    pass


def _docker(arguments: list[str], environ: dict[str, str]) -> str:
    try:
        result = subprocess.run(["docker", *arguments], cwd=ROOT, env=environ,
                                capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired):
        raise RunnerError("Docker command unavailable or timed out") from None
    if result.returncode:
        # Docker output may contain interpolated credentials; never forward it.
        raise RunnerError("Docker command failed")
    return result.stdout.strip()


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    mysql = bool(arguments and arguments[0] == "--mysql")
    if mysql:
        arguments.pop(0)
    if arguments[:1] == ["--"]:
        arguments.pop(0)
    pytest = [sys.executable, "-m", "pytest", "-m", "mysql" if mysql else "not mysql", *arguments]
    if not mysql:
        return subprocess.run(pytest, cwd=BACKEND).returncode

    run_id = uuid4().hex
    project = f"dayforge-t05-{run_id}"
    environ = os.environ.copy()
    compose = None
    exit_code = 1
    with tempfile.TemporaryDirectory(prefix="dayforge-t05-") as directory:
        env_file = Path(directory) / "empty.env"
        env_file.write_text("", encoding="utf-8")
        try:
            images = _docker(["compose", "--env-file", ".env", "config", "--images"], environ).splitlines()
            if len(images) != 1 or not re.fullmatch(r"mysql:[^\s@]+@sha256:[0-9a-f]{64}", images[0]):
                raise RunnerError("Expected exactly one digest-pinned MySQL image")
            # Docker may reassign an empty published port after stop/start.
            # Select an available OS port once and bind it explicitly so the
            # same application engine can prove outage recovery at one endpoint.
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.bind(("127.0.0.1", 0))
                test_port = str(probe.getsockname()[1])
            environ.update(
                DAYFORGE_T05_MYSQL_IMAGE=images[0],
                DAYFORGE_T05_MYSQL_PASSWORD=secrets.token_hex(32),
                DAYFORGE_T05_MYSQL_ROOT_PASSWORD=secrets.token_hex(32),
                DAYFORGE_T05_MYSQL_PORT=test_port,
            )
            compose = ["compose", "--env-file", str(env_file), "-f",
                       str(BACKEND / "tests" / "compose.mysql.yaml"), "--project-name", project]
            _docker([*compose, "up", "-d", "--wait", "--wait-timeout", "120"], environ)
            port = _docker([*compose, "port", "mysql", "3306"], environ)
            match = re.fullmatch(r"127\.0\.0\.1:([0-9]+)", port)
            container = _docker([*compose, "ps", "-q", "mysql"], environ)
            if (not match or match[1] != test_port
                    or not re.fullmatch(r"[0-9a-f]{12,64}", container)):
                raise RunnerError("Invalid isolated MySQL endpoint")
            environ.update(
                APP_ENV="test", PUBLIC_ORIGIN="https://localhost:3000", DB_HOST="127.0.0.1",
                DB_PORT=match[1], DB_NAME="dayforge_t05_test", DB_USER="dayforge_test",
                DB_PASSWORD=environ["DAYFORGE_T05_MYSQL_PASSWORD"], DAYFORGE_T05_TEST_RUN_ID=run_id,
                DAYFORGE_T05_TEST_PROJECT=project, DAYFORGE_T05_TEST_CONTAINER_ID=container,
            )
            # Tests receive only the application credential, never the root credential.
            test_environ = {key: value for key, value in environ.items()
                            if key not in ("DAYFORGE_T05_MYSQL_ROOT_PASSWORD", "MYSQL_ROOT_PASSWORD")}
            exit_code = subprocess.run(pytest, cwd=BACKEND, env=test_environ).returncode
        except (RunnerError, OSError):
            print("Isolated MySQL test runner failed; Docker details suppressed to protect credentials.", file=sys.stderr)
        finally:
            if compose is not None and re.fullmatch(r"dayforge-t05-[0-9a-f]{32}", project):
                try:
                    _docker([*compose, "down", "--volumes", "--remove-orphans"], environ)
                except RunnerError:
                    print("Isolated MySQL cleanup failed for " + project, file=sys.stderr)
                    exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
