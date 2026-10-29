import os
import re
from datetime import datetime, timezone
from uuid import uuid4

import pytest


@pytest.fixture
def user_factory():
    from app.models.owner import User

    def factory(**overrides):
        identifier = uuid4()
        instant = datetime(2026, 10, 29, 1, 2, 3, 456000, tzinfo=timezone.utc)
        values = dict(id=identifier, owner_slot=1,
                      email_canonical=f"owner-{identifier.hex}@example.test".encode("utf-8"),
                      email_delivery=f"owner-{identifier.hex}@example.test",
                      password_hash="$argon2id$v=19$storage-test-placeholder",
                      email_verified_at=instant, auth_version=1,
                      created_at=instant, updated_at=instant)
        values.update(overrides)
        return User(**values)

    return factory


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
