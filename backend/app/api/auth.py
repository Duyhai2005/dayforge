"""HTTP routes for session state and targeted logout."""

from fastapi import APIRouter, Depends, Request, Response

from app.core.auth_security import validate_auth_post
from app.core.values import format_utc_timestamp
from app.schemas.auth import (
    AcceptedEmailRequest,
    AuthActionResponse,
    EmailRequest,
    EmailTokenPasswordRequest,
    LocalKeyResponse,
    LoginRequest,
    LogoutRequest,
    SessionInfo,
    SessionOwner,
    SessionView,
)
from app.services.auth import AuthService
from app.services.auth_crypto import (
    create_logout_ticket,
    encode_base64url,
    verify_logout_ticket,
)
from app.services.sessions import (
    SessionContext,
    clear_session_cookie,
    create_anonymous_session,
    get_session_context,
    require_verified_owner,
    revoke_session,
    set_session_cookie,
    touch_session,
    utc_now,
)

router = APIRouter(prefix="/api/v1/auth")


def get_auth_service(request: Request) -> AuthService:
    return AuthService(request.app.state.database, request.app.state.settings)


def _peer_ip(request: Request) -> str | None:
    return None if request.client is None else request.client.host


def _view(context: SessionContext, request: Request) -> SessionView:
    authenticated = context.authenticated and context.user is not None
    owner = None
    session_info = None
    logout_ticket = None
    if authenticated and context.user is not None:
        user = context.user
        record = context.session
        owner = SessionOwner(
            id=str(user.id),
            email=user.email_delivery,
            email_verified_at=format_utc_timestamp(user.email_verified_at),
        )
        password_authenticated_at = (
            None
            if record.password_authenticated_at is None
            else format_utc_timestamp(record.password_authenticated_at)
        )
        session_info = SessionInfo(
            id=str(record.id),
            remember_me=bool(record.remember_me),
            idle_expires_at=format_utc_timestamp(record.idle_expires_at),
            absolute_expires_at=format_utc_timestamp(record.absolute_expires_at),
            password_authenticated_at=password_authenticated_at,
        )
        key = request.app.state.settings.secret_key("logout_ticket_key_b64")
        logout_ticket = create_logout_ticket(record.id, key)
    return SessionView(
        authenticated=authenticated,
        owner=owner,
        session=session_info,
        csrf_token=encode_base64url(context.csrf_token),
        server_time=format_utc_timestamp(utc_now()),
        logout_ticket=logout_ticket,
    )


@router.get("/session", response_model=SessionView)
async def session_view(
    request: Request,
    response: Response,
    context: SessionContext | None = Depends(get_session_context),
    service: AuthService = Depends(get_auth_service),
) -> SessionView:
    await service.session_request_limit(context, _peer_ip(request))
    if context is None:
        context = await create_anonymous_session(request)
        set_session_cookie(response, context)
    elif context.authenticated:
        current = await touch_session(request, context)
        if current is None:
            context = await create_anonymous_session(request)
            set_session_cookie(response, context)
        else:
            context = current
    return _view(context, request)


@router.post("/logout", status_code=204, response_class=Response)
async def logout(
    body: LogoutRequest,
    request: Request,
    context: SessionContext | None = Depends(get_session_context),
) -> Response:
    validate_auth_post(request, None if context is None else context.csrf_token)
    settings = request.app.state.settings
    response = Response(status_code=204)
    target_id = None
    if body.logout_ticket is None:
        target_id = None if context is None else context.session.id
    else:
        target_id = verify_logout_ticket(
            body.logout_ticket, settings.logout_ticket_verification_keys()
        )
    if target_id is not None:
        await revoke_session(request, target_id)
        if context is not None and context.session.id == target_id:
            clear_session_cookie(response)
    return response


@router.post("/register", status_code=202, response_model=AcceptedEmailRequest)
async def register(
    body: EmailRequest,
    request: Request,
    context: SessionContext | None = Depends(get_session_context),
    service: AuthService = Depends(get_auth_service),
) -> AcceptedEmailRequest:
    validate_auth_post(request, None if context is None else context.csrf_token)
    await service.request_email(body.email, "verify_email", _peer_ip(request))
    return AcceptedEmailRequest()


@router.post(
    "/verification/resend", status_code=202, response_model=AcceptedEmailRequest
)
async def resend_verification(
    body: EmailRequest,
    request: Request,
    context: SessionContext | None = Depends(get_session_context),
    service: AuthService = Depends(get_auth_service),
) -> AcceptedEmailRequest:
    validate_auth_post(request, None if context is None else context.csrf_token)
    await service.request_email(body.email, "verify_email", _peer_ip(request))
    return AcceptedEmailRequest()


@router.post("/verification/confirm", response_model=AuthActionResponse)
async def confirm_verification(
    body: EmailTokenPasswordRequest,
    request: Request,
    context: SessionContext | None = Depends(get_session_context),
    service: AuthService = Depends(get_auth_service),
) -> AuthActionResponse:
    validate_auth_post(request, None if context is None else context.csrf_token)
    await service.confirm_email(body.token, body.password, _peer_ip(request))
    return AuthActionResponse(status="verified")


@router.post("/login", response_model=SessionView)
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    context: SessionContext | None = Depends(get_session_context),
    service: AuthService = Depends(get_auth_service),
) -> SessionView:
    validate_auth_post(request, None if context is None else context.csrf_token)
    authenticated = await service.login(
        body.email,
        body.password,
        body.remember_me,
        context,
        _peer_ip(request),
    )
    set_session_cookie(response, authenticated)
    return _view(authenticated, request)


@router.post("/password/forgot", status_code=202, response_model=AcceptedEmailRequest)
async def forgot_password(
    body: EmailRequest,
    request: Request,
    context: SessionContext | None = Depends(get_session_context),
    service: AuthService = Depends(get_auth_service),
) -> AcceptedEmailRequest:
    validate_auth_post(request, None if context is None else context.csrf_token)
    await service.request_email(body.email, "password_reset", _peer_ip(request))
    return AcceptedEmailRequest()


@router.post("/password/reset", response_model=AuthActionResponse)
async def reset_password(
    body: EmailTokenPasswordRequest,
    request: Request,
    context: SessionContext | None = Depends(get_session_context),
    service: AuthService = Depends(get_auth_service),
) -> AuthActionResponse:
    validate_auth_post(request, None if context is None else context.csrf_token)
    await service.reset_password(body.token, body.password, _peer_ip(request))
    return AuthActionResponse(status="password_reset")


@router.get("/local-key", response_model=LocalKeyResponse)
async def local_key(
    request: Request,
    context: SessionContext = Depends(require_verified_owner),
    service: AuthService = Depends(get_auth_service),
) -> LocalKeyResponse:
    value = await service.local_key(context, _peer_ip(request))
    return LocalKeyResponse(
        owner_id=value["owner_id"],
        key_id=value["key_id"],
        algorithm="A256GCM",
        key_base64url=value["key_base64url"],
    )
