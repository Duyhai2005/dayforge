# DAYFORGE — T08: Kế hoạch triển khai lớp lưu trữ cục bộ bền vững

**Repository:** `Duyhai2005/dayforge` · **Base:** `develop` · **Branch đề xuất:** `feature/local-persistent-storage`  
**Ngày lập:** 31/10/2026 · **Trạng thái:** Kế hoạch, đang triển khai  
**Nguồn yêu cầu:** `docs/tasks/README.md` (T08), hợp đồng T03 tại `docs/tasks/t03/{data,sync,auth}-contract.md`, shell T06 và quality gates T07.

## 1. Mục tiêu và kết quả

Tạo nền lưu trữ browser dùng IndexedDB, có schema version/migration, API đọc/ghi và transaction bất biến để một hành động được coi là **đã lưu trên thiết bị** chỉ khi dữ liệu local, operation outbox, HLC, device sequence và metadata phụ thuộc đã commit thành công trong **cùng một transaction**. Dữ liệu còn nguyên qua reload, lỗi quota / blocked / denied / corruption được thông báo đúng; dữ liệu của owner khác không thể đọc hoặc gửi nhầm.

**T08 chỉ tạo hạ tầng lưu trữ và phép thử có dữ liệu tổng hợp.** Không bật nút tạo tác vụ thật hoặc tuyên bố đã đồng bộ; UI lịch thực và CRUD thuộc T14–T23; auth/unlock key và đăng xuất thuộc T09; server push/pull T10, coordinator T11, canonical reducer/LWW T12; service worker thuộc T13. T08 phải để ra các interface nối các task này mà không phải phá schema.

### Điều kiện đầu vào
- Đọc hợp đồng T03 trước code. Rà soát trạng thái `develop` và T07 merged/chạy CI; không giả định branch PR chưa merge là baseline.
- Kiểm tra `frontend/` hiện có App Router, `frontend/lib/calendar/view-state.ts`, Playwright/ESLint/TypeScript strict; package root có `verify:fast`, `verify`, `test:web`, `build:web`.
- Rà soát JSON schema/fixtures T03 và các mẫu operation để tránh tự đặt tên wire mới trái contract.

## 2. Quyết định thiết kế và ranh giới

1. **Chọn IndexedDB native + adapter có type**, hoặc Dexie sau khi so sánh khả năng transaction, browser support và bundle size. Dexie đang là đề xuất chưa chốt, không tùy tiện thêm dependency. Kế hoạch file dưới đây mô tả logical modules; cần điều chỉnh theo adapter thực tế.
2. **Không đưa business data lên `localStorage`, `sessionStorage`, React Server Components hoặc Next.js cache.** `sessionStorage` T06 chỉ chứa view preferences tạm. Không tạo route debug lộ data.
3. **Per-owner partition bắt buộc.** Mọi record business/outbox/clock/view metadata gắn scope owner; owner assertion từ wire không thay được quyền cấp từ auth. Namespace DB có thể chung với composite owner keys, nhưng owner gate là bắt buộc ở mọi read/write; không tìm kiếm qua toàn bộ owners khi unlocked.
4. **Encryption-first.** Các payload lịch, outbox, shadow, cursor, draft/undo nhạy cảm phải là AES-256-GCM ciphertext trong IDB ngay từ commit đầu tiên. Key được cấp bởi T09 từ `/auth/local-key`, import thành nonextractable `CryptoKey`. T08 xây crypto adapter + fake/injected test key, không phát hành key bền tự tạo hay ghi plaintext demo. Lưu `CryptoKey` bằng structured clone ở trạng thái unlocked theo T03; key không nằm trong string/debug logs. Với owner chưa unlock, API trả `locked` và từ chối ghi/đọc nghiệp vụ.
5. **AAD cố định** gắn `owner_id`, `key_id`, `store`, `record_id`, và schema/record format version nếu đã lựa chọn; mỗi lần mã hóa IV CSPRNG 96-bit mới, tag 128-bit. Không reuse IV cùng key; integrity/decoding fail phải chuyển trạng thái lỗi an toàn.
6. **Outbox operation immutable.** Lưu envelope nguyên gốc, hash/canonical JSON theo RFC 8785 khi nối T10/T11; không tự stringify lại rồi đổi body khi retry. Dùng typed operation dựa trên T03; `device_sequence` là số thập phân unsigned 64-bit, không ép Number gây mất chính xác.
7. **HLC/sequence atomic.** Cấp sequence, cập nhật clock, encrypt snapshot/overlay và outbox trong một `readwrite` transaction. Bất kỳ lỗi nào rollback toàn bộ. HLC evidence gồm `physical_ms`, `logical`, `calibration_id`, `raw_wall_ms`, `quality` đúng contract; không tự lấy `Date.now()` làm clock đã hiệu chỉnh.
8. **Projection/cache là derived state có quy tắc.** Khi reducer đầy đủ chưa có ở T12, không giả vờ đã tính canonical materialized state. Ghi `local overlay`/record test có version và chỉ tích hợp reducer đúng T03 sau này. Giữ nguyên operation log và pending cho replay; không giải quyết conflict trong storage adapter.
9. **Không mở service worker** ở T08, do T13 chịu trách nhiệm shell offline/network cache. IndexedDB không đảm bảo tự khởi chạy app khi mất mạng nếu shell chưa được cache.
10. **Không tự động xóa DB khi lỗi** (quota, invalid key, migration fail, decode corruption). Ưu tiên khóa store, hiển thị lỗi và bảo toàn dữ liệu cần cứu.

## 3. Thiết kế module / file dự kiến

```text
frontend/
  lib/
    storage/
      db.ts                  # open/close/version/blocked/versionchange
      schema.ts              # object stores, indexes, schema version, upgrade
      errors.ts              # typed storage errors
      owner-gate.ts          # owner + lock epoch checks
      crypto.ts              # AES-GCM, AAD, encrypted record codec
      repositories.ts        # reads, lists, mutations, paging
      outbox.ts              # immutable envelope, statuses, listing
      unit-of-work.ts        # atomic local write + outbox + HLC + sequence
      clock-state.ts         # persistence/validation only; HLC evolution from T03
      migration.ts           # explicit upgrade logic, version compatibility
      view-preferences.ts    # owner/device scoped view state migration
      index.ts               # deliberately small public API
  tests/
    storage-persistence.spec.ts
    storage-atomicity.spec.ts
    storage-migrations.spec.ts
    storage-security.spec.ts
    storage-failures.spec.ts
    storage-view-state.spec.ts
  components/
    storage/ (only if a visible, honest status surface is needed)
docs/tasks/t08/
  plan.md
  review-and-verification.md
```

### Đề xuất object stores (đối chiếu schema T03)

| Store | Key | Payload | Mục đích |
|---|---|---|---|
| `owner_meta` | `owner_id` | owner scope, `lock_epoch`, `locked`, active key ref; minimal unencrypted fields | Lock/owner gate |
| `crypto_keys` | `[owner_id,key_id]` | structured-cloned nonextractable `CryptoKey` ở trạng thái unlocked | Reload offline khi đúng owner chưa logout |
| `device_meta` | `[owner_id,device_id]` | encrypted clock/calibration metadata và sequence (minimal technical counters nếu cần atomic indexing) | HLC/sequence |
| `records` | `[owner_id,kind,id]` | encrypted versioned business record/overlay | Domain projections, placeholders T14+ |
| `operations` | `[owner_id,operation_id]` | encrypted immutable original envelope + hash; restricted technical status | Pending replay/diagnostics |
| `sync_meta` | `[owner_id,key]` | encrypted cursor, shadow, checkpoint | T10–T12 handoff |
| `view_preferences` | `[owner_id,calendar]` | encrypted owner state / clearly non-sensitive UI fields | Replace temporary preferences deliberately |
| `drafts` | `[owner_id,draft_id]` | encrypted draft/undo | Preserve dirty work on failures |

## 4. Trình tự triển khai theo TDD

- **P0** — Audit baseline và tạo branch (`feature/local-persistent-storage`).
- **P1** — Browser IndexedDB runtime + versioned schema (`db.ts`, `schema.ts`, `errors.ts`, `migration.ts`, `storage-persistence.spec.ts`).
- **P2** — Owner gating, encryption và key lifecycle seam (`owner-gate.ts`, `crypto.ts`, `storage-security.spec.ts`).
- **P3** — Outbox immutable + atomic unit-of-work (`outbox.ts`, `unit-of-work.ts`, `clock-state.ts`, `repositories.ts`, `storage-atomicity.spec.ts`).
- **P4** — Migration, phiên bản ngược và bảo toàn pending (`migration.ts`, `storage-migrations.spec.ts`).
- **P5** — View preferences của T06 và wiring UI an toàn (`view-preferences.ts`, `frontend/lib/calendar/view-state.ts`, `storage-view-state.spec.ts`).
- **P6** — Failure injection + security + performance (`storage-failures.spec.ts`, `storage-security.spec.ts`).
- **P7** — CI / tài liệu / review final (`docs/tasks/t08/review-and-verification.md`, `docs/tasks/README.md`, full verification).
