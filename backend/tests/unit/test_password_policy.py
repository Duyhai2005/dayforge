import unicodedata

import pytest

from app.services.passwords import (
    PasswordPolicyError,
    hash_password,
    validate_new_password,
    verify_password,
)


def test_password_nfc_and_15_to_128_codepoints():
    composed = "cafe\u0301" + "a" * 11
    normalized = unicodedata.normalize("NFC", composed)

    assert len(normalized) == 15
    assert validate_new_password(composed, "owner@example.test") == normalized
    assert len(validate_new_password("a" * 128, "owner@example.test")) == 128

    with pytest.raises(PasswordPolicyError, match="password_policy_violation"):
        validate_new_password("a" * 14, "owner@example.test")
    with pytest.raises(PasswordPolicyError, match="password_policy_violation"):
        validate_new_password("a" * 129, "owner@example.test")


def test_password_rejects_blocklist_and_email_derived_values():
    with pytest.raises(PasswordPolicyError, match="password_blocklisted"):
        validate_new_password("password123456789", "owner@example.test")
    with pytest.raises(PasswordPolicyError, match="password_blocklisted"):
        validate_new_password("OwnerAccountName", "OwnerAccountName@example.test")


def test_password_hash_uses_argon2id_and_verification_is_constant_contract():
    encoded = hash_password("a secure password with unicode café")

    assert encoded.startswith("$argon2id$v=19$m=65536,t=3,p=1$")
    assert verify_password("a secure password with unicode café", encoded)
    assert not verify_password("a different password", encoded)
    assert not verify_password("anything", None)
