"""Owner-scoped sync state and transactional cursor services."""

from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sync import OwnerSyncState


def _utc_now() -> datetime:
    value = datetime.now(timezone.utc)
    return value.replace(microsecond=(value.microsecond // 1000) * 1000)


def unix_milliseconds(value: datetime) -> int:
    utc_value = value.astimezone(timezone.utc)
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    delta = utc_value - epoch
    return delta.days * 86_400_000 + delta.seconds * 1_000 + delta.microseconds // 1_000


async def ensure_owner_sync_state(
    session: AsyncSession,
    owner_id: UUID,
    *,
    now: datetime | None = None,
) -> OwnerSyncState:
    """Create one epoch row if needed and lock it for the caller transaction."""
    instant = (
        _utc_now()
        if now is None
        else now.astimezone(timezone.utc).replace(microsecond=(now.microsecond // 1000) * 1000)
    )
    insert = mysql_insert(OwnerSyncState).values(
        owner_id=owner_id,
        epoch=uuid4(),
        head_cursor=0,
        created_at=instant,
        updated_at=instant,
    )
    await session.execute(insert.on_duplicate_key_update(owner_id=insert.inserted.owner_id))
    state = (
        await session.execute(select(OwnerSyncState).where(OwnerSyncState.owner_id == owner_id).with_for_update())
    ).scalar_one()
    return state
