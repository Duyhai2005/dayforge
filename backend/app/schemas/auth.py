"""Strict account and session DTOs shared with the T03 wire contract."""

from typing import Literal

from pydantic import Field

from app.schemas.common import ContractModel, WireTimestamp, WireUUID


class EmailRequest(ContractModel):
    email: str = Field(min_length=1, max_length=1024)


class TokenPasswordRequest(ContractModel):
    token: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")
    password: str = Field(min_length=1, max_length=1024)


class LoginRequest(ContractModel):
    email: str = Field(min_length=1, max_length=1024)
    password: str = Field(min_length=1, max_length=1024)
    remember_me: bool


class LogoutRequest(ContractModel):
    logout_ticket: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{64}$")


class AcceptedEmailRequest(ContractModel):
    status: Literal["accepted"] = "accepted"
    resend_after_seconds: Literal[60] = 60


class StatusResponse(ContractModel):
    status: Literal["verified", "password_reset"]


class OwnerView(ContractModel):
    id: WireUUID
    email: str = Field(min_length=3, max_length=254)
    email_verified_at: WireTimestamp


class SessionDetails(ContractModel):
    id: WireUUID
    remember_me: bool
    idle_expires_at: WireTimestamp
    absolute_expires_at: WireTimestamp
    password_authenticated_at: WireTimestamp


class SessionView(ContractModel):
    authenticated: bool
    owner: OwnerView | None
    session: SessionDetails | None
    csrf_token: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")
    server_time: WireTimestamp
    logout_ticket: str | None = Field(pattern=r"^[A-Za-z0-9_-]{64}$")


class LocalKeyView(ContractModel):
    owner_id: WireUUID
    key_id: WireUUID
    algorithm: Literal["A256GCM"]
    key_base64url: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")
