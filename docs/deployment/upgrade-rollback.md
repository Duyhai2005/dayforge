# T33 upgrade, rollback và recovery runbook

Runbook này điều phối rehearsal trên một staging/restore target đã được phê duyệt. Nó không tự tạo cloud resource, DNS, SMTP account hay budget. Mọi file config, owner credential, compatibility manifest, output, persistent browser profile và evidence phải ở thư mục riêng ngoài repository.

## Chuẩn bị

1. Có release manifests A/B được build và khóa digest. Hai manifest phải cùng platform và MySQL image digest, có release/build ID khác nhau, web/API digest khác nhau, `test_harness: false`.
2. Tạo config runtime staging hoặc restore đã tách project, database, secrets, state, subnet và HTTPS origin. Script rehearsal từ chối `environment=production`.
3. Tạo owner credential JSON đúng schema `{"owner_email":"...","owner_password":"..."}` và runtime compatibility JSON đọc từ target thật. Không ghi password/token/secret vào command line, report hay evidence.
4. Chọn một output root ngoài checkout, giới hạn quyền đọc. Dùng đúng output root đó cho các scenario A/B cùng candidate để suite có thể gom evidence. Không dùng thư mục output cho candidate khác.
5. Với backup/restore, chuẩn bị T31 backup policy, snapshot ID 64 ký tự hex và `source_environment=staging` hoặc `production`. Restore target phải dùng owner/key version tương thích snapshot; origin rehearsal phải khác origin ghi trong snapshot.

## A→B update, rollback và migration

Deploy A vào target staging/restore qua `scripts/deploy_release.py`, rồi chạy suite update để kiểm tra service worker, pending/draft, lost ACK, frozen tab, asset fallback và Flight response:

```powershell
python scripts/rehearse_release.py `
  --config <target.json> `
  --from <release-A.json> `
  --to <release-B.json> `
  --scenario update `
  --output <private-run-root> `
  --credentials <owner-credentials.json> `
  --runtime <runtime-compatibility.json>
```

Rollback suite chuyển B, ghi task bằng B, admission-check rollback về A mà không downgrade schema/restore backup, rồi kiểm tra dữ liệu B qua profile mới:

```powershell
python scripts/rehearse_release.py `
  --config <target.json> `
  --from <release-A.json> `
  --to <release-B.json> `
  --scenario rollback `
  --output <private-run-root> `
  --credentials <owner-credentials.json> `
  --runtime <runtime-compatibility.json>
```

Migration/partial-DDL fixture chạy MySQL test runner cô lập. Nó chứng minh readiness vẫn fail sau interrupted DDL, sau đó chỉ trên DB disposable xóa orphan đã xác minh, replay migration tiến và readiness lên `0004_sync`:

```powershell
python scripts/rehearse_release.py `
  --from <release-A.json> `
  --to <release-B.json> `
  --scenario migration `
  --output <private-run-root>
```

IndexedDB 1→2, future-version reject và dữ liệu mã hóa được kiểm tra riêng bằng `frontend/tests/storage-migrations.spec.ts` cùng storage atomicity suite; không dùng test harness route trong release image.

## DR-01: cùng snapshot, hai target restore, cùng hai profile

Tạo hai config `environment=restore`, A/B có cùng `public_origin` rehearsal nhưng project, DB, edge alias, state dir, secrets dir và app subnet khác nhau. Mỗi target có volume rỗng mới. Origin này không được là origin staging/production của snapshot S. Cấu hình và HTTPS edge phải được người vận hành kiểm tra trước khi chạy.

1. Trỏ HTTPS rehearsal edge tới edge alias target A. Chạy seed phase bằng snapshot S. Script import S vào DB sạch, xoay epoch, khởi động release B và tạo hai persistent browser profile riêng dưới `<private-run-root>/profiles/device-a` và `device-b`.
2. Seed suite xác nhận server ban đầu chỉ có baseline E0 trong S; đăng nhập cùng owner trên hai thiết bị; tạo E1/E2 và chờ ACK/shadow; tạo P0 offline cùng một draft chưa lưu. Nó lưu operation IDs, epoch, draft ciphertext hash, origin hash và hai profile path hash vào `restore-state.json` riêng tư.
3. Chỉ tiếp tục khi seed suite pass và `restore-state.json.status` là `seeded`. Trỏ HTTPS rehearsal edge tới edge alias target B. Target B phải là restore project/DB/volume mới; edge có thể trả 502 trong khoảng target cũ dừng và target mới khởi động.
4. Chạy recover phase với cùng snapshot, source environment, release pair, credentials, runtime compatibility và **cùng output root**. Runner xác minh session seed, origin/candidate/profile bindings, dừng `api`/`web` ở target A nhưng giữ nguyên volume; import S vào B; prepare epoch mới; activate B; rồi chạy suite với đúng hai persistent profile cũ.
5. Recover suite kiểm tra server chỉ còn E0 trước reconnect; retry một push sau khi server commit nhưng mất ACK; cuối cùng server có union E0+E1+E2+P0, hai profile hội tụ, epoch mới, journal rỗng và draft ciphertext giữ nguyên. Snapshot ID/hash được gắn vào evidence DR-01.

Ví dụ recover phase:

```powershell
python scripts/rehearse_release.py `
  --config <restore-target-B.json> `
  --from <release-A.json> `
  --to <release-B.json> `
  --scenario restore `
  --restore-phase recover `
  --output <private-run-root> `
  --credentials <owner-credentials.json> `
  --runtime <runtime-compatibility.json> `
  --policy <backup-policy.json> `
  --snapshot-id <64-hex-restic-id> `
  --source-environment staging
```

Seed phase dùng cùng lệnh với `--config <restore-target-A.json>` và `--restore-phase seed`. Không chạy hai restore đồng thời. Harness không xóa volume/config tự động; chỉ cleanup sau khi evidence đã được lưu và operator đã xác minh đúng project/run ID.

## Xác nhận kết quả

Candidate bindings, expected outcomes và trạng thái của từng case được theo dõi trong [compatibility matrix](compatibility-matrix.json). Điền release A/B SHA, digest, build ID, platform và version thực trước khi chạy target.

Chỉ validator mới tổng kết được 10 case. Nó từ chối `RUNNING`, `TARGET_PENDING`, case thiếu biến thể bắt buộc, snapshot DR-01 không phải SHA-256 hex, origin/profile hash thiếu, evidence sai candidate hoặc path thoát evidence root:

```powershell
python scripts/validate_rehearsal_results.py `
  --results <private-run-root>/rehearsal-results.json `
  --from <release-A.json> `
  --to <release-B.json> `
  --evidence-root <private-run-root>
```

Exit 0 và `10 rehearsal cases verified` là điều kiện cần cho T33; thời gian maintenance, RPO/RTO thực, quyền giữ backup key, email/inbox và 38 AC staging vẫn phải được ghi nhận riêng ở T32/T34/T36. Không suy diễn acceptance môi trường thật từ typecheck, discovery hoặc fixture disposable.

## Nhánh xử lý lỗi

- Candidate health/smoke fail trước khi migration: giữ A và điều tra image/config.
- Migration lỗi/partial DDL: giữ maintenance, xác nhận Alembic revision và object DDL thực tế, rồi chỉ roll-forward theo repair đã thử trên disposable DB; không tự giả định DDL được rollback.
- B khỏe nhưng lỗi ứng dụng: rollback binary về A chỉ khi runtime DB revision nằm rõ trong manifest A support. Nếu không tương thích, giữ B hoặc maintenance và roll-forward.
- Mất DB: restore snapshot vào project/volume mới, đổi epoch, kiểm tra owner/key, yêu cầu thiết bị cũ đăng nhập/recover; không restore DB cũ đè lên target còn writes mới.
- Browser suite hoặc phase thất bại: giữ report ở trạng thái incomplete, lưu target/profile để điều tra; tạo run root và target ID mới trước khi thử lại từ đầu. Không đổi status thủ công thành PASS.
