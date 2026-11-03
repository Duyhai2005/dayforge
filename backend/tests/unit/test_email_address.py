import pytest

from app.services.email_address import EmailAddressError, canonicalize_email


def test_email_canonicalization_preserves_local_case_and_idna():
    result = canonicalize_email(" Owner@BÜCHER.example ")
    assert result.canonical == b"Owner@xn--bcher-kva.example"
    assert result.delivery == "Owner@xn--bcher-kva.example"


def test_email_does_not_collapse_aliases():
    assert (
        canonicalize_email("Owner+tag@example.com").canonical
        != canonicalize_email("Owner@example.com").canonical
    )
    assert (
        canonicalize_email("Owner@example.com").canonical
        != canonicalize_email("owner@example.com").canonical
    )


@pytest.mark.parametrize(
    "value",
    [
        "first@example.com,second@example.com",
        "Owner@example.com\nBcc:evil@example.com",
        "a" * 250 + "@example.com",
        "Owner <owner@example.com>",
    ],
)
def test_email_rejects_multiple_mailboxes_controls_and_over_254_bytes(value):
    with pytest.raises(EmailAddressError):
        canonicalize_email(value)
