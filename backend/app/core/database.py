"""Application-owned engines and request-owned sessions; services own commits."""

from collections.abc import AsyncIterator
from dataclasses import dataclass

from fastapi import Request
from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import Settings, build_database_url


@dataclass(frozen=True)
class Database:
    engine: AsyncEngine
    sessions: async_sessionmaker[AsyncSession]


def create_database(settings: Settings) -> Database:
    engine = create_async_engine(
        build_database_url(settings),
        pool_size=5,
        max_overflow=0,
        pool_timeout=3,
        pool_recycle=1800,
        pool_pre_ping=True,
        connect_args={"connect_timeout": 3},
        echo=False,
        hide_parameters=True,
    )

    @event.listens_for(engine.sync_engine, "connect")
    def configure_connection(connection, _record):
        cursor = connection.cursor()
        try:
            cursor.execute("SET SESSION time_zone = '+00:00'")
            cursor.execute("SELECT @@SESSION.sql_mode")
            modes = cursor.fetchone()[0].split(",")
            if not {"STRICT_TRANS_TABLES", "STRICT_ALL_TABLES"}.intersection(modes):
                cursor.execute(
                    "SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_TRANS_TABLES')"
                )
        finally:
            cursor.close()

    return Database(
        engine, async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    )


async def close_database(database: Database) -> None:
    await database.engine.dispose()


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    session = request.app.state.database.sessions()
    try:
        yield session
    finally:
        try:
            if session.in_transaction():
                await session.rollback()
        finally:
            await session.close()
