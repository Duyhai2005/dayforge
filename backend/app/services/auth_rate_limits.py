"""Deterministic HMAC pseudonyms and rolling-window rate-limit primitives."""

import hashlib
import hmac
import math
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    retry_after_seconds: int
    retained_events: tuple[datetime, ...]


def pseudonymize(key: bytes, action: str, subject_kind: str, subject: bytes) -> bytes:
    if not isinstance(key, bytes) or len(key) != 32:
        raise ValueError("rate_limit_key_invalid")
    if not action or not subject_kind or not isinstance(subject, bytes):
        raise ValueError("rate_limit_subject_invalid")
    message = (
        b"dayforge-auth-rate-v1\0"
        + action.encode("ascii")
        + b"\0"
        + subject_kind.encode("ascii")
        + b"\0"
        + subject
    )
    return hmac.new(key, message, hashlib.sha256).digest()


def evaluate_rolling_limit(
    events: Iterable[datetime], now: datetime, *, window_seconds: int, maximum: int
) -> RateLimitDecision:
    if now.tzinfo is None or window_seconds <= 0 or maximum <= 0:
        raise ValueError("rate_limit_window_invalid")
    instant = now.astimezone(timezone.utc)
    cutoff = instant - timedelta(seconds=window_seconds)
    retained = tuple(
        sorted(
            event.astimezone(timezone.utc)
            for event in events
            if event.tzinfo is not None
            and cutoff < event.astimezone(timezone.utc) <= instant
        )
    )
    if len(retained) < maximum:
        return RateLimitDecision(True, 0, retained)
    retry = max(
        1,
        math.ceil(
            (retained[0] + timedelta(seconds=window_seconds) - instant).total_seconds()
        ),
    )
    return RateLimitDecision(False, retry, retained)
