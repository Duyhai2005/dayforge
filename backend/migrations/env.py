"""Async migrations use explicit settings without passing credentials to ConfigParser."""

import asyncio

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import build_database_url, load_settings
from app.models import Base

target_metadata = Base.metadata


def configure(connection):
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_online():
    engine = create_async_engine(
        build_database_url(load_settings()),
        poolclass=NullPool,
        echo=False,
        hide_parameters=True,
        connect_args={"connect_timeout": 3},
    )
    try:
        async with engine.connect() as connection:
            await connection.run_sync(configure)
    finally:
        await engine.dispose()


if context.is_offline_mode():
    # Offline DDL needs neither credentials nor a live database/settings instance.
    context.configure(
        dialect_name="mysql",
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()
else:
    asyncio.run(run_online())
