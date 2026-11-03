"""NFC password policy and Argon2id PHC hashing."""

import secrets
import unicodedata
from functools import lru_cache

from argon2 import PasswordHasher, Type, exceptions

from app.services.email_address import EmailAddressError, canonicalize_email

PASSWORD_BLOCKLIST_VERSION = "dayforge-common-2026-11-02-v1"
PASSWORD_BLOCKLIST = frozenset(
    {
        "123456789012345",
        "1234567890123456",
        "passwordpassword",
        "password123456",
        "qwerty123456789",
        "letmeinletmein",
        "iloveyouiloveyou",
        "correcthorsebatterystaple",
        "changemechangeme",
        "adminadminadmin",
        "welcome12345678",
        "dayforgedayforge",
        "dayforge123456",
        "dayforge2026!",
        "thisisapassword",
        "trustno1trustno1",
        "monkeymonkeymonkey",
        "dragon dragon dragon",
        "footballfootball",
    }
)

_HASHER = PasswordHasher(
    time_cost=3,
    memory_cost=65_536,
    parallelism=1,
    hash_len=32,
    salt_len=16,
    type=Type.ID,
)


class PasswordPolicyError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _email_derived(password: str, email: str) -> bool:
    try:
        local = canonicalize_email(email).delivery.rsplit("@", 1)[0]
    except EmailAddressError:
        local = email.split("@", 1)[0]
    folded_password = unicodedata.normalize("NFKC", password).casefold()
    folded_local = unicodedata.normalize("NFKC", local).casefold()
    alphanumeric_password = "".join(
        character for character in folded_password if character.isalnum()
    )
    alphanumeric_local = "".join(
        character for character in folded_local if character.isalnum()
    )
    if not folded_local:
        return False
    return folded_password in {
        folded_local,
        f"{folded_local}123",
        f"{folded_local}2026",
    } or (
        len(alphanumeric_local) >= 4
        and alphanumeric_password
        in {alphanumeric_local, f"{alphanumeric_local}123", f"{alphanumeric_local}2026"}
    )


def validate_new_password(password: str, email: str) -> str:
    if not isinstance(password, str):
        raise PasswordPolicyError("password_policy_violation")
    try:
        transport = password.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        raise PasswordPolicyError("password_policy_violation") from None
    if len(password) > 1024 or len(transport) > 4096:
        raise PasswordPolicyError("password_policy_violation")
    normalized = unicodedata.normalize("NFC", password)
    if not 15 <= len(normalized) <= 128:
        raise PasswordPolicyError("password_policy_violation")
    folded = unicodedata.normalize("NFKC", normalized).casefold()
    if folded in PASSWORD_BLOCKLIST or _email_derived(normalized, email):
        raise PasswordPolicyError("password_blocklisted")
    return normalized


def hash_password(password: str) -> str:
    return _HASHER.hash(password)


@lru_cache(maxsize=1)
def _dummy_hash() -> str:
    return _HASHER.hash(secrets.token_urlsafe(32))


def verify_password(password: str, password_hash: str | None) -> bool:
    encoded = (
        password_hash
        if isinstance(password_hash, str) and password_hash.startswith("$argon2id$")
        else _dummy_hash()
    )
    try:
        return bool(_HASHER.verify(encoded, password)) and password_hash is not None
    except (
        exceptions.VerifyMismatchError,
        exceptions.VerificationError,
        exceptions.InvalidHashError,
    ):
        return False


def password_needs_rehash(password_hash: str) -> bool:
    try:
        return _HASHER.check_needs_rehash(password_hash)
    except exceptions.VerificationError, exceptions.InvalidHashError:
        return True
