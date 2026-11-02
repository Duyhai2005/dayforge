import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.auth import router as auth_router
from app.api.sync import router as sync_router
from app.api.system import router as system_router
from app.core.auth_security import AuthNoStoreMiddleware
from app.core.config import Settings, load_settings
from app.core.database import close_database, create_database
from app.core.errors import register_exception_handlers
from app.core.request_logging import AuthAuditMiddleware, RequestLoggingMiddleware
from app.core.strict_json import StrictJSONMiddleware
from app.services.auth import validate_owner_email_binding
from app.services.auth_maintenance import run_auth_maintenance
from app.services.email_delivery import run_delivery_worker
from app.services.readiness import required_schema_revision


def create_app(settings: Settings | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        configured = settings if settings is not None else load_settings()
        revision = required_schema_revision()
        if configured.app_env == "production" and application.openapi_url is not None:
            application.router.routes[:] = [
                route for route in application.router.routes if getattr(route, "path", None) != application.openapi_url
            ]
            application.openapi_url = None
        database = create_database(configured)
        application.state.settings = configured
        application.state.database = database
        application.state.required_schema_revision = revision
        worker = None
        maintenance = None
        try:
            if configured.app_env != "test":
                await validate_owner_email_binding(database, configured)
                worker = asyncio.create_task(run_delivery_worker(database, configured))
                maintenance = asyncio.create_task(run_auth_maintenance(database))
            yield
        finally:
            for task in (worker, maintenance):
                if task is None:
                    continue
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            await close_database(database)

    application = FastAPI(
        title="DAYFORGE API",
        version="0.0.0",
        openapi_url="/api/v1/openapi.json",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    register_exception_handlers(application)
    application.include_router(system_router)
    application.include_router(auth_router)
    application.include_router(sync_router)
    application.add_middleware(StrictJSONMiddleware)
    application.add_middleware(AuthAuditMiddleware)
    application.add_middleware(AuthNoStoreMiddleware)
    # Register context last so it remains outside downstream parsing middleware.
    application.add_middleware(RequestLoggingMiddleware)
    return application


app = create_app()
