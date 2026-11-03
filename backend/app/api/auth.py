"""Same-origin authentication endpoints with server-side sessions."""

from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status

from app.core.database import get_session
from app.models.auth import Session
from app.schemas.auth import (
    AcceptedEmailRequest,
    EmailRequest,
    LocalKeyView,
    LoginRequest,
    LogoutRequest,
    SessionView,
    StatusResponse,
    TokenPasswordRequest,
)
from app.services import auth
from app.services.auth_crypto import decode_key, logout_ticket_session_id, token_digest
from app.services.sessions import (
    SessionContext,
    clear_session_cookie,
    csrf_protected_context,
    get_session_context,
    make_session_view,
)

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.get("/session", response_model=SessionView)
async def session_view(
    request: Request,
    db: AsyncSession = Depends(get_session),
    context: SessionContext = Depends(get_session_context),
) -> dict:
    await auth._consume_session_limits(
        db, request.app.state.settings, request, context, context.now
    )
    return make_session_view(context)


@router.post(
    "/register",
    response_model=AcceptedEmailRequest,
    status_code=status.HTTP_202_ACCEPTED,
)
async def register(
    payload: EmailRequest,
    request: Request,
    db: AsyncSession = Depends(get_session),
    context: SessionContext = Depends(csrf_protected_context),
) -> dict:
    del context
    return await auth.request_verification(
        db, request.app.state.settings, request, payload.email
    )


@router.post(
    "/verification/resend",
    response_model=AcceptedEmailRequest,
    status_code=status.HTTP_202_ACCEPTED,
)
async def resend_verification(
    payload: EmailRequest,
    request: Request,
    db: AsyncSession = Depends(get_session),
    context: SessionContext = Depends(csrf_protected_context),
) -> dict:
    del context
    return await auth.request_verification(
        db, request.app.state.settings, request, payload.email
    )


@router.post("/verification/confirm", response_model=StatusResponse)
async def confirm_verification(
    payload: TokenPasswordRequest,
    request: Request,
    db: AsyncSession = Depends(get_session),
    context: SessionContext = Depends(csrf_protected_context),
) -> dict:
    del context
    return await auth.confirm_verification(
        db, request.app.state.settings, request, payload.token, payload.password
    )


@router.post("/login", response_model=SessionView)
async def login(
    payload: LoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_session),
    context: SessionContext = Depends(csrf_protected_context),
) -> dict:
    return await auth.login(
        db,
        request.app.state.settings,
        request,
        context,
        payload.email,
        payload.password,
        payload.remember_me,
    )


@router.post(
    "/password/forgot",
    response_model=AcceptedEmailRequest,
    status_code=status.HTTP_202_ACCEPTED,
)
async def password_forgot(
    payload: EmailRequest,
    request: Request,
    db: AsyncSession = Depends(get_session),
    context: SessionContext = Depends(csrf_protected_context),
) -> dict:
    del context
    return await auth.request_password_reset(
        db, request.app.state.settings, request, payload.email
    )


@router.post("/password/reset", response_model=StatusResponse)
async def password_reset(
    payload: TokenPasswordRequest,
    request: Request,
    db: AsyncSession = Depends(get_session),
    context: SessionContext = Depends(csrf_protected_context),
) -> dict:
    del context
    return await auth.reset_password(
        db, request.app.state.settings, request, payload.token, payload.password
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    payload: LogoutRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_session),
    context: SessionContext = Depends(csrf_protected_context),
) -> Response:
    now = auth._now()
    target_id: UUID | None = context.row.id
    if payload.logout_ticket:
        key = decode_key(
            request.app.state.settings.logout_ticket_key_b64.get_secret_value()
        )
        target_id = logout_ticket_session_id(payload.logout_ticket, key)
        if target_id is not None:
            target = await db.scalar(
                select(Session).where(Session.id == target_id).with_for_update()
            )
            if target is not None and target.revoked_at is None:
                target.revoked_at = now
            current_cookie = request.cookies.get("__Host-dayforge-session")
            if context.row.id == target_id and current_cookie:
                try:
                    if token_digest(current_cookie) == context.row.token_hash:
                        clear_session_cookie(request, response)
                except ValueError:
                    pass
    else:
        if context.row.revoked_at is None:
            context.row.revoked_at = now
        clear_session_cookie(request, response)
    await db.commit()
    return Response(
        status_code=status.HTTP_204_NO_CONTENT, headers=dict(response.headers)
    )


@router.get("/local-key", response_model=LocalKeyView)
async def local_key(
    request: Request,
    db: AsyncSession = Depends(get_session),
    context: SessionContext = Depends(get_session_context),
) -> dict:
    return await auth.local_key(db, request.app.state.settings, request, context)
