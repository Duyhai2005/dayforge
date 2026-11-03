# T11 — Rà soát và kiểm chứng

Cập nhật: **03/11/2026** · Phạm vi: client sync nền T11; thao tác qua biểu mẫu lịch và nghiệm thu browser/OS đích thuộc các bước sau.

## Adapter và phiên bản nền

- Storage/vault T08–T09: IndexedDB `dayforge-local`, schema version **2** (`frontend/lib/storage/vault.ts`); owner key dùng AES-GCM, `local_state_revision`, `lock_epoch`, `sync_generation`, server epoch/cursor, observed HLC, outbox, shadow, projection, diagnostics, journal và staging. Snapshot prepare ngoài transaction; commit kiểm tra owner, lock, generation, cursor, build gate, revision và fencing token khi có leader.
- Auth T09: cùng origin `/api/v1/auth/session`, `/login`, `/local-key`, `/logout`; session không cache, CSRF cùng origin; khóa vault chỉ mở sau xác thực/local-key và có thể được dùng offline từ CryptoKey đã lưu trong IndexedDB. Logout/lock khóa owner và coordinator liên tab.
- Sync T10: protocol **1**, reducer **1**, version/limits lấy từ `/api/v1/version`; endpoints `/api/v1/sync/clock`, `/bootstrap`, `/push`, `/pull`. Event log, receipt và cursor nằm trong MySQL; client kiểm tra result theo operation ID/hash.
- T11 giữ đúng ranh giới trên: `frontend/services/sync.ts` sở hữu HTTP, `frontend/lib/sync/coordinator.ts` điều phối, `outbox.ts`/`ingestion.ts`/`bootstrap.ts` thực hiện cập nhật state qua storage CAS. Test harness gọi mutation/storage API sản phẩm; mock API chỉ dùng để điều khiển fault ở suite cập nhật T13.

## Kết quả kiểm chứng

- `pnpm test:sync:browser`: passed với MySQL disposable và hai Chromium context; offline create/edit/delete rồi reconnect hội tụ cùng operation ID/hash. Ca test gồm lost response, ACK/pull race, transaction abort, owner lock, takeover/fencing sau process death và tab idle suspend ba lease TTL, clock recovery/re-author, server epoch restore hai lần, journal/staging/publish rollback và recovery reupload.
- `pnpm test:web:offline`: **6/6 passed** trên production Chromium profile, gồm cold start, worker cache, IndexedDB migration gate và resume sau crash.
- `pnpm test:web:offline:update`: **1/1 scenario passed** trên production A/B build cùng origin; gồm mutation thật qua `commitLocalMutation`, ACK-waiting preservation, pause/drain, hai push response đã commit nhưng bị giữ/mất trong lúc defer và A→B switch, retry body byte-identical, một effect mỗi operation, pull hội tụ, draft và cache privacy.
- Corpus reducer dùng chung Python/TypeScript: **18 action v1**, **1.724** arrival permutations; chi tiết corpus nằm trong trạng thái T12.
- Quality gates đã chạy trong lượt triển khai: frontend TypeScript/ESLint, backend Ruff/mypy/Black; API/unit và MySQL integration. Bộ A/B vừa chạy dựng cả hai production build và tự chạy TypeScript production compile. Lượt này không chạy lại toàn bộ `pnpm verify`.

## Giới hạn và kết luận

Client sync nền T11 đã được kiểm chứng bằng API/MySQL thật, hai browser context và fault-injection transactions. Chưa có thao tác lịch qua biểu mẫu sản phẩm; UI lịch thuộc T14–T23. Chưa nghiệm thu browser/OS production target. Đây là giới hạn sản phẩm/môi trường, không làm thay đổi API/storage contract nền được T11 dùng.

Xem [trạng thái triển khai T11](implementation-status.md), [plan T11](plan.md), [trạng thái recovery T12](../t12/implementation-status.md) và [runbook offline/update T13](../t13/offline-update-runbook.md).
