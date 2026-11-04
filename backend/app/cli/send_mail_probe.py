"""Send a harmless delivery probe to the configured owner inbox."""

from __future__ import annotations

import argparse
import re
import sys
from email.message import EmailMessage
from typing import Callable

from app.core.config import Settings, load_settings
from app.services.email_address import EmailAddressError, canonicalize_email
from app.services.email_delivery import smtp_send_message

_PROBE_ID = re.compile(r"[A-Za-z0-9._-]{1,64}\Z")


def send_mail_probe(
    settings: Settings,
    *,
    recipient: str,
    probe_id: str,
    send_message: Callable[..., None] = smtp_send_message,
) -> None:
    """Send one non-authentication message and require the owner mailbox."""
    if not isinstance(probe_id, str) or not _PROBE_ID.fullmatch(probe_id):
        raise ValueError("mail_probe_id_invalid")
    try:
        expected = canonicalize_email(settings.owner_email)
        actual = canonicalize_email(recipient)
        sender = canonicalize_email(settings.email_from)
    except EmailAddressError:
        raise ValueError("mail_probe_address_invalid") from None
    if actual.canonical != expected.canonical:
        raise ValueError("mail_probe_recipient_must_be_owner")
    if settings.app_env == "production" and settings.email_smtp_tls == "none":
        raise ValueError("mail_probe_tls_required")

    message = EmailMessage()
    message["From"] = sender.delivery
    message["To"] = expected.delivery
    message["Subject"] = f"DAYFORGE delivery probe [{probe_id}]"
    message.set_content(
        "This is a harmless DAYFORGE email delivery probe.\n"
        f"Probe ID: {probe_id}\n"
        "No account verification or password reset action is attached.\n"
    )
    send_message(
        settings.email_smtp_host,
        settings.email_smtp_port,
        message,
        tls=settings.email_smtp_tls,
        username=settings.email_smtp_username.get_secret_value() if settings.email_smtp_username else None,
        password=settings.email_smtp_password.get_secret_value() if settings.email_smtp_password else None,
        timeout_seconds=settings.email_smtp_timeout_seconds,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe-id", required=True)
    args = parser.parse_args(argv)
    try:
        settings = load_settings()
        send_mail_probe(settings, recipient=settings.owner_email, probe_id=args.probe_id)
    except Exception:
        print("mail_probe_failed", file=sys.stderr)
        return 1
    print("mail_probe_accepted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
