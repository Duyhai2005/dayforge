"""Explicit, immutable configuration with secret-safe validation failures."""

import base64
import os
import re
from collections.abc import Mapping
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, SecretStr, ValidationError
from sqlalchemy.engine import URL


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
    "auth_rate_limit_key_b64": "AUTH_RATE_LIMIT_KEY_B64",
    "auth_email_outbox_key_b64": "AUTH_EMAIL_OUTBOX_KEY_B64",
    "email_smtp_host": "EMAIL_SMTP_HOST",
    "email_smtp_port": "EMAIL_SMTP_PORT",
    "email_from": "EMAIL_FROM",
}


class Settings(BaseModel):
    model_config = ConfigDict(frozen=True, hide_input_in_errors=True, extra="forbid")

    app_env: Literal["development", "test", "production"]
    public_origin: str
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    db_password: SecretStr
    owner_email: SecretStr
    local_key_kek_b64: SecretStr
    local_key_kek_version: int
    logout_ticket_key_b64: SecretStr
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
            if field in ("db_port", "email_smtp_port", "local_key_kek_version"):
                try:
                    maximum = 65535 if field != "local_key_kek_version" else 65535
                    valid = (type(value) is int and 1 <= value <= maximum) or (
                        isinstance(value, str) and re.fullmatch(r"[0-9]+", value) and 1 <= int(value) <= maximum
                    )
                except ValueError:
                    valid = False
                if not valid:
                    invalid.add(field)
            elif field == "owner_email":
                # The local initializer must not invent an account allowlist. An
                # empty value disables account creation until an operator sets it.
                if value is not None and (
                    not isinstance(value, str)
                    or len(value.encode("utf-8", errors="ignore")) > 254
                    or "\r" in value
                    or "\n" in value
                ):
                    invalid.add(field)
            elif field in {
                "local_key_kek_b64",
                "logout_ticket_key_b64",
                "auth_rate_limit_key_b64",
                "auth_email_outbox_key_b64",
            }:
                if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9_-]{43}", value) is None:
                    invalid.add(field)
                else:
                    try:
                        decoded = base64.urlsafe_b64decode(value + "=")
                        if (
                            len(decoded) != 32
                            or base64.urlsafe_b64encode(decoded).rstrip(b"=").decode("ascii") != value
                        ):
                            invalid.add(field)
                    except ValueError, UnicodeError:
                        invalid.add(field)
            elif not isinstance(value, str) or not value.strip() or re.search(r"__GENERATE_.*?__", value):
                invalid.add(field)
        if values.get("app_env") not in ("development", "test", "production"):
            invalid.add("app_env")
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
                origin.port  # Validate malformed and out-of-range ports.
            except ValueError:
                invalid.add("public_origin")
        owner_email = values.get("owner_email")
        if isinstance(owner_email, SecretStr):
            owner_email = owner_email.get_secret_value()
        if isinstance(owner_email, str) and owner_email.strip():
            try:
                from app.services.email_address import canonicalize_email

                canonicalize_email(owner_email)
            except ValueError:
                invalid.add("owner_email")
        if values.get("app_env") == "development" and values.get("public_origin") != "https://localhost:3000":
            invalid.add("public_origin")
        if invalid:
            raise SettingsError(", ".join(ENV_FIELDS.get(field, field) for field in sorted(invalid)))
        try:
            super().__init__(**values)
        except ValidationError as error:
            fields = {str(entry["loc"][0]) for entry in error.errors()}
            raise SettingsError(", ".join(ENV_FIELDS.get(field, field) for field in sorted(fields))) from None


def load_settings(environ: Mapping[str, str] | None = None) -> Settings:
    source = os.environ if environ is None else environ
    return Settings(**{field: source[env] for field, env in ENV_FIELDS.items() if env in source})


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
