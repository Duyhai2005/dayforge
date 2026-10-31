"""Explicit, immutable configuration with secret-safe validation failures."""

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

    def __init__(self, **values):
        invalid = set(values) - ENV_FIELDS.keys()
        for field in ENV_FIELDS:
            value = values.get(field)
            if isinstance(value, SecretStr):
                value = value.get_secret_value()
            if field == "db_port":
                try:
                    valid = (type(value) is int and 1 <= value <= 65535) or (
                        isinstance(value, str)
                        and re.fullmatch(r"[0-9]+", value)
                        and 1 <= int(value) <= 65535
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
            fields = {entry["loc"][0] for entry in error.errors()}
            raise SettingsError(
                ", ".join(ENV_FIELDS.get(field, field) for field in sorted(fields))
            ) from None


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
