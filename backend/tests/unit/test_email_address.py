import pytest

from app.services.email_address import EmailAddressError, canonicalize_email


def test_email_canonicalization_preserves_local_case_and_idna():
    result = canonicalize_email(" Owner@BÜCHER.example ")

    assert result.canonical == b"Owner@xn--bcher-kva.example"
    assert result.delivery == "Owner@BÜCHER.example"


def test_email_does_not_collapse_aliases():
    assert canonicalize_email("owner+daily@example.test").canonical == b"owner+daily@example.test"
    assert canonicalize_email("o.w.n.e.r@example.test").canonical == b"o.w.n.e.r@example.test"
    assert (
        canonicalize_email("owner@example.test").canonical != canonicalize_email("owner+daily@example.test").canonical
    )


@pytest.mark.parametrize(
    "value",
    [
        "Owner <owner@example.test>",
        "owner@example.test, other@example.test",
        "owner@example.test\nBcc: other@example.test",
        "owner\x00@example.test",
        "x" * 245 + "@example.test",
        "owner@bad_domain.example",
    ],
)
def test_email_rejects_multiple_mailboxes_controls_and_over_254_bytes(value):
    with pytest.raises(EmailAddressError):
        canonicalize_email(value)
