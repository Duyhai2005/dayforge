"""Invalidate restored authentication and rotate the sync epoch before startup."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4

from sqlalchemy import select

from app.core.config import SettingsError, load_settings
from app.core.database import close_database, create_database
from app.models.owner import User
from app.models.sync import OwnerSyncState, RecordedOperation
from app.services.restore_recovery import (
    OwnerEpochRotation,
    RestoredOwnerResult,
    RestoreRecoveryError,
    prepare_restored_database,
)

_RESTORE_PROJECT = re.compile(r"dayforge-restore-([a-f0-9]{32})\Z")
_RESTORE_DATABASE = re.compile(r"dayforge_restore_([a-f0-9]{32})\Z")
_JOURNAL_FIELDS = frozenset(
    {
        "format_version",
        "restore_id",
        "environment",
        "compose_project",
        "db_name",
        "source_fingerprint_sha256",
        "rotations",
        "state",
        "prepared_at",
        "completed_at",
        "results",
    }
)


class RestorePreparationError(RuntimeError):
    """Safe CLI failure containing no private target or owner values."""


def _target_identity() -> tuple[str, str, str]:
    environment = os.environ.get("DEPLOYMENT_ENV", "")
    compose_project = os.environ.get("COMPOSE_PROJECT", "")
    db_name = os.environ.get("DB_NAME", "")
    project_match = _RESTORE_PROJECT.fullmatch(compose_project)
    database_match = _RESTORE_DATABASE.fullmatch(db_name)
    if (
        environment != "restore"
        or project_match is None
        or database_match is None
        or project_match.group(1) != database_match.group(1)
    ):
        raise RestorePreparationError("restore_target_identity_invalid")
    return environment, compose_project, db_name


def _safe_utc_text(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise RestorePreparationError("restore_clock_invalid")
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _read_journal(path: Path) -> dict[str, object] | None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    except OSError:
        raise RestorePreparationError("restore_journal_unavailable") from None
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise RestorePreparationError("restore_journal_invalid")
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise RestorePreparationError("restore_journal_permissions_invalid")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError, UnicodeError, json.JSONDecodeError:
        raise RestorePreparationError("restore_journal_unreadable") from None
    if not isinstance(raw, dict) or set(raw) != _JOURNAL_FIELDS or raw.get("format_version") != 1:
        raise RestorePreparationError("restore_journal_invalid")
    if raw.get("state") not in {"prepared", "completed"} or not isinstance(raw.get("rotations"), list):
        raise RestorePreparationError("restore_journal_invalid")
    if raw.get("state") == "completed" and (
        not isinstance(raw.get("completed_at"), str) or not isinstance(raw.get("results"), list)
    ):
        raise RestorePreparationError("restore_journal_invalid")
    return raw


def _write_journal(path: Path, payload: dict[str, object]) -> None:
    temporary: Path | None = None
    try:
        if path.parent.is_symlink():
            raise OSError
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if stat.S_IMODE(path.parent.stat().st_mode) & 0o077:
            raise OSError
        temporary = path.with_name(f".{path.name}-{uuid4().hex}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    except OSError:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
        raise RestorePreparationError("restore_journal_write_failed") from None


async def _current_rotations(database) -> tuple[OwnerEpochRotation, ...]:
    async with database.sessions() as session:
        rows = (
            await session.execute(
                select(User.id, OwnerSyncState.epoch)
                .outerjoin(OwnerSyncState, OwnerSyncState.owner_id == User.id)
                .order_by(User.id)
            )
        ).all()
    if not rows:
        raise RestorePreparationError("restore_owner_missing")
    return tuple(
        OwnerEpochRotation(owner_id=owner_id, previous_epoch=epoch, new_epoch=uuid4()) for owner_id, epoch in rows
    )


def _rotations_from_journal(raw: dict[str, object]) -> tuple[OwnerEpochRotation, ...]:
    rotations: list[OwnerEpochRotation] = []
    raw_rotations = raw.get("rotations")
    if not isinstance(raw_rotations, list):
        raise RestorePreparationError("restore_journal_invalid")
    for item in raw_rotations:
        if not isinstance(item, dict) or set(item) != {"owner_id", "previous_epoch", "new_epoch"}:
            raise RestorePreparationError("restore_journal_invalid")
        try:
            rotations.append(
                OwnerEpochRotation(
                    owner_id=UUID(item["owner_id"]),
                    previous_epoch=None if item["previous_epoch"] is None else UUID(item["previous_epoch"]),
                    new_epoch=UUID(item["new_epoch"]),
                )
            )
        except TypeError, ValueError, AttributeError:
            raise RestorePreparationError("restore_journal_invalid") from None
    if not rotations or len({item.owner_id for item in rotations}) != len(rotations):
        raise RestorePreparationError("restore_journal_invalid")
    return tuple(rotations)


async def _operation_fingerprint(database) -> tuple[str, int]:
    digest = hashlib.sha256()
    count = 0
    async with database.sessions() as session:
        records = (
            await session.scalars(
                select(RecordedOperation).order_by(
                    RecordedOperation.owner_id,
                    RecordedOperation.operation_id,
                )
            )
        ).all()
        for row in records:
            digest.update(row.owner_id.bytes)
            digest.update(row.operation_id.bytes)
            digest.update(row.request_hash)
            digest.update(hashlib.sha256(row.envelope).digest())
            digest.update(int(row.commit_cursor).to_bytes(8, "big", signed=False))
            digest.update(row.committed_at.isoformat(timespec="milliseconds").encode("ascii"))
            count += 1
    return digest.hexdigest(), count


def _validate_journal_target(raw: dict[str, object], restore_id: UUID, compose_project: str, db_name: str) -> None:
    if (
        raw.get("restore_id") != str(restore_id)
        or raw.get("environment") != "restore"
        or raw.get("compose_project") != compose_project
        or raw.get("db_name") != db_name
    ):
        raise RestorePreparationError("restore_journal_target_mismatch")


def _result_records(results: list[RestoredOwnerResult]) -> list[dict[str, object]]:
    return [
        {
            "owner_id": str(item.owner_id),
            "epoch": str(item.epoch),
            "preserved_operations": item.preserved_operations,
            "preserved_receipts": item.preserved_receipts,
            "preserved_changes": item.preserved_changes,
        }
        for item in results
    ]


async def _prepare(restore_id: UUID, journal_file: Path) -> list[RestoredOwnerResult]:
    environment, compose_project, db_name = _target_identity()
    settings = load_settings()
    if settings.db_name != db_name or settings.app_env != "production":
        raise RestorePreparationError("restore_database_identity_mismatch")
    journal = _read_journal(journal_file)
    database = create_database(settings)
    try:
        if journal is None:
            rotations = await _current_rotations(database)
            source_fingerprint, operation_count = await _operation_fingerprint(database)
            now = datetime.now(timezone.utc)
            journal = {
                "format_version": 1,
                "restore_id": str(restore_id),
                "environment": environment,
                "compose_project": compose_project,
                "db_name": db_name,
                "source_fingerprint_sha256": source_fingerprint,
                "rotations": [
                    {
                        "owner_id": str(item.owner_id),
                        "previous_epoch": None if item.previous_epoch is None else str(item.previous_epoch),
                        "new_epoch": str(item.new_epoch),
                    }
                    for item in rotations
                ],
                "state": "prepared",
                "prepared_at": _safe_utc_text(now),
                "completed_at": None,
                "results": None,
            }
            _write_journal(journal_file, journal)
        else:
            _validate_journal_target(journal, restore_id, compose_project, db_name)
            rotations = _rotations_from_journal(journal)
            source_fingerprint, operation_count = await _operation_fingerprint(database)
            if source_fingerprint != journal["source_fingerprint_sha256"]:
                raise RestorePreparationError("restore_source_fingerprint_mismatch")
            if journal["state"] == "completed":
                results = await prepare_restored_database(
                    database,
                    now=datetime.now(timezone.utc),
                    rotations=rotations,
                )
                if _result_records(results) != journal["results"]:
                    raise RestorePreparationError("restore_completed_journal_mismatch")
                return results
        if journal["state"] != "prepared":
            raise RestorePreparationError("restore_journal_state_invalid")
        source_fingerprint, operation_count = await _operation_fingerprint(database)
        if source_fingerprint != journal["source_fingerprint_sha256"]:
            raise RestorePreparationError("restore_source_fingerprint_mismatch")
        results = await prepare_restored_database(
            database,
            now=datetime.now(timezone.utc),
            rotations=rotations,
        )
        after_fingerprint, after_count = await _operation_fingerprint(database)
        if after_fingerprint != source_fingerprint or after_count != operation_count:
            raise RestorePreparationError("restore_postcondition_failed")
        journal["state"] = "completed"
        journal["completed_at"] = _safe_utc_text(datetime.now(timezone.utc))
        journal["results"] = _result_records(results)
        _write_journal(journal_file, journal)
        return results
    finally:
        await close_database(database)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restore-id", type=UUID, required=True)
    parser.add_argument("--journal-file", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        results = asyncio.run(_prepare(args.restore_id, args.journal_file))
    except RestorePreparationError, RestoreRecoveryError, SettingsError, OSError, ValueError:
        print("restore_preparation_failed", file=sys.stderr)
        return 2
    print(
        json.dumps(
            {
                "status": "restore_prepared",
                "owner_count": len(results),
                "preserved_operations": sum(item.preserved_operations for item in results),
                "preserved_receipts": sum(item.preserved_receipts for item in results),
                "preserved_changes": sum(item.preserved_changes for item in results),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
