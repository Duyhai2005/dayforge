"""Strict single-mailbox canonicalization for owner identity."""

import unicodedata
from dataclasses import dataclass

from email_validator import EmailNotValidError, validate_email


@dataclass(frozen=True)
class CanonicalEmail:
    canonical: bytes
    delivery: str


class EmailAddressError(ValueError):
    def __init__(self, code: str = "email_invalid") -> None:
        super().__init__(code)
        self.code = code


def canonicalize_email(value: str) -> CanonicalEmail:
    if not isinstance(value, str):
        raise EmailAddressError()
    candidate = value.strip(" \t\n\r\v\f")
    if not candidate or any(
        unicodedata.category(character).startswith("C") for character in candidate
    ):
        raise EmailAddressError()
    if (
        any(character in candidate for character in (",", ";", "<", ">", "(", ")"))
        or candidate.count("@") != 1
    ):
        raise EmailAddressError()
    try:
        parsed = validate_email(
            candidate, allow_smtputf8=True, check_deliverability=False
        )
    except EmailNotValidError:
        raise EmailAddressError() from None
    local = unicodedata.normalize("NFC", parsed.local_part)
    domain = (parsed.ascii_domain or "").lower()
    delivery = f"{local}@{domain}"
    canonical = delivery.encode("utf-8")
    if not local or not domain or len(canonical) > 254:
        raise EmailAddressError()
    return CanonicalEmail(canonical=canonical, delivery=delivery)
