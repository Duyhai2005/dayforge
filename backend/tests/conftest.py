import os
import re
from datetime import datetime, timezone
from uuid import uuid4

import pytest


@pytest.fixture
def contract_validator():
    import json
    from pathlib import Path

    from jsonschema import Draft202012Validator, FormatChecker

    schema = json.loads(
        (
            Path(__file__).resolve().parents[2] / "docs/tasks/t03/contract.schema.json"
        ).read_text(encoding="utf-8")
    )

    def validator(definition):
        return Draft202012Validator(
            {"$ref": f"#/$defs/{definition}", "$defs": schema["$defs"]},
            format_checker=FormatChecker(),
        )

    return validator


@pytest.fixture
def system_client(settings_factory):
    import warnings

    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="Using `httpx` with `starlette.testclient` is deprecated.*",
        )
        from fastapi.testclient import TestClient
    from app.main import create_app

    with TestClient(create_app(settings_factory(db_port=1))) as client:
        yield client


@pytest.fixture
def mysql_control(mysql_test_settings):
    import subprocess
    from time import monotonic, sleep

    container = os.environ["DAYFORGE_TEST_CONTAINER_ID"]
    project = os.environ["DAYFORGE_TEST_PROJECT"]

    def docker(*arguments, timeout=15):
        try:
            result = subprocess.run(
                ["docker", *arguments], capture_output=True, text=True, timeout=timeout
            )
        except (OSError, subprocess.TimeoutExpired):
            pytest.fail("Isolated MySQL control unavailable")
        code, output = result.returncode, result.stdout.strip()
        del result
        if code:
            pytest.fail("Isolated MySQL control failed (details suppressed)")
        return output

    actual_project = docker(
        "inspect",
        "--format",
        '{{ index .Config.Labels "com.docker.compose.project" }}',
        container,
    )
    if actual_project != project:
        pytest.fail("Isolated MySQL container project mismatch")
    initial_endpoint = docker("port", container, "3306/tcp")

    def control(action):
        if action not in ("stop", "start"):
            raise ValueError("invalid_mysql_control_action")
        deadline = monotonic() + 120
        docker(action, container)
        if action == "start":
            while monotonic() < deadline:
                if (
                    docker(
                        "inspect",
                        "--format",
                        "{{.State.Health.Status}}",
                        container,
                        timeout=min(15, deadline - monotonic()),
                    )
                    == "healthy"
                ):
                    if (
                        docker(
                            "port",
                            container,
                            "3306/tcp",
                            timeout=min(15, deadline - monotonic()),
                        )
                        != initial_endpoint
                    ):
                        pytest.fail(
                            "Isolated MySQL published endpoint changed across container restart"
                        )
                    return
                sleep(1)
            pytest.fail("Isolated MySQL did not become healthy")

    return control


@pytest.fixture
def user_factory():
    from app.models.owner import User

    def factory(**overrides):
        identifier = uuid4()
        instant = datetime(2026, 10, 29, 1, 2, 3, 456000, tzinfo=timezone.utc)
        values = dict(
            id=identifier,
            owner_slot=1,
            email_canonical=f"owner-{identifier.hex}@example.test".encode("utf-8"),
            email_delivery=f"owner-{identifier.hex}@example.test",
            password_hash="$argon2id$v=19$storage-test-placeholder",
            email_verified_at=instant,
            auth_version=1,
            created_at=instant,
            updated_at=instant,
        )
        values.update(overrides)
        return User(**values)

    return factory


@pytest.fixture
def settings_factory():
    from app.core.config import Settings

    def factory(**overrides):
        values = dict(
            app_env="test",
            public_origin="https://localhost:3000",
            db_host="127.0.0.1",
            db_port=3306,
            db_name="dayforge_test",
            db_user="dayforge_test",
            db_password="test-only-password",
        )
        values.update(overrides)
        return Settings(**values)

    return factory


@pytest.fixture
def mysql_test_settings():
    from app.core.config import load_settings

    run_id = os.environ.get("DAYFORGE_TEST_RUN_ID", "")
    if not re.fullmatch(r"[0-9a-f]{32}", run_id):
        pytest.fail("MySQL tests require an isolated runner test-run ID")
    if (
        os.environ.get("DB_NAME") != "dayforge_test"
        or os.environ.get("APP_ENV") != "test"
        or os.environ.get("DB_USER") != "dayforge_test"
        or os.environ.get("DB_HOST") != "127.0.0.1"
        or not re.fullmatch(
            r"[0-9a-f]{12,64}", os.environ.get("DAYFORGE_TEST_CONTAINER_ID", "")
        )
        or os.environ.get("DAYFORGE_TEST_PROJECT") != f"dayforge-test-{run_id}"
    ):
        pytest.fail("MySQL test environment is not isolated")
    return load_settings()


_mysql_skipped_tests: set[str] = set()


def pytest_runtest_logreport(report):
    if not os.environ.get("DAYFORGE_TEST_RUN_ID"):
        return
    if report.skipped and not hasattr(report, "wasxfail"):
        _mysql_skipped_tests.add(report.nodeid)


def pytest_sessionfinish(session, exitstatus):
    if not os.environ.get("DAYFORGE_TEST_RUN_ID"):
        return
    if _mysql_skipped_tests and session.exitstatus == 0:
        session.exitstatus = 1


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    if os.environ.get("DAYFORGE_TEST_RUN_ID") and _mysql_skipped_tests:
        terminalreporter.write_sep(
            "=",
            f"MySQL acceptance failed because {len(_mysql_skipped_tests)} selected test(s) were skipped: {', '.join(sorted(_mysql_skipped_tests))}",
            red=True,
            bold=True,
        )
