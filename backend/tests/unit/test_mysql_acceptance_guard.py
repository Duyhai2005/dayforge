from unittest.mock import MagicMock

from tests import conftest


def test_skip_guard_inactive_without_test_run_id(monkeypatch):
    monkeypatch.delenv("DAYFORGE_TEST_RUN_ID", raising=False)
    conftest._mysql_skipped_tests.clear()

    report = MagicMock()
    report.skipped = True
    report.nodeid = "tests/test_example.py::test_dummy"
    del report.wasxfail

    conftest.pytest_runtest_logreport(report)
    assert len(conftest._mysql_skipped_tests) == 0

    session = MagicMock()
    session.exitstatus = 0
    conftest.pytest_sessionfinish(session, 0)
    assert session.exitstatus == 0


def test_skip_guard_fails_when_test_skipped_under_test_run_id(monkeypatch):
    monkeypatch.setenv("DAYFORGE_TEST_RUN_ID", "a" * 32)
    conftest._mysql_skipped_tests.clear()

    report = MagicMock()
    report.skipped = True
    report.nodeid = "tests/test_example.py::test_dummy"
    delattr(report, "wasxfail")

    conftest.pytest_runtest_logreport(report)
    assert "tests/test_example.py::test_dummy" in conftest._mysql_skipped_tests

    session = MagicMock()
    session.exitstatus = 0
    conftest.pytest_sessionfinish(session, 0)
    assert session.exitstatus == 1

    terminalreporter = MagicMock()
    config = MagicMock()
    conftest.pytest_terminal_summary(terminalreporter, 1, config)
    terminalreporter.write_sep.assert_called_once()
    assert "MySQL acceptance failed" in terminalreporter.write_sep.call_args[0][1]

    conftest._mysql_skipped_tests.clear()


def test_skip_guard_ignores_xfailed_tests(monkeypatch):
    monkeypatch.setenv("DAYFORGE_TEST_RUN_ID", "a" * 32)
    conftest._mysql_skipped_tests.clear()

    report = MagicMock()
    report.skipped = True
    report.wasxfail = "expected failure reason"
    report.nodeid = "tests/test_example.py::test_xfailed"

    conftest.pytest_runtest_logreport(report)
    assert len(conftest._mysql_skipped_tests) == 0

    session = MagicMock()
    session.exitstatus = 0
    conftest.pytest_sessionfinish(session, 0)
    assert session.exitstatus == 0
    conftest._mysql_skipped_tests.clear()
