import uuid

from app.services.auth_audit import make_auth_audit_event


def test_auth_audit_event_pseudonymizes_email_and_peer(settings_factory):
    email = b"owner@example.test"
    peer = "203.0.113.10"
    event = make_auth_audit_event(
        settings_factory(),
        action="login",
        outcome="denied",
        request_id=str(uuid.uuid4()),
        email_canonical=email,
        peer_ip=peer,
    )

    assert event.email_digest is not None and email not in event.email_digest
    assert event.peer_digest is not None and peer.encode() not in event.peer_digest
    assert not {"email", "ip", "token", "password", "cookie", "csrf_token"}.intersection(event.__dict__)


def test_auth_audit_event_rejects_unallowlisted_action(settings_factory):
    import pytest

    with pytest.raises(ValueError, match="auth_audit_event_invalid"):
        make_auth_audit_event(
            settings_factory(), action="login " + "password", outcome="success", request_id=str(uuid.uuid4())
        )
