from app.services import sync


def test_sync_transaction_failpoint_reports_named_stages(monkeypatch):
    observed = []
    monkeypatch.setattr(sync, "_SYNC_WRITE_FAILPOINT", observed.append)

    sync._sync_write_failpoint("after_event_flush")
    sync._sync_write_failpoint("before_commit")

    assert observed == ["after_event_flush", "before_commit"]
