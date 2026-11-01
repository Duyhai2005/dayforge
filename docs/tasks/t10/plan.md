# T10 — API đồng bộ phía máy chủ

> Kế hoạch thực thi T10 theo hợp đồng T03; làm tuần tự, mỗi task theo TDD. Event và tombstone đã ghi được giữ nguyên; canonical LWW replay/projection nghiệp vụ thuộc T12.

**Mục tiêu:** Cung cấp sync API có owner isolation, clock, push idempotent theo operation ID/hash, bootstrap/pull theo prefix event bất biến, epoch/cursor rõ ràng và transaction InnoDB không làm mất event đã commit.

**Thiết kế:** FastAPI lấy owner từ verified session. MySQL lưu trạng thái owner (epoch + head cursor), envelope/hash bất biến, receipt và change log. Mỗi operation trong batch là transaction riêng dưới khóa owner; trang đọc giữ watermark H cố định, continuation token HMAC ràng buộc owner/epoch/version/position. T10 không dựng reducer nghiệp vụ; T12 replay event.

**Tài liệu chuẩn:** docs/tasks/t03/sync-contract.md, docs/tasks/t03/api-contract.md, docs/tasks/t03/data-contract.md, docs/tasks/t09/review-and-verification.md, docs/tasks/README.md.

## Ràng buộc

- Prefix /api/v1; mọi sync endpoint cần require_verified_owner; owner_id trong envelope chỉ là assertion phải khớp session.
- Mọi POST qua Origin/CSRF gate T09. Mọi sync response thành công/lỗi đặt Cache-Control: no-store; không log operation, note, token hoặc payload.
- 0004_sync nối sau 0003_auth_lifecycle_hardening; không sửa migration cũ.
- Giới hạn push: 100 operations, 8 MiB body, 2 MiB/operation, 1.000 commands/operation. Không cắt payload. SHA-256 tính trên UTF-8 JCS.
- Protocol/reducer hiện hỗ trợ version 1. device_sequence và cursor/head truyền bằng chuỗi unsigned thập phân.
- Operation được ghi kể cả semantic no-op/superseded; T10 từ chối malformed/version/auth/owner/dependency/clock-integrity violations.
- Một transaction ghi operation, receipt, change log và tăng head đúng một lần; duplicate cùng hash trả receipt cũ, khác hash là 409 operation_id_reused.
- Bootstrap/pull lấy H đã commit, token 30 phút; mỗi trang tối đa 200 groups và 8 MiB, không chia group; trang cuối tiến tới H.
- Giữ event, receipt và tombstone; không prune/checkpoint trong T10.
- Thêm test trước thay đổi production; MySQL test dùng pnpm test:api:mysql.

## File map

| File | Vai trò |
| --- | --- |
| backend/app/models/sync.py, backend/app/models/__init__.py | Owner sync state, recorded operation, receipt, change log. |
| backend/migrations/versions/0004_sync.py | Schema/index/check constraints, downgrade. |
| backend/app/schemas/sync.py | DTO clock, operation, push, receipt, page. |
| backend/app/services/sync.py, sync_tokens.py, sync_wire.py | JCS/hash, transactions, epoch/cursor, signed page reads. |
| backend/app/api/sync.py, backend/app/main.py | Routes, verified-owner, cache policy. |
| backend/app/core/errors.py, backend/app/core/config.py | Problem codes and token signing secret if required. |
| backend/tests/unit/test_sync_*.py, backend/tests/api/test_sync*.py, backend/tests/integration/test_sync*.py | Wire, security, idempotency, pagination, atomicity, isolation. |
| docs/tasks/t10/review-and-verification.md, docs/tasks/README.md | Verification and T11/T12 handoff. |

## Tasks

### Task 1 — Schema event log và migration

Files: tạo backend/app/models/sync.py, backend/migrations/versions/0004_sync.py, backend/tests/integration/test_sync_migration.py; sửa exports/migration tests.

1. Viết test migration đỏ: revision sau 0003; tạo owner_sync_states, recorded_operations, operation_receipts, change_log; unique owner-operation và owner-epoch-cursor; FK owner; unsigned BIGINT; không đổi auth/users schema.
2. Chạy test để thấy lỗi vì schema chưa tồn tại.
3. Thêm SQLAlchemy models và migration đồng bộ; cursor không dùng AUTO_INCREMENT; mọi bảng InnoDB/utf8mb4.
4. Chạy upgrade/downgrade/upgrade trên MySQL và kiểm tra schema cũ.
5. Commit: feat: add sync event log schema.

### Task 2 — Strict DTO, JCS và envelope validation

Files: tạo backend/app/schemas/sync.py, backend/app/services/sync_wire.py, backend/tests/unit/test_sync_wire.py.

1. Viết test đỏ cho DTO cấm extra/coercion, UUID canonical, version 1, 1–1000 commands, uint64 device_sequence, dependencies unique, HLC fields/ranges, operation/body size và JCS/hash ổn định.
2. Chạy unit tests đỏ.
3. Triển khai canonical envelope parsing giữ array/string nguyên trạng; từ chối duplicate keys, NaN/Infinity, surrogate sai, JSON number ngoài miền; SHA-256 trên RFC 8785 bytes; server metadata không vào hash.
4. Version không hỗ trợ trả 409 client_update_required; payload không bị chuẩn hóa thành envelope khác.
5. Chạy vectors JCS, Unicode, thứ tự key, integer boundaries và invalid data; không log payload.
6. Commit: feat: validate and hash sync envelopes.

### Task 3 — Owner sync state, epoch và clock

Files: tạo/sửa sync service/API/schema; thêm unit/API tests.

1. Viết test đỏ cho GET /sync/clock?device_id=UUID: verified owner bắt buộc; calibration UUID, server_time_ms/server_time, max_future_skew_ms=300000; no-store.
2. Test epoch bền vững theo owner và race tạo state chỉ sinh một epoch.
3. Chạy tests đỏ.
4. Thêm service khởi tạo OwnerSyncState trong transaction, cursor ban đầu 0; calibration UUID opaque, không dùng làm chứng cứ thời gian.
5. Thêm route clock và UTC millisecond.
6. Chạy API/MySQL tests.
7. Commit: feat: add owner sync clock and epoch.

### Task 4 — Push: auth, validation, dependency và idempotency

Files: tạo/sửa sync API/service/errors; thêm API/integration tests.

1. Viết test đỏ: anonymous/unverified/CSRF/Origin sai không mutate; owner assertion sai trả 403 không lộ owner khác; malformed/oversize body không ghi; dependency thiếu hoặc K không tăng trả lỗi đúng.
2. Test duplicate ID/hash trả receipt cũ; ID/hash khác trả 409; batch giữ thứ tự, lỗi operation không chặn operation độc lập.
3. Chạy tests đỏ.
4. Thêm POST /sync/push; xét item theo thứ tự request, mỗi operation transaction riêng. InnoDB SELECT FOR UPDATE trên owner state; receipt lookup trước clock guard; xác thực owner/device/version/dependencies; ghi envelope/hash/receipt/change log và tăng head. Duplicate không tăng cursor; rollback hoàn tác toàn bộ.
5. Hỗ trợ recorded/duplicate/deferred/rejected; operation_id null chỉ khi ID không parse được; head_cursor không thay pull cursor.
6. Thêm Problem codes T03: owner_mismatch, dependency_missing, operation_id_reused, client_update_required, time_invalid, invalid_causality, clock_unhealthy, cursor_epoch_mismatch, page_token_expired.
7. Chạy API/MySQL, gồm cùng ID được push đồng thời.
8. Commit: feat: add idempotent sync push API.

### Task 5 — Bootstrap/pull prefix bất biến và signed page token

Files: tạo sync_tokens; sửa service/router; thêm unit/API/integration tests.

1. Test đỏ bootstrap epoch/H; pull cursor/epoch; continuation token gắn owner, epoch, H, position, endpoint/version, TTL 30 phút; token giả hoặc sai owner/epoch bị từ chối.
2. Test event mới sau H không xuất hiện continuation; pull thỏa after < cursor <= H; epoch mismatch trả 409.
3. Test giới hạn 200 groups/8 MiB, operation không bị cắt, trang has_more luôn tiến, trang cuối next_cursor=H và token=null.
4. Chạy tests đỏ.
5. Ký token HMAC-SHA256 bằng secret riêng; token không chứa event/payload. Nếu thêm config key, dùng 32 byte riêng, cập nhật example/init/test runner; không tái dùng secret auth.
6. Đọc primary theo owner/epoch/cursor tăng dần; committed_at là server metadata; continuation không nhận cursor query cùng page_token.
7. Mọi sync response có Cache-Control: no-store.
8. Chạy API/MySQL với ghi đồng thời trong lúc phân trang.
9. Commit: feat: add snapshot and pull pagination.

### Task 6 — Clock guard và dependency integrity

Files: sửa sync_wire/sync service; thêm unit/API/integration tests.

1. Test đỏ physical_ms <= server + 300000, physical_ms >= account-created −300000, logical uint32, calibration UUID, quality không phải untrusted; dependency cùng owner/recorded và K nhỏ hơn; retry receipt trước time guard.
2. Chạy tests đỏ.
3. Guard trong transaction với server UTC ms; so sánh K theo số và UUID bytes; chỉ áp dụng delete_rank từ action được wire nhận diện chắc chắn.
4. Dependency query theo owner composite key, không tiết lộ ID thuộc owner khác; deferred/rejected không ACK.
5. Test biên clock, retry sau time advance và dependency trong batch.
6. Chạy unit/API/MySQL.
7. Commit: feat: enforce sync time and dependency guards.

### Task 7 — Atomicity, serialization và owner isolation

Files: thêm integration tests test_sync_transactions.py và test_sync_isolation.py.

1. Viết MySQL tests đỏ cho concurrent pushes cùng owner, lỗi giữa transaction/rollback, cursor liên tục, duplicate race, cross-owner read/write, race khởi tạo owner state.
2. Xác nhận test thất bại trước fix.
3. Hoàn thiện row locking/unique constraints; mọi query log scoped owner; watermark không dùng MAX(id), AUTO_INCREMENT, server timestamp, replica hay SKIP LOCKED.
4. Dùng service failpoint trong test để chứng minh rollback không sót event/receipt/head.
5. Chạy lặp integration tests để bắt race; không mock bất biến MySQL.
6. Commit: test: verify atomic sync commits and isolation.

### Task 8 — Contract acceptance, limits, docs/security

Files: hoàn thiện API/schema tests, sync cache middleware, config/scripts/docs nếu cần.

1. Viết acceptance tests theo T03: empty bootstrap, multi-page, empty pull, push/duplicate receipt, media type/problem, no-store, /version limits.
2. Chạy đỏ.
3. Bảo đảm no-store cả 401/403/404/413/500; request logging không đọc body; sync POST vẫn qua CSRF/Origin.
4. Public /version nêu limits; docs giải thích migration và ranh giới T10/T11/T12.
5. Chạy backend API/unit/MySQL acceptance.
6. Commit: docs: document sync API contract and limits.

### Task 9 — Rà soát T10 và handoff

1. Đối chiếu routes/fields/errors/limits với T03; rà owner scoping, token MAC/TTL, no-store, privacy, rollback, duplicate, watermark H, empty tail và page progress.
2. Chạy pnpm verify:fast, pnpm test:api:mysql và migration offline SQL; ghi rõ nếu môi trường không hỗ trợ MySQL.
3. Ghi command/result/giới hạn ở docs/tasks/t10/review-and-verification.md; cập nhật docs/tasks/README.md.
4. Handoff T11: endpoint/DTO/retry/ACK; cursor chỉ tiến qua pull. Ghi reducer/projection/LWW là T12.
5. Self-review diff/status; commit: docs: record T10 sync API verification.

## Acceptance

- Auth/CSRF/owner assertion trước mutation; owner A không đọc/ghi log B.
- Retry mất response trả receipt cũ; hash mismatch không mutate; no-op vẫn có event/cursor.
- Rollback không sót event/receipt/head; concurrent commits không thủng cursor.
- Bootstrap/pull giữ prefix H; token expiry/epoch mismatch theo Problem contract; mọi trang tiến hữu hạn.
- Tombstone nguyên vẹn trong event; không prune; operation không bị cắt.
- Reducer nghiệp vụ/LWW và client coordinator tiếp tục ở T12/T11.