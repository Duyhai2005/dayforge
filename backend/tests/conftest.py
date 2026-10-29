import os
import re

import pytest


@pytest.fixture
def settings_factory():
    from app.core.config import Settings

    def factory(**overrides):
        values = dict(app_env="test", public_origin="https://localhost:3000",
                      db_host="127.0.0.1", db_port=3306, db_name="dayforge_t05_test",
                      db_user="dayforge_test", db_password="test-only-password")
        values.update(overrides)
        return Settings(**values)

    return factory


@pytest.fixture
def t05_mysql_settings():
    from app.core.config import load_settings

    run_id = os.environ.get("DAYFORGE_T05_TEST_RUN_ID", "")
    if not re.fullmatch(r"[0-9a-f]{32}", run_id):
        pytest.fail("MySQL tests require an isolated runner test-run ID")
    if (os.environ.get("DB_NAME") != "dayforge_t05_test"
            or os.environ.get("APP_ENV") != "test"
            or os.environ.get("DB_USER") != "dayforge_test"
            or os.environ.get("DB_HOST") != "127.0.0.1"
            or not re.fullmatch(r"[0-9a-f]{12,64}", os.environ.get("DAYFORGE_T05_TEST_CONTAINER_ID", ""))
            or os.environ.get("DAYFORGE_T05_TEST_PROJECT") != f"dayforge-t05-{run_id}"):
        pytest.fail("MySQL test environment is not isolated")
    return load_settings()
