import asyncio
import base64

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


@pytest.mark.parametrize(
    "origin",
    [
        "http://localhost:3000",
        "https://user:pass@example.com",
        "https://example.com/path",
        "https://example.com?x=1",
        "https://example.com#part",
        "https://",
    ],
)
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


def test_unknown_constructor_field_is_rejected_without_echo(settings_factory):
    with pytest.raises(SettingsError) as caught:
        settings_factory(unknown_option="test-only-private-option")
    assert str(caught.value) == "unknown_option"
    assert "test-only-private-option" not in str(caught.value)


def test_unrelated_environment_variables_are_ignored():
    settings = load_settings(
        {
            "APP_ENV": "test",
            "PUBLIC_ORIGIN": "https://localhost:3000",
            "DB_HOST": "127.0.0.1",
            "DB_PORT": "3306",
            "DB_NAME": "dayforge_t05_test",
            "DB_USER": "dayforge_test",
            "DB_PASSWORD": "test-only-password",
            "OWNER_EMAIL": "owner@example.test",
            "LOCAL_KEY_KEK_B64": "A" * 43,
            "LOCAL_KEY_KEK_VERSION": "1",
            "LOGOUT_TICKET_KEY_B64": "A" * 43,
            "AUTH_RATE_LIMIT_KEY_B64": "A" * 43,
            "AUTH_EMAIL_OUTBOX_KEY_B64": "A" * 43,
            "EMAIL_SMTP_HOST": "127.0.0.1",
            "EMAIL_SMTP_PORT": "1025",
            "EMAIL_FROM": "dayforge@example.test",
            "UNKNOWN_OPTION": "unrelated-process-value",
        }
    )
    assert settings.app_env == "test"
    assert not hasattr(settings, "unknown_option")


def test_auth_secret_keys_decode_to_32_bytes_and_remain_hidden(settings_factory):
    settings = settings_factory()
    for field in (
        "local_key_kek_b64",
        "logout_ticket_key_b64",
        "auth_rate_limit_key_b64",
        "auth_email_outbox_key_b64",
    ):
        assert len(settings.secret_key(field)) == 32
    assert settings.local_key_kek_b64.get_secret_value() not in repr(settings)


def test_logout_ticket_previous_keys_are_optional_and_available_for_verification(
    settings_factory,
):
    def encode(raw):
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    current = bytes([4]) * 32
    previous = bytes([5]) * 32
    settings = settings_factory(
        logout_ticket_key_b64=encode(current),
        logout_ticket_previous_keys_b64=f"{encode(previous)}",
    )

    assert settings.logout_ticket_verification_keys() == [current, previous]
    assert settings_factory().logout_ticket_previous_keys_b64 is None


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("local_key_kek_b64", "too-short"),
        ("logout_ticket_key_b64", "!" * 43),
        ("auth_rate_limit_key_b64", "A" * 42),
        ("auth_email_outbox_key_b64", "__GENERATE_OUTBOX_KEY__"),
    ],
)
def test_auth_secret_keys_reject_malformed_values_without_echo(settings_factory, field, value):
    with pytest.raises(SettingsError) as caught:
        settings_factory(**{field: value})
    assert field.upper() in str(caught.value)
    assert value not in str(caught.value)
