"""HMAC-authenticated continuation tokens for immutable sync pages."""

import base64
import binascii
import hashlib
import hmac
import json
import re
from dataclasses import dataclass
from uuid import UUID

TOKEN_TTL_SECONDS = 1800
_TOKEN_VERSION = 1
_API_MAJOR = 1
_SCHEMA_VERSION = 1
_MAX_TOKEN_LENGTH = 2048
_MAX_CURSOR = 18_446_744_073_709_551_615
_TOKEN_PART = re.compile(r"[A-Za-z0-9_-]+")
_PAYLOAD_FIELDS = {
    "api_major",
    "endpoint",
    "schema_version",
    "owner_id",
    "epoch",
    "after_cursor",
    "through_cursor",
    "position",
    "expires_at",
    "version",
}
_ENDPOINTS = {"bootstrap", "pull"}
_DOMAIN = b"dayforge-sync-page-token-v1\0"


class PageTokenError(ValueError):
    """A safe page-token failure with a stable public problem code."""

    def __init__(self, code: str, status_code: int = 400):
        super().__init__(code)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class PageToken:
    endpoint: str
    owner_id: UUID
    epoch: UUID
    after_cursor: int
    through_cursor: int
    position: int
    expires_at: int
    version: int
    api_major: int
    schema_version: int


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode_part(value: str) -> bytes:
    if not _TOKEN_PART.fullmatch(value):
        raise ValueError("invalid_token")
    decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if _b64url(decoded) != value:
        raise ValueError("invalid_token")
    return decoded


def _validate_fields(
    *,
    endpoint: str,
    owner_id: UUID,
    epoch: UUID,
    after_cursor: int,
    through_cursor: int,
    position: int,
    expires_at: int,
) -> None:
    values = (after_cursor, through_cursor, position, expires_at)
    if (
        not isinstance(endpoint, str)
        or endpoint not in _ENDPOINTS
        or not isinstance(owner_id, UUID)
        or not isinstance(epoch, UUID)
        or any(type(value) is not int or value < 0 for value in values)
        or any(value > _MAX_CURSOR for value in (after_cursor, through_cursor, position))
        or after_cursor > position
        or position > through_cursor
    ):
        raise PageTokenError("malformed_request")


def create_page_token(
    key: bytes,
    *,
    endpoint: str,
    owner_id: UUID,
    epoch: UUID,
    after_cursor: int,
    through_cursor: int,
    position: int,
    now: int,
    expires_at: int | None = None,
) -> str:
    """Sign a prefix position, retaining the original expiry when continued."""
    if type(now) is not int:
        raise PageTokenError("malformed_request")
    expiration = now + TOKEN_TTL_SECONDS if expires_at is None else expires_at
    _validate_fields(
        endpoint=endpoint,
        owner_id=owner_id,
        epoch=epoch,
        after_cursor=after_cursor,
        through_cursor=through_cursor,
        position=position,
        expires_at=expiration,
    )
    if not isinstance(key, bytes) or len(key) != 32 or not now < expiration <= now + TOKEN_TTL_SECONDS:
        raise PageTokenError("malformed_request")
    payload = {
        "api_major": _API_MAJOR,
        "endpoint": endpoint,
        "schema_version": _SCHEMA_VERSION,
        "owner_id": str(owner_id),
        "epoch": str(epoch),
        "after_cursor": str(after_cursor),
        "through_cursor": str(through_cursor),
        "position": str(position),
        "expires_at": expiration,
        "version": _TOKEN_VERSION,
    }
    serialized = json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("ascii")
    signature = hmac.new(key, _DOMAIN + serialized, hashlib.sha256).digest()
    return f"{_b64url(serialized)}.{_b64url(signature)}"


def verify_page_token(
    key: bytes,
    token: str,
    *,
    endpoint: str,
    owner_id: UUID,
    now: int,
) -> PageToken:
    """Verify signature, scope, cursor bounds, and expiry before database access."""
    if (
        not isinstance(key, bytes)
        or len(key) != 32
        or type(now) is not int
        or not isinstance(endpoint, str)
        or endpoint not in _ENDPOINTS
        or not isinstance(owner_id, UUID)
        or not isinstance(token, str)
        or not 1 <= len(token) <= _MAX_TOKEN_LENGTH
    ):
        raise PageTokenError("malformed_request")
    parts = token.split(".")
    if len(parts) != 2:
        raise PageTokenError("malformed_request")
    try:
        serialized = _decode_part(parts[0])
        signature = _decode_part(parts[1])
    except ValueError, binascii.Error:
        raise PageTokenError("malformed_request") from None
    expected = hmac.new(key, _DOMAIN + serialized, hashlib.sha256).digest()
    if not hmac.compare_digest(signature, expected):
        raise PageTokenError("malformed_request")
    try:
        payload = json.loads(serialized)
        if not isinstance(payload, dict) or set(payload) != _PAYLOAD_FIELDS:
            raise ValueError("invalid_token")
        if json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("ascii") != serialized:
            raise ValueError("invalid_token")
        if (
            type(payload["version"]) is not int
            or payload["version"] != _TOKEN_VERSION
            or type(payload["api_major"]) is not int
            or payload["api_major"] != _API_MAJOR
            or type(payload["schema_version"]) is not int
            or payload["schema_version"] != _SCHEMA_VERSION
        ):
            raise ValueError("invalid_token")
        if (
            not isinstance(payload["endpoint"], str)
            or not isinstance(payload["owner_id"], str)
            or not isinstance(payload["epoch"], str)
        ):
            raise ValueError("invalid_token")
        token_endpoint = payload["endpoint"]
        token_owner = UUID(payload["owner_id"])
        epoch = UUID(payload["epoch"])
        after_cursor = int(payload["after_cursor"])
        through_cursor = int(payload["through_cursor"])
        position = int(payload["position"])
        expires_at = payload["expires_at"]
        if any(
            type(payload[name]) is not str
            for name in ("owner_id", "epoch", "after_cursor", "through_cursor", "position")
        ):
            raise ValueError("invalid_token")
        if any(
            str(number) != payload[name]
            for number, name in (
                (after_cursor, "after_cursor"),
                (through_cursor, "through_cursor"),
                (position, "position"),
            )
        ):
            raise ValueError("invalid_token")
        if type(expires_at) is not int:
            raise ValueError("invalid_token")
        if str(token_owner) != payload["owner_id"] or str(epoch) != payload["epoch"]:
            raise ValueError("invalid_token")
        _validate_fields(
            endpoint=token_endpoint,
            owner_id=token_owner,
            epoch=epoch,
            after_cursor=after_cursor,
            through_cursor=through_cursor,
            position=position,
            expires_at=expires_at,
        )
    except AttributeError, KeyError, TypeError, ValueError, OverflowError:
        raise PageTokenError("malformed_request") from None
    if token_endpoint != endpoint or token_owner != owner_id:
        raise PageTokenError("malformed_request")
    if expires_at <= now:
        raise PageTokenError("page_token_expired", status_code=409)
    if expires_at > now + TOKEN_TTL_SECONDS:
        raise PageTokenError("malformed_request")
    return PageToken(
        endpoint=token_endpoint,
        owner_id=token_owner,
        epoch=epoch,
        after_cursor=after_cursor,
        through_cursor=through_cursor,
        position=position,
        expires_at=expires_at,
        version=_TOKEN_VERSION,
        api_major=_API_MAJOR,
        schema_version=_SCHEMA_VERSION,
    )
