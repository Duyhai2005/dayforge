# T09 — Tài khoản và phiên đăng nhập Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hoàn thiện tài khoản một chủ sở hữu, xác minh email, mật khẩu, phiên an toàn và mở/khóa vault local theo hợp đồng T03.

**Architecture:** FastAPI là nguồn xác thực duy nhất; MySQL lưu owner, session, token, local key đã wrap và rate limit. Frontend gọi API cùng origin, giữ dữ liệu lịch mã hóa trong IndexedDB, chỉ mở vault sau lần đăng nhập có mật khẩu và khóa local khi người dùng chủ động đăng xuất.

**Tech Stack:** Python 3.14.10, FastAPI 0.162.0, Pydantic 2.14.1, SQLAlchemy 2.1.6, Alembic 1.19.2, MySQL, Next.js 16.4.3, React 19.3.1, TypeScript, IndexedDB/Web Crypto, Playwright; Argon2id và bộ phân tích email được duy trì, SMTP sink chỉ cho phát triển.

**Spec:** [T03 — hợp đồng tài khoản và khóa local](../t03/auth-contract.md), [T03 — hợp đồng API](../t03/api-contract.md), [T02 — thiết kế UI và luồng tài khoản](../t02/design.md), [T09 trong danh sách task](../README.md), [T08 — bàn giao owner gate](../t08/review-and-verification.md).

## Global Constraints

- `OWNER_EMAIL` chỉ ở cấu hình server; không đưa allowlist vào bundle hoặc response công khai.
- Email: bỏ khoảng trắng ASCII hai đầu; local-part chuẩn hóa NFC và giữ hoa/thường; domain chuyển IDNA sang ASCII rồi lowercase; tối đa 254 byte UTF-8; chỉ nhận một mailbox hợp lệ, không display name, danh sách địa chỉ hoặc ký tự điều khiển.
- Mật khẩu sau NFC dài **15–128 Unicode code point**; transport tối đa **1.024 code point và 4.096 byte UTF-8** trước chuẩn hóa; body auth tối đa **16 KiB**.
- Argon2id v19: `m = 65536 KiB`, `t = 3`, `p = 1`, salt CSPRNG 16 byte, output 32 byte; không thấp hơn baseline `m = 19456 KiB, t = 2, p = 1` nếu có lý do giảm RAM.
- Kiểm tra mật khẩu mới bằng blocklist có version, đóng gói backend; không gửi mật khẩu tới dịch vụ kiểm tra bên ngoài.
- Session token, email token và CSRF token mỗi loại **32 byte CSPRNG**, base64url không padding; DB chỉ lưu SHA-256 verifier cho session/email token.
- `token` trong HTTP là 43 ký tự base64url của 32 byte; `logout_ticket` là 64 ký tự base64url của 48 byte.
- Anonymous session tuyệt đối **30 phút**; session thường idle/absolute **30 phút/12 giờ**; remembered idle/absolute **7 ngày/30 ngày**; recent-password window **5 phút**; email verify/reset token TTL **24 giờ/30 phút**.
- Cookie `__Host-dayforge-session`: `Secure; HttpOnly; SameSite=Lax; Path=/`, không `Domain`; cookie không chứa email, owner hoặc quyền tự xác nhận.
- Cookie session thường không có `Max-Age`/`Expires`; cookie remembered không vượt absolute expiry còn lại. `password_authenticated_at` không được kéo dài bởi polling hoặc sync.
- Mọi POST auth cần `application/json`, Origin khớp chính xác `PUBLIC_ORIGIN`, CSRF token trong `X-CSRF-Token`; thiếu Origin chỉ dùng Referer đúng origin; chặn `Sec-Fetch-Site: cross-site`.
- Auth request DTO từ chối field lạ và coercion chuỗi thành boolean; không bật CORS credentials cho origin khác. Timestamp wire là RFC 3339 UTC có hậu tố `Z`; token hết hạn khi `now >= expires_at`.
- Không nhận `owner_id` từ request để cấp quyền; login lỗi luôn trả `401 invalid_credentials`; email token sai purpose trả `400 email_token_invalid`, đã dùng trả `409 email_token_used`, hết hạn trả `410 email_token_expired`; rate limit trả `429` cùng `Retry-After` và `retry_after_seconds`.
- Chỉ thiết lập owner đầu tiên cho email allowlist đã xác minh cùng `WorkspaceSettings` `Asia/Bangkok`, UTC offset `420` phút, tuần bắt đầu `1` trong một transaction; `owner_slot = 1`; xác minh/reset không tự đăng nhập, không có public sign-up hoặc Google login.
- Email request trả trung tính `{status:"accepted",resend_after_seconds:60}`; callback token nằm ở URL fragment, chỉ POST sau thao tác người dùng, không đưa token vào storage, log hoặc telemetry.
- Digest token đã dùng/hết hạn được giữ 7 ngày để phân biệt link cũ rồi xóa; token bearer không lưu plaintext.
- Rate limit rolling window, atomic giữa workers: login thất bại **5/15 phút/email** và **30/15 phút/IP**; register+resend+forgot gộp **ít nhất 60 giây/email, tối đa 5/giờ và 10/ngày/email, 30/giờ và 100/ngày/IP**; verify/reset **10/phút/token digest và 60/phút/IP**; session/local-key **60/phút/session và 120/phút/IP**. Email/IP pseudonym dùng HMAC; chỉ lấy IP từ peer hoặc proxy tin cậy.
- `/auth/local-key` chỉ trả key sau xác thực mật khẩu trong 5 phút; khóa AES-256-GCM ngẫu nhiên 32 byte, import thành `CryptoKey` không extractable; reset không đổi owner hoặc local key.
- Logout ticket là `base64url(session_id_bytes || HMAC-SHA256(K_LOGOUT, "logout-v1" || session_id_bytes))`; `K_LOGOUT` tách biệt, có version và kiểm tra được tới khi mọi session ký bằng key đó hết hạn.
- `/api/v1/auth/*` trả `Cache-Control: private, no-store`, `Pragma: no-cache`; không log password, token, cookie, CSRF, logout ticket, local key hoặc full email link.
- Auth event log giữ mặc định 30 ngày; rate-limit bucket tối đa 48 giờ; không ghi email đầy đủ hoặc token/IP thô.
- Logout khóa local ngay, tăng `lock_epoch`, xóa CryptoKey khỏi IndexedDB nhưng giữ ciphertext/outbox; offline giữ logout ticket giới hạn quyền revoke đúng phiên đó để gửi lại khi có mạng.

## Review Focus

- Email Unicode/IDNA, local-part phân biệt hoa thường, alias không được gộp và địa chỉ ngoài allowlist phải canonicalize/được từ chối đúng; khóa bằng `test_email_canonicalization_preserves_local_case_and_idna`, `test_email_does_not_collapse_aliases` và `test_register_is_neutral_for_non_allowlisted_email` (Task 1, Task 3).
- Hai request cùng consume token verify/reset hoặc link bị scanner GET phải tạo đúng một tác dụng; khóa bằng `test_verification_race_creates_one_owner`, `test_email_get_does_not_consume_token` và `test_reset_race_revokes_once` (Task 3).
- Origin thiếu/null/suffix-sai/cross-site và CSRF sai không được chạy mutation; anonymous CSRF phải ổn định giữa các tab cùng session; khóa bằng `test_auth_posts_reject_untrusted_origin_or_csrf` và `test_anonymous_session_shares_csrf_across_tabs` (Task 2).
- Idle timeout, absolute timeout, đổi `auth_version` và recent-password quá 5 phút phải chặn server-side; khóa bằng `test_authenticated_session_enforces_idle_absolute_and_auth_version` và `test_local_key_requires_recent_password` (Task 2, Task 3).
- Logout offline hoặc từ một tab khác phải khóa mọi tab, giữ pending/ciphertext và chỉ revoke session trong ticket; khóa bằng `logoutOfflineLocksAllTabsAndPreservesPendingData` và `test_logout_ticket_revokes_only_target_session` (Task 4, Task 2).

---

## File Map

| File | Trách nhiệm |
| --- | --- |
| `backend/app/models/auth.py`, `backend/migrations/versions/0002_authentication.py` | Bảng session, email token, local key, rate limit và email delivery job đã mã hóa. |
| `backend/app/services/email_address.py`, `passwords.py`, `auth_crypto.py`, `auth_rate_limits.py` | Canonical email, chính sách/hash mật khẩu, wrap key/token/ticket và bucket giới hạn request. |
| `backend/app/core/auth_security.py`, `backend/app/services/sessions.py`, `backend/app/api/auth.py`, `backend/app/schemas/auth.py` | Origin/CSRF gate, session, DTO và HTTP contract `/api/v1/auth/*`. |
| `backend/app/services/auth.py`, `backend/app/services/email_delivery.py` | Transaction vòng đời owner/token/session và hàng đợi email mã hóa cùng adapter SMTP. |
| `frontend/lib/services/auth.ts`, `frontend/lib/auth/session-provider.tsx`, `frontend/lib/auth/device-auth-state.ts` | Client API, trạng thái phiên liên tab, logout ticket pending và tích hợp owner gate. |
| `frontend/components/account/account-form.tsx`, `frontend/components/account/email-callback.tsx`, `frontend/app/(account)/*` | Form đăng nhập/thiết lập/gửi lại/quên/reset/xác minh và trạng thái an toàn cho callback. |
| `frontend/lib/storage/schema.ts`, `frontend/lib/storage/auth-state.ts`, `frontend/lib/storage/migrations/auth-state-v2.ts` | IndexedDB v2 và store metadata tối thiểu giữ logout ticket offline; không đổi envelope dữ liệu lịch T08. |
| `backend/tests/unit/*auth*`, `backend/tests/api/test_auth*.py`, `backend/tests/integration/test_auth*.py`, `frontend/tests/auth-routes.spec.ts`, `frontend/tests/auth-session.spec.ts` | Kiểm chứng chính sách, API/MySQL, liên kết email, callback, owner gate và UX. |
| `backend/.env.example`, `scripts/init_local.py`, `scripts/test_backend.py`, `compose.auth-mailpit.yaml`, `docs/development.md` | Cấu hình server local có secret sinh riêng, test keys, SMTP sink phát triển và hướng dẫn nhận email thử. |
| `docs/tasks/t09/review-and-verification.md`, `docs/tasks/README.md` | Kết quả kiểm chứng, giới hạn môi trường và trạng thái task. |

### Task 1: Schema xác thực, cấu hình và primitive bảo mật

**Files:**
- Create: `backend/app/models/auth.py`
- Create: `backend/app/services/email_address.py`
- Create: `backend/app/services/passwords.py`
- Create: `backend/app/services/auth_crypto.py`
- Create: `backend/app/services/auth_rate_limits.py`
- Create: `backend/migrations/versions/0002_authentication.py`
- Create: `backend/tests/unit/test_email_address.py`
- Create: `backend/tests/unit/test_password_policy.py`
- Create: `backend/tests/unit/test_auth_crypto.py`
- Create: `backend/tests/integration/test_auth_migration.py`
- Modify: `backend/tests/integration/test_initial_migration.py`
- Modify: `backend/app/models/__init__.py`
- Modify: `backend/app/core/config.py`
- Modify: `backend/.env.example`, `scripts/init_local.py`, `scripts/test_backend.py`, `scripts/tests/test_init_local.py`
- Modify: `backend/pyproject.toml`, `backend/uv.lock`, `backend/tests/conftest.py`

**Interfaces:**
- Produces: `canonicalize_email(value: str) -> CanonicalEmail`; `validate_new_password(password: str, email: str) -> str` trả mật khẩu NFC hoặc lỗi theo contract; `hash_password(password: str) -> str`; `verify_password(password: str, password_hash: str | None) -> bool`; `wrap_owner_key(owner_id: UUID, key_id: UUID, raw_key: bytes, kek: bytes, kek_version: int) -> WrappedKey`; `unwrap_owner_key(...) -> bytes`.
- Produces models `Session`, `EmailToken`, `OwnerLocalKey`, `AuthRateLimit`, `EmailDeliveryJob`; `0002_authentication` kế thừa `0001_owner_workspace` và không sửa hoặc xóa bảng/ID `User` hiện hữu.

- [x] **Step 1: Viết test thất bại cho canonical email, password policy, key wrapping và migration.** Tên test phải gồm `test_email_canonicalization_preserves_local_case_and_idna`, `test_email_does_not_collapse_aliases`, `test_email_rejects_multiple_mailboxes_controls_and_over_254_bytes`, `test_password_nfc_and_15_to_128_codepoints`, `test_password_rejects_blocklist_and_email_derived_values`, `test_owner_key_wrap_round_trip_binds_owner_key_and_kek_version`, `test_auth_migration_adds_auth_tables_and_preserves_existing_owner_schema`.

```python
def test_email_canonicalization_preserves_local_case_and_idna():
    result = canonicalize_email(" Owner@BÜCHER.example ")
    assert result.canonical == b"Owner@xn--bcher-kva.example"
```

- [x] **Step 2: Chạy test để xác nhận đang thất bại.**

Run: `pnpm test:api -- tests/unit/test_email_address.py tests/unit/test_password_policy.py tests/unit/test_auth_crypto.py`
Expected: FAIL vì module/hàm auth chưa có.

- [x] **Step 3: Thêm models, migration, cấu hình và primitive.** Migration tạo đúng các cột/bất biến trong T03; owner local key dùng AES-GCM với AAD gắn `owner_id`, `key_id`, thuật toán và `kek_version`. Bổ sung `Settings`/`ENV_FIELDS` cho `OWNER_EMAIL`, `LOCAL_KEY_KEK_B64`, `LOCAL_KEY_KEK_VERSION`, `LOGOUT_TICKET_KEY_B64`, `AUTH_RATE_LIMIT_KEY_B64`, `AUTH_EMAIL_OUTBOX_KEY_B64`, `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_FROM`; các key mã hóa/HMAC decode đúng 32 byte. Ghi chúng ở `backend/.env`; `scripts/init_local.py` sinh giá trị secret riêng cho từng checkout, không tự đặt `OWNER_EMAIL` và không in secret; test fixtures dùng test keys cố định và `scripts/test_backend.py` truyền test keys ngẫu nhiên chỉ cho MySQL test process.

- [x] **Step 4: Chạy unit test và kiểm tra migration trên MySQL cô lập.**

Run: `pnpm test:api -- tests/unit/test_email_address.py tests/unit/test_password_policy.py tests/unit/test_auth_crypto.py`
Expected: PASS; canonical email giữ hoa/thường local-part, chuyển domain IDNA; key unwrap sai owner/key/version thất bại.

Run: `pnpm test:api:mysql -- tests/integration/test_auth_migration.py -v`
Expected: PASS; migration mới lên head, chạy lặp an toàn và không thay ID/schema của owner T05.

- [x] **Step 5: Commit phần nền xác thực.**

```bash
git add backend scripts
git commit -m "feat: add authentication schema and security primitives"
```

### Task 2: Origin/CSRF gate và session server-side

**Files:**
- Create: `backend/app/core/auth_security.py`
- Create: `backend/app/services/sessions.py`
- Create: `backend/app/schemas/auth.py`
- Create: `backend/app/api/auth.py`
- Create: `backend/tests/api/test_auth_security.py`
- Create: `backend/tests/integration/test_auth_sessions.py`
- Modify: `backend/app/main.py`, `backend/app/core/errors.py`, `backend/tests/conftest.py`

**Interfaces:**
- Consumes: primitive/mô hình Task 1 và `Settings.public_origin`.
- Produces: `GET /api/v1/auth/session`, `POST /api/v1/auth/logout`; `get_session_context(request)`, `require_verified_owner(request)`, `validate_auth_post(request, csrf_token)`; `SessionView {authenticated, owner, session, csrf_token, server_time, logout_ticket}` đúng nullable fields trong T03. T03/API Task 3 sẽ thêm các route còn lại vào cùng router.

- [x] **Step 1: Viết test thất bại cho anonymous session, cookie, no-store, Origin và CSRF.** Trong `test_auth_security.py` đặt `test_auth_posts_reject_untrusted_origin_or_csrf`, `test_matching_referer_is_only_origin_fallback`, `test_auth_requires_application_json`, `test_auth_response_headers_are_no_store_even_on_rejection`; trong `test_auth_sessions.py` đặt `test_anonymous_session_shares_csrf_across_tabs`, `test_authenticated_session_enforces_idle_absolute_and_auth_version`, `test_logout_ticket_revokes_only_target_session`.

```python
def test_anonymous_session_shares_csrf_across_tabs(client):
    first = client.get("/api/v1/auth/session")
    second = client.get("/api/v1/auth/session")
    assert first.json()["authenticated"] is False
    assert first.json()["owner"] is None
    assert first.json()["session"] is None
    assert first.json()["logout_ticket"] is None
    assert first.json()["csrf_token"] == second.json()["csrf_token"]
    cookie = first.headers["set-cookie"].lower()
    assert "__host-dayforge-session=" in cookie
    assert "httponly" in cookie
    assert "secure" in cookie
    assert "samesite=lax" in cookie
    assert "path=/" in cookie
    assert "domain=" not in cookie
```

- [x] **Step 2: Chạy API tests để xác nhận gate đang thất bại.**

Run: `pnpm test:api -- tests/api/test_auth_security.py`
Expected: FAIL vì auth security dependency/router chưa được mount.

- [x] **Step 3: Triển khai session, CSRF và Origin gates.** Dùng cookie `__Host-dayforge-session`, token verifier SHA-256 trong DB, CSRF ổn định theo session context, idle/absolute expiry phía server và `auth_version`; cookie anonymous chỉ cấp CSRF, không có quyền lịch. Gate kiểm tra Origin chính xác với `PUBLIC_ORIGIN`, fallback Referer đúng origin, `Sec-Fetch-Site` và constant-time CSRF trước mutation. Ticket dùng đúng HMAC formula ở Global Constraints, logout `204` idempotent và chỉ xóa cookie nếu đang trỏ phiên bị revoke; email/local key/auth response không được ghi log. Trả Problem Details registry T03 và no-store.

- [x] **Step 4: Chạy API/MySQL test và xác nhận trường hợp biên.**

Run: `pnpm test:api -- tests/api/test_auth_security.py`
Expected: PASS với Origin thiếu/null/khác origin/cross-site và CSRF sai bị từ chối trước service.

Run: `pnpm test:api:mysql -- tests/integration/test_auth_sessions.py -v`
Expected: PASS; fake clock xác nhận idle, absolute, revoke và auth-version; ticket cũ không xóa cookie phiên mới.

- [x] **Step 5: Commit session boundary.**

```bash
git add backend
git commit -m "feat: add csrf protected server sessions"
```

### Task 3: Verify, login, reset mật khẩu, rate limit và local-key API

**Files:**
- Create: `backend/app/services/auth.py`
- Create: `backend/app/services/email_delivery.py`
- Create: `backend/tests/api/test_auth_account_flows.py`
- Create: `backend/tests/integration/test_auth_account_flows.py`
- Create: `compose.auth-mailpit.yaml`
- Modify: `backend/app/api/auth.py`, `backend/app/schemas/auth.py`, `backend/app/main.py`, `backend/app/core/config.py`
- Modify: `backend/.env.example`, `docs/development.md`

**Interfaces:**
- Consumes: `canonicalize_email`, password/crypto/rate-limit primitives Task 1; session/CSRF service Task 2; migration Task 1.
- Produces các route: `POST /auth/register`, `/auth/verification/resend`, `/auth/verification/confirm`, `/auth/login`, `/auth/password/forgot`, `/auth/password/reset`; `GET /auth/local-key`; payload/status/headers đúng bảng API trong T03.
- Produces email adapter SMTP dùng phát triển với Mailpit; worker chỉ đọc delivery job đã mã hóa dưới email-outbox key, gửi thư verify/reset từ link `PUBLIC_ORIGIN` có token trong fragment, xóa job sau khi gửi/hết hạn. Nhà cung cấp thư production thuộc T29/T30.

- [x] **Step 1: Viết test thất bại cho verify/login/forgot/reset/local-key và rate limit.** Tên test: `test_register_is_neutral_for_non_allowlisted_email`, `test_forgot_is_neutral_for_unknown_and_non_allowlisted_email`, `test_owner_email_binding_mismatch_fails_startup`, `test_verification_race_creates_one_owner`, `test_verify_creates_owner_workspace_and_wrapped_key_atomically`, `test_email_get_does_not_consume_token`, `test_used_token_returns_email_token_used_without_reapplying`, `test_expired_token_digest_is_pruned_after_7_days`, `test_token_expired_at_boundary_and_wrong_purpose_is_rejected`, `test_login_rotates_session_and_sets_remembered_cookie`, `test_two_devices_get_distinct_sessions_for_same_owner_and_stable_key`, `test_unknown_user_uses_dummy_argon2_and_same_credentials_error`, `test_reset_revokes_sessions_but_preserves_owner_key`, `test_reset_race_revokes_once`, `test_local_key_requires_recent_password`, `test_delivery_job_stores_ciphertext_only_and_sends_fragment_link`, `test_auth_limits_are_atomic_across_email_and_ip_buckets`. API tests dùng `auth_client` có anonymous cookie/CSRF cùng in-memory repository và captured mailbox; integration tests lặp lại persistence/race trên MySQL.

```python
def test_register_is_neutral_for_non_allowlisted_email(auth_client, auth_repository, auth_mailbox):
    response = auth_client.post(
        "/api/v1/auth/register", json={"email": "other@example.test"}
    )
    assert response.status_code == 202
    assert response.json() == {"status": "accepted", "resend_after_seconds": 60}
    assert auth_repository.users == []
    assert auth_mailbox.messages == []
```

- [x] **Step 2: Chạy API tests để xác nhận đang thất bại.**

Run: `pnpm test:api -- tests/api/test_auth_account_flows.py`
Expected: FAIL vì các route/service account chưa có.

- [x] **Step 3: Cài đặt giao dịch account/token và delivery.** Register/resend/forgot dùng response trung tính và bucket ghép đúng các ngưỡng T03; register chỉ nhận allowlist canonical. Verify/reset kiểm tra token hợp lệ trước password policy/hash, consume bằng transaction khóa hoặc conditional update, tạo `User` + `WorkspaceSettings` + random local key atomically; resend không vô hiệu link còn hạn; verify không đăng nhập. Login dùng dummy Argon2id verify khi email không tồn tại, rotate session, hỗ trợ remembered cookie; reset cập nhật hash, tăng `auth_version`, revoke authenticated session/reset link, gửi thông báo reset và giữ nguyên owner key. `/auth/local-key` kiểm tra verified owner và recent-password 5 phút, không gia hạn window bởi polling. Email delivery job chỉ chứa payload đã mã hóa, worker không log token/link; Mailpit chỉ nằm trong compose phát triển riêng, không bật trong image/test MySQL runner.

- [x] **Step 4: Chạy API và MySQL tests.**

Run: `pnpm test:api -- tests/api/test_auth_account_flows.py`
Expected: PASS; mọi email request ngoài eligibility vẫn giống nhau, không rò account; scanner GET không consume token.

Run: `pnpm test:api:mysql -- tests/integration/test_auth_account_flows.py -v`
Expected: PASS; chỉ một request cạnh tranh tạo owner/consume reset, rollback không để token consumed một phần.

- [x] **Step 5: Kiểm tra thư dev qua Mailpit.**

Run: `docker compose -f compose.auth-mailpit.yaml up -d`
Expected: SMTP sink chỉ bind `127.0.0.1:1025`, hộp thư dev mở ở `http://127.0.0.1:8025`; API worker gửi verify/reset tới đó. Link dùng HTTPS `PUBLIC_ORIGIN`, token chỉ ở fragment; tắt Mailpit không làm response tiết lộ email có hợp lệ hay không.

- [x] **Step 6: Commit luồng xác thực backend.**

```bash
git add backend compose.auth-mailpit.yaml docs/development.md
git commit -m "feat: implement verified owner authentication flows"
```

### Task 4: UI tài khoản, callback và owner-aware local logout

**Files:**
- Create: `frontend/lib/services/auth.ts`
- Create: `frontend/lib/auth/session-provider.tsx`
- Create: `frontend/lib/auth/device-auth-state.ts`
- Create: `frontend/lib/storage/auth-state.ts`
- Create: `frontend/lib/storage/migrations/auth-state-v2.ts`
- Create: `frontend/components/account/account-form.tsx`
- Create: `frontend/tests/auth-session.spec.ts`
- Modify: `frontend/lib/storage/schema.ts`, `frontend/lib/storage/db.ts`, `frontend/lib/storage/index.ts`
- Modify: `frontend/app/layout.tsx`, `frontend/app/(account)/account/page.tsx`, `frontend/components/account/email-callback.tsx`
- Modify: `frontend/components/calendar/calendar-widget.tsx`, `frontend/tests/auth-routes.spec.ts`, `frontend/tests/storage-migrations.spec.ts`, `frontend/app/globals.css`

**Interfaces:**
- Consumes: T03 auth DTOs/routes; T08 `openDatabase`, `unlockOwner(db, ownerId, keyId, key)`, `lockOwner(db, ownerId)`, `listPendingOperations(db, ctx)`.
- Produces: `getSession()`, `postAuth<T>(path, body)`, `importLocalKey(keyBase64url)`, `lockAndQueueLogout(sessionView)`; `AuthSessionProvider` phát session/status và khóa liên tab qua `BroadcastChannel`.
- IndexedDB schema v2 thêm `auth_state` với keyPath `key`; chỉ giữ pending logout ticket và metadata tối thiểu, migration 1→2 giữ nguyên toàn bộ stores/outbox T08.

- [x] **Step 1: Viết Playwright tests thất bại cho form, callback, session và offline logout.** Tên test: `accountLoginDefaultsRememberMeAndUnlocksOwner`, `verifyCallbackPostsOnlyAfterConfirmationAndScrubsFragment`, `resetCallbackRequiresMatchingPasswords`, `expiredSessionKeepsLocalVaultAvailable`, `logoutOfflineLocksAllTabsAndPreservesPendingData`, `loginDoesNotAutoUnlockFromRestoredCookie`, `ownerAuthStateMigrationPreservesT08Stores`. Tạo test helpers `prepareUnlockedOwnerWithPendingOperation(page)`, `readOwnerMeta(page)`, và `readEncryptedOutbox(page)`, trong đó helper outbox đọc raw envelope chỉ trong test và so sánh byte ciphertext trước/sau lock.

```ts
test("logoutOfflineLocksAllTabsAndPreservesPendingData", async ({ page, context }) => {
  await prepareUnlockedOwnerWithPendingOperation(page);
  const otherTab = await context.newPage();
  await otherTab.goto("/work");
  const pendingBefore = await readEncryptedOutbox(page);
  await page.context().setOffline(true);
  await page.getByRole("button", { name: "Đăng xuất" }).click();
  await expect(page.getByRole("dialog")).toContainText("đang chờ đồng bộ");
  await page.getByRole("button", { name: "Vẫn đăng xuất" }).click();
  await expect(page.getByRole("status")).toContainText("chưa thu hồi trên máy chủ");
  await expect(await readOwnerMeta(page)).toMatchObject({ locked: true });
  await expect(await readOwnerMeta(otherTab)).toMatchObject({ locked: true });
  expect(await readEncryptedOutbox(page)).toEqual(pendingBefore);
});
```

- [x] **Step 2: Chạy Playwright tests để xác nhận đang thất bại.**

Run: `pnpm test:web -- tests/auth-session.spec.ts tests/auth-routes.spec.ts`
Expected: FAIL vì account hiện là placeholder và callback chưa submit token.

- [x] **Step 3: Nối UI với API cùng origin.** Tất cả POST lấy CSRF từ `GET /auth/session`, gửi `X-CSRF-Token` và `credentials: "same-origin"`; mọi fetch auth dùng `cache: "no-store"`. Account UI theo T02: login, remember mặc định bật, hiện/ẩn mật khẩu, thiết lập ban đầu chỉ cho allowlist (không public sign-up), resend, forgot, reset hai ô khớp; disable khi chờ; lỗi sát form; không tự thêm composition rule; email request luôn nói “Nếu email phù hợp, hệ thống sẽ gửi hướng dẫn”. Callback không có script bên thứ ba, dùng `Referrer-Policy: no-referrer`, chỉ giữ token trong memory, scrub URL trước render, chỉ POST sau submit rõ ràng; verify/reset thành công đưa về login; GET/scanner không gọi mutation.

- [x] **Step 4: Nối đăng nhập vào T08 owner gate và logout.** Sau login nhập đúng mật khẩu, gọi `/auth/local-key`, base64url decode, import AES-GCM key 256-bit không extractable qua `importRawKey`, rồi gọi `unlockOwner`. Cookie/session còn sống tự nó không unlock. Logout cảnh báo khi có pending hoặc draft bẩn, cho người dùng xác nhận/hủy, không xóa outbox/ciphertext hoặc draft. Lưu ticket vào IndexedDB `auth_state`, khóa owner bằng `lockOwner`, phát event liên tab và dọn memory trước khi thử revoke server; offline giữ ticket để retry trước lần login/sync tiếp theo. Cung cấp lock event hook để T11 dừng coordinator/request khi được thêm. Hết phiên chỉ hiện trạng thái; không tự khóa local.

- [x] **Step 5: Chạy browser suites dev và production.**

Run: `pnpm test:web -- tests/auth-session.spec.ts tests/auth-routes.spec.ts tests/storage-migrations.spec.ts`
Expected: PASS; callback headers vẫn `private, no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer`; reload không làm mất ticket/outbox.

Run: `pnpm build:web`
Expected: production build thành công, không đưa `OWNER_EMAIL`, auth key, token hoặc owner data vào client bundle/RSC.

Run: `pnpm test:web:prod -- tests/auth-session.spec.ts tests/auth-routes.spec.ts`
Expected: PASS trên production server.

- [x] **Step 6: Commit giao diện và local lifecycle.**

```bash
git add frontend
git commit -m "feat: connect account flows to the local owner vault"
```

### Task 5: Nghiệm thu T09, runbook và bàn giao T10/T11/T13

**Files:**
- Create: `docs/tasks/t09/review-and-verification.md`
- Modify: `docs/development.md`, `docs/tasks/README.md`
- Verify: các file Task 1–4; không mở API CRUD lịch hoặc thay đổi hợp đồng sync T03.

**Interfaces:**
- Consumes: endpoint/session/vault/UI contracts của Task 1–4.
- Produces: bảng đối chiếu auth acceptance, kết quả dev inbox, lệnh cài/chạy local và handoff: T10 dùng `require_verified_owner`; T11 dừng sync/replay ticket qua lock hook; T13 loại `/api/**` và callback khỏi cache; T25 hiển thị expiry/logout/email lỗi.

- [x] **Step 1: Thêm checklist tích hợp cho verify, login, reset, expiry, local vault, offline logout, cách ly owner và no-store.** Mỗi case ghi command/fixture, expected HTTP/UI/DB state và kết quả thực tế; email production và inbox thật ghi là T30/T32, chưa tuyên bố T09 đạt phần đó.

- [x] **Step 2: Chạy quality gates và toàn bộ suites liên quan.**

Run: `pnpm verify:fast`
Expected: lint, format, typecheck, env regressions và backend tests đều PASS.

Run: `pnpm test:api:mysql`
Expected: tất cả test MySQL chọn chạy, không skip.

Run: `pnpm test:web`
Expected: tất cả browser/unit tests, gồm toàn bộ test lưu trữ T08 và auth, PASS.

Run: `pnpm build:web`
Expected: production build thành công.

Run: `pnpm test:web:prod -- tests/auth-session.spec.ts tests/auth-routes.spec.ts`
Expected: browser suite production PASS; auth/callback vẫn no-store.

- [x] **Step 3: Cập nhật runbook và T09 status.** Ghi cách tạo local secrets, bật/tắt SMTP sink, nhận verify/reset trong Mailpit, migrate DB, chạy API/web và test; đánh dấu T09 hoàn tất trong README chỉ sau khi có kết quả, nêu rõ email gửi inbox thật còn chờ T30/T32.

- [x] **Step 4: Commit kết quả và tài liệu.**

```bash
git add docs
git commit -m "docs: record task 9 authentication verification"
```

---

## Self-Review

- **Spec coverage:** Đã ánh xạ allowlist/canonicalization, owner duy nhất, mật khẩu, token và session, endpoint HTTP, CSRF/Origin, rate limit, reset/revoke, email delivery, local-key, logout offline, cache/log, UI và nghiệm thu vào Task 1–5.
- **Step scan:** Mỗi bước tạo test, chạy một nhóm kiểm tra, triển khai một thành phần có ranh giới hoặc cập nhật hồ sơ; không có mục “xử lý phù hợp”/TBD.
- **Type consistency:** `SessionView`, `OwnerLocalKey`, `canonicalize_email`, `importRawKey`, `unlockOwner`, `lockOwner` và `listPendingOperations` giữ nhất quán với T03/T08.
- **Review Focus:** Năm failure mode đều có test đặt tại task sở hữu; phần quan trọng nhất là token race/scanner, hostile Origin/CSRF, expiry, và ticket/offline owner lock.
- **Proportion:** Plan chia T09 theo backend persistence/security/lifecycle và client integration; giữ giá trị contract cần thiết, không mô tả implementation body ngoài các thuật toán mà giao diện không tự quyết định.
