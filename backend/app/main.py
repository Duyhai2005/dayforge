from fastapi import FastAPI

app = FastAPI(
    title="DAYFORGE API",
    version="0.0.0",
    openapi_url="/api/v1/openapi.json",
    docs_url=None,
    redoc_url=None,
)
