import asyncio

import pytest
from pydantic import ValidationError

from app.core.config import SettingsError, build_database_url, load_settings


def test_database_url_preserves_reserved_password(settings_factory):
    settings = settings_factory(db_password="test-only:@/#%? mật khẩu")
    url = build_database_url(settings)
    assert url.drivername == "mysql+aiomysql"
    assert url.password == "test-only:@/#%? mật khẩu"
    assert url.query["charset"] == "utf8mb4"
    assert settings.db_password.get_secret_value() not in repr(settings)


@pytest.mark.parametrize("port", ["0", "65536", "3.5", "true"])
def test_invalid_port_is_rejected_without_echo(port):
    env = {"APP_ENV": "test", "DB_PORT": port, "DB_PASSWORD": "test-only-private"}
    with pytest.raises(SettingsError) as caught:
        load_settings(env)
    assert "DB_PORT" in str(caught.value)
    assert "test-only-private" not in str(caught.value)


def test_missing_required_env_is_not_defaulted():
    with pytest.raises(SettingsError) as caught:
        load_settings({})
    assert "DB_NAME" in str(caught.value)


def test_environment_does_not_override_explicit_settings(settings_factory, monkeypatch):
    from app.main import create_app

    monkeypatch.setenv("DB_NAME", "must_not_be_used")
    settings = settings_factory(db_name="explicit_database")
    application = create_app(settings)

    async def check():
        async with application.router.lifespan_context(application):
            assert application.state.settings == settings
            assert application.state.database.engine.url.database == "explicit_database"

    asyncio.run(check())


@pytest.mark.parametrize("origin", ["http://localhost:3000", "https://user:pass@example.com",
                                  "https://example.com/path", "https://example.com?x=1",
                                  "https://example.com#part", "https://"])
def test_invalid_public_origin_is_sanitized(settings_factory, origin):
    with pytest.raises(SettingsError) as caught:
        settings_factory(public_origin=origin)
    assert str(caught.value) == "PUBLIC_ORIGIN"


def test_development_origin_must_match_local_https(settings_factory):
    with pytest.raises(SettingsError):
        settings_factory(app_env="development", public_origin="https://example.com")


@pytest.mark.parametrize("field", ["db_host", "db_name", "db_user", "db_password", "public_origin"])
@pytest.mark.parametrize("value", ["", "   ", "__GENERATE_SECRET__"])
def test_required_values_reject_empty_or_generation_markers(settings_factory, field, value):
    with pytest.raises(SettingsError):
        settings_factory(**{field: value})


def test_settings_are_immutable(settings_factory):
    settings = settings_factory()
    with pytest.raises(ValidationError):
        settings.db_name = "changed"


def test_oversized_port_is_rejected_with_only_field_name(settings_factory):
    with pytest.raises(SettingsError) as caught:
        settings_factory(db_port="9" * 5000)
    assert str(caught.value) == "DB_PORT"
