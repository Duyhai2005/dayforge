# T31 — Backup and Restore Implementation Plan

> **Implementation:** Follow the task steps below and track completed work with checkboxes.

**Goal:** Tự động sao lưu dữ liệu đã đồng bộ và khóa cần thiết ra ngoài host, rồi chứng minh phục hồi được vào MySQL sạch và dùng lại bằng ứng dụng.

**Architecture:** Backup job dùng mysqldump consistent InnoDB dưới operation lock chung để tránh DDL/key rotation, đóng gói SQL/metadata/key files trong workspace private rồi ghi snapshot restic mã hóa ngoài VM. Restore mặc định chỉ nhận target environment=restore trống, kiểm tra snapshot/checksum/revision, import DB và chuẩn bị auth/sync recovery trước khi mở app. Disaster restore không thay thế rollback binary và không thể hứa khôi phục outbox chưa rời thiết bị.

**Tech Stack:** MySQL 8.4.13 mysqldump/mysql client, restic pin từ T29, systemd timer, Python ops stdlib, SQLAlchemy transactions, pytest/MySQL và two-browser recovery runner hiện có.

**Spec:** [T31](../README.md), [T03 auth — key custody](../t03/auth-contract.md), [T03 sync — epoch/bootstrap](../t03/sync-contract.md), [recovery T12](../t12/recovery-runbook.md), [T30](../t30/plan.md), [plan tổng](../../superpowers/plans/2026-11-04-group7-deployment-rehearsal.md).

## Global Constraints

- Kế thừa Global Constraints/interfaces trong plan tổng.
- “Bản sao lưu server chỉ có dữ liệu đã đồng bộ.” Không tuyên bố đã backup local IndexedDB/outbox/draft của browser.
- “Khi epoch đổi do restore, giữ toàn bộ union event cũ cùng outbox trong journal phục hồi; rebootstrap không được xóa các event từng được ACK.”
- Không copy nóng /var/lib/mysql làm phương án backup chuẩn; không chạy DDL hoặc key rotation chồng snapshot.
- Đề xuất timer 02:15 Asia/Bangkok, retention 7 daily/4 weekly/3 monthly, RPO≤24h/RTO≤120phút; chỉ coi đạt sau khi đo và đã chốt trong decision.
- SQL, config riêng và keys trong backup là dữ liệu riêng; report public chỉ chứa fingerprint/ID đã che, không raw dump hoặc key.

## Review Focus

- Dump success nhưng restic upload fail/dump pipeline lỗi phải không ghi last-success — fault test.
- Snapshot thiếu KEK/version hoặc repository password không còn ngoài host phải không được gọi là recoverable — key escrow/restore test.
- Fingerprint lấy từ DB đang ghi khác thời điểm dump không được dùng làm bằng chứng snapshot bị hỏng — drill quiesce writer và cùng baseline.
- Restore không được hồi sinh phiên/token/email job cũ hoặc gửi nhầm thư nguồn — preparation test trước API startup.
- Epoch mới phải cập nhật đầy đủ FK/event/receipt/changelog và giữ bytes/hash/ID/time — MySQL transaction rollback/fault test.

---

## Bản đồ file

| File | Trách nhiệm |
| --- | --- |
| scripts/backup_policy.py, deploy/backup-policy.example.json | Tạo policy repository/secret paths/retention/threshold, không credentials trong JSON public |
| scripts/backup_database.py | Tạo dump→private stage→restic→check snapshot→atomic success marker |
| scripts/restore_database.py, scripts/verify_restore.py | Tạo restore guard/import/checksum/fingerprint/app probe |
| scripts/tests/test_backup_policy.py, test_backup_database.py, test_restore_database.py | Unit argv, lock, failure, path và redaction |
| scripts/deploy_tests/test_backup_restore.py | Integration disposable source/clean target và local restic test repository |
| backend/app/services/restore_recovery.py | Tạo transaction chuẩn bị DB restore, giữ event/hash |
| backend/app/cli/prepare_restored_database.py | Tạo CLI nội bộ trong package app/cli đã có từ T30; không HTTP endpoint |
| backend/tests/integration/test_restore_recovery.py | Tạo MySQL FK/rollback/auth invalidation tests |
| deploy/systemd/dayforge-backup@.service, dayforge-backup@.timer | Tạo lịch backup và hardening unit |
| deploy/systemd/dayforge-backup-check@.service, dayforge-backup-check@.timer | Tạo kiểm tra repository/retention ngoài giờ snapshot |
| docs/deployment/backup-restore.md, docs/tasks/t31/restore-results.md | Runbook, custody, số đo/evidence và giới hạn |

## Task T31.1: Backup pipeline và lịch chạy có kiểm chứng

**Files:** Create backup_policy.py/policy example, backup_database.py, unit tests, systemd backup/check units.

**Interfaces:**

- Frozen **BackupPolicy** trong backup_policy.py: repository_file: Path, password_file: Path, credentials_file: Path, workspace_root: Path, keep_daily: int=7, keep_weekly: int=4, keep_monthly: int=3, max_success_age_hours: int=26. **load_backup_policy(path: Path) -> BackupPolicy**, lỗi BackupPolicyError không echo nội dung/path secret.
- **create_backup(config: DeployConfig, release: ReleaseManifest, policy: BackupPolicy) -> BackupResult**; BackupResult fields snapshot_id: str, completed_at: str, dump_sha256: str, source_revision: str. Snapshot chỉ xuất hiện như success sau restic exit0 + snapshot lookup đúng ID/tag/env.
- CLI **python3 scripts/backup_database.py --config <path> --release <release.json> --policy <path>**; dùng operation.lock từ T30. State last-backup.json không có SQL/keys, write atomic.
- Snapshot payload: database.sql.gz; backup-manifest.json format_version1/source environment/release_id/build_id/mysql_version/alembic_revision/start+end UTC/dump SHA256/key_versions; restore-secrets chứa KEK/version và auth signing/encryption keys cần phục hồi; private runtime settings đủ biết OWNER_EMAIL/origin. Không đưa restic password/access credential vào snapshot duy nhất mà nó mở được.

- [ ] **Step 1: Viết failing unit backup.** Fake subprocess/clock/fs ở module test; assert:

~~~python
def test_upload_failure_does_not_advance_last_success(self):
    self.runner.fail('restic-backup')
    self.assertEqual(self.run_backup(), 1)
    self.assertEqual(self.read_success_marker(), self.previous_marker)

def test_dump_failure_never_publishes_a_snapshot(self):
    self.runner.fail('mysqldump')
    self.assertEqual(self.run_backup(), 1)
    self.assertNotIn('restic-backup', self.runner.events)
    self.assertFalse(self.private_workspace_exists())
~~~

Thêm tests mất disk, lock busy, SIGTERM cleanup, symlink workspace ra ngoài root, thiếu KEK/version, stage secrets mode không đúng, restic trả partial/failure, redaction sentinel và retention không xóa snapshot trước khi upload/check thành công. Helpers/fake runner được định nghĩa cùng file.

- [ ] **Step 2: Run đỏ.** `uv run --directory backend --locked python -m unittest discover -s ../scripts/tests -p 'test_backup*.py' -v`. Expected FAIL vì chưa có backup implementation.
- [ ] **Step 3: Implement dump và lock.** mysqldump dùng defaults-extra-file riêng mode0600, đúng thứ tự option-file trước các options khác; flags **--single-transaction --quick --hex-blob --no-tablespaces --set-gtid-purged=OFF --skip-lock-tables** với DB đã validate. Toàn bộ bảng app hiện là InnoDB; check engine và chặn nếu khác. Không dump mysql system schema, CREATE DATABASE hoặc user grants. Cấm migrate/key rotation bằng operation.lock chung; ghi revision trước/sau, fail nếu đổi. DML app vẫn có thể chạy với consistent snapshot; không dùng live cursor query riêng để khẳng định cùng snapshot.
- [ ] **Step 4: Implement staging/restic.** Temp directory0700, SQL gzip0600, chỉ copy keys/runtime config cần phục hồi, sha256 dump, đảm bảo cleanup cả khi lỗi. restic đọc repo/password/credential từ private file/environment process không log. Snapshot tag environment/release và đường stage ổn định tương đối để retention grouping không bị tách thành một group mỗi temp path; dùng một staging root riêng theo environment, lock và cleanup trước/sau, hoặc override grouping thành host+tags có kiểm chứng. Bắt mọi exit code khác0, không coi partial snapshot là success.
- [ ] **Step 5: Lịch và retention.** Timer OnCalendar với timezone Asia/Bangkok đúng02:15, Persistent=true; kiểm tra bằng systemd-analyze calendar, không suy timezone host. Restic forget giữ7daily/4weekly/3monthly chỉ filter đúng env/backup tag, --dry-run trước khi bật. Chạy prune/check riêng hằng tuần, khóa repository không chồng backup. Password khôi phục lưu ở nơi người dùng lấy được khi VM mất hoàn toàn; không chỉ có một copy trên VM hoặc chính repository.
- [ ] **Step 6: Run xanh.** Unit PASS; `systemd-analyze verify` và calendar output đúng ngày/giờ; integration local encrypted repository snapshot tạo được và failure không thay marker. Host thật phải có snapshot **ngoài VM và volume app**, kiểm tra download/check bằng credential khôi phục; local repo chỉ là fixture test. Health T30 báo stale khi last-success>26h.
- [ ] **Step 7: Commit.** Stage pipeline/policy/tests/units; `git commit -m "feat(backup): schedule encrypted off-host database snapshots"`.

## Task T31.2: Restore vào DB sạch và chứng minh mở vault bằng profile mới

**Files:** Create restore_database.py, verify_restore.py, unit/integration tests, backup-restore.md.

**Interfaces:**

- **restore_database(config: DeployConfig, release: ReleaseManifest, policy: BackupPolicy, *, snapshot_id: str) -> RestoreResult**; chỉ environment=restore, project/DB prefix restore, DB trống và volume đích mới. RestoreResult gồm snapshot_id, restored_revision, verified_dump_sha256; chưa đồng nghĩa đã mở app an toàn trước T31.3.
- **verify_restored_database(config: DeployConfig, *, expected_fingerprint: Path) -> RestoreVerification**; fingerprint bao gồm table counts, owner/workspace/local-key IDs và hash envelope canonical sorted theo owner_id/operation_id; loại dữ liệu volatile sẽ được invalidated và epoch dự kiến đổi.
- CLI restore **python3 scripts/restore_database.py --config <restore.json> --release <release.json> --policy <policy.json> --snapshot <id>**; không nhận --force/--overwrite production. CLI verify tương tự với --expected-fingerprint.

- [ ] **Step 1: Viết test đỏ restore guard/key loss.** Assert production/staging target exit2 trước mọi restic/docker/DB call; nonempty target exit2; snapshot tag env không khớp source đã chọn reject; checksum sai hoặc KEK/version thiếu reject. Integration source fixture có tiếng Việt nhiều dòng, plan/color, task, milestone, recurrence/exception/deletion; tất cả đi qua API/sync hợp lệ, không tạo domain rows tưởng tượng.

~~~python
def test_restore_preserves_domain_envelopes_and_owner_key(self):
    source = self.seed_source_and_quiesce_writers()
    snapshot = self.backup_source()
    restored = self.restore_into_empty_target(snapshot)
    self.assertEqual(restored.envelope_hashes, source.envelope_hashes)
    self.assertEqual(restored.owner_local_key_ids, source.owner_local_key_ids)
    self.assertEqual(restored.domain_fingerprint, source.domain_fingerprint)
~~~

Fixture source writer dừng khi lấy baseline và backup để so fingerprint chính xác; test backup concurrency riêng chỉ kiểm tra app invariant sau restore, không so với live head sau dump.

- [ ] **Step 2: Run đỏ.** `uv run --directory backend --locked python -m unittest discover -s ../scripts/tests -p test_restore_database.py -v`; integration `... -s ../scripts/deploy_tests -p test_backup_restore.py -v`. Expected FAIL thiếu restore implementation.
- [ ] **Step 3: Implement download/verify/import.** Restore snapshot ID cụ thể từ repo encrypted vào directory private, verify manifest/tag/checksum/MySQL revision trước import. Dùng MySQL client cùng8.4.13; DB sạch do target provision, import credential target, không tái dùng source DB/root/SMTP password. Không tự migrate latest trước khi biết artifact tương thích revision snapshot; có thể khởi động image tương ứng snapshot hoặc migrate đã được T33 kiểm chứng.
- [ ] **Step 4: Khôi phục crypto custody.** Cài source LOCAL_KEY_KEK_B64 cùng LOCAL_KEY_KEK_VERSION để mở OwnerLocalKey; những key còn lại được bảo toàn hoặc xoay có bước rõ theo T31.3, không regenerate KEK. Chỉ environment restore có quyền sử dụng bản sao này; credential/SMTP target riêng và email worker chưa được bật. Cần source OWNER_EMAIL binding giống DB; đổi origin không đổi owner/key IDs.
- [ ] **Step 5: Chạy integrity trước phục hồi auth/epoch.** SQL counts/FK/reference checks và hash bytes giống baseline. Sau T31.3, mở app qua HTTPS restore origin cô lập và **browser profile sạch**; reset/login verified owner theo kênh khôi phục kiểm soát, lấy /auth/local-key rồi bootstrap/decrypt/render hai lịch. Profile cũ có key trong memory không đủ chứng minh đã restore KEK. Không gửi email job của source ra ngoài.
- [ ] **Step 6: Run xanh và số đo.** Unit+integration PASS; test negative thiếu KEK phải thất bại rõ; lưu snapshot ID, source/dest revision, timings download/import/prepare/app verify, dataset size. Đo RTO từ bắt đầu phục hồi đến hai lịch+sync health đạt; report RPO từ thời điểm snapshot, ghi ngoài phạm vi pending local. Không đánh dấu mục tiêu RTO đạt nếu chỉ thử tiny fixture.
- [ ] **Step 7: Commit.** Stage restore/verify/tests/runbook; `git commit -m "feat(restore): verify clean database and vault key recovery"`.

## Task T31.3: Chuẩn bị auth/sync sau restore mà không mất event

**Files:** Create backend/app/services/restore_recovery.py, app/cli/prepare_restored_database.py, integration/test_restore_recovery.py; Modify restore_database.py/runbook.

**Interfaces:**

- **prepare_restored_owner(session: AsyncSession, owner_id: UUID, *, now: datetime, new_epoch: UUID) -> RestoredOwnerResult**; RestoredOwnerResult frozen dataclass gồm owner_id, previous_epoch, epoch, preserved_operations, preserved_receipts, preserved_changes. Caller sở hữu session.begin(); hàm không commit riêng.
- **OwnerEpochRotation** frozen dataclass gồm owner_id: UUID, previous_epoch: UUID, new_epoch: UUID. **prepare_restored_database(database: Database, *, now: datetime, rotations: Sequence[OwnerEpochRotation]) -> list[RestoredOwnerResult]** xử lý các owner trong một transaction DB restore khi API đang tắt. Nếu current epoch đã bằng new_epoch do retry, kiểm tra auth invalidation và fingerprint rồi trả kết quả, không xoay lần nữa; nếu không bằng previous_epoch/new_epoch thì fail.
- CLI **python -m app.cli.prepare_restored_database --restore-id <uuid> --journal-file <path>** chạy **trong API image**, nhận guard environment=restore từ config ops và DB identity đã kiểm chứng; không expose HTTP hoặc cho worker app gọi. Journal private read-write được mount vào container. Trước production recovery T35/T36 phải dùng runbook mở rộng kiểm soát, không bỏ guard target chỉ để chạy tiện.

- [ ] **Step 1: Viết test MySQL đỏ.** Dùng fixture thật seed event/receipt/changelog hợp lệ, session/token/mail jobs. Assert:

~~~python
def test_epoch_rotation_preserves_original_operation_bytes_and_receipts(migrated):
    before, after = run_restore_preparation(migrated)
    assert before.epoch != after.epoch
    assert after.envelopes == before.envelopes
    assert after.operation_ids == before.operation_ids
    assert after.request_hashes == before.request_hashes
    assert after.commit_cursors == before.commit_cursors
    assert after.head_cursor == before.head_cursor
    assert after.foreign_key_violations == []
~~~

run_restore_preparation được định nghĩa trong test module bằng DB session thật. Test thêm exception giữa bước rotate rollback toàn bộ; retry cùng restore_id không xoay lần nữa; client pull old epoch→409 cursor_epoch_mismatch; retry old operation→duplicate đúng hash; bootstrap epoch mới chứa toàn bộ dump events. Test auth: mọi session cũ bị revoke/auth_version tăng, token cũ invalidated, queued email nguồn bị xóa, KEK/wrapped owner key/password hash không tự đổi.

- [ ] **Step 2: Run đỏ.** `uv run --directory backend --locked python ../scripts/test_backend.py --mysql tests/integration/test_restore_recovery.py -q`; expected FAIL thiếu restore_recovery service, không tắt foreign_key_checks để làm test qua.
- [ ] **Step 3: Implement transaction re-epoch bảo toàn FK.** Với owner lock, đọc và giữ receipt/changelog rows; xóa **child** changelog rồi receipts; đổi epoch trong recorded_operations; insert lại receipts/changelog với cùng IDs/hash/cursor/committed_at và epoch mới; đổi owner_sync_states.epoch, giữ head_cursor. Tất cả là DML trong transaction, không DDL/implicit commit, không sửa envelope/edit-time/request hash, không xóa recorded operation. Plan chọn thuật toán này vì FK composite hiện tại không có ON UPDATE CASCADE; chỉ update owner_sync_states là sai vì bootstrap filter theo epoch.
- [ ] **Step 4: Implement auth invalidation/idempotence.** Trong cùng recovery transaction, revoke sessions, tăng users.auth_version, invalidate email tokens, xóa email_delivery_jobs của snapshot trước khi startup worker. Không đổi owner ID/wrapped vault key hoặc coi mật khẩu hash cũ đã là mật khẩu mới nhất; quy trình thực phải reset mật khẩu qua inbox trong chế độ truy cập hạn chế **trước khi mở lại public login**. Chọn CLI lock + journal file private, không thêm bảng/migration chỉ để ghi lịch diễn tập: trước transaction ghi/fsync restore-id, OwnerEpochRotation entries và pre-restore fingerprint; sau commit ghi atomic completed. Crash sau commit trước completed được nhận diện bằng current epoch=new_epoch và postconditions, không tăng auth_version hoặc xoay epoch lần hai. Crash trước commit vẫn current epoch=previous_epoch và được retry; trạng thái khác fail closed.
- [ ] **Step 5: Gắn vào restore pipeline.** SQL import→integrity→journal new epoch/restore-id→prepare transaction→verify old sessions invalid→start API ở restore origin hạn chế với target SMTP cấu hình riêng. Nếu step fail, không mở edge/app/mail worker; giữ lỗi cố định và log request/run ID. Không khôi phục trực tiếp dump vào DB đang phục vụ người dùng.
- [ ] **Step 6: Run xanh hồi quy.** Chạy test MySQL trên và `pnpm test:api:mysql`; `pnpm test:sync:browser` vẫn PASS. Kiểm tra fresh-browser T31.2 và old-epoch API tests; recovery union ACK+pending cùng origin sẽ được diễn tập T33.4 trên staging, không suy từ test reset epoch xóa event của runner cũ.
- [ ] **Step 7: Commit.** Stage service/CLI/integration và scripts/runbook; `git commit -m "feat(restore): preserve sync history while rotating restored epochs"`.

## Task T31.4: Diễn tập off-host và đóng runbook khôi phục

**Files:** Modify backup-restore.md; Create docs/tasks/t31/restore-results.md; Extend integration fault tests.

**Interfaces:**

- Consumes BackupResult/RestoreResult và CLI T31.1–3; không tạo API mới.
- Produces evidence BK-01..BK-08 và hướng dẫn dùng khi mất VM, thiếu secret, repo lỗi hoặc thiết bị còn pending.

- [ ] **Step 1: Thêm failing fault assertions.** BK-01 dump fail không success; BK-02 repo offline không success; BK-03 snapshot corrupt reject; BK-04 key thiếu fail trước mở app; BK-05 restore target nonempty/production reject; BK-06 recovery transaction fail rollback; BK-07 timer stale hiện health warning; BK-08 off-host recovery bằng credential ngoài host. Mỗi case có assert trong unit/integration hoặc procedure kỳ vọng cụ thể ở report.
- [ ] **Step 2: Run đỏ cho fault chưa hỗ trợ.** Chạy unit backup/restore/policy và integration backup_restore; expected các case mới fail ở điều kiện chưa xử lý, không chạy lỗi trên data thật.
- [ ] **Step 3: Hoàn thiện xử lý và custody runbook.** Ghi đường lấy restic password khi VM mất, lấy image/manifest cũ, dựng DB sạch, import/prepare, password reset hạn chế, app verify, mở lại mạng và kiểm tra client recovery. Report outbox trên thiết bị không online chưa được backup; không yêu cầu Clear site data/IndexedDB để phục hồi.
- [ ] **Step 4: Diễn tập từ tài nguyên ngoài host.** Tạo snapshot staging có dữ liệu đại diện; từ target restore sạch tải về bằng recovery credentials ngoài nguồn, không mount volume/secret nguồn để test. Nếu chỉ cùng VM thì bổ sung ca bỏ toàn bộ source filesystem access trong container/VM restore và ghi giới hạn; mục tiêu disaster VM loss chỉ PASS khi thực sự không cần nguồn.
- [ ] **Step 5: Run xanh và chốt số đo.** Check snapshot/check/restore/app verify, RPO/RTO theo dataset và bandwidth thật; timer/cảnh báo đã test. Lưu evidence đã che và mọi limitation. T31 không PASS nếu chỉ tạo được file .sql hoặc repository local cùng đĩa MySQL.
- [ ] **Step 6: Commit.** `git add docs/deployment/backup-restore.md docs/tasks/t31/restore-results.md scripts/tests scripts/deploy_tests`; `git commit -m "test(backup): rehearse off-host restoration and failure recovery"`.

## Cổng hoàn tất T31

- [ ] Tự động backup ngoài host theo policy, retention/check có kiểm chứng và password lấy được khi host mất.
- [ ] Restore DB sạch chứa tiếng Việt/plan/task/milestone/recurrence; profile mới mở được vault bằng KEK được phục hồi.
- [ ] Auth cũ vô hiệu, không replay email nguồn, epoch mới giữ nguyên event/hash/receipt/cursor và transaction rollback an toàn.
- [ ] Chốt RPO/RTO bằng số đo, báo rõ phần local chưa gửi ngoài phạm vi backup server.
- [ ] Runbook và evidence BK-01..08 đủ; T33 dùng snapshot/CLI này để diễn tập cùng origin.

Nguồn: [mysqldump 8.4 — single transaction và giới hạn DDL](https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html), [restic repository/password](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html), [backup](https://restic.readthedocs.io/en/stable/040_backup.html), [retention](https://restic.readthedocs.io/en/stable/060_forget.html), [restore](https://restic.readthedocs.io/en/stable/050_restore.html).
