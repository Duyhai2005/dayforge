"""Token, key-wrapping and pseudonym primitives for the auth contract."""

import base64
import hashlib
import hmac
import secrets
from dataclasses import dataclass
from uuid import UUID

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class AuthCryptoError(ValueError):
    pass


@dataclass(frozen=True)
class WrappedKey:
    key_id: UUID
    algorithm: str
    wrapped_key: bytes
    kek_version: int


def _b64decode(value: str, expected_bytes: int) -> bytes:
    if (
        not isinstance(value, str)
        or not value
        or "=" in value
        or not all(
            character.isascii() and (character.isalnum() or character in "-_")
            for character in value
        )
    ):
        raise AuthCryptoError("invalid_base64url")
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))
    except Exception:
        raise AuthCryptoError("invalid_base64url") from None
    if (
        len(decoded) != expected_bytes
        or base64.urlsafe_b64encode(decoded).rstrip(b"=").decode("ascii") != value
    ):
        raise AuthCryptoError("invalid_base64url")
    return decoded


def decode_key(value: str) -> bytes:
    return _b64decode(value, 32)


def encode_token(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def generate_token() -> str:
    return encode_token(secrets.token_bytes(32))


def token_digest(token: str) -> bytes:
    raw = _b64decode(token, 32)
    return hashlib.sha256(raw).digest()


def wrap_owner_key(
    owner_id: UUID, key_id: UUID, raw_key: bytes, kek: bytes, kek_version: int
) -> WrappedKey:
    if len(raw_key) != 32 or len(kek) != 32 or not 1 <= kek_version <= 65535:
        raise AuthCryptoError("invalid_key_material")
    nonce = secrets.token_bytes(12)
    aad = (
        b"dayforge-local-key-v1\x00"
        + owner_id.bytes
        + key_id.bytes
        + b"\x00A256GCM\x00"
        + kek_version.to_bytes(2, "big")
    )
    encrypted = AESGCM(kek).encrypt(nonce, raw_key, aad)
    return WrappedKey(
        key_id=key_id,
        algorithm="A256GCM",
        wrapped_key=nonce + encrypted,
        kek_version=kek_version,
    )


def unwrap_owner_key(
    owner_id: UUID, key_id: UUID, wrapped_key: bytes, kek: bytes, kek_version: int
) -> bytes:
    if len(kek) != 32 or len(wrapped_key) != 60 or not 1 <= kek_version <= 65535:
        raise AuthCryptoError("invalid_wrapped_key")
    aad = (
        b"dayforge-local-key-v1\x00"
        + owner_id.bytes
        + key_id.bytes
        + b"\x00A256GCM\x00"
        + kek_version.to_bytes(2, "big")
    )
    try:
        return AESGCM(kek).decrypt(wrapped_key[:12], wrapped_key[12:], aad)
    except Exception:
        raise AuthCryptoError("wrapped_key_authentication_failed") from None


def pseudonym(key: bytes, namespace: str, value: bytes | str) -> bytes:
    if len(key) != 32 or not namespace.isascii() or not namespace:
        raise AuthCryptoError("invalid_pseudonym_input")
    raw = value.encode("utf-8") if isinstance(value, str) else value
    return hmac.new(
        key, namespace.encode("ascii") + b"\x00" + raw, hashlib.sha256
    ).digest()


def make_logout_ticket(session_id: UUID, key: bytes) -> str:
    if len(key) != 32:
        raise AuthCryptoError("invalid_logout_key")
    message = b"logout-v1" + session_id.bytes
    return encode_token(
        session_id.bytes + hmac.new(key, message, hashlib.sha256).digest()
    )


def verify_logout_ticket(ticket: str, session_id: UUID, key: bytes) -> bool:
    try:
        candidate = _b64decode(ticket, 48)
    except AuthCryptoError:
        return False
    expected = (
        session_id.bytes
        + hmac.new(key, b"logout-v1" + session_id.bytes, hashlib.sha256).digest()
    )
    return hmac.compare_digest(candidate, expected)


def logout_ticket_session_id(ticket: str, key: bytes) -> UUID | None:
    if len(key) != 32:
        return None
    try:
        candidate = _b64decode(ticket, 48)
    except AuthCryptoError:
        return None
    session_id = UUID(bytes=candidate[:16])
    expected = (
        session_id.bytes
        + hmac.new(key, b"logout-v1" + session_id.bytes, hashlib.sha256).digest()
    )
    return session_id if hmac.compare_digest(candidate, expected) else None
