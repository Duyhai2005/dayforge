"""Read-only readiness probes against the packaged schema contract."""

import asyncio
import logging
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.core.database import Database

ALEMBIC_CONFIG = Path(__file__).resolve().parents[2] / "alembic.ini"
_logger = logging.getLogger(__name__)


def required_schema_revision() -> str:
    try:
        scripts = ScriptDirectory.from_config(Config(str(ALEMBIC_CONFIG)))
        heads = scripts.get_heads()
        if len(heads) != 1:
            raise ValueError("invalid_schema_configuration")
        return heads[0]
    except Exception:
        # Script/config errors can contain paths or exception messages; startup
        # exposes only the fixed configuration failure, never their contents.
        raise ValueError("invalid_schema_configuration") from None


async def check_readiness(database: Database, *, required_revision: str) -> bool:
    ready = await _probe_readiness(database, required_revision=required_revision)
    if not ready:
        _logger.warning("database_not_ready")
    return ready


async def _probe_readiness(database: Database, *, required_revision: str) -> bool:
    try:
        async with asyncio.timeout(2):
            async with database.engine.connect() as connection:
                if (await connection.execute(text("SELECT 1"))).scalar_one() != 1:
                    return False
                charset, time_zone, sql_mode = (
                    await connection.execute(
                        text(
                            "SELECT @@character_set_connection, @@SESSION.time_zone, @@SESSION.sql_mode"
                        )
                    )
                ).one()
                if (
                    charset != "utf8mb4"
                    or time_zone != "+00:00"
                    or not {"STRICT_TRANS_TABLES", "STRICT_ALL_TABLES"}.intersection(
                        sql_mode.split(",")
                    )
                ):
                    return False
                revisions = (
                    (
                        await connection.execute(
                            text("SELECT version_num FROM alembic_version")
                        )
                    )
                    .scalars()
                    .all()
                )
                if revisions != [required_revision]:
                    return False
                await connection.execute(text("SELECT id FROM users LIMIT 0"))
                await connection.execute(
                    text("SELECT owner_id FROM workspace_settings LIMIT 0")
                )
                return True
    except (SQLAlchemyError, TimeoutError, OSError):
        return False
