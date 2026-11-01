"""Strict DTOs for server-side authentication sessions."""

from typing import Annotated

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
