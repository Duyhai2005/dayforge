from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.core.config import Settings, load_settings
from app.core.database import close_database, create_database


def create_app(settings: Settings | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        configured = settings if settings is not None else load_settings()
        database = create_database(configured)
        application.state.settings = configured
        application.state.database = database
        try:
            yield
        finally:
            await close_database(database)

    return FastAPI(
        title="DAYFORGE API", version="0.0.0", openapi_url="/api/v1/openapi.json",
        docs_url=None, redoc_url=None, lifespan=lifespan,
    )


app = create_app()
