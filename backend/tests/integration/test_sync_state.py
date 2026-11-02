import asyncio
import os
import subprocess
import sys
from pathlib import Path
from uuid import UUID

import pytest

from app.core.database import create_database
from app.models.sync import OwnerSyncState
from app.services.sync import ensure_owner_sync_state

pytestmark = pytest.mark.mysql
BACKEND = Path(__file__).resolve().parents[2]


def alembic(*arguments):
    result = subprocess.run(
        [sys.executable, "-m", "alembic", *arguments],
        cwd=BACKEND,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
    )
    code = result.returncode
    del result
    assert code == 0, "Alembic command failed (output suppressed for secret safety)"


@pytest.fixture
def migrated(mysql_test_settings):
    alembic("downgrade", "base")
    alembic("upgrade", "head")
    try:
        yield mysql_test_settings
    finally:
        alembic("downgrade", "base")


def test_owner_sync_state_creation_is_persistent_and_serialized(migrated, user_factory):
    async def run():
        database = create_database(migrated)
        owner = user_factory()
        try:
            async with database.sessions() as session:
                async with session.begin():
                    session.add(owner)

            async def ensure_state():
                async with database.sessions() as session:
                    async with session.begin():
                        state = await ensure_owner_sync_state(session, owner.id)
                        return state.epoch, state.head_cursor

            first, second = await asyncio.gather(ensure_state(), ensure_state())
            assert first == second
            assert isinstance(first[0], UUID)
            assert first[1] == 0

            async with database.sessions() as session:
                stored = await session.get(OwnerSyncState, owner.id)
                assert stored is not None
                assert (stored.epoch, stored.head_cursor) == first
        finally:
            await database.engine.dispose()

    asyncio.run(run())
