import importlib.util
from pathlib import Path

from app.models import Base

BACKEND = Path(__file__).resolve().parents[2]


def test_sync_models_register_owner_scoped_event_tables():
    module_path = BACKEND / "app" / "models" / "sync.py"
    assert module_path.is_file()
    expected = {
        "owner_sync_states",
        "recorded_operations",
        "operation_receipts",
        "change_log",
    }
    assert expected <= set(Base.metadata.tables)


def test_sync_migration_follows_auth_lifecycle_hardening():
    migration_path = BACKEND / "migrations" / "versions" / "0004_sync.py"
    assert migration_path.is_file()
    spec = importlib.util.spec_from_file_location("sync_migration", migration_path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    assert migration.revision == "0004_sync"
    assert migration.down_revision == "0003_auth_lifecycle_hardening"
