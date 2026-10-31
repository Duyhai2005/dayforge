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
   - T11 sẽ sử dụng `listPendingOperations` để lấy dữ liệu gửi push lên máy chủ khi có mạng.
   - Sau khi nhận ACK thành công từ server, T11 gọi `markOperationSynced(ownerContext, opId, serverRevision)` để cập nhật trạng thái outbox mà không làm gián đoạn các transaction đang chạy.
4. **Bàn giao cho T12 (Bộ Thu Gọn LWW Reducer & Giải Quyết Xung Đột):**
   - T08 lưu trữ các bản ghi dưới dạng snapshot/overlay độc lập.
   - Khi T12 hoàn thành LWW reducer theo hợp đồng T03, T12 có thể đọc tuần tự các operations và áp dụng deterministic reduction lên store `records` một cách an toàn.
5. **Bàn giao cho T13 (Cache Offline & Service Worker):**
   - Store `view_preferences` đã được mã hóa an toàn theo từng owner, thay thế hoàn toàn `sessionStorage` tạm của T06.
   - Service worker ở T13 có thể phục vụ shell ứng dụng offline từ cache, trong khi toàn bộ dữ liệu nghiệp vụ offline được đảm bảo 100% bền vững trong IndexedDB của T08.
