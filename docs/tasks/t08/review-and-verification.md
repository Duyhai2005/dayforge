# T08 — Verification and handoff

**Cập nhật:** 01/11/2026
**PR:** [#8 Implement persistent local storage engine with encrypted outbox](https://github.com/Duyhai2005/dayforge/pull/8) → `develop`
**Nhánh:** `feature/local-persistent-storage` (worktree `codex/t08-integrity-api`)
**Mốc CI gần nhất đã xác minh:** [`bc63108`](https://github.com/Duyhai2005/dayforge/commit/bc6310890f0c91dda3feef705e0f08bc2be3f6e7), [run 41277992819](https://github.com/Duyhai2005/dayforge/actions/runs/41277992819) — `quality`, `frontend`, `backend-mysql` đều xanh. Run này áp dụng cho `bc63108`; chưa có CI cho commit `29bada5` vì commit đó chưa push.

Phần bên dưới là trạng thái hiện tại của API và kiểm chứng. Các mục review cũ được giữ làm lịch sử; không dùng các API trong chúng làm hướng dẫn tích hợp.

## 1. Môi trường kiểm thử hiện tại

| Thành phần | Trạng thái |
|---|---|
| Node.js / pnpm | `24.22.1` / `12.16.1` |
| Next.js / React / TypeScript | `16.4.3` / `19.3.1` / `6.0.3` |
| Playwright | `1.64.1`, Chromium headless |
| `uv` | Không cài trong môi trường cục bộ; chưa chạy backend gates tại đây |
| Cổng Playwright | 3010 (dev), 3001 (production) |

## 2. Quality gates đã quan sát

Các kết quả frontend dưới đây thuộc mã cục bộ sau N07–N10. CI link ở đầu trang xác nhận commit nền `bc63108`, không đại diện cho diff chưa push.

| Gate | Lệnh | Kết quả |
|---|---|---|
| Frontend lint | `pnpm lint:web` | PASS, `eslint . --max-warnings=0` |
| Frontend typecheck | `pnpm typecheck:web` | PASS, `tsc --noEmit` |
| Dev browser suite | `pnpm --filter @dayforge/frontend exec playwright test --workers=4` | PASS, 139/139 |
| Production build | `pnpm build:web` | PASS, optimized Next.js build |
| Production browser suite | `pnpm test:web:prod` | PASS, 139/139 |
| Backend local gates | `pnpm verify:fast` | Chưa chạy: thiếu `uv`; CI trên commit nền xanh như link đầu trang |

`pnpm test:web` và `pnpm test:web:prod` trong các mục lịch sử phía dưới là số liệu tại thời điểm cũ, không phải số hiện tại.

---

## 3. Ma Trận Nghiệm Thu Ban Đầu (ST-01 đến ST-20, bản lịch sử)

> Ma trận và thời lượng bên dưới ghi lại lượt kiểm thử đầu tiên của T08; số lượng hiện tại nằm ở mục 2.

T08 xây dựng 6 tệp kiểm thử Playwright chuyên biệt (`frontend/tests/storage-*.spec.ts`) bao phủ chính xác 20 kịch bản cốt lõi theo hợp đồng kỹ thuật T03:

| Kịch bản | Tên kịch bản | Tệp kiểm thử & Mô tả kiểm chứng | Kết quả |
|---|---|---|---|
| **ST-01** | Multi-store durability across page reload | `storage-persistence.spec.ts`<br>Mở database, ghi đồng thời các bản ghi vào nhiều store, đóng kết nối, mở lại và reload trang web hoàn chỉnh: dữ liệu vẫn bảo toàn nguyên vẹn 100%. | **PASS** (1.7s) |
| **ST-02** | Server-side & SSR Safety | `storage-persistence.spec.ts`<br>Gọi `openDatabase`, import module lưu trữ trong môi trường Node.js không có `indexedDB`: trả về typed `StorageError('unavailable')`, không throw exception, an toàn tuyệt đối cho Next.js SSR. | **PASS** (22ms) |
| **ST-03** | Atomic Unit of Work Commit | `storage-atomicity.spec.ts`<br>Ghi đồng thời outbox operation, record overlays, device sequence và clock state trong duy nhất một `readwrite` transaction. | **PASS** (1.1s) |
| **ST-04** | Aborted Transaction Rollback | `storage-atomicity.spec.ts`<br>Giao dịch bị abort giữa chừng: 0 outbox record, 0 overlay, device sequence không tăng. Hoàn toàn không có partial commit. | **PASS** (1.2s) |
| **ST-05** | Multi-Tab Concurrent Writes | `storage-atomicity.spec.ts`<br>Hai tab browser ghi đồng thời: các transaction được tuần tự hóa, sequence sinh ra tăng đơn điệu tuyệt đối (`1`, `2`, `3`, `4`, `5`, `6`), 0 lost updates. | **PASS** (7.7s) |
| **ST-06** | Duplicate Operation Rejection | `storage-atomicity.spec.ts`<br>Ghi operation có `operation_id` đã tồn tại: trả về `StorageError('invalid_data')`, không ghi đè và không làm hỏng outbox hiện tại. | **PASS** (1.8s) |
| **ST-07** | Envelope & Hash Durability | `storage-atomicity.spec.ts`<br>Sau khi reload trình duyệt, envelope gốc, RFC 8785 canonical hash (`request_hash`), `device_sequence` và record overlays vẫn bất biến. | **PASS** (1.7s) |
| **ST-08** | Owner Isolation | `storage-security.spec.ts`<br>Owner A không thể giải mã bản ghi của Owner B kể cả khi biết record ID. Giải mã với sai khóa lập tức trả về `StorageError('integrity_failed')`. | **PASS** (18ms) |
| **ST-09** | AAD Binding & Tampering Rejection | `storage-security.spec.ts`<br>Tráo đổi ciphertext giữa các bản ghi hoặc sửa đổi AAD (ownerId, store, recordId): AES-256-GCM authentication tag xác thực thất bại, fail-closed với `StorageError('integrity_failed')`. | **PASS** (13ms) |
| **ST-10** | Owner Gating & Lock Epoch | `storage-security.spec.ts`<br>`lockOwner`, `unlockOwner`, và tăng lock epoch (mô phỏng đăng xuất): mọi truy cập dùng context cũ đều bị từ chối với `StorageError('locked')`. | **PASS** (2.4s) |
| **ST-11** | QuotaExceededError Injection | `storage-failures.spec.ts`<br>Tiêm lỗi hạn ngạch trình duyệt đầy khi put record: trả về typed `StorageError('quota_exceeded')`, rollback sạch stores, dữ liệu uncommitted giữ trong bộ nhớ để retry. | **PASS** (1.1s) |
| **ST-12** | IndexedDB Restricted / Private Mode | `storage-failures.spec.ts`<br>Mô phỏng trình duyệt chặn IndexedDB (DOMException `SecurityError` trong sandbox): trả về typed `StorageError('unavailable')`, không crash app, không báo "saved" sai lệch. | **PASS** (1.4s) |
| **ST-13** | Schema Migration Data Preservation | `storage-migrations.spec.ts`<br>Nâng cấp schema từ v1 lên v2: bảo toàn nguyên vẹn 100% outbox pending, crypto keys, business records và device metadata. | **PASS** (2.8s) |
| **ST-14** | Unsupported Version Rejection | `storage-migrations.spec.ts`<br>Tab cũ mở cơ sở dữ liệu có phiên bản cao hơn `CURRENT_SCHEMA_VERSION`: trả về `StorageError('unsupported_version')`, tuyệt đối không gọi `deleteDatabase()`. | **PASS** (1.7s) |
| **ST-15** | View Preferences Safe Migration | `storage-view-state.spec.ts`<br>Di chuyển sở thích xem hợp lệ từ `sessionStorage` của T06 vào store `view_preferences` được mã hóa theo owner trong IndexedDB và dọn sạch key cũ. | **PASS** (1.4s) |
| **ST-16** | 64-Bit Sequence Precision | `storage-atomicity.spec.ts`<br>Bảo toàn độ chính xác số học của `device_sequence` 64-bit: tăng từ `18446744073709551614` lên max `18446744073709551615` bằng `BigInt` mà không mất độ chính xác. | **PASS** (555ms) |
| **ST-17** | Untrusted Clock Handling | `storage-atomicity.spec.ts`<br>Thao tác có chất lượng đồng hồ `quality: "untrusted"` được gắn cờ `status: "time_invalid"` trong outbox và bị loại trừ khỏi `listSendableOperations`. | **PASS** (497ms) |
| **ST-18** | Non-Leakage Security Invariant | `storage-failures.spec.ts`<br>Quét toàn bộ 8 object stores trong IndexedDB và console logs của trình duyệt: xác nhận 0 token phiên, 0 raw key, và 0 bí mật plaintext bị rò rỉ. | **PASS** (1.1s) |
| **ST-19** | Boundary Scale & Unicode Content | `storage-failures.spec.ts`<br>1. Lưu và xác thực 1.000 commands trong một operation với mã băm chuẩn RFC 8785 Canonical JSON SHA-256.<br>2. Lưu và đọc 4.000 codepoint Unicode note đa ngôn ngữ (Persian RTL, Tiếng Việt dấu thanh, Emoji astral plane, CJK) không bị cắt ngắn hay lỗi giải mã. | **PASS** (2.6s + 1.2s) |
| **ST-20** | Performance Scale Benchmark | `storage-failures.spec.ts`<br>Đo kiểm hiệu năng thực tế 100 outbox operations được mã hóa AES-256-GCM trong Chromium: batch persist ~ 1.28 ms/op, read & decrypt ~ 0.05 ms/op. | **PASS** (850ms) |

---

## 4. Đo Kiểm Hiệu Năng Ban Đầu (bản lịch sử)

Thực thi trên trình duyệt Chromium thực tế thông qua Playwright runner:

```text
========================================
[PERFORMANCE METRICS - 100 ENCRYPTED OUTBOX OPS]
Persist 100 Operations Total: 127.60 ms ~ 181.60 ms
Avg Persist per Operation:    1.28 ms ~ 1.82 ms
List & Decrypt 100 Ops Total: 4.90 ms ~ 5.40 ms
Avg Read & Decrypt per Op:    0.05 ms
========================================
```

- **Quy mô 1.000 Commands / 1 Operation:** 1.000 commands độc lập được tính hash RFC 8785 Canonical JSON SHA-256 và lưu atomic trong IndexedDB mất **~1.2s - 2.6s**.
- **Quy mô 4.000 Codepoint Multiline Note:** Quá trình mã hóa AES-GCM và roundtrip 4.000 codepoint đa ngôn ngữ hoàn tất trong **~732ms - 1.2s**, bảo toàn tính toàn vẹn 100%.

---

## 5. Khảo Sát Rủi Ro Kỹ Thuật (R1 -> R6) và Cách Giải Quyết

| Mã rủi ro | Rủi ro kỹ thuật | Cách giải quyết trong T08 |
|---|---|---|
| **R1** | **Rò rỉ dữ liệu hoặc khóa mã hóa** (Data & Key Leakage) | Sử dụng non-extractable `CryptoKey` (`extractable: false`), lưu bằng structured clone vào `crypto_keys` store; toàn bộ business records, outbox payload, view preferences đều mã hóa AES-256-GCM; không bao giờ log key hoặc payload nhạy cảm ra console; kiểm chứng qua **ST-18**. |
| **R2** | **Tráo đổi ciphertext hoặc làm hỏng dữ liệu** (Tampering & Swapping) | Sử dụng AAD (Additional Authenticated Data) cố định gắn chặt `owner_id`, `key_id`, `store`, `record_id`, `schema_version`. Bất kỳ thay đổi bit hay tráo đổi context nào đều khiến AES-GCM tag verification thất bại lập tức (`StorageError('integrity_failed')`), fail-closed an toàn; kiểm chứng qua **ST-09**. |
| **R3** | **Ghi dở dang và mất tính nguyên tử** (Partial Writes & Atomicity Loss) | Unit of Work gom toàn bộ việc ghi outbox envelope, record overlays, device sequence, và clock state vào trong DUY NHẤT một IDB `readwrite` transaction. Nếu có lỗi (`QuotaExceededError`, `AbortError`), transaction rollback 100% (zero partial changes), dữ liệu uncommitted được giữ trong memory cho phép caller retry; kiểm chứng qua **ST-03**, **ST-04**, **ST-11**. |
| **R4** | **Xung đột ghi đồng thời giữa các tab** (Multi-Tab Race Conditions) | Transaction `readwrite` trên store `device_meta` và `operations` tuần tự hóa các ghi nhận giữa các tabs. Mỗi tab đọc sequence hiện tại, tăng tuần tự trong transaction, đảm bảo sequence sinh ra strictly monotonic không trùng lặp và không mất update; kiểm chứng qua **ST-05**. |
| **R5** | **Mất dữ liệu pending khi nâng cấp schema** (Upgrade Data Loss) | Thực hiện nguyên tắc **Zero-Deletion Policy**: quá trình `onupgradeneeded` chỉ bổ sung store/index mới theo các bước migration đã đăng ký, không bao giờ gọi `deleteDatabase()` hay drop store chứa dữ liệu. Tab cũ gặp DB phiên bản cao hơn trả về typed `unsupported_version` thay vì xóa DB; kiểm chứng qua **ST-13**, **ST-14**. |
| **R6** | **Mất độ chính xác của số nguyên 64-bit** (64-Bit Sequence Precision Loss) | Hợp đồng T03 yêu cầu `device_sequence` là unsigned 64-bit integer (tối đa `18446744073709551615`). T08 lưu trữ sequence dưới dạng chuỗi thập phân (`string`) và thực hiện tính toán số học bằng `BigInt`, ngăn chặn hoàn toàn hiện tượng làm tròn sai lệch của kiểu `Number` trong JavaScript; kiểm chứng qua **ST-16**. |

---

## 6. Runbook Vận Hành (Operational Runbook)

### 6.1 Quản Lý Schema và Migration
- **Phiên bản hiện tại:** `CURRENT_SCHEMA_VERSION = 1`.
- **Thực hiện nâng cấp:** Khi cần thêm object store hoặc index mới, đăng ký một `MigrationStep` tường minh trong `migration.ts` với `fromVersion` và `toVersion` liên tiếp (`v1 -> v2`, `v2 -> v3`).
- **Nguyên tắc Zero-Deletion:** Tuyệt đối không xóa cơ sở dữ liệu (`indexedDB.deleteDatabase`) khi gặp lỗi migration. Mọi lỗi đều phải fail-closed với `StorageError('migration_failed')` để bảo toàn outbox chưa đồng bộ cho người dùng.

### 6.2 Xử Lý Lỗi Hạn Ngạch (`quota_exceeded`)
- Khi trình duyệt trả về DOMException `QuotaExceededError`, storage adapter chuyển thành `StorageError('quota_exceeded')`.
- Transaction tự động hủy hoàn toàn (zero partial commit), dữ liệu thay đổi của người dùng được giữ lại trong bộ nhớ (`in-memory dirty draft`).
- UI cần hiển thị cảnh báo dung lượng lưu trữ đầy và cho phép người dùng giải phóng bộ nhớ trước khi nhấn thử lại (retry).

### 6.3 Xử Lý Chặn Nâng Cấp (`blocked`)
- Khi một tab mở phiên bản mới trong khi các tab khác vẫn đang giữ kết nối cũ:
  - Sự kiện `versionchange` được gắn trên tất cả các kết nối đang mở để tự động đóng kết nối cũ (`db.close()`).
  - Nếu kết nối cũ không đóng kịp, sự kiện `onblocked` kích hoạt và adapter trả về `StorageError('blocked')`.
  - UI hướng dẫn người dùng đóng các tab DAYFORGE khác và tải lại trang.

### 6.4 Kiểm Tra Metadata An Toàn (Safe Metadata Inspection)
- Khi bảo trì hoặc kiểm tra IndexedDB qua DevTools (Application > IndexedDB):
  - Tuyệt đối không lưu raw session tokens hoặc plaintext password vào bất kỳ trường nào của IndexedDB.
  - Object store `crypto_keys` chỉ chứa các `CryptoKey` đối tượng non-extractable (không thể export key qua script).
  - Các store `records`, `operations`, `sync_meta`, `view_preferences` chỉ chứa trường kỹ thuật `iv` (12 bytes) và `ciphertext` (Uint8Array).

---

## 7. Bàn giao kỹ thuật hiện tại cho T09–T13

`frontend/lib/storage/index.ts` là API app-facing. `frontend/lib/storage/integration.ts` là bề mặt low-level cho các tích hợp T09/T10/T11. Dùng các chữ ký đang export:

1. **T09 — owner và khóa phiên:** `openDatabase(options?)` trả `StorageResult<IDBDatabase>`; sau khi nạp khóa AES-GCM 256-bit không extractable, gọi `unlockOwner(db, ownerId, keyId, key, optionsForTest?)`. `lockOwner(db, ownerId)` trả `StorageResult<number>` và `isOwnerUnlocked(db, ownerId)` trả `StorageResult<boolean>`. Các thao tác đọc/ghi dùng `OwnerAccessContext` trả về từ `unlockOwner`.
2. **T10 — push:** gọi `gateway.listSendableOperations(ctx)` để nhận envelope có trạng thái `queued`, `sending` hoặc `pending`. Mỗi envelope giữ `device_sequence`, `edit_time`, dependencies và commands; `requestHash` trong DTO replay là SHA-256 của JCS envelope gốc. Không dùng alias `listPending`/`listPendingOperations`; chúng không còn trong API production.
3. **T11 — replay/pull:** gọi `gateway.listOutboxForReplay(ctx)` để nhận `OutboxReplayItem { envelope, status, requestHash }`. Kết quả gồm `queued`, `sending`, `blocked`, `ack_waiting_pull`, `time_invalid`, `pending`; `superseded_by` vẫn lưu trên đĩa nhưng bị loại khỏi replay. ACK không xóa row: `gateway.markOperationAcked(ctx, operationId)` chỉ đổi trạng thái sang `ack_waiting_pull`.
   - Sau khi pull xác nhận đúng operation ID/hash, T11 gọi `confirmPulledOperationInTx(tx, ctx, operationId, expectedRequestHash, callbacks?)` trong chính transaction `readwrite` của caller.
   - Transaction caller phải bao gồm `owner_meta`, `operations` và các store dùng để ghi shadow, projection/replay cùng pull cursor. Helper kiểm tra owner gate bên trong transaction, rồi xác nhận trạng thái `ack_waiting_pull` và hash trước khi xóa outbox. Ghi shadow/projection, tiến cursor và xóa outbox phải commit hoặc rollback cùng nhau.
   - Không có API production `markOperationSynced` mở transaction riêng; helper tích hợp không tự ghi shadow hoặc cursor.
   - UI đếm operation chưa ACK: giữ `blocked`/`time_invalid` trong pending overlay; không đếm `ack_waiting_pull`. API replay trả status để caller không phải suy đoán từ envelope.
4. **T12 — reducer:** đọc `item.envelope` từ replay DTO và kết hợp theo operation ID/hash với shadow/pull; không xóa row ACK trước khi pull cùng transaction xác nhận.
5. **T13 — view preferences:** các primitive `readOwnerViewPreference`, `writeOwnerViewPreference` và `migrateLegacyViewPreferences` nằm ở integration exports; dữ liệu có owner scope và mã hóa trong IndexedDB.

---

## 8. Lịch sử review: Nhận xét ban đầu PR #8

> Nội dung các mục 8–14 là lịch sử theo từng thời điểm; API/hướng dẫn hiện tại ở mục 7.

Dưới đây là chi tiết kỹ thuật 8 hạng mục được review bởi maintainer repository `Duyhai2005` và các giải pháp đã được tích hợp:

1. **Blocker 1 (Atomic In-Transaction HLC Allocation):**
   - Đã cập nhật `PersistOperationInput` chấp nhận `clockInput?: ClockInputParams` hoặc `editTime?: HlcEditTime`.
   - Trong `persistOperationAtomic`, `allocatedHlc` được sinh trực tiếp bên trong IndexedDB transaction dựa trên persisted `devMeta.last_hlc`.
   - Nếu caller truyền explicit `editTime`, transaction xác thực rằng nó strictly ahead of `devMeta.last_hlc`; nếu stale, fail-closed với `StorageError("invalid_data")`.
   - `allocatedHlc` được trả về trong `PersistOperationResult`.

2. **Blocker 2 (Active Key Binding & Validation):**
   - Hàm chuẩn hóa `checkOwnerMetaRecord(meta, ctx)` kiểm tra `meta.active_key_id && meta.active_key_id !== ctx.keyId`, fail-closed với `StorageError("locked")`.
   - `unlockOwner` tự động kiểm tra: nếu re-unlock cùng owner với `keyId` khác mà chưa gọi lock, `lock_epoch` được tự động tăng để vô hiệu hóa context cũ.
   - Thêm phương thức `isOwnerUnlocked(db, ownerId)` trả về boolean có lock hay không.

3. **Blocker 3 (Single-Transaction Read Paths / Anti-TOCTOU):**
   - Cả `getRecord`, `listPendingOperations`, `readOwnerViewPreference` và `writeOwnerViewPreference` đều chuyển sang transaction đơn nhất chứa `[owner_meta, target_store]`.
   - Đọc và kiểm tra `owner_meta` ngay trong transaction, loại bỏ hoàn toàn TOCTOU window giữa lúc validate và lúc truy xuất dữ liệu.

4. **Major 4 (Sequence Range & Fail-Closed Corruption):**
   - Kiểm tra định dạng `devMeta.last_sequence`: bắt buộc khớp `/^[1-9][0-9]*$/`. Nếu chuỗi bị hỏng hoặc chứa ký tự không hợp lệ, fail-closed với `StorageError("invalid_data")` (không fallback về "1").
   - Xác thực `currentSeq >= UINT64_MAX`: nếu đạt ngưỡng tối đa 64-bit uint64, fail-closed với `StorageError("invalid_data")`.

5. **Major 5 (Strict HLC Logical Overflow Handling):**
   - Khai báo hằng số `UINT32_MAX = 0xffffffff`.
   - Xác thực `wallMs >= 0`, `calibrationId` UUID, `physical_ms <= Number.MAX_SAFE_INTEGER`, `logical <= UINT32_MAX`.
   - `advanceHlc` ném `StorageError("invalid_data", "HLC logical counter overflow: maximum uint32 exceeded")` khi `logical >= UINT32_MAX`.

6. **Major 6 (Record Decryption Expected AAD Derivation):**
   - Trong `getRecord<T>(ctx, kind, id)`, expected AAD được sinh trực tiếp từ tham số gọi: store = `STORAGE_STORES.records` và recordId = `${kind}:${id}`.
   - Không còn đọc `row.store` hay `row.record_id` từ đối tượng lưu trữ untrusted để làm expected AAD.

7. **Major 7 (Outbox State Machine & Lifecycle Methods):**
   - Bổ sung `queued` và `sending` vào `OutboxStatus`.
   - Bổ sung `markOperationAcked(ctx, operationId)` (chuyển trạng thái sang `ack_waiting_pull`) và `markOperationSynced(ctx, operationId)` (xóa atomic khỏi outbox khi pull xác nhận) trên `LocalStorageGateway` và module `repositories.ts`.
   - Cung cấp `listPendingOperations` song song với alias `listPending`.

8. **Cleanup & Refinements:**
   - Cắt tỉa `frontend/lib/storage/index.ts` thành curated explicit exports, chỉ định rõ ràng các symbols công khai và helper phục vụ tích hợp.
   - Bổ sung kiểm tra `hasLoneSurrogates` trong `canonicalizeJson` từ chối lone surrogates theo chuẩn RFC 8785 section 3.2.2.2.
   - Thêm đầy đủ các regression tests Playwright cho từng hạng mục kiểm chứng.

---

## 9. Lịch sử review: follow-up PR #8

Maintainer `Duyhai2005` đã tiến hành rà soát chuyên sâu bổ sung sau commit `32248cdf`. Toàn bộ 7 hạng mục còn lại đã được xử lý triệt để:

1. **HLC/Clock Evidence & Fail-Closed Calibration (Item 1):**
   - Nâng cấp `ClockInputParams` và `advanceHlc()` hỗ trợ độc lập `estimatedUtcMs` và `rawWallMs`, cho phép biểu diễn chính xác calibrated clock offset theo hợp đồng T03.
   - Loại bỏ hoàn toàn fallback synthetic calibration ID và fake "calibrated" quality: nếu caller không cung cấp `clockInput` hoặc `editTime`, fail-closed ngay lập tức với `StorageError("invalid_data")`.
   - Bổ sung xác thực `validateHlc(devMeta.last_hlc)` đối với `device_meta` đã lưu: nếu dữ liệu HLC bị hỏng, fail-closed với `StorageError("invalid_data")`.

2. **Đóng Hoàn Toàn Cửa Sổ TOCTOU Khi Đọc Dữ Liệu (Item 2):**
   - Trong `getRecord()`, `listPendingOperations()`, và `readOwnerViewPreference()`: sau khi giải mã ciphertext, thực hiện re-check `owner_meta` ngay trước khi trả dữ liệu plaintext ra ngoài. Nếu owner bị lock trong lúc đang giải mã, plaintext bị hủy và fail-closed với `StorageError("locked")`.

3. **Chuẩn Hóa Validator Durable Outbox Khớp 100% T03 Wire Contract (Item 3):**
   - `SupportedRootKind`: Giới hạn nghiêm ngặt ở `"plan" | "milestone" | "work_item"` theo T03.
   - Số lượng commands: Bắt buộc từ 1 đến 1000 lệnh (`1 <= commands.length <= 1000`), từ chối danh sách rỗng 0 commands.
   - Định dạng UUID: Kiểm tra regex UUID chuẩn cho `operation_id`, `owner_id`, `device_id`, `root.id`, và danh sách `dependencies` (loại trừ UUID trùng lặp).
   - Action: Ràng buộc vào đúng 18 actions hợp lệ được định nghĩa trong schema T03.
   - Precondition: Chặn toàn bộ thuộc tính lạ (`additionalProperties: false`), chỉ chấp nhận `expected_root_hash` (chuỗi hex 64 ký tự thường) và `expected_bucket` (`date`, `period`, `order_hash`).

4. **Kiểm Soát Chặt Chẽ Máy Trạng Thái Outbox (Item 4):**
   - Hàng outbox mới lưu chuyển sang trạng thái khởi tạo chuẩn là `"queued"` (hoặc `"time_invalid"` nếu clock quality không tin cậy).
   - `markOperationAcked()` chỉ cho phép chuyển từ `"queued"` / `"sending"` (hoặc `"pending"`) sang `"ack_waiting_pull"`.
   - `markOperationSynced()` từ chối xóa hàng nếu chưa chuyển qua `"ack_waiting_pull"`. Hỗ trợ tham số xác thực `expectedRequestHash`: từ chối xóa với `StorageError("integrity_failed")` nếu request hash không khớp với bản tin pull nhận được.

5. **Bảo Toàn Tương Thích Dữ Liệu Mã Hóa Cũ (AAD Compatibility) (Item 5):**
   - Khôi phục định dạng mã hóa AAD gốc `${ownerId}:${keyId}:${store}:${recordId}` không escape ký tự dấu hai chấm, đảm bảo 100% dữ liệu đã lưu ở các bản build trước tiếp tục giải mã thành công mà không gây hồi quy.

6. **Ép Buộc Tiêu Chuẩn Khóa AES-256 (Item 6):**
   - `unlockOwner()` kiểm tra chặt chẽ `(key.algorithm as AesKeyAlgorithm).length === 256`, từ chối các khóa AES-128-GCM với `StorageError("invalid_data")`.

7. **Minh Bạch Bề Mặt API & Dọn Dẹp (Item 7):**
   - `frontend/lib/storage/index.ts` xuất khẩu tường minh các hợp đồng kiểu, gateway facade, và các primitives cần thiết cho harness kiểm thử và các task tích hợp tiếp theo.

---

## 10. Lịch sử review: T03 schema parity (Comment ID 6545156728)

Reviewer `Duyhai2005` đã rà soát chuyên sâu commit `1a3db33d` và yêu cầu 6 nhóm sửa đổi trọng yếu về tính toàn vẹn schema wire protocol T03 cùng bảo mật vault key:

1. **Khớp Hoàn Toàn T03 `Command.oneOf` Payload DTO Schemas & Ràng Buộc Phối Hợp Lệnh (Finding 1):**
   - **Tương thích Root/Action:** Ràng buộc chặt chẽ root kind với action được phép (`plan` chỉ cho phép `plan.create`, `plan.replace`, `undo`; `milestone` cho phép `milestone.create`, `milestone.replace`, `milestone.delete`, `undo`; `work_item` cho phép 11 action task/series/detached/occurrence cùng `set_order` và `undo`). Mọi cặp root/action không hợp lệ đều bị từ chối với `StorageError("invalid_data")`.
   - **Đặc tả Payload DTO Đầy Đủ:** Bổ sung validators kiểm tra chi tiết theo hợp đồng T03 JSON Schema: `PlanData` (`name` 1..100 ký tự, `color_id` thuộc 10 màu hợp lệ), `MilestoneData` (`title`, `date`, `period`, `note` tối đa 4000 codepoints Unicode không chứa control characters, `plan_id`, `standalone_color_id`, `show_in_work_calendar`), `TaskData`, `TaskTemplate`, `RecurrenceRule`, `TaskTarget`, và `ExpectedState[]`.
   - **Chặn Thuộc Tính Lạ:** Mọi payload và DTO con đều áp dụng quy tắc `additionalProperties: false`, phát hiện và từ chối các thuộc tính thừa.
   - **Quy tắc Solitary Undo:** Lệnh `undo` bắt buộc phải là lệnh duy nhất trong thao tác (`commands.length === 1`). Bất kỳ thao tác nào kết hợp `undo` với lệnh khác đều bị fail-closed.
   - **Bảo Vệ Lệnh `set_order`:** Bắt buộc root kind là `work_item`, command precondition phải có `expected_root_hash` (chuỗi hex 64 ký tự), và thao tác outbox phải chứa ít nhất một command có guard `expected_bucket` (`date`, `period`, `order_hash`).

2. **Chuẩn Hóa Canonical UUID Theo Quy Chuẩn T03 (Finding 2):**
   - Áp dụng regex canonical UUID chuẩn trong toàn bộ tầng lưu trữ (`clock-state.ts`, `outbox.ts`, `owner-gate.ts`, `repositories.ts`):
     `/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`
   - Chỉ chấp nhận ký tự thường, phiên bản 4 hoặc 5, và variant 8, 9, a, b. Từ chối hoàn toàn UUID viết hoa hoặc UUID phiên bản cũ.

3. **Bắt Buộc Xác Thực Hash Khi Xác Nhận Kéo Dữ Liệu (`markOperationSynced`) (Finding 3):**
   - Tham số `expectedRequestHash: string` trên `LocalStorageGateway` và `repositories.ts` trở thành bắt buộc (loại bỏ tùy chọn `?: string`).
   - Kiểm tra định dạng hash bắt buộc là chuỗi hex 64 ký tự thường (`/^[0-9a-f]{64}$/`).
   - Bắt buộc hàng outbox phải ở trạng thái `"ack_waiting_pull"` và `entry.request_hash === expectedRequestHash` mới cho phép xóa; nếu không khớp, trả về `StorageError("integrity_failed")`.

4. **Bảo Vệ Khóa Danh Tính Vault Bền Vững & Gate An Toàn (Finding 4):**
   - `unlockOwner()` kiểm tra danh tính khóa: từ chối thay đổi `keyId` đối với owner đã được khởi tạo (kể cả khi đang mở khóa hoặc sau khi khóa lại) với `StorageError("invalid_data")`, bảo vệ tính nhất quán của dữ liệu mã hóa A256GCM.
   - Owner gate (`checkOwnerMetaRecord`) và `unlockOwner` tự động fail-closed nếu bản ghi owner đã mở khóa thiếu trường `active_key_id`.

5. **Ràng Buộc Số Nguyên An Toàn HLC (`raw_wall_ms` & `estimatedUtcMs`) (Finding 5):**
   - `validateHlc()` yêu cầu `Number.isSafeInteger(candidate.raw_wall_ms)`, `>= 0`, `<= Number.MAX_SAFE_INTEGER`, và canonical UUID cho `calibration_id`.
   - `advanceHlc()` kiểm tra `Number.isSafeInteger` cho cả `estimatedUtcMs` và `rawWallMs`, từ chối các số thực dấu phẩy động hoặc số không an toàn.

6. **Thu Hẹp Kiểu Dữ Liệu `StorageCommand.action` (Finding 6):**
   - Kiểu `action` được thu hẹp về `SupportedAction` (loại bỏ `| string`), ngăn chặn các action không hợp lệ ngay tại thời điểm biên dịch TypeScript.

7. **Bổ Sung Bộ Test Kiểm Chứng Schema Parity & Kết Quả Xác Minh Toàn Diện:**
   - Đã bổ sung bộ test kiểm chứng parity toàn diện trong `storage-atomicity.spec.ts` (test 22) và cập nhật `storage-failures.spec.ts`, `storage-security.spec.ts`.
   - Toàn bộ 107 bài test Playwright e2e/unit frontend (`pnpm test:web`) đều PASSED (29.3s).
   - `pnpm lint:web` và `pnpm typecheck:web` hoàn thành với 0 cảnh báo.
   - `pnpm verify:fast` vượt qua 100% (203 pytest API tests, 28 python unittests, black formatting, ruff linter, mypy typing).

## 11. Lịch sử review: bổ sung PR #8 (Comment ID 6545873304)

Reviewer `Duyhai2005` đã rà soát commit tiếp theo và chỉ ra 6 phát hiện (F01–F06) cùng 1 yêu cầu bàn giao cho T11 (H01):

1. **F01 (BLOCKER) — Cách Ly State Kiểm Thử Migration (`isVersionSupported(2)` trên CI Production):**
   - **Nguyên nhân gốc:** `storage-migrations.spec.ts` đăng ký các bước migration động vào registry module mutable `migrationRegistry` nhưng thiếu dọn dẹp trong `afterEach`/`afterAll`. Khi chạy trên cùng một worker tiến trình Node của Playwright trong cấu hình production (`playwright.production.config.ts`), `storage-persistence.spec.ts` kế thừa registry bị ô nhiễm và báo version 2 là supported dù DB version hiện hành chỉ là 1.
   - **Khắc phục:** Bổ sung `clearMigrationSteps()` vào `afterEach` và `afterAll` của `storage-migrations.spec.ts`, đồng thời bổ sung `beforeEach` và `afterEach` trong `storage-persistence.spec.ts`.

2. **F02 (P1) — Bắt Buộc Thuộc Tính `precondition` Trên Toàn Bộ Lệnh T03:**
   - Hợp đồng wire protocol T03 quy định mọi `StorageCommand` đều bắt buộc phải có thuộc tính `precondition` (`Object.prototype.hasOwnProperty(cmd, "precondition")` và `!== undefined`). Khi lệnh không có guard, giá trị bắt buộc là `null` (`precondition: null | StoragePrecondition`).
   - Lệnh `set_order` bắt buộc phải có guard (`precondition: null` bị từ chối; yêu cầu tối thiểu `expected_root_hash`).
   - Đối tượng rỗng `precondition: {}` bị từ chối với `StorageError("invalid_data")`.

3. **F03 (P1) — Kiểm Tra Ngữ Nghĩa Lịch Gregory Canonical `LocalDate`:**
   - Thay thế regex thô bằng hàm kiểm tra ngữ nghĩa toàn diện `isCanonicalLocalDate(value)`:
     - Năm 4 chữ số `0001..9999` (từ chối năm `0000` và `>= 10000`).
     - Kiểm tra số ngày hợp lệ theo từng tháng (tháng 30 ngày, 31 ngày).
     - Quy tắc năm nhuận Gregory chuẩn xác: chia hết cho 4, ngoại trừ năm tròn thế kỷ không chia hết cho 400 (chấp nhận `2024-02-29`, `2000-02-29`; từ chối `2026-02-30`, `2025-02-29`, `1900-02-29`).
   - Áp dụng kiểm tra `isCanonicalLocalDate` đồng bộ cho mọi trường ngày tháng trong T03 DTOs (`MilestoneData.date`, `TaskData.date`, `work_item.create_recurrence.start_date`, `occurrence.replace/delete.original_date`, `series.edit/stop_future.cutoff_original_date`, `TaskTarget.original_date`, `expected_bucket.date`).

4. **F04 (P1) — Ràng Buộc Miền Giá Trị Số Nguyên 64-bit Có Dấu Của `OrderKey`:**
   - Bổ sung hàm kiểm tra chuẩn `isCanonicalInt64(value)`:
     - Định dạng chuỗi số nguyên chuẩn: `/^(0|-?[1-9][0-9]*)$/` (từ chối số có số 0 ở đầu như `"01"`, từ chối `"-0"`).
     - Sử dụng `BigInt` kiểm tra trong khoảng đóng `[-9223372036854775808, 9223372036854775807]` (tương ứng $[-2^{63}, 2^{63} - 1]$).
   - Áp dụng cho `TaskData.order_key`, `TaskTemplate.order_key`, và `set_order.payload.order_key`.

5. **F05 (P1) — Đảm Bảo Tính Liên Tục Của Khóa Mã Hóa (Authenticated Sentinel Record):**
   - Để ngăn ngừa tấn công hoặc lỗi cấu hình khi cùng một `keyId` được mở khóa với khóa `CryptoKey` khác sau khi khóa:
   - `unlockOwner()` thực hiện quy trình hai pha:
     - Lưu trữ một bản ghi sentinel xác thực mã hóa AES-256-GCM trong object store `sync_meta` với key `[owner_id, "owner-key-sentinel"]` và AAD `${owner_id}:${key_id}:sync_meta:owner-key-sentinel`.
     - Ở các lần mở khóa tiếp theo, `unlockOwner` giải mã sentinel này bằng khóa mới nạp trước khi commit unlock vào bộ nhớ hoặc IDB. Nếu tag xác thực GCM không khớp, lập tức trả về `StorageError("integrity_failed")` mà không làm thay đổi trạng thái database.
     - Nếu một owner đã có dữ liệu trong kho nhưng thiếu sentinel key, hệ thống tự động fail-closed với `StorageError("integrity_failed")`.

6. **F06 (P1/P2) — Quy Chuẩn Thứ Tự `weekdays` Tăng Ngặt & Kiểm Soát Chặt Chẽ Lệnh `undo`:**
   - `RecurrenceRule.weekdays`: các số nguyên từ 1 đến 7 bắt buộc phải được sắp xếp tăng ngặt (`weekdays[i - 1] < weekdays[i]`), từ chối danh sách trùng lặp hoặc chưa sắp xếp.
   - Lệnh `undo`:
     - Kiểm soát thuộc tính chính xác: `expected_states` chỉ chứa chính xác `["root", "hash"]`; `root` chỉ chứa chính xác `["kind", "id"]`.
     - Kiểm tra tính duy nhất: các root bị ảnh hưởng `(kind, id)` phải là duy nhất trên toàn bộ danh sách `expected_states`.
     - Ràng buộc quan hệ: trường `dependencies` của thao tác outbox bắt buộc phải chứa `original_operation_id` của lệnh undo.

7. **H01 (T11 HANDOFF REQUIREMENT) — Phối Hợp Atomic Pull-to-Shadow Cho T11:**
   - `confirmPulledOperationInTx(tx, ctx, opId, expectedRequestHash)` và `markOperationSynced(db, ctx, opId, expectedRequestHash)` chỉ là các primitive cấp thấp có trách nhiệm xác thực owner gate + trạng thái `ack_waiting_pull` + hash SHA-256 rồi xóa hàng outbox đã được ACK. Chúng **không** thể và **không** được sử dụng độc lập để hoàn thành chu trình kéo dữ liệu từ server.
   - Nhiệm vụ T11 (Network Sync Engine) khi nhận payload pull từ server bắt buộc phải thực hiện trong **1 transaction IndexedDB duy nhất (readwrite)** trên các stores liên quan:
     - Xác thực `ctx` với `owner_meta` (chưa khóa, đúng `active_key_id`, đúng `lock_epoch`) trước khi ghi bất kỳ dữ liệu nào; context stale/khóa/khác chủ phải fail-closed với `locked`.
     - Áp dụng thay đổi vào shadow records.
     - Cập nhật server pull cursor.
     - Xóa / cập nhật outbox entry tương ứng thông qua `confirmPulledOperationInTx(tx, ctx, ...)`.
   - Bất kỳ thiết kế tách rời nào giữa apply shadow, cập nhật cursor và xóa outbox đều vi phạm invariant chống mất mát dữ liệu và xung đột đồng bộ của Dayforge.

8. **Kết Quả Xác Minh Toàn Bộ Hệ Thống:**
   - 111/111 bài test Playwright e2e/unit frontend (`pnpm test:web`) PASSED.
   - 111/111 bài test Playwright Production (`pnpm test:web:prod` với `playwright.production.config.ts`) PASSED 100%.
   - `pnpm lint:web` và `pnpm typecheck:web` hoàn thành với 0 lỗi / 0 cảnh báo.
   - `pnpm verify:fast` vượt qua 100% (203 pytest tests, 28 unittest tests, ruff, black, mypy).

---

## 12. Lịch sử review: S01–S05 (key-continuity sentinel, concurrency CAS, legacy migration)

Dựa trên tài liệu đề xuất rà soát chuyên sâu (*"DAYFORGE — PR #8: Detailed Fix Proposal for Key-Continuity Sentinel"*), nhóm đã hoàn thiện triển khai và bổ sung bộ regression test tương ứng cho 5 phát hiện S01–S05:

1. **S01 (P0 — Blocker) — Tuyến Tính Hóa `unlockOwner` & CAS Atomic Commit Đa Tab:**
   - **Vấn đề gốc:** Hai tab cùng mở một fresh owner song song với hai khóa AES-GCM khác nhau (cùng `keyId`) có thể cùng đọc Phase 1 `null` rồi commit Phase 3 đè lên nhau, khiến cả hai nhận `ok=true` và ghi dữ liệu ciphertext trộn lẫn.
   - **Khắc phục:**
     - Thiết kế lại Phase 3 thành giao dịch nguyên tử Compare-And-Swap (CAS) bao quát `owner_meta`, `crypto_keys`, và `sync_meta`.
     - Trong giao dịch Phase 3, đọc lại `currentMeta` và `currentSentinel`, so sánh theo giá trị byte/thuộc tính với snapshot ở Phase 1 qua `sameOwnerMeta()` và `sameSentinel()`.
     - Nếu phát hiện trạng thái bị thay đổi bởi tab khác, giao dịch commit bị hủy (`tx.abort()`) và chuyển sang vòng lặp thử lại (tối đa `MAX_UNLOCK_ATTEMPTS = 3`).
     - Khi tab thứ hai thử lại ở Phase 1, nó nhận diện sentinel mà tab thứ nhất đã commit, chuyển sang xác thực giải mã bằng khóa của tab thứ hai. Do khác vật liệu khóa, xác thực thẻ GCM thất bại và tab thứ hai nhận lỗi có kiểu `integrity_failed` mà không chạm vào IDB.
     - Cung cấp tham số `_optionsForTest.afterPhase1Barrier` cho phép kiểm thử Playwright điều phối điểm đồng bộ Phase 1 đa tab một cách tất định (deterministic).

2. **S02 (P1) & S03 (P1) — Catalog Lưu Trữ Mã Hóa Toàn Diện & Tự Động Backfill Sentinel Cho Dữ Liệu Legacy:**
   - **Vấn đề gốc:** Triển khai cũ chỉ đếm `records` và `operations` khi kiểm tra dữ liệu hiện hữu và còn phụ thuộc vào `owner_meta.active_key_id`. Nếu một owner chỉ có `view_preferences`, `drafts`, `sync_meta`, hoặc bị mất `owner_meta`, hệ thống có thể tạo sentinel mù hoặc từ chối mở khóa dù người dùng cung cấp đúng khóa.
   - **Khắc phục:**
     - Xây dựng hàm `readUnlockSnapshot()` quét toàn bộ catalog 5 store chứa ciphertext: `records`, `operations`, `view_preferences`, `drafts`, và `sync_meta` (loại trừ sentinel).
     - Khi phát hiện ciphertext nhưng thiếu sentinel: lập inventory toàn bộ ciphertext của owner và xác thực khóa truyền vào bằng `decryptPayload()` với AAD chuẩn của từng store/record. Chỉ cần một row không giải mã được hoặc sai context/key ID là fail-closed, không cài sentinel.
     - Nếu xác thực thành công toàn bộ inventory (đúng khóa), hệ thống tự động sinh sentinel mới và lưu trữ nguyên tử vào `sync_meta` trong Phase 3 commit (backfill migration an toàn, không cần nâng `CURRENT_SCHEMA_VERSION`), đồng thời tăng `lock_epoch` để vô hiệu hóa mọi context có từ trước migration.
     - Nếu xác thực thất bại (sai khóa), lập tức trả về `StorageError("integrity_failed")`, bảo toàn nguyên vẹn ciphertext và outbox của người dùng.

3. **S04 (P2 / T11 Handoff) — Chuẩn Hóa Helper Đồng Bộ Nguyên Tử `confirmPulledOperationInTx` Cho T11:**
   - Bổ sung và export hàm `confirmPulledOperationInTx(tx, ctx, operationId, expectedRequestHash, callbacks?)` hoạt động trực tiếp trong transaction do luồng pull sở hữu.
   - Hàm xác thực `OwnerAccessContext` và đọc `owner_meta` **bên trong chính transaction của caller**, bảo đảm owner chưa khóa, đúng `active_key_id` và đúng `lock_epoch`; context stale/khóa/khác chủ bị từ chối fail-closed (`locked`), transaction thiếu `owner_meta` bị từ chối (`invalid_data`).
   - Sau khi owner gate hợp lệ, hàm kiểm tra trạng thái outbox `ack_waiting_pull` và khớp nối hash SHA-256 trước khi xóa hàng outbox; nếu không khớp, transaction bị hủy lập tức.
   - Hàm cấp cao `markOperationSynced` được tái cấu trúc để mở transaction `[owner_meta, operations]` và ủy quyền thực thi cho helper này, bảo đảm sự nhất quán tuyệt đối giữa standalone API và batch sync transaction của T11.

4. **S05 (P2 Hardening) — Ràng Buộc Phiên Bản & Bảo Vệ Toàn Vẹn Sentinel Payload:**
   - Cấu trúc plaintext sentinel payload được chuẩn hóa:
     `{ kind: "dayforge-owner-key-check", format_version: 1, owner_id, key_id }`.
   - Trong quá trình xác thực giải mã, bắt buộc kiểm tra `payload.format_version === 1`, `payload.owner_id === ownerId`, và `payload.key_id === keyId`.
   - Các định dạng payload bất thường hoặc phiên bản tương lai chưa được hỗ trợ (`format_version !== 1`) đều bị từ chối fail-closed với `integrity_failed` mà không ghi đè dữ liệu.
   - Phát hiện xung đột khi `lockOwner` diễn ra đồng thời với `unlockOwner`: giao dịch commit lập tức fail-closed với `StorageError("locked")`, ngăn ngừa stale continuation mở lại tài khoản sau khi người dùng đã đăng xuất.

5. **Kết Quả Kiểm Thử Toàn Diện (Dev & Production):**
   - Bổ sung 9 bài kiểm thử hồi quy bảo mật chuyên sâu trong `storage-security.spec.ts`:
     - `ST-S01`: Đua hai tab fresh owner khác khóa -> đơn thắng commit CAS, tab thua nhận `integrity_failed`.
     - `ST-S02`: Đua hai tab fresh owner cùng vật liệu khóa -> cả hai đều mở khóa thành công thông qua cơ chế CAS retry.
     - `ST-S04`: Gọi `lockOwner` trong khi `unlockOwner` đang chạy -> stale continuation bị hủy, trả về `locked`, owner giữ nguyên trạng thái khóa.
     - `ST-S05 & ST-S06`: Dữ liệu legacy trong `records` -> đúng khóa tự động backfill sentinel thành công, sai khóa fail-closed với `integrity_failed`.
     - `ST-S07`: Dữ liệu legacy chỉ có trong `operations` (outbox) -> đúng khóa migration thành công, sai khóa bị từ chối.
     - `ST-S08`: Dữ liệu legacy chỉ có trong `view_preferences` -> đúng khóa migration thành công, sai khóa bị từ chối.
     - `ST-S09`: Dữ liệu legacy khi `owner_meta` bị mất/corrupt -> không coi là fresh owner, bảo vệ bằng xác thực khóa.
     - `ST-S12`: Sentinel payload mang `format_version: 2` hoặc bị sửa đổi -> fail-closed với `integrity_failed`, không ghi đè sentinel.
     - `ST-S13 & S04`: `confirmPulledOperationInTx` trong transaction IDB -> xóa outbox khi đúng hash, hủy transaction khi sai hash.
   - **Toàn bộ 120/120 bài test Playwright e2e/unit frontend (`pnpm test:web`) PASSED.**
   - **Toàn bộ 120/120 bài test Playwright Production (`pnpm test:web:prod`) PASSED.**
   - `pnpm lint:web` và `pnpm typecheck:web` hoàn thành với 0 lỗi / 0 cảnh báo.
   - `pnpm verify:fast` vượt qua 100% (203 pytest tests, 28 unittest tests, ruff, black, mypy).

---

## 13. Lịch sử review: M01–M05 (legacy inventory, epoch invalidation, owner gate)

Maintainer `Duyhai2005` đã rà soát commit `fe0c2b75` và yêu cầu sửa 5 phát hiện còn lại (M01–M05). Toàn bộ đã được xử lý:

1. **M01 (P0) — Backfill Sentinel Phải Xác Thực Toàn Bộ Inventory Legacy:**
   - **Vấn đề gốc:** Trước đây backfill chỉ giải mã **một bản ghi mẫu** để xác thực khóa. Một dataset trộn ciphertext của nhiều khóa (hoặc row mẫu may mắn đúng khóa) có thể khiến sentinel được cài trong khi các row còn lại không đọc được bằng khóa hiện tại.
   - **Khắc phục:** `readUnlockSnapshot()` lập inventory **toàn bộ** row mã hóa thuộc owner trong 5 store: `records`, `operations`, `view_preferences`, `drafts`, `sync_meta` (loại trừ sentinel). Mỗi row được kiểm tra context (`owner_id`, `key_id`, record ID) và giải mã bằng `decryptPayload()` với AAD dẫn xuất từ store/record. Chỉ cần một row malformed, sai context, sai `key_id`, hoặc không giải mã được là fail-closed `integrity_failed`; sentinel không được cài và toàn bộ ciphertext/outbox được giữ nguyên.
   - **Tối ưu:** Inventory chỉ được quét khi sentinel vắng mặt; các lần unlock bình thường chỉ đọc sentinel và xác thực payload.

2. **M02 (P1) — Backfill Sentinel Là Thay Đổi Generation, Phải Tăng `lock_epoch`:**
   - **Vấn đề gốc:** Khi sentinel được cài trên owner đã có dữ liệu/meta từ trước, các `OwnerAccessContext` cũ vẫn giữ `lock_epoch` cũ và tiếp tục ghi/đọc được, bỏ qua generation mới.
   - **Khắc phục:** Phase 3 CAS phát hiện `newSentinelRecord !== null && (hasExistingData || meta !== null)` và tăng `lock_epoch` lên `max(1, currentEpoch + 1)` trong cùng transaction với việc cài sentinel. Mọi context tạo trước migration lập tức nhận `locked`; context do lần unlock mới trả về dùng epoch mới và hoạt động bình thường.

3. **M03 (P1) — `confirmPulledOperationInTx` Phải Xác Thực Owner Gate Trong Transaction Của Caller:**
   - **Vấn đề gốc:** Helper cũ chỉ nhận `ownerId`, không kiểm tra `owner_meta`/`lock_epoch`/`active_key_id`, nên một context stale/khóa/khác chủ vẫn có thể xóa outbox row nếu biết hash.
   - **Khắc phục:** Đổi chữ ký thành `confirmPulledOperationInTx(tx, ctx, operationId, expectedRequestHash, callbacks?)`. Helper yêu cầu transaction bao quát `owner_meta` + `operations`, đọc `owner_meta` và gọi `checkOwnerMetaRecord(meta, ctx)` **bên trong transaction** trước khi kiểm tra trạng thái/hash và xóa row. Transaction thiếu `owner_meta` → `invalid_data`; context stale/khóa/khác chủ → `locked`; hash/state sai → `integrity_failed`/`invalid_data`. `markOperationSynced` được refactor để mở transaction tương ứng và ủy quyền cho helper.

4. **M04 (P2) — Bổ Sung Regression Test Đa Tab Thật Cho Backfill Legacy:**
   - Thêm test Playwright dùng **hai page với hai kết nối IndexedDB độc lập** trong cùng browser context và barrier Phase 1 đặt tại Node (`exposeFunction`) để cả hai hoàn tất snapshot trước khi commit.
   - Kịch bản: owner legacy đã unlock, hai tab đồng thời unlock bằng khóa đúng và khóa sai. Kết quả: tab đúng thắng với epoch mới, tab sai nhận `integrity_failed`; cả hai context epoch cũ bị `locked`; tab thua không thể retry thành công; tab thắng vẫn ghi/đọc được dữ liệu mã hóa của mình.

5. **M05 (P2) — Sentinel `key_id` Bắt Buộc, Không Fallback Về Key ID Của Caller:**
   - **Vấn đề gốc:** Sentinel thiếu `key_id` từng được xử lý bằng `snap.sentinel.key_id ?? keyId`, cho phép caller "bù" key ID và che giấu row malformed.
   - **Khắc phục:** Sentinel phải có `owner_id`/`key` đúng vị trí, `key_id` là chuỗi không rỗng và **bằng đúng** `keyId` của caller. Thiếu `key_id`, sai key ID, IV/ciphertext malformed, hoặc payload sai `format_version`/owner/key đều fail-closed `integrity_failed`; row được giữ nguyên, không ghi đè.

6. **Kết Quả Kiểm Thử:**
   - Bổ sung/cập nhật các test hồi quy trong `frontend/tests/storage-security.spec.ts`:
     - `M01`: dataset trộn hai khóa → cả hai unlock đều `integrity_failed`, không có sentinel, 2 row ciphertext còn nguyên.
     - `M01`: inventory đủ 5 store với `sync_meta` bị corrupt → `integrity_failed`, không sentinel, đủ 5 row còn nguyên; phục hồi → unlock thành công và cài sentinel.
     - `M02`: legacy meta epoch `7` → backfill trả epoch `8`; context epoch `7` bị `locked` khi write/read; context epoch `8` ghi thành công.
     - `M05`: sentinel thiếu `key_id` → `integrity_failed`, row vẫn tồn tại và vẫn thiếu `key_id`.
     - `ST-S13 & M03`: transaction thiếu `owner_meta` → `invalid_data`; stale epoch / wrong owner / locked owner → `locked`; row outbox chỉ bị xóa khi context + state + hash đều hợp lệ.
     - `M04`: race hai tab thật → khóa đúng thắng epoch `2`, khóa sai `integrity_failed`, stale context hai tab `locked`, winner write/read thành công.
   - **Toàn bộ 125/125 bài test Playwright e2e/unit frontend (`pnpm test:web`) PASSED.**
   - **Toàn bộ 125/125 bài test Playwright Production (`pnpm test:web:prod`, bản build production) PASSED.**
   - `tsc --noEmit` và `eslint . --max-warnings=0` trên `frontend/` hoàn thành với 0 lỗi / 0 cảnh báo.
   - `pnpm build:web` (Next.js production build) thành công.
   - Backend không thay đổi trong đợt sửa này; `pnpm verify:fast` không chạy được cục bộ vì môi trường hiện tại không có `uv`, sẽ được CI xác nhận.

---

## 14. Lịch sử review: M06 — ciphertext legacy trong transaction CAS

Commit `c4638f3` đóng race giữa việc chụp snapshot/giải mã toàn bộ legacy inventory và Phase 3 CAS:

- Phase 1 duyệt `records`, `operations`, `view_preferences`, `drafts` và `sync_meta` bằng **IndexedDB cursor** thay vì `getAll()`. Các ciphertext vẫn được lưu trong snapshot để so sánh nhưng không tạo thêm mảng `getAll()` tạm thời cho mỗi store.
- Khi **tạo mới hoặc backfill sentinel**, Phase 3 mở **một transaction `readwrite` trên cả bảy store** (năm ciphertext stores cộng `owner_meta`, `crypto_keys`).
- Trong transaction này, code duyệt cursor và so khớp danh tính owner/store/record, `key_id`, IV và toàn bộ ciphertext bytes với snapshot đã giải mã; phát hiện row mới, bị xóa, thay đổi hoặc malformed sẽ abort CAS và retry từ Phase 1.
- Transaction còn giữ lock đọc-ghi trên toàn bộ stores trong lúc so khớp và tăng `lock_epoch`/cài sentinel, nên những write khác hoặc được kiểm tra trước commit, hoặc bị đẩy về sau epoch bump và sẽ bị owner gate từ chối.
- Regression **M06** mô phỏng context cũ ghi thêm encrypted preference với khóa khác ngay sau Phase 1. Migration phải phát hiện conflict, thử lại và trả `integrity_failed` **mà không cài sentinel hoặc xóa các ciphertext cũ**.

### Ràng buộc T11 trong bản M06 (lịch sử, đã thay thế)

Bản ghi cũ nhắc tới `markOperationSynced()` như API tạm thời. API production đó đã bị gỡ; tích hợp hiện tại phải theo mục 7 và dùng `confirmPulledOperationInTx()` trong transaction do pull sở hữu.

> Kết quả CI phải được kiểm tra trên GitHub Actions; mục 2 chỉ ghi những run và SHA đã quan sát.

## 15. PR #8 follow-up hiện tại — R01–R04 và N07–N10

**Cập nhật:** 01/11/2026
**Implementation commit:** `29bada5`, dựa trên `bc63108`. CI ở đầu tài liệu hiện xác nhận SHA nền; CI cho implementation commit sẽ được cập nhật sau khi push.

- **R01–R04:** input persist được snapshot trước validate/hash/encrypt; sequence metadata lỗi fail-closed; HLC validation strict và quality không còn mặc định; close trong lúc read trả lỗi typed.
- **N07:** `listOutboxForReplay(ctx)` trả `{ envelope, status, requestHash }`; ACK-waiting tiếp tục replay-visible nhưng không sendable.
- **N08:** mục 7 là handoff hiện hành với chữ ký thật và transaction ownership cho pull; các mục review cũ đã được đánh dấu lịch sử.
- **N09:** `ClockInputParams.quality` bắt buộc; thiếu, `undefined`, `null` hoặc sai enum không thể được diễn giải thành `calibrated`.
- **N10:** mọi owner-scoped row được kiểm tra status, UUID, sequence uint64, hash và encrypted context trước khi lọc; row được giải mã còn được đối chiếu envelope và canonical hash. Lỗi trả `integrity_failed`, không xóa row.

| Check cục bộ | Kết quả |
|---|---|
| `pnpm lint:web` | PASS |
| `pnpm typecheck:web` | PASS |
| Dev Playwright suite (`--workers=4`) | PASS, 139/139 |
| `pnpm build:web` | PASS, optimized Next.js build |
| Production Playwright suite (`--workers=4`) | PASS, 139/139 |
| Backend `pnpm verify:fast` | Chưa chạy tại local vì thiếu `uv`; CI xanh trên SHA nền theo link đầu trang |

