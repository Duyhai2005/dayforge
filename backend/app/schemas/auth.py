"""Strict DTOs for server-side authentication sessions."""

from typing import Annotated, Literal

from pydantic import Field

from app.schemas.common import ContractModel, WireTimestamp, WireUUID


class SessionOwner(ContractModel):
    id: WireUUID
    email: Annotated[str, Field(strict=True, min_length=1, max_length=254)]
    email_verified_at: WireTimestamp


class SessionInfo(ContractModel):
    id: WireUUID
    remember_me: bool
    idle_expires_at: WireTimestamp
    absolute_expires_at: WireTimestamp
    password_authenticated_at: WireTimestamp | None


class SessionView(ContractModel):
    authenticated: bool
    owner: SessionOwner | None
    session: SessionInfo | None
    csrf_token: Annotated[str, Field(strict=True, pattern=r"^[A-Za-z0-9_-]{43}$")]
    server_time: WireTimestamp
    logout_ticket: (
        Annotated[str, Field(strict=True, pattern=r"^[A-Za-z0-9_-]{64}$")] | None
    )


class LogoutRequest(ContractModel):
    logout_ticket: (
        Annotated[
            str,
            Field(
                strict=True,
                min_length=64,
                max_length=64,
                pattern=r"^[A-Za-z0-9_-]{64}$",
            ),
        ]
        | None
    ) = None


class EmailRequest(ContractModel):
    email: Annotated[str, Field(strict=True, min_length=1, max_length=1024)]


class EmailTokenPasswordRequest(ContractModel):
    token: Annotated[
        str,
        Field(
            strict=True, min_length=43, max_length=43, pattern=r"^[A-Za-z0-9_-]{43}$"
        ),
    ]
    password: Annotated[str, Field(strict=True, max_length=1024)]


class LoginRequest(ContractModel):
    email: Annotated[str, Field(strict=True, min_length=1, max_length=1024)]
    password: Annotated[str, Field(strict=True, max_length=1024)]
    remember_me: bool


class AcceptedEmailRequest(ContractModel):
    status: Literal["accepted"] = "accepted"
    resend_after_seconds: Literal[60] = 60


class AuthActionResponse(ContractModel):
    status: Literal["verified", "password_reset"]


class LocalKeyResponse(ContractModel):
    owner_id: WireUUID
    key_id: WireUUID
    algorithm: Literal["A256GCM"]
    key_base64url: Annotated[str, Field(strict=True, pattern=r"^[A-Za-z0-9_-]{43}$")]
