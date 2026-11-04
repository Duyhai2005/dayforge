# T33 — Upgrade and Rollback Rehearsal Implementation Plan

> **Implementation:** Follow the task steps below and track completed work with checkboxes.

**Goal:** Chứng minh nâng cấp, cập nhật local schema/service worker, rollback tương thích và disaster recovery giữ dữ liệu đã đồng bộ cùng pending/draft chưa gửi.

**Architecture:** Dùng hai image release A/B và cùng origin/browser profile để kiểm tra vòng đời thật; compatibility validator chặn image/schema/protocol không hỗ trợ trước activation. Binary rollback giữ MySQL hiện tại, chỉ được chạy khi manifest và readiness chứng minh tương thích; migration lỗi hoặc không tương thích đi theo roll-forward đã kiểm thử. Disaster restore chạy riêng trên installation rehearsal cô lập, khôi phục snapshot cũ với epoch mới rồi kiểm tra union event ACK+pending từ hai thiết bị.

**Tech Stack:** T29 immutable images, T30 deploy/maintenance script, T31 backup/restore, T32 staging runner, Alembic/MySQL8.4, IndexedDB version1→2, Service Worker/build gate, Playwright và real two-browser/MySQL sync.

**Spec:** [T33](../README.md), [T03 version/epoch](../t03/sync-contract.md), [T13 offline/update runbook](../t13/offline-update-runbook.md), [T12 recovery](../t12/recovery-runbook.md), [AC-19–30/33–35](../../project-definition/06-delivery-and-acceptance.md), [T31](../t31/plan.md), [T32](../t32/plan.md), [plan tổng](../../superpowers/plans/2026-11-04-group7-deployment-rehearsal.md).

## Global Constraints

- Kế thừa Global Constraints/manifest/config/CLI/evidence của plan tổng.
- “Rollback phải tương thích dữ liệu, không mặc định restore backup cũ.”
- “Migration IndexedDB giữ journal/outbox nguyên tử; triển khai server phải tiếp nhận authored v1 trong phạm vi hỗ trợ đã công bố.”
- “Mất response sau commit là trạng thái chưa biết: retry cùng envelope, không tạo operation thay thế.”
- Không Clear site data/xóa IndexedDB/ép skipWaiting/bỏ bản nhập để đạt test. Không dùng automatic full-reload vượt gate T13.
- MySQL DDL có thể commit một phần; không coi Alembic transaction exception là toàn bộ DDL đã rollback.
- Bản A/B phải là build phân biệt, test ở đúng digest; không gắn nhãn A/B khác nhau cho cùng một image ID.

## Review Focus

- App A readiness đang yêu cầu đúng packaged Alembic head; rollback A lên schema B mới không tự hợp lệ dù “chỉ thêm cột” — compatibility rejection test.
- Client cũ giữ draft/pending trong tab suspend hoặc request Flight đang bay không được hard-reload — A/B same-profile test.
- B đã ghi thêm dữ liệu thì rollback A phải giữ các operation mới; không restore snapshot trước deploy — persistence test.
- Restore snapshot trước một event đã ACK phải được epoch recovery reupload từ shadow, không chỉ gửi active outbox — two-device union test.
- Chạy thử migration phải dùng revision/schema thực hoặc fixture cô lập; không đẩy migration giả lên sản phẩm chỉ để có ca test — fixture packaging gate.

---

## Bản đồ file

| File | Trách nhiệm |
| --- | --- |
| scripts/check_release_compatibility.py | Tạo manifest/runtime compatibility validator |
| scripts/rehearse_release.py | Tạo orchestration staging/rehearsal, lock, checkpoints và fault hooks có guard |
| scripts/tests/test_release_compatibility.py, test_rehearse_release.py | Tạo unit matrix/guard/activation failure tests |
| scripts/validate_rehearsal_results.py, scripts/tests/test_rehearsal_results.py | Tạo validator coverage/provenance cho report10case |
| scripts/deploy_release.py | Mở rộng admission check, --rollback, --skip-migration chỉ khi tương thích; không restore ngầm |
| deploy/compose.app.yaml, deploy/Caddyfile | Mở rộng web_previous/static fallback và maintenance/switch đã kiểm tra |
| frontend/playwright.release.config.ts | Tạo suite tests/release, SW allow, origin persistent, không local webServer |
| frontend/tests/release/fixtures.ts | Build/runtime switching + pending metadata helpers + network fault không mock receipt |
| frontend/tests/release/update.spec.ts, rollback.spec.ts, restore.spec.ts | Tạo A/B, rollback và ACK+pending recovery |
| frontend/playwright.config.ts, playwright.production.config.ts, playwright.staging.config.ts; scripts/check-playwright-discovery.cjs | Cập nhật suite isolation |
| scripts/deploy_tests/test_migration_rehearsal.py | Tạo Alembic historical/interrupted migration trên disposable DB |
| backend/tests/integration/test_restore_recovery.py | Mở rộng integrity khi data sau snapshot được reupload |
| scripts/test-offline-update.cjs | Chỉ reuse helper/intent; không làm runner mutate source .next khi test target |
| frontend/lib/storage/vault.ts, migration.ts; components/offline/offline-bootstrap.tsx; public/sw.js | Chỉ sửa nếu rehearsal tìm defect; không bump schema/rewrite gate vô cớ |
| backend/app/services/readiness.py | Chỉ sửa khi có cặp revision thực sự cần mở hỗ trợ và có compatibility test; hiện tại giữ exact head là mặc định |
| docs/deployment/upgrade-rollback.md, docs/tasks/t33/rehearsal-results.md, compatibility-matrix.json | Tạo runbook, matrix và evidence |

## Task T33.1: Admission check theo schema/protocol thực

**Files:** Create compatibility validator/unit/matrix; Modify deploy_release.py.

**Interfaces:**

- Frozen **RuntimeCompatibility**: db_revision: str, indexeddb_schema_version: int, protocol_version: int, reducer_version: int.
- **check_release_compatibility(release: ReleaseManifest, runtime: RuntimeCompatibility) -> CompatibilityDecision**; CompatibilityDecision fields allowed: bool, reasons: tuple[str,...]. Reason codes db_revision_unsupported, local_schema_unsupported, protocol_unsupported, reducer_unsupported. Không override bằng --force.
- CLI **python3 scripts/check_release_compatibility.py --release <path> --runtime <json>**; exit2 khi không tương thích.
- Runtime DB revision lấy từ DB hiện tại bằng admin/read-only probe, không tin current-release.json sau migrate lỗi. Local schema là giá trị profile test quan sát; host không thể biết hết browser offline nên manifest công bố support và browser gate phải tự kiểm tra.

- [ ] **Step 1: Viết failing tests bảng tương thích.** Fixture release A/B thật baseline0004_sync/schema2/protocol1/reducer1; tương lai chỉ fixture:

| Client | API | DB/local | Kết quả bắt buộc |
| --- | --- | --- | --- |
| A v1 | B nhận v1 |0004_sync/2|sync pending cũ được nhận|
| B v1 | A nhận v1 |0004_sync/2|rollback giữ dữ liệu mới|
| A | A chỉ hỗ trợ0004_sync |0005_rehearsal/2|reject rollback trước activation|
| A max local2 | A |0004_sync/3 fixture|giữ DB/queue, báo unsupported/update; không downgrade|
| v2 fixture | API chỉv1 |0004_sync/2|client_update_required, giữ queue|
| v1 reducer2 fixture | API reducer1 |0004_sync/2|reject replay/push, giữ original envelope|

~~~python
def test_rejects_rollback_onto_unadvertised_schema(self):
    decision = check_release_compatibility(self.release_a,
        RuntimeCompatibility('0005_rehearsal', 2, 1, 1))
    self.assertFalse(decision.allowed)
    self.assertIn('db_revision_unsupported', decision.reasons)
    self.assertEqual(self.activation_calls, [])
~~~

Thêm unit deployment fail-before-pull/start; current runtime inspection lỗi thì fail closed; user-supplied manifest không chứng minh runtime đã hỗ trợ version nếu packaged readiness vẫn reject.

- [ ] **Step 2: Run đỏ.** `uv run --directory backend --locked python -m unittest discover -s ../scripts/tests -p test_release_compatibility.py -v`; expected FAIL chưa validator.
- [ ] **Step 3: Implement validator.** Compare set membership đúng manifest T29; không mặc định revision A≤B là tương thích, không wildcard schema. Separate **upgrade** yêu cầu migrator đi từ actual revision tới packaged head và có preflight path; **rollback --skip-migration** chỉ khi actual revision đã nằm trong target supported set. Nếu có additive migration thật cần A bridge, phải build image A-compatible với readiness allowlist tường minh và test trước; không sửa release.json cũ để tuyên bố A cũ hỗ trợ.
- [ ] **Step 4: Wire deploy admission.** --rollback chọn manifest/digest cũ, backup current DB trước switch, không gọi alembic downgrade/restore_database. Nếu incompatible giữ current healthy B hoặc maintenance khi DB đã lỗi và đi roll-forward; không tự hạ schema. Chặn protocol/reducer không hỗ trợ từ client bằng behavior T03, giữ pending.
- [ ] **Step 5: Run xanh.** Unit compatibility/deploy PASS; MySQL test actual /health exact head vẫn đúng. Baseline A/B cùng0004_sync không cần mở readiness. Negative0005 fixture không nằm trong image/release production.
- [ ] **Step 6: Commit.** Stage validator/unit/deploy changes/matrix; `git commit -m "feat(release): gate activation on explicit data compatibility"`.

## Task T33.2: Cập nhật A→B qua SW khi còn draft/pending/tab cũ

**Files:** Create release Playwright config/fixtures/update spec/rehearsal CLI; Modify Compose/Caddy static retention; conditional fixes trong offline code nếu test phát hiện.

**Interfaces:**

- CLI **python3 scripts/rehearse_release.py --config <staging-or-restore.json> --from <A.json> --to <B.json> --scenario update --output <dir>**. Refuse production, mock/harness flags và origin khác profile đã ghi.
- fixtures.ts **capturePendingMetadata(page: Page): Promise<{operationIds: string[]; ciphertextHashes: string[]}>**, **switchRelease(release: 'A'|'B'): Promise<void>**, **holdNextPushResponse(page: Page): Promise<{release(): Promise<void>}>**. Capture dùng IndexedDB read-only và SHA256 ciphertext; compare canonical request bytes khi network push xuất hiện. Không decrypt/log draft/key để chứng minh retention.
- web_previous chạy image A cùng app network, proxy API tới **API current**, không chạy API A/worker A song song. Edge /_next/static/* thử current rồi previous khi404, giữ X-Dayforge-Build từ upstream thực, không đổi marker A thànhB. HTML/Flight vẫn qua gate hiện tại; không phục vụ cached private data từ edge.
- Giữ web_previous trong cửa sổ rollback **7 ngày** đề xuất; trước xóa phải đã backup/giữ image+manifest A và public asset invariant pass. Protocol/reducer v1 authored cũ vẫn hỗ trợ, không lấy7ngày asset window làm thời hạn mất quyền sync.

- [ ] **Step 1: Viết failing update cases.** Các test tên: dirtyDraftDefersBuildSwitch, pendingCiphertextSurvivesBuildSwitch, lostPushAckRetriesOriginalEnvelope, suspendedTabDoesNotConsentToUpdate, incompleteAssetsKeepApprovedBuild, lateFlightDoesNotMixBuilds, previousStaticAssetsRemainReachable.

~~~typescript
expect(await capturePendingMetadata(page)).toEqual(pendingBeforeSwitch);
expect(await readGatePhase(page)).toBe('preparing');
expect(await currentApprovedBuild(page)).toBe(releaseA.build_id);
await resolveDraftAndAcceptUpdate(page);
await expect.poll(() => currentApprovedBuild(page)).toBe(releaseB.build_id);
expect(retriedPushBytes).toEqual(originalPushBytes);
expect(serverOperationCountForId).toBe(1);
~~~

readGatePhase/currentApprovedBuild/resolveDraftAndAcceptUpdate thuộc fixture/module UI helpers, dùng DB/build gate thực và thao tác sản phẩm; no skipped assertions. Thêm storage quota trong journal/migration và image B asset404 fault chỉ trên test proxy có guard; không dùng Cache Storage quota thay IndexedDB quota.

- [ ] **Step 2: Run đỏ.** `pnpm --filter @dayforge/frontend exec playwright test --config=playwright.release.config.ts --grep "dirtyDraft|pendingCiphertext|previousStatic"` với private config A/B và same HTTPS origin. Expected FAIL thiếu runner/retention hoặc defect integration; nếu host thiếu ghi BLOCKED.
- [ ] **Step 3: Implement runner và giữ A/B độc lập.** Build A/B riêng bằng T29, build_id khác và digest khác; A là baseline chức năng trước thay đổi cuối hoặc cùng source với build metadata khác để test SW, record rõ trường hợp không có code migration mới. Dùng persistent context/profile cùng origin, không copy/reset IndexedDB giữa A/B; checkpoint state_dir/rehearsal/<runid>.json chỉ metadata. Không gọi script T13 hiện đang rename .next source trong target test.
- [ ] **Step 4: Implement static retention/gate fixes tối thiểu.** Compose web_previous và Caddy fallback chỉ public static; shared API route current, callback/auth vẫn network-only/no-store. Gate chờ flush writer và draft handling trước switch; client không phản hồi không tính đồng ý. Nếu tests mới đã PASS với gate hiện tại thì giữ code storage/SW, chỉ thêm integration coverage/topology; không thêm schema3 thật hoặc Next hard reload.
- [ ] **Step 5: Chạy A→B fault scenarios.** A chuẩn bị cả2route/SW; A offline tạo pending và draft chưa lưu, giữ push sau server commit, B deploy khi tab khác suspend, reconnect/update; operation ID/hash/time gốc không đổi, receipt duplicate một effect, B nhận payload đầy đủ. B assets thiếu/quota install fail thì A tiếp tục dùng, không delete A cache. Flight B trễ khi approvedA phải409/document-navigation hoặc fallback gate đúng, không mix module.
- [ ] **Step 6: Run xanh.** Release update suite PASS + `pnpm test:web:offline` + `pnpm test:web:offline:update` + `pnpm test:sync:browser`. Image candidate không chứa test routes/harness dù fixture test có fault proxy ngoài image. Ghi gate/build states, IDs/hashes đã che và current/previous asset HTTP200 theo marker thực.
- [ ] **Step 7: Commit.** Stage runner/spec/topology/minimal fixes/docs; `git commit -m "test(release): preserve local edits across real build switches"`.

## Task T33.3: MySQL/IndexedDB migration, binary rollback và roll-forward

**Files:** Create rollback.spec.ts, deploy_tests/test_migration_rehearsal.py; Modify deploy_release.py/rehearse_release.py/upgrade runbook.

**Interfaces:**

- Rehearsal CLI scenario **rollback**: A→B→writeB→A --rollback --skip-migration→verify; return report includes same DB volume identity and semantic operation set before/after.
- Scenario **migration** chỉ dùng DB disposable và image fixture ngoài production: MySQL historical **0003_auth_lifecycle_hardening→0004_sync**; IndexedDB **1→2** theo source hiện tại; unsupported revision0005/schema3 chỉ test fixture không đóng gói.
- Không tạo support matrix giả cho API reducer2; baseline protocol/reducer1 tương thích hai chiều, unknown-version negative test chứng minh safe stop.

- [ ] **Step 1: Viết failing rollback/migration tests.** Test A reads B-written task/note/recurrence after rollback; DB volume/owner ID/event hashes unchanged; alembic downgrade/restore không được gọi. Thêm migration1→2 owner auth_state giữ ciphertext/drafts/outbox, versionchange blocked/resume, crash sau commit trước approve và future schema reject không delete stores.

~~~typescript
const beforeRollback = await readDomainAndPendingFingerprints(page);
await switchRelease('A');
expect(await readDomainAndPendingFingerprints(page)).toEqual(beforeRollback);
expect(await serverHasOperation(bWrittenOperationId)).toBe(true);
expect(await currentDbRevision()).toBe('0004_sync');
~~~

Helpers thuộc release/fixtures.ts; do schema baseline không đổi, test negative riêng dùng DB fixture revision khác và assert no activation. Migration MySQL test inject fail sau create_table đầu của0004, assert Alembic revision vẫn0003 nhưng DDL có thể tồn tại; readiness503 và writer không start.

- [ ] **Step 2: Run đỏ.** Release rollback suite và `uv run --directory backend --locked python -m unittest discover -s ../scripts/deploy_tests -p test_migration_rehearsal.py -v`. Expected FAIL trước khi có harness/guards, không chạy downgrade trên staging chính hoặc production.
- [ ] **Step 3: Implement migration fixtures/repair procedure.** Historical source migrations chạy trên DB mới; interruption fixture copy migration source vào temporary script_location và fault hook ở test, không sửa migration production đã phát hành. Ghi rõ MySQL DDL partial state: sau lỗi giữ maintenance, inspect actual schema+alembic version, chọn sửa tiến đã test hoặc restore **vào DB sạch riêng** rồi tiến lại khi chưa có postbackup writes. Không tự rerun một migration create_table đã chạy nửa chừng và không giả định rollback DDL.
- [ ] **Step 4: Diễn tập binary rollback tương thích.** Prechange backup B data, admission A chấp nhận actual0004/protocol1/reducer1/local2, giữ MySQL volume và keys, stop B writer ngắn, start API A/web A rồi smoke; task/note được B tạo và client pending còn nguyên. current-release pointer chỉ đổi sau health+build check; thử health fail giữa switch và quy trình quay về image B khỏe.
- [ ] **Step 5: Diễn tập rollback bị từ chối và roll-forward.** Fixture schema0005_rehearsal không nằm trong A supported set: command exit2 trước activation và vẫn giữ B nếu B khỏe. Với migration partial/readiness fail, chạy quy trình roll-forward đã kiểm thử trên DB fixture; nếu cần rollback schema thật phải có migration ngược được chứng minh không mất data hoặc phương án chuyển đổi riêng, không lấy backup cũ đè dữ liệu mới. Current product không cần downgrade schema để kết thúc T33.
- [ ] **Step 6: Run xanh và chốt matrix.** MySQL historical/partial, IndexedDB1→2/future-reject, clientA/APIB và clientB/APIA, B-write→A-read đều PASS. Required CI/source parity suites PASS. Không declare binary rollback supported cho revision chỉ có dự đoán lý thuyết.
- [ ] **Step 7: Commit.** Stage rollback/migration tests/deploy changes/runbook; `git commit -m "test(release): rehearse compatible rollback and failed migrations"`.

## Task T33.4: Restore snapshot cũ với ACK shadow và outbox còn sống

**Files:** Create release/restore.spec.ts; Extend restore_recovery integration; Modify rehearse_release.py/runbook.

**Interfaces:**

- Scenario **restore** dùng một installation environment=restore/project dayforge-restore-<runid>/origin rehearsal riêng đã chốt. Trước và sau restore giữ **cùng origin và hai browser profiles**, không dùng origin source production/staging đang phục vụ.
- T31 restore_database mặc định đích trống. Rehearsal dừng stack nguồn test, giữ nguyên volume nguồn làm evidence, tạo target restore **project/DB/volume mới** sau snapshot, dùng cùng rehearsal origin chỉ khi stack cũ đã dừng; isolation validator nhận active configs sau khi dừng nguồn. Không cần nới guard để import vào staging/production đang dùng.
- T31 prepare_restored_database xoay epoch, vô hiệu auth/token/jobs; password reset/relogin đúng owner trong chế độ origin hạn chế trước public. Source owner/key identity phải giữ.

- [ ] **Step 1: Viết failing recovery-union test.** Gắn IDs E0/E1/E2/P0 có vai trò rõ:

1. E0 được commit trước snapshot S, cảA/B đã pull.
2. E1 được server ACK **sau S**, chỉ còn recorded shadow củaA, active outbox đã rỗng.
3. E2 được ACK sauS chỉ có shadow củaB; P0 là pending offline chưa gửi củaA, cùng một draft tiếng Việt chưa lưu.
4. Restore S vào DB sạch/new epoch, chưa reconnect client để xác nhận server chỉ cóE0.
5. Đăng nhập đúng owner và reconnectA/B theo thứ tự đảo, có một push response bị mất.

~~~typescript
expect(restoredServerIdsBeforeReconnect).toEqual([e0]);
await reconnectBothOwners();
expect(await sortedServerOperationIds()).toEqual([e0, e1, e2, p0].sort());
expect(await domainHash(deviceA)).toBe(await domainHash(deviceB));
expect(await encryptedDraftHash(deviceA)).toBe(draftHashBeforeRestore);
expect(await pendingCount(deviceA)).toBe(0);
expect(await recoveryJournalExists(deviceA)).toBe(false);
~~~

Helpers là release fixture đọc IDs/hash không secret; sorted IDs lọc dataset prefix để không đếm auth fixture hoặc operation khác. Assert original bytes/edit-time/hash không đổi cho E1/E2/P0, duplicate chỉ một effect, không lost E1 vì nó đã ACK.

- [ ] **Step 2: Run đỏ.** Release restore suite với T31 snapshot/keys và isolated rehearsal origin; expected FAIL nếu epoch không đổi hoặc union chỉ lấy active outbox. Không dùng runner test cũ vốn xóa toàn bộ event để giả restore làm bằng chứng snapshot thật.
- [ ] **Step 3: Implement orchestration checkpoint.** Snapshot/source fingerprints→suspend clients/stop source API+mail→new empty restore target→T31 import/check/prepare→check serverE0 only→start restricted origin→reset/relogin→reconnect. Record snapshot ID/old+new epoch/release/digests/operation IDs, không ciphertext/key plaintext vào report public. Giữ old volume đến khi evidence xong; cleanup chỉ đúng project/run path đã resolve và sau verify.
- [ ] **Step 4: Thêm failure-resume cases.** Abort journal persist/bootstrap staging/publish transaction do quota ở boundary thực rồi reload: active generation/cursor/outbox không mất; resume hội tụ. Một tab chết sau server commit trước ACK retry nguyên body; nếu epoch lại đổi giữa recovery, journal union vẫn giữE1/E2. UI không báo synced khi recovery chưa complete. Không sửa wall clock OS production để tạo fault.
- [ ] **Step 5: Run xanh.** T31 MySQL recovery tests + two-browser release restore PASS; kiểm tra profile sạch vẫn mở vault từ backup key, còn profile cũ giữ draft. Với những thiết bị không bao giờ reconnect sau disaster, dữ liệu chỉ có trên chúng không thể được hứa khôi phục; report ghi giới hạn này và cảnh báo không xóa site data.
- [ ] **Step 6: Commit.** Stage restore rehearsal/spec/integration/docs; `git commit -m "test(recovery): restore acknowledged and pending edits after snapshot loss"`.

## Task T33.5: Runbook phát hành và bằng chứng sẵn sàng bàn giao

**Files:** Create scripts/validate_rehearsal_results.py, scripts/tests/test_rehearsal_results.py; Finalize upgrade-rollback.md, rehearsal-results.md, compatibility-matrix.json; update docs/tasks/README.md links sau execution.

**Interfaces:**

- Matrix rows có release A/B SHA/digest/build/schema/protocol/reducer, scenario, expected_action, actual_status, evidence. Report case IDs **UP-01 dirty draft, UP-02 pending/lost ACK, UP-03 suspend/Flight, UP-04 asset/quota, UP-05 MySQL migration, UP-06 IDB migration, RB-01 compatible rollback, RB-02 incompatible blocked, RF-01 roll-forward, DR-01 restore union**.
- **validate_rehearsal_results(path: Path, from_release: ReleaseManifest, to_release: ReleaseManifest) -> list[str]** trả issue codes; CLI nhận --results/--from/--to, exit1 nếu thiếu/fail case hoặc evidence sai SHA/digest, exit0 in “10 rehearsal cases verified”.
- Bàn giao T34/T35/T36 gồm current/previous manifest, snapshot và recovery custody reference, commands, measured maintenance duration, support window và production rechecks.

- [ ] **Step 1: Viết test đỏ report coverage.** Trong test_rehearsal_results.py tạo fixtures JSON local đủ10case; assert thiếuDR-01/duplicateUP-01/wrong digest/no evidence/missing backup ID choDR-01 đều trả issue; đủ10case đúng metadata trả[]. Mỗi PASS có same-profile/same-origin evidence ở ca liên quan, không viết test phản chiếu văn xuôi runbook.
- [ ] **Step 2: Run đỏ.** `uv run --directory backend --locked python -m unittest discover -s ../scripts/tests -p test_rehearsal_results.py -v`; expected FAIL thiếu validator. Sau khi có validator, report thiếu evidence phải vẫn exit1, không auto fill PASS.
- [ ] **Step 3: Implement validator và hoàn thiện runbook.** Định nghĩa JSON envelope from_release_id/to_release_id/cases; mỗi case có case_id/status/evidence_paths/from_digest/to_digest/same_origin/same_profile và snapshot_id bắt buộc choDR-01. Dùng signature ở Interfaces, validate path evidence tồn tại. Runbook có nhánh rõ: health fail trước migrate→giữ A; migration fail/partial→maintenance+triage+roll-forward; B healthy nhưng lỗi UI→compatible binary rollback; rollback incompatible→giữB/roll-forward; mất DB→disaster restore+new epoch+client recovery. Ghi ai giữ khóa/recovery credential và cách kiểm tra restored password/session, không đưa credential vào doc.
- [ ] **Step 4: Run xanh và final gates đúng candidate cuối.** Chạy lại unit validator; `python3 scripts/validate_rehearsal_results.py --results <rehearsal.json> --from <A.json> --to <B.json>` expected “10 rehearsal cases verified”, exit0. Required CI, package smoke, staging smoke/auth/cache/offline và10case rehearsal có bằng chứng. Nếu rehearsal sửa code runtime, tạo candidateB mới, re-run affected suites và các gate cơ bản ở digest mới; không dùng report digest cũ. Không lặp full suite không liên quan nếu không có code mới hoặc concern chưa giải quyết.
- [ ] **Step 5: Cập nhật status/bàn giao.** T33 chỉxong khi mọicase bắt buộc PASS và ghi thời gian downtime/RPO/RTO thật; T34 tổng hợp checklist, T35 phát hành production, T36 xác nhận real inbox/PC-off/38AC production. Viết runbook trước không đồng nghĩa đã diễn tập.
- [ ] **Step 6: Commit.** `git add scripts/validate_rehearsal_results.py scripts/tests/test_rehearsal_results.py docs/deployment/upgrade-rollback.md docs/tasks/t33 docs/tasks/README.md`; `git commit -m "docs(release): record upgrade rollback and recovery rehearsal"`.

## Cổng hoàn tất T33 và nhóm 7

- [ ] A/B chuyển build cùng origin giữ draft/pending/hash, dirty/suspend/lost ACK/quota/Flight không mất dữ liệu.
- [ ] MigrationMySQL/IndexedDB thành công và interrupted recovery đã thử; future version fail an toàn.
- [ ] Rollback tương thích giữ data B; rollback không tương thích bị chặn; roll-forward có evidence.
- [ ] Snapshot thật phục hồi vào DB sạch/new epoch, hai profiles reupload ACKshadow+pending hội tụ.
- [ ] Mười case report PASS đúng candidate; tài liệu/evidence/keys custody đủ để T34 hoàn thiện phát hành. Production chưa được triển khai bởi plan này.

Nguồn đối chiếu: [Next self-hosting/version skew](https://nextjs.org/docs/app/guides/self-hosting), [deploymentId hard navigation](https://nextjs.org/docs/app/api-reference/config/next-config-js/deploymentId), [MySQL8.4 backup/DDL constraints](https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html), [restic restore](https://restic.readthedocs.io/en/stable/050_restore.html). Không bật deploymentId tự động chỉ vì framework hỗ trợ; phải bảo toàn gate T13 đã có.
