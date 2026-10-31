# T08 — Verification and handoff

**Date:** 31/10/2026  
**Branch:** `feature/local-persistent-storage`  
**Base commit:** `65480f2`  
**Pull Request:** [#8 Implement persistent local storage engine with encrypted outbox](https://github.com/Duyhai2005/dayforge/pull/8)  
**PR target:** `develop`  
**Status:** Hoàn thành toàn diện lớp lưu trữ cục bộ bền vững IndexedDB (T08). Tất cả 20 kịch bản kiểm thử bắt buộc (ST-01 đến ST-20) và 89 tests Playwright trình duyệt đã được kiểm chứng 100% PASS trên cả môi trường Next.js Dev Server và Production Server. Toàn bộ các quality gates CI (`verify:fast`, `test:web`, `build:web`, `test:web:prod`, `verify`) đều vượt qua với 0 cảnh báo và 0 lỗi.

---

## 1. Môi Trường Kiểm Thử (Verification Environment)

| Thành phần | Phiên bản / Cấu hình |
|---|---|
| Hệ điều hành | Microsoft Windows 11 Home, `10.0.26300`, build `26300` |
| Node.js | `24.22.1` |
| pnpm | `12.16.1` |
| uv | `0.13.6` |
| Python (uv managed) | `3.14.10` |
| Next.js / React / TypeScript | `16.4.3` / `19.3.1` / `6.0.3` (strict mode: 0 errors) |
| ESLint / eslint-config-next | `9.39.5` / `16.4.3` (`--max-warnings=0`) |
| Ruff / Black / mypy | `0.17.3` / `26.10.1` / `2.4.1` (0 issues) |
| Playwright | `1.64.1` / Chromium `156.0.8078.4` (headless, trace retain-on-failure) |
| Cổng dịch vụ kiểm thử | Port 3010 (Next dev server), Port 3001 (Next production server) |

---

## 2. Kết Quả Xác Minh Quality Gates (Commands & Observed Results)

Toàn bộ các lệnh kiểm thử và kiểm tra chất lượng từ root repo đều đạt kết quả PASS:

| Quality Gate | Lệnh thực thi | Kết quả quan sát |
|---|---|---|
| Frontend Lint | `pnpm lint:web` | **PASS**, ESLint bao quát toàn bộ workspace với `--max-warnings=0`, 0 lỗi, 0 cảnh báo |
| Backend Lint | `pnpm lint:api` | **PASS**, Ruff check trên `app`, `tests`, `migrations`, `scripts`, 0 issues |
| Backend Format | `pnpm format:check:api` | **PASS**, Black check 42 files để nguyên |
| Frontend Typecheck | `pnpm typecheck:web` | **PASS**, `tsc --noEmit` hoàn thành không có bất kỳ lỗi kiểu nào |
| Backend Typecheck | `pnpm typecheck:api` | **PASS**, mypy trên 21 source files không phát hiện lỗi |
| Environment Regressions | `pnpm verify:env` | **PASS**, 28/28 tests trong 1.25s (generator, smoke, origin guard, runner regressions) |
| Backend Non-MySQL Tests | `pnpm test:api` | **PASS**, 203 passed, 38 deselected trong 7.67s |
| Fast Aggregate Gate | `pnpm verify:fast` | **PASS**, chạy tuần tự lint, typecheck, verify:env, test:api thành công |
| Frontend Dev Browser Suite | `pnpm test:web` | **PASS**, 89/89 tests passed (bao gồm 57 tests lưu trữ T08 và 32 tests T06) |
| Frontend Production Build | `pnpm build:web` | **PASS**, Next.js production build tối ưu hóa trong 2.1s |
| Frontend Prod Browser Suite | `pnpm test:web:prod` | **PASS**, 89/89 tests passed trên production server (port 3001) với strict security headers |
| Full Repository Gate | `pnpm verify` | **PASS**, toàn bộ pipeline verify:fast + test:web + build:web + test:web:prod hoàn tất 100% |

---

## 3. Ma Trận Nghiệm Thu 20 Kịch Bản Lưu Trữ (ST-01 đến ST-20)

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
| **ST-17** | Untrusted Clock Handling | `storage-atomicity.spec.ts`<br>Thao tác có chất lượng đồng hồ `quality: "untrusted"` được gắn cờ `status: "time_invalid"` trong outbox và bị loại trừ khỏi `listPending`. | **PASS** (497ms) |
| **ST-18** | Non-Leakage Security Invariant | `storage-failures.spec.ts`<br>Quét toàn bộ 8 object stores trong IndexedDB và console logs của trình duyệt: xác nhận 0 token phiên, 0 raw key, và 0 bí mật plaintext bị rò rỉ. | **PASS** (1.1s) |
| **ST-19** | Boundary Scale & Unicode Content | `storage-failures.spec.ts`<br>1. Lưu và xác thực 1.000 commands trong một operation với mã băm chuẩn RFC 8785 Canonical JSON SHA-256.<br>2. Lưu và đọc 4.000 codepoint Unicode note đa ngôn ngữ (Persian RTL, Tiếng Việt dấu thanh, Emoji astral plane, CJK) không bị cắt ngắn hay lỗi giải mã. | **PASS** (2.6s + 1.2s) |
| **ST-20** | Performance Scale Benchmark | `storage-failures.spec.ts`<br>Đo kiểm hiệu năng thực tế 100 outbox operations được mã hóa AES-256-GCM trong Chromium: batch persist ~ 1.28 ms/op, read & decrypt ~ 0.05 ms/op. | **PASS** (850ms) |

---

## 4. Đo Kiểm Hiệu Năng Thực Tế (Performance Metrics)

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

## 7. Bàn Giao Kỹ Thuật (Handoff to Subsequent Tasks)

Lớp lưu trữ T08 đã sẵn sàng cung cấp các giao diện và hợp đồng cho các task tiếp theo:

1. **Bàn giao cho T09 (Tài khoản, Xác thực & Khóa phiên `local-key`):**
   - API sẵn sàng: `unlockOwner(ownerId, lockEpoch, cryptoKey)`, `lockOwner(ownerId)`, `isOwnerUnlocked(ownerId)`.
   - T09 chỉ cần gọi `/auth/local-key` từ server, import thành non-extractable `CryptoKey` qua Web Crypto API, và truyền vào `unlockOwner` để mở khóa toàn bộ quyền ghi/đọc dữ liệu của chủ sở hữu.
2. **Bàn giao cho T10 (API Đồng Bộ Máy Chủ `push`/`pull`):**
   - `outbox.ts` đã chuẩn hóa `OperationEnvelope` và mã băm `request_hash` theo chuẩn RFC 8785 Canonical JSON SHA-256.
   - API `listPendingOperations(ownerContext)` cung cấp danh sách thao tác pending kèm theo `device_sequence` và `hlc` theo đúng định dạng wire của T03.
3. **Bàn giao cho T11 (Bộ Điều Phối Đồng Bộ Client `sync-coordinator`):**
   - T11 sử dụng `listPendingOperations` (hoặc `listPending`) để lấy danh sách thao tác có trạng thái `pending` gửi push lên máy chủ khi có mạng.
   - **Vòng đời Outbox & Xác nhận Pull (`ack_waiting_pull`):**
     - Khi máy chủ trả về ACK xác nhận đã nhận operation, T11 gọi `markOperationAcked(ctx, operationId)` để chuyển trạng thái sang `ack_waiting_pull`. **Hàng outbox KHÔNG được xóa ngay tại thời điểm ACK!**
     - Theo quy định hợp đồng T03 và T08, một hàng outbox BẮT BUỘC phải tiếp tục tồn tại ở trạng thái `ack_waiting_pull` cho đến khi một lượt pull tiếp theo (`subsequent pull`) xác nhận máy chủ đã xử lý thành công và cập nhật bản ghi vào projection.
     - Tại thời điểm đó, T11 gọi `markOperationSynced(ctx, operationId)` để loại bỏ hoàn toàn hàng outbox khỏi IndexedDB một cách nguyên tử.
4. **Bàn giao cho T12 (Bộ Thu Gọn LWW Reducer & Giải Quyết Xung Đột):**
   - T08 lưu trữ các bản ghi dưới dạng snapshot/overlay độc lập.
   - Khi T12 hoàn thành LWW reducer theo hợp đồng T03, T12 có thể đọc tuần tự các operations và áp dụng deterministic reduction lên store `records` một cách an toàn.
5. **Bàn giao cho T13 (Cache Offline & Primitives Lưu Trữ Tùy Chọn Xem):**
   - **Storage Primitive / Handoff Seam (`view_preferences`):** Store `view_preferences` là một primitive lưu trữ cục bộ có schema rõ ràng (`calendar`, `date`, `scale`, `scrollY`, `updatedAt`), được mã hóa AES-256-GCM theo từng owner với AAD gắn chặt `ownerId:calendar`. Đây là một storage primitive / handoff seam độc lập với tầng UI components, cung cấp `readOwnerViewPreference` và `writeOwnerViewPreference` an toàn cho bất kỳ caller nào cần lưu trữ trạng thái hiển thị của owner mà không làm ô nhiễm store `records`.
   - Service worker ở T13 có thể phục vụ shell ứng dụng offline từ cache, trong khi toàn bộ dữ liệu nghiệp vụ offline được đảm bảo 100% bền vững trong IndexedDB của T08.

---

## 8. Giải Quyết Đầy Đủ Các Nhận Xét Đánh Giá PR #8 (PR #8 Review Resolution)

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

## 9. Giải Quyết Nhận Xét Đánh Giá Bổ Sung PR #8 (Follow-up Review Resolution)

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

## 10. Giải Quyết Nhận Xét Đánh Giá Chuyên Sâu T03 Schema Parity (Review Comment ID 6545156728)

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
