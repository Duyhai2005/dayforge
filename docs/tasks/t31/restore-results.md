# T31 backup and restore evidence

**Status:** implementation and automated checks are in progress. No production or off-host recovery rehearsal has been run.

## Evidence ledger

| Check | Evidence | Status |
| --- | --- | --- |
| BK-01 dump failure does not publish success | `scripts.tests.test_backup_database.BackupDatabaseTests.test_dump_failure_never_publishes_a_snapshot` | Local unit test passed |
| BK-02 restic upload/repository failure does not advance success | `scripts.tests.test_backup_database.BackupDatabaseTests.test_upload_failure_does_not_advance_last_success` | Local unit test passed |
| BK-03 altered or checksum-mismatched dump is rejected before import | `scripts.tests.test_restore_database.RestoreDatabaseTests.test_rejects_corrupt_dump_before_import_or_installing_keys` | Local unit test passed |
| BK-04 missing KEK version is rejected before import | `scripts.tests.test_restore_database.RestoreDatabaseTests.test_rejects_missing_kek_version_before_import` | Local unit test passed |
| BK-05 production/nonempty restore target is rejected | Restore target and empty database guard unit tests | Local unit tests passed |
| BK-06 recovery transaction rollback preserves source rows | `backend/tests/integration/test_restore_recovery.py::test_recovery_transaction_rolls_back_all_rows_when_caller_aborts` | MySQL integration run pending |
| BK-07 stale backup reports the health code after 26 hours | `scripts/tests/test_host_health.py::HostHealthTests.test_backup_stale_only_when_enabled_and_after_26_hours` | Local unit test passed |
| BK-08 recovery from an independent off-host destination and credential | No external repository, recovery credential, or clean remote target is configured in this workspace | Pending external rehearsal |

The targeted local unit batch currently covers policy validation, repository initialization, backup failure and marker behavior, retention ordering, isolated restore guards, snapshot metadata and checksum checks, and the one-shot recovery launcher. The most recent run had 29 passing tests and 1 platform skip (Windows symlink creation requires Developer Mode). Ruff passed on the changed backup/restore files. The full local `scripts/tests` run had 87 passes, 1 skip, and 1 failure in the unrelated localhost redirect test: this sandbox returned `PermissionError` for its loopback HTTP connection instead of reaching the fixture's 307 response. The Docker-backed source/target rehearsal could not run locally because the Docker Desktop named pipe denied access. CI results will be appended after the pull request checks finish.

## Not measured yet

- Production snapshot ID and destination, repository check result, dataset size, and dump duration.
- Restore download/import/recovery duration and representative-data RTO.
- Snapshot age at recovery and measured RPO.
- Fresh-browser vault decryption and work/milestone rendering through an isolated HTTPS restore origin.
- Old session rejection, old epoch rejection, and fresh bootstrap verification against the restored server history.
- Recovery after complete loss of source VM disks using only separately held restic password and credentials.

Do not report the proposed RPO of 24 hours or RTO of 120 minutes as achieved until these measurements are recorded. Local browser drafts, pending IndexedDB operations, and other data that never reached the server remain outside the backup boundary.
