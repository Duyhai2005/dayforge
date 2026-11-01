from dataclasses import replace
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from app.services.auth_crypto import (
    CryptoEnvelopeError,
    create_logout_ticket,
    decode_base64url,
    unwrap_owner_key,
    verify_logout_ticket,
    wrap_owner_key,
)
from app.services.auth_rate_limits import evaluate_rolling_limit, pseudonymize


def test_owner_key_wrap_round_trip_binds_owner_key_and_kek_version():
    owner_id = uuid4()
    key_id = uuid4()
    raw_key = bytes(range(32))
    kek = bytes(reversed(range(32)))
    wrapped = wrap_owner_key(owner_id, key_id, raw_key, kek, kek_version=3)

    assert wrapped.algorithm == "A256GCM"
    assert wrapped.kek_version == 3
    assert unwrap_owner_key(owner_id, key_id, wrapped, kek, kek_version=3) == raw_key

    for other_owner, other_key, other_version in (
        (uuid4(), key_id, 3),
        (owner_id, uuid4(), 3),
        (owner_id, key_id, 4),
    ):
        with pytest.raises(CryptoEnvelopeError):
            unwrap_owner_key(
                other_owner, other_key, wrapped, kek, kek_version=other_version
            )


def test_owner_key_wrap_rejects_bad_key_material_and_tampering():
    owner_id = uuid4()
    key_id = uuid4()
    kek = bytes(range(32))

    with pytest.raises(CryptoEnvelopeError):
        wrap_owner_key(owner_id, key_id, b"short", kek, kek_version=1)
    with pytest.raises(CryptoEnvelopeError):
        wrap_owner_key(owner_id, key_id, bytes(range(32)), b"short", kek_version=1)

    wrapped = wrap_owner_key(owner_id, key_id, bytes(range(32)), kek, kek_version=1)
    tampered = replace(
        wrapped,
        wrapped_key=wrapped.wrapped_key[:-1] + bytes([wrapped.wrapped_key[-1] ^ 1]),
    )
    with pytest.raises(CryptoEnvelopeError):
        unwrap_owner_key(owner_id, key_id, tampered, kek, kek_version=1)


def test_rate_limit_pseudonyms_are_keyed_and_scoped():
    subject = b"Owner@example.test"
    first_key = bytes([1]) * 32
    second_key = bytes([2]) * 32

    digest = pseudonymize(first_key, "login", "email", subject)
    assert digest == pseudonymize(first_key, "login", "email", subject)
    assert digest != pseudonymize(second_key, "login", "email", subject)
    assert digest != pseudonymize(first_key, "forgot", "email", subject)
    assert digest != pseudonymize(first_key, "login", "ip", subject)
    assert len(digest) == 32


def test_rate_limit_uses_a_rolling_window_and_returns_retry_after():
    now = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)
    events = [
        now - timedelta(seconds=901),
        now - timedelta(seconds=30),
        now - timedelta(seconds=15),
    ]

    blocked = evaluate_rolling_limit(events, now, window_seconds=900, maximum=2)
    allowed = evaluate_rolling_limit(events[1:], now, window_seconds=900, maximum=3)

    assert not blocked.allowed
    assert blocked.retry_after_seconds == 870
    assert blocked.retained_events == (
        now - timedelta(seconds=30),
        now - timedelta(seconds=15),
    )
    assert allowed.allowed
    assert allowed.retry_after_seconds == 0


def test_logout_ticket_is_target_bound_and_has_contract_encoding():
    session_id = uuid4()
    key = bytes([9]) * 32
    ticket = create_logout_ticket(session_id, key)

    assert len(ticket) == 64
    assert decode_base64url(ticket, 48) is not None
    assert verify_logout_ticket(ticket, key) == session_id
    assert verify_logout_ticket(ticket, bytes([8]) * 32) is None
    assert (
        verify_logout_ticket(ticket[:-1] + ("A" if ticket[-1] != "A" else "B"), key)
        is None
    )


def test_logout_ticket_accepts_previous_verification_key_after_rotation():
    session_id = uuid4()
    previous_key = bytes([9]) * 32
    current_key = bytes([10]) * 32
    ticket = create_logout_ticket(session_id, previous_key)

    assert verify_logout_ticket(ticket, (current_key, previous_key)) == session_id
    assert verify_logout_ticket(ticket, (current_key, bytes([11]) * 32)) is None
