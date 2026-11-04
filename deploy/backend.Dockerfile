# syntax=docker/dockerfile:1.7
ARG PYTHON_IMAGE=python:3.14.10-slim-bookworm@sha256:5dca57ddc56794d9049dee9ee95a7f071b69d3b018368f2ddc61813649ca2fa0

FROM ${PYTHON_IMAGE} AS build
ENV UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /build/backend
RUN pip install --no-cache-dir uv==0.13.6
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project --python /usr/local/bin/python

FROM ${PYTHON_IMAGE} AS runtime
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONPATH=/app/backend \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    USER=dayforge \
    LOGNAME=dayforge
WORKDIR /app/backend
COPY --from=build --chown=10001:10001 /app/.venv /app/.venv
COPY --chown=10001:10001 backend/app ./app
COPY --chown=10001:10001 backend/migrations ./migrations
COPY --chown=10001:10001 backend/alembic.ini ./alembic.ini
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=2).read()"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log", "--proxy-headers", "--forwarded-allow-ips", "127.0.0.1"]
