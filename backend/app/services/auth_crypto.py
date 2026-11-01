"""Cryptographic primitives for token verifiers and wrapped local owner keys."""

import secrets
import struct
from dataclasses import dataclass
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
    except (InvalidTag, ValueError):
        raise CryptoEnvelopeError("wrapped_key_invalid") from None
    if len(raw_key) != 32:
        raise CryptoEnvelopeError("wrapped_key_invalid")
    return raw_key
