from uuid import uuid4

import pytest

from app.services.auth_crypto import (
    AuthCryptoError,
    decode_key,
    generate_token,
    token_digest,
    unwrap_owner_key,
    wrap_owner_key,
)


def test_owner_key_wrap_round_trip_binds_owner_key_and_kek_version():
    owner_id, key_id = uuid4(), uuid4()
    raw_key, kek = b"k" * 32, b"e" * 32
    wrapped = wrap_owner_key(owner_id, key_id, raw_key, kek, 1)
    assert unwrap_owner_key(owner_id, key_id, wrapped.wrapped_key, kek, 1) == raw_key
    with pytest.raises(AuthCryptoError):
        unwrap_owner_key(uuid4(), key_id, wrapped.wrapped_key, kek, 1)
    with pytest.raises(AuthCryptoError):
        unwrap_owner_key(owner_id, uuid4(), wrapped.wrapped_key, kek, 1)
    with pytest.raises(AuthCryptoError):
        unwrap_owner_key(owner_id, key_id, wrapped.wrapped_key, kek, 2)


def test_opaque_token_has_32_bytes_and_sha256_verifier():
    token = generate_token()
    assert len(token) == 43
    assert (
        token_digest(token) == __import__("hashlib").sha256(decode_key(token)).digest()
    )
