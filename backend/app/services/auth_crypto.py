"""Cryptographic primitives for token verifiers and wrapped local owner keys."""

import base64
import binascii
import hashlib
import hmac
import re
import secrets
import struct
from collections.abc import Sequence
from dataclasses import dataclass
from typing import cast
from uuid import UUID

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class CryptoEnvelopeError(ValueError):
    """Key envelope input is invalid or cannot be authenticated."""


@dataclass(frozen=True)
class WrappedKey:
    algorithm: str
    wrapped_key: bytes
    kek_version: int


def _validate_key_parameters(raw_key: bytes, kek: bytes, kek_version: int) -> None:
    if not isinstance(raw_key, bytes) or len(raw_key) != 32:
        raise CryptoEnvelopeError("local_key_invalid")
    if not isinstance(kek, bytes) or len(kek) != 32:
        raise CryptoEnvelopeError("kek_invalid")
    if type(kek_version) is not int or not 1 <= kek_version <= 0xFFFFFFFF:
        raise CryptoEnvelopeError("kek_version_invalid")


def _aad(owner_id: UUID, key_id: UUID, kek_version: int) -> bytes:
    if not isinstance(owner_id, UUID) or not isinstance(key_id, UUID):
        raise CryptoEnvelopeError("key_identity_invalid")
    return (
        b"dayforge-owner-local-key-v1\0"
        + owner_id.bytes
        + key_id.bytes
        + struct.pack(">I", kek_version)
    )


def wrap_owner_key(
    owner_id: UUID, key_id: UUID, raw_key: bytes, kek: bytes, kek_version: int
) -> WrappedKey:
    _validate_key_parameters(raw_key, kek, kek_version)
    aad = _aad(owner_id, key_id, kek_version)
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(kek).encrypt(nonce, raw_key, aad)
    return WrappedKey(
        algorithm="A256GCM", wrapped_key=nonce + ciphertext, kek_version=kek_version
    )


def unwrap_owner_key(
    owner_id: UUID, key_id: UUID, wrapped: WrappedKey, kek: bytes, kek_version: int
) -> bytes:
    if not isinstance(wrapped, WrappedKey) or wrapped.algorithm != "A256GCM":
        raise CryptoEnvelopeError("wrapped_key_invalid")
    _validate_key_parameters(bytes(32), kek, kek_version)
    if wrapped.kek_version != kek_version or len(wrapped.wrapped_key) != 60:
        raise CryptoEnvelopeError("wrapped_key_invalid")
    aad = _aad(owner_id, key_id, kek_version)
    nonce, ciphertext = wrapped.wrapped_key[:12], wrapped.wrapped_key[12:]
    try:
        raw_key = AESGCM(kek).decrypt(nonce, ciphertext, aad)
    except InvalidTag, ValueError:
        raise CryptoEnvelopeError("wrapped_key_invalid") from None
    if len(raw_key) != 32:
        raise CryptoEnvelopeError("wrapped_key_invalid")
    return raw_key


def encode_base64url(value: bytes) -> str:
    if not isinstance(value, bytes):
        raise ValueError("token_invalid")
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def decode_base64url(value: str | None, expected_bytes: int) -> bytes | None:
    if not isinstance(value, str) or expected_bytes <= 0:
        return None
    expected_chars = (expected_bytes * 8 + 5) // 6
    if not re.fullmatch(rf"[A-Za-z0-9_-]{{{expected_chars}}}", value):
        return None
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except ValueError, binascii.Error:
        return None
    if len(decoded) != expected_bytes or encode_base64url(decoded) != value:
        return None
    return decoded


def create_logout_ticket(session_id: UUID, key: bytes) -> str:
    if not isinstance(session_id, UUID) or not isinstance(key, bytes) or len(key) != 32:
        raise CryptoEnvelopeError("logout_ticket_invalid")
    identifier = session_id.bytes
    signature = hmac.new(key, b"logout-v1" + identifier, hashlib.sha256).digest()
    return encode_base64url(identifier + signature)


def verify_logout_ticket(
    ticket: str | None, key: bytes | Sequence[bytes]
) -> UUID | None:
    if isinstance(key, bytes):
        keys: tuple[bytes, ...] = (key,)
    elif isinstance(key, Sequence):
        if not all(isinstance(candidate, bytes) for candidate in key):
            return None
        keys = tuple(cast(Sequence[bytes], key))
    else:
        return None
    if not keys or any(len(candidate) != 32 for candidate in keys):
        return None
    payload = decode_base64url(ticket, 48)
    if payload is None:
        return None
    identifier, supplied_signature = payload[:16], payload[16:]
    valid_signature = False
    for candidate in keys:
        expected_signature = hmac.new(
            candidate, b"logout-v1" + identifier, hashlib.sha256
        ).digest()
        valid_signature = (
            hmac.compare_digest(supplied_signature, expected_signature)
            | valid_signature
        )
    if not valid_signature:
        return None
    return UUID(bytes=identifier)
