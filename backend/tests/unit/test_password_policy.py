import pytest

from app.services.passwords import PasswordPolicyError, validate_new_password


def test_password_nfc_and_15_to_128_codepoints():
    assert (
        validate_new_password("e\u0301" + "a" * 14, "owner@example.com")
        == "é" + "a" * 14
    )
    with pytest.raises(PasswordPolicyError):
        validate_new_password("a" * 14, "owner@example.com")
    with pytest.raises(PasswordPolicyError):
        validate_new_password("a" * 129, "owner@example.com")


def test_password_rejects_blocklist_and_email_derived_values():
    with pytest.raises(PasswordPolicyError, match="password_blocklisted"):
        validate_new_password("passwordpassword", "owner@example.com")
    with pytest.raises(PasswordPolicyError, match="password_blocklisted"):
        validate_new_password("verylongidentifier123", "verylongidentifier@example.com")
