from email.message import EmailMessage

import pytest

from app.cli.send_mail_probe import send_mail_probe
from app.core.config import SettingsError


def test_probe_uses_configured_tls_auth_and_contains_no_auth_token(settings_factory):
    settings = settings_factory(
        app_env="production",
        public_origin="https://dayforge.example.test",
        email_smtp_tls="starttls",
        email_smtp_username="probe-user",
        email_smtp_password="smtp-private-password",
    )
    calls = []

    def send(host, port, message, **options):
        calls.append((host, port, message, options))

    send_mail_probe(
        settings,
        recipient=settings.owner_email,
        probe_id="t30-stage-20261104",
        send_message=send,
    )

    host, port, message, options = calls[0]
    assert (host, port) == (settings.email_smtp_host, settings.email_smtp_port)
    assert isinstance(message, EmailMessage)
    assert message["Subject"] == "DAYFORGE delivery probe [t30-stage-20261104]"
    assert "No account verification" in message.get_content()
    assert "smtp-private-password" not in message.as_string()
    assert options == {
        "tls": "starttls",
        "username": "probe-user",
        "password": "smtp-private-password",
        "timeout_seconds": settings.email_smtp_timeout_seconds,
    }


@pytest.mark.parametrize("probe_id", ["bad\nid", "bad\rsubject", "x" * 65, ""])
def test_probe_rejects_header_injection_and_invalid_probe_ids(settings_factory, probe_id):
    settings = settings_factory()
    with pytest.raises(ValueError, match="mail_probe_id_invalid"):
        send_mail_probe(
            settings,
            recipient=settings.owner_email,
            probe_id=probe_id,
            send_message=lambda *args, **kwargs: pytest.fail("SMTP must not run"),
        )


def test_probe_only_allows_the_canonical_owner_recipient(settings_factory):
    settings = settings_factory()
    with pytest.raises(ValueError, match="mail_probe_recipient_must_be_owner"):
        send_mail_probe(
            settings,
            recipient="other@example.test",
            probe_id="safe-probe",
            send_message=lambda *args, **kwargs: pytest.fail("SMTP must not run"),
        )


def test_probe_requires_verified_tls_for_production(settings_factory):
    with pytest.raises(SettingsError):
        settings = settings_factory(
            app_env="production",
            public_origin="https://dayforge.example.test",
            email_smtp_tls="none",
        )
        send_mail_probe(settings, recipient=settings.owner_email, probe_id="safe-probe")
