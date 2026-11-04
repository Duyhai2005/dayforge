import asyncio
import base64

import pytest
from pydantic import SecretStr, ValidationError

from app.core.config import ENV_FIELDS, SettingsError, build_database_url, load_settings


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
            "SYNC_PAGE_TOKEN_KEY_B64": base64.urlsafe_b64encode(bytes(range(4, 36))).decode("ascii").rstrip("="),
            "EMAIL_SMTP_HOST": "127.0.0.1",
            "EMAIL_SMTP_PORT": "1025",
            "EMAIL_FROM": "dayforge@example.test",
            "UNKNOWN_OPTION": "unrelated-process-value",
        }
    )
    assert settings.app_env == "test"
    assert not hasattr(settings, "unknown_option")


def test_smtp_runtime_options_default_to_development_compatible_values(settings_factory):
    settings = settings_factory()
    assert settings.email_smtp_tls == "none"
    assert settings.email_smtp_username is None
    assert settings.email_smtp_password is None
    assert settings.email_smtp_timeout_seconds == 10


@pytest.mark.parametrize("tls", ["none", "invalid", "implicit"])
def test_production_requires_authenticated_tls_smtp(settings_factory, tls):
    with pytest.raises(SettingsError):
        settings_factory(app_env="production", public_origin="https://example.test", email_smtp_tls=tls)


@pytest.mark.parametrize("tls", ["starttls", "implicit"])
def test_production_accepts_only_authenticated_tls_smtp(settings_factory, tls):
    settings = settings_factory(
        app_env="production",
        public_origin="https://example.test",
        email_smtp_tls=tls,
        email_smtp_username="smtp-user",
        email_smtp_password="smtp-secret",
    )
    assert settings.email_smtp_tls == tls


def test_smtp_credentials_must_be_a_pair(settings_factory):
    with pytest.raises(SettingsError) as caught:
        settings_factory(email_smtp_username="smtp-user")
    assert "EMAIL_SMTP_USERNAME" in str(caught.value)


@pytest.mark.parametrize("timeout", [0, 61, "invalid"])
def test_smtp_timeout_is_bounded(settings_factory, timeout):
    with pytest.raises(SettingsError) as caught:
        settings_factory(email_smtp_timeout_seconds=timeout)
    assert "EMAIL_SMTP_TIMEOUT_SECONDS" in str(caught.value)


def test_smtp_password_is_redacted(settings_factory):
    settings = settings_factory(
        email_smtp_tls="starttls", email_smtp_username="smtp-user", email_smtp_password="smtp-secret"
    )
    assert "smtp-secret" not in repr(settings)


def _valid_environment(settings_factory):
    model = settings_factory().model_dump()
    return {
        name: value.get_secret_value() if isinstance(value, SecretStr) else str(value)
        for field, name in ENV_FIELDS.items()
        if (value := model[field]) is not None
    }


def test_secret_file_loads_one_trailing_newline_and_keeps_password_spaces(settings_factory, tmp_path):
    environment = _valid_environment(settings_factory)
    password_file = tmp_path / "db-password"
    password_file.write_text("  private password  \n", encoding="utf-8")
    environment.pop("DB_PASSWORD")
    environment["DB_PASSWORD_FILE"] = str(password_file)

    loaded = load_settings(environment)

    assert loaded.db_password.get_secret_value() == "  private password  "


def test_smtp_secret_files_load_into_redacted_runtime_settings(settings_factory, tmp_path):
    environment = _valid_environment(settings_factory)
    username_file = tmp_path / "smtp-username"
    password_file = tmp_path / "smtp-password"
    username_file.write_text("smtp-user\n", encoding="utf-8")
    password_file.write_bytes(" smtp-private-password \r\n".encode("utf-8"))
    environment["EMAIL_SMTP_TLS"] = "starttls"
    environment["EMAIL_SMTP_USERNAME_FILE"] = str(username_file)
    environment["EMAIL_SMTP_PASSWORD_FILE"] = str(password_file)

    loaded = load_settings(environment)

    assert loaded.email_smtp_username.get_secret_value() == "smtp-user"
    assert loaded.email_smtp_password.get_secret_value() == " smtp-private-password "
    assert "smtp-private-password" not in repr(loaded)


def test_secret_file_rejects_conflict_or_missing_file_without_echo(settings_factory, tmp_path):
    environment = _valid_environment(settings_factory)
    environment["DB_PASSWORD_FILE"] = str(tmp_path / "private-location-do-not-echo")

    with pytest.raises(SettingsError) as caught:
        load_settings(environment)
    assert str(caught.value) == "DB_PASSWORD"
    assert "private-location-do-not-echo" not in str(caught.value)

    environment["DB_PASSWORD"] = "existing-value"
    with pytest.raises(SettingsError) as caught:
        load_settings(environment)
    assert str(caught.value) == "DB_PASSWORD"
    assert "existing-value" not in str(caught.value)


def test_auth_secret_keys_decode_to_32_bytes_and_remain_hidden(settings_factory):
    settings = settings_factory()
    for field in (
        "local_key_kek_b64",
        "logout_ticket_key_b64",
        "auth_rate_limit_key_b64",
        "auth_email_outbox_key_b64",
        "sync_page_token_key_b64",
    ):
        assert len(settings.secret_key(field)) == 32
    assert settings.local_key_kek_b64.get_secret_value() not in repr(settings)


def test_sync_page_token_secret_is_distinct_from_auth_secrets(settings_factory):
    settings = settings_factory()
    token_key = settings.secret_key("sync_page_token_key_b64")
    auth_keys = [
        settings.secret_key("local_key_kek_b64"),
        settings.secret_key("logout_ticket_key_b64"),
        settings.secret_key("auth_rate_limit_key_b64"),
        settings.secret_key("auth_email_outbox_key_b64"),
    ]
    assert len(token_key) == 32
    assert token_key not in auth_keys

    same_as_auth = base64.urlsafe_b64encode(auth_keys[0]).decode("ascii").rstrip("=")
    with pytest.raises(SettingsError, match="SYNC_PAGE_TOKEN_KEY_B64"):
        settings_factory(sync_page_token_key_b64=same_as_auth)

    same_as_previous_auth = base64.urlsafe_b64encode(token_key).decode("ascii").rstrip("=")
    with pytest.raises(SettingsError, match="SYNC_PAGE_TOKEN_KEY_B64"):
        settings_factory(logout_ticket_previous_keys_b64=same_as_previous_auth)


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
        ("sync_page_token_key_b64", "__GENERATE_SYNC_PAGE_TOKEN_KEY_B64__"),
    ],
)
def test_auth_secret_keys_reject_malformed_values_without_echo(settings_factory, field, value):
    with pytest.raises(SettingsError) as caught:
        settings_factory(**{field: value})
    assert field.upper() in str(caught.value)
    assert value not in str(caught.value)
