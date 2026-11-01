"""Email parsing and the single canonical form used by authentication."""

import unicodedata
from dataclasses import dataclass

from email_validator import EmailNotValidError, validate_email


class EmailAddressError(ValueError):
    """The supplied value is not one acceptable mailbox."""


@dataclass(frozen=True)
class CanonicalEmail:
    canonical: bytes
    delivery: str


def canonicalize_email(value: str) -> CanonicalEmail:
    if not isinstance(value, str):
        raise EmailAddressError("email_invalid")
    delivery = value.strip(" \t\r\n\v\f")
    if not delivery or any(unicodedata.category(character) == "Cc" for character in delivery):
        raise EmailAddressError("email_invalid")
    try:
        parsed = validate_email(
            delivery,
            check_deliverability=False,
            allow_smtputf8=True,
            allow_quoted_local=False,
            allow_domain_literal=False,
            test_environment=True,
        )
    except EmailNotValidError:
        raise EmailAddressError("email_invalid") from None

    local_part = unicodedata.normalize("NFC", parsed.local_part)
    domain = parsed.ascii_domain.lower()
    canonical = f"{local_part}@{domain}".encode("utf-8")
    if len(canonical) > 254:
        raise EmailAddressError("email_invalid")
    return CanonicalEmail(canonical=canonical, delivery=delivery)
