from email.message import EmailMessage
from unittest.mock import MagicMock

import pytest

from app.services.email_delivery import smtp_send_message


def _smtp_fakes(monkeypatch):
    actions = []
    connection = MagicMock()
    connection.__enter__.return_value = connection
    connection.ehlo.side_effect = lambda: actions.append("ehlo")
    connection.starttls.side_effect = lambda **kwargs: actions.append("starttls")
    connection.login.side_effect = lambda *_: actions.append("login")
    connection.send_message.side_effect = lambda *_: actions.append("send")
    smtp = MagicMock(return_value=connection)
    smtp_ssl = MagicMock(return_value=connection)
    context = object()
    create_context = MagicMock(return_value=context)
    monkeypatch.setattr("app.services.email_delivery.smtplib.SMTP", smtp)
    monkeypatch.setattr("app.services.email_delivery.smtplib.SMTP_SSL", smtp_ssl)
    monkeypatch.setattr("app.services.email_delivery.ssl.create_default_context", create_context)
    return actions, connection, smtp, smtp_ssl, create_context, context


def _message():
    message = EmailMessage()
    message["Subject"] = "delivery probe"
    message.set_content("smtp transport test")
    return message


def test_starttls_precedes_login_and_send_with_verified_context(monkeypatch):
    actions, connection, smtp, _, create_context, context = _smtp_fakes(monkeypatch)

    smtp_send_message(
        "smtp.example.test", 587, _message(), tls="starttls", username="account", password="secret", timeout_seconds=12
    )

    smtp.assert_called_once_with("smtp.example.test", 587, timeout=12)
    assert actions == ["ehlo", "starttls", "ehlo", "login", "send"]
    connection.starttls.assert_called_once_with(context=context)
    connection.login.assert_called_once_with("account", "secret")
    create_context.assert_called_once_with()


def test_implicit_tls_uses_smtpsocket_without_plaintext_fallback(monkeypatch):
    _, connection, smtp, smtp_ssl, create_context, context = _smtp_fakes(monkeypatch)

    smtp_send_message("smtp.example.test", 465, _message(), tls="implicit", timeout_seconds=8)

    smtp_ssl.assert_called_once_with("smtp.example.test", 465, timeout=8, context=context)
    smtp.assert_not_called()
    connection.starttls.assert_not_called()
    connection.login.assert_not_called()
    connection.send_message.assert_called_once()
    create_context.assert_called_once_with()


def test_starttls_error_is_propagated_without_plaintext_retry(monkeypatch):
    _, connection, smtp, _, _, _ = _smtp_fakes(monkeypatch)
    connection.starttls.side_effect = RuntimeError("certificate validation failed")

    with pytest.raises(RuntimeError, match="certificate validation failed"):
        smtp_send_message("smtp.example.test", 587, _message(), tls="starttls")

    smtp.assert_called_once()
    connection.send_message.assert_not_called()


@pytest.mark.parametrize(
    ("tls", "username", "password", "error"),
    [
        ("none", "account", "secret", "smtp_auth_requires_tls"),
        ("none", None, "secret", "smtp_credentials_incomplete"),
        ("invalid", None, None, "smtp_tls_mode_invalid"),
    ],
)
def test_invalid_tls_or_auth_configuration_fails_before_connect(monkeypatch, tls, username, password, error):
    _, _, smtp, smtp_ssl, _, _ = _smtp_fakes(monkeypatch)

    with pytest.raises(ValueError, match=error):
        smtp_send_message("smtp.example.test", 25, _message(), tls=tls, username=username, password=password)

    smtp.assert_not_called()
    smtp_ssl.assert_not_called()
