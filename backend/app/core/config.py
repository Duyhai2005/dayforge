"""Explicit, immutable configuration with secret-safe validation failures."""

import base64
import binascii
import os
import re
from collections.abc import Mapping
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, SecretStr, ValidationError
from sqlalchemy.engine import URL

from app.services.email_address import EmailAddressError, canonicalize_email


class SettingsError(ValueError):
    """Contains only the names of invalid environment fields."""


ENV_FIELDS = {
    "app_env": "APP_ENV",
    "public_origin": "PUBLIC_ORIGIN",
    "db_host": "DB_HOST",
    "db_port": "DB_PORT",
    "db_name": "DB_NAME",
    "db_user": "DB_USER",
    "db_password": "DB_PASSWORD",
    "owner_email": "OWNER_EMAIL",
    "local_key_kek_b64": "LOCAL_KEY_KEK_B64",
    "local_key_kek_version": "LOCAL_KEY_KEK_VERSION",
    "logout_ticket_key_b64": "LOGOUT_TICKET_KEY_B64",
    "logout_ticket_previous_keys_b64": "LOGOUT_TICKET_PREVIOUS_KEYS_B64",
    "auth_rate_limit_key_b64": "AUTH_RATE_LIMIT_KEY_B64",
    "auth_email_outbox_key_b64": "AUTH_EMAIL_OUTBOX_KEY_B64",
    "email_smtp_host": "EMAIL_SMTP_HOST",
    "email_smtp_port": "EMAIL_SMTP_PORT",
    "email_from": "EMAIL_FROM",
}
_SECRET_FIELDS = (
    "local_key_kek_b64",
    "logout_ticket_key_b64",
    "auth_rate_limit_key_b64",
    "auth_email_outbox_key_b64",
)


def _decode_key(value: str) -> bytes:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", value):
        raise ValueError("invalid_key")
    try:
        decoded = base64.b64decode(value + "=", altchars=b"-_", validate=True)
    except binascii.Error, ValueError:
        raise ValueError("invalid_key") from None
    if (
        len(decoded) != 32
        or base64.urlsafe_b64encode(decoded).rstrip(b"=").decode("ascii") != value
    ):
        raise ValueError("invalid_key")
    return decoded


class Settings(BaseModel):
    model_config = ConfigDict(frozen=True, hide_input_in_errors=True, extra="forbid")

    app_env: Literal["development", "test", "production"]
    public_origin: str
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    db_password: SecretStr
    owner_email: str
    local_key_kek_b64: SecretStr
    local_key_kek_version: int
    logout_ticket_key_b64: SecretStr
    logout_ticket_previous_keys_b64: SecretStr | None = None
    auth_rate_limit_key_b64: SecretStr
    auth_email_outbox_key_b64: SecretStr
    email_smtp_host: str
    email_smtp_port: int
    email_from: str

    def __init__(self, **values):
        invalid = set(values) - ENV_FIELDS.keys()
        for field in ENV_FIELDS:
            value = values.get(field)
            if isinstance(value, SecretStr):
                value = value.get_secret_value()
            if field == "logout_ticket_previous_keys_b64":
                if field not in values or value is None or value == "":
                    values[field] = None
                    continue
                keys = value.split(",") if isinstance(value, str) else []
                if not keys:
                    invalid.add(field)
                    continue
                try:
                    for key in keys:
                        _decode_key(key)
                except ValueError:
                    invalid.add(field)
                continue
            if field in ("db_port", "email_smtp_port", "local_key_kek_version"):
                maximum = 65535
                try:
                    valid = (type(value) is int and 1 <= value <= maximum) or (
                        isinstance(value, str)
                        and re.fullmatch(r"[0-9]+", value)
                        and 1 <= int(value) <= maximum
                    )
                except ValueError:
                    valid = False
                if not valid:
                    invalid.add(field)
            elif (
                not isinstance(value, str)
                or not value.strip()
                or re.search(r"__GENERATE_.*?__", value)
            ):
                invalid.add(field)
        if values.get("app_env") not in ("development", "test", "production"):
            invalid.add("app_env")
        for field in _SECRET_FIELDS:
            value = values.get(field)
            if isinstance(value, SecretStr):
                value = value.get_secret_value()
            if isinstance(value, str):
                try:
                    _decode_key(value)
                except ValueError:
                    invalid.add(field)
        for field in ("owner_email", "email_from"):
            value = values.get(field)
            if field not in invalid and isinstance(value, str):
                try:
                    canonicalize_email(value)
                except EmailAddressError:
                    invalid.add(field)
        if "email_smtp_host" not in invalid and not re.fullmatch(
            r"[A-Za-z0-9.-]+", values["email_smtp_host"]
        ):
            invalid.add("email_smtp_host")
        if "public_origin" not in invalid:
            try:
                origin = urlsplit(values["public_origin"])
                if (
                    origin.scheme != "https"
                    or not origin.hostname
                    or origin.username is not None
                    or origin.password is not None
                    or origin.path
                    or origin.query
                    or origin.fragment
                    or any(c.isspace() for c in values["public_origin"])
                    or "?" in values["public_origin"]
                    or "#" in values["public_origin"]
                ):
                    invalid.add("public_origin")
                origin.port
            except ValueError:
                invalid.add("public_origin")
            if (
                values.get("app_env") == "development"
                and values["public_origin"] != "https://localhost:3000"
            ):
                invalid.add("public_origin")
        if invalid:
            raise SettingsError(
                ", ".join(ENV_FIELDS.get(field, field) for field in sorted(invalid))
            )
        try:
            super().__init__(**values)
        except ValidationError as error:
            fields = {str(entry["loc"][0]) for entry in error.errors()}
            raise SettingsError(
                ", ".join(ENV_FIELDS.get(field, field) for field in sorted(fields))
            ) from None

    def secret_key(
        self,
        field: Literal[
            "local_key_kek_b64",
            "logout_ticket_key_b64",
            "auth_rate_limit_key_b64",
            "auth_email_outbox_key_b64",
        ],
    ) -> bytes:
        return _decode_key(getattr(self, field).get_secret_value())

    def logout_ticket_verification_keys(self) -> list[bytes]:
        keys = [self.secret_key("logout_ticket_key_b64")]
        if self.logout_ticket_previous_keys_b64 is not None:
            keys.extend(
                _decode_key(value)
                for value in self.logout_ticket_previous_keys_b64.get_secret_value().split(
                    ","
                )
            )
        return keys


def load_settings(environ: Mapping[str, str] | None = None) -> Settings:
    source = os.environ if environ is None else environ
    return Settings(
        **{field: source[env] for field, env in ENV_FIELDS.items() if env in source}
    )


def build_database_url(settings: Settings) -> URL:
    return URL.create(
        "mysql+aiomysql",
        username=settings.db_user,
        password=settings.db_password.get_secret_value(),
        host=settings.db_host,
        port=settings.db_port,
        database=settings.db_name,
        query={"charset": "utf8mb4"},
    )
