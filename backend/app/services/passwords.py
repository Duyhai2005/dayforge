"""Password policy and Argon2id hashing for verified owner credentials."""

import unicodedata

from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.services.email_address import EmailAddressError, canonicalize_email

PASSWORD_BLOCKLIST_VERSION = "dayforge-passwords-2026-11"
_PASSWORD_BLOCKLIST = frozenset(
    {
        "password123456789",
        "passwordpassword",
        "123456789012345",
        "qwertyuiopasdfg",
        "letmeinletmein1",
        "dayforge2026",
        "dayforgeplanner",
        "changemechangeme",
        "iloveyouiloveyou",
        "correcthorsebatterystaple",
        "correct horse battery staple",
        "password12345678",
        "passwordpassword123",
        "1234567890123456",
        "qwertyuiopqwerty",
        "qwerty1234567890",
        "adminadminadmin1",
        "administrator1234",
        "welcome123456789",
        "welcomehome12345",
        "changeme123456789",
        "letmein123456789",
        "iloveyou123456789",
        "abc123abc123abc123",
        "baseballbaseball",
        "footballfootball",
        "sunshine12345678",
        "princessprincess",
        "monkeymonkeymonkey",
        "passw0rdpassw0rd",
    }
)
_PASSWORD_HASHER = PasswordHasher(
    time_cost=3,
    memory_cost=65536,
    parallelism=1,
    hash_len=32,
    salt_len=16,
    type=Type.ID,
)
DUMMY_PASSWORD_HASH = (
    "$argon2id$v=19$m=65536,t=3,p=1$kBvIFFyeBVP14QrH1obrFA$"
    "9wchBP85PZYgqtWeVw6VrDNZOdGCOYXGFj1UWAPYyKE"
)


class PasswordPolicyError(ValueError):
    """A password violates transport, length, or blocklist policy."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _transport_password(password: str) -> bytes:
    if not isinstance(password, str):
        raise PasswordPolicyError("password_policy_violation")
    try:
        encoded = password.encode("utf-8")
    except UnicodeEncodeError:
        raise PasswordPolicyError("password_policy_violation") from None
    if len(password) > 1024 or len(encoded) > 4096:
        raise PasswordPolicyError("password_policy_violation")
    return encoded


def validate_new_password(password: str, email: str) -> str:
    _transport_password(password)
    normalized = unicodedata.normalize("NFC", password)
    if not 15 <= len(normalized) <= 128:
        raise PasswordPolicyError("password_policy_violation")
    folded = normalized.casefold()
    if folded in _PASSWORD_BLOCKLIST:
        raise PasswordPolicyError("password_blocklisted")
    try:
        canonical_email = canonicalize_email(email).canonical.decode("utf-8")
    except (EmailAddressError, UnicodeDecodeError):
        raise PasswordPolicyError("password_policy_violation") from None
    local_part = canonical_email.rsplit("@", 1)[0].casefold()
    if canonical_email.casefold() in folded or (
        len(local_part) >= 4 and local_part in folded
    ):
        raise PasswordPolicyError("password_blocklisted")
    return normalized


def hash_password(password: str) -> str:
    if not isinstance(password, str):
        raise PasswordPolicyError("password_policy_violation")
    try:
        normalized = unicodedata.normalize("NFC", password)
        normalized.encode("utf-8")
    except UnicodeEncodeError:
        raise PasswordPolicyError("password_policy_violation") from None
    return _PASSWORD_HASHER.hash(normalized)


def verify_password(password: str, password_hash: str | None) -> bool:
    if not isinstance(password, str) or not password_hash:
        return False
    try:
        normalized = unicodedata.normalize("NFC", password)
        normalized.encode("utf-8")
        return bool(_PASSWORD_HASHER.verify(password_hash, normalized))
    except (
        InvalidHashError,
        VerificationError,
        VerifyMismatchError,
        UnicodeEncodeError,
    ):
        return False
