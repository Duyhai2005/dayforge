# DAYFORGE — hợp đồng tài khoản và khóa local T03

Ngày **28/10/2026** · Phiên bản **1.0** · Trạng thái: **Lựa chọn kỹ thuật của người thực hiện trong T03**.

Tài liệu này cụ thể hóa hành vi đã duyệt trong [T01](../t01/design.md) và [T02](../t02/design.md).
Đây là đặc tả để triển khai và kiểm thử sau; không phải tuyên bố đã có sản phẩm, đã kiểm tra production hoặc người dùng đã duyệt riêng tài liệu này.
Tuân theo [CONVENTION](../../CONVENTION.md) và [GITFLOW](../../GITFLOW.md): FastAPI là nguồn auth duy nhất, schema Pydantic, service nghiệp vụ, repository lưu trữ; frontend gọi API qua `services/`.

## 1. Yêu cầu đã duyệt và lựa chọn T03

**Đã duyệt:** một chủ sở hữu; email được cấu hình, xác minh email, mật khẩu riêng, gửi lại link, quên/reset mật khẩu và ghi nhớ đăng nhập mặc định bật; không Google hoặc đăng ký công khai.
Lần đầu, xác minh và reset cần mạng. Thiết bị đã chuẩn bị được xem/sửa local khi offline hoặc hết phiên; chỉ đăng xuất chủ động mới khóa local.
Hết phiên và đăng xuất không xóa pending edits. Sync cần phiên hợp lệ của đúng chủ. Không hứa thu hồi phiên có thể xóa dữ liệu trên thiết bị đang offline.

**T03 chọn:** phiên opaque lưu server, Argon2id, cookie cùng origin, CSRF synchronizer token, token email một lần, vault local mã hóa và các thời hạn/giới hạn dưới đây.
Các con số là mặc định kỹ thuật có thể đo và kiểm chứng, không phải yêu cầu người dùng chọn thuật toán hoặc thông số bảo mật.
Domain, dịch vụ email, region, cấu hình máy và nơi backup vẫn thuộc T29/T30/T32.

## 2. Danh tính và khởi tạo chủ sở hữu

- `OWNER_EMAIL` chỉ ở cấu hình server; không đưa allowlist vào bundle hoặc response công khai.
- Dùng thư viện email được duy trì để parse một mailbox; không nhận display name, danh sách địa chỉ hoặc ký tự điều khiển. Giới hạn địa chỉ canonical là 254 byte UTF-8.
- Bỏ khoảng trắng ASCII ở hai đầu; local-part chuẩn hóa NFC và **giữ hoa/thường**; domain chuyển IDNA sang ASCII rồi lowercase. Không bỏ dấu chấm, dấu `+` hoặc alias riêng của nhà cung cấp.
- Cùng một hàm canonical hóa áp dụng cho cấu hình, đăng ký, đăng nhập, resend và forgot. Lưu `email_canonical` để so sánh binary và `email_delivery` từ cấu hình để gửi thư.
- Chỉ địa chỉ canonical khớp cấu hình được nhận thư khởi tạo. Request ngoài allowlist vẫn nhận response trung tính; không tạo account hoặc gửi thư.
- `POST /auth/register` chỉ nhận email, tạo yêu cầu xác minh; chưa tạo mật khẩu hoặc account sử dụng được.
- `POST /auth/verification/confirm` nhận token và mật khẩu do người đang giữ email chọn, rồi tạo chủ đã xác minh trong một transaction. Không kích hoạt mật khẩu do người khác nhập trước khi email được chứng minh.
- Khóa singleton installation khi tạo account; `owner_slot = 1` có unique constraint. Đua hai request vẫn chỉ tạo đúng một `owner_id` bất biến.
- Khi đã có chủ, register/resend không tạo thêm account. Thay `OWNER_EMAIL` không tự chuyển quyền hoặc tạo chủ mới; cấu hình lệch binding đã lưu phải bị phát hiện khi khởi động. Đổi email/chuyển chủ để sau.
- Xác minh thành công không tự đăng nhập. UI chuyển về đăng nhập; callback GET chỉ hiển thị form, không tiêu thụ token.

## 3. Mật khẩu

- Khi thiết lập/reset: NFC trước khi tính độ dài và hash; chấp nhận **15–128 Unicode code point**, gồm dấu cách và Unicode; không trim, đổi hoa/thường hoặc cắt mật khẩu.
- Transport nhận tối đa 1.024 code point và 4.096 byte UTF-8 trước chuẩn hóa; body auth tối đa 16 KiB. Chính sách 15–128 áp dụng sau NFC, tránh đếm sai tiếng Việt dạng tổ hợp.
- Không buộc chữ hoa/số/ký hiệu, đổi định kỳ hoặc câu hỏi bảo mật. Cho phép paste, autofill, password manager và hiện/ẩn mật khẩu.
- Kiểm tra toàn bộ mật khẩu mới với blocklist có phiên bản, đóng gói cùng backend: mật khẩu phổ biến/đã lộ và giá trị dự đoán được theo DAYFORGE/email. Không gửi mật khẩu ra dịch vụ kiểm tra bên ngoài.
- Blocklist từ chối bằng `password_blocklisted`; lỗi độ dài bằng `password_policy_violation`. UI hiển thị lý do, không tự đặt một chính sách khác.
- Argon2id phiên bản 19, `m = 65536 KiB`, `t = 3`, `p = 1`, salt CSPRNG 16 byte, output 32 byte; lưu chuỗi PHC có tham số và salt.
- Benchmark trên cấu hình deploy, mục tiêu một lần kiểm tra dưới một giây khi tải dự kiến; nếu cần giảm RAM, không thấp hơn baseline OWASP `m = 19456 KiB, t = 2, p = 1`. Thay tham số phải được ghi và kiểm tra trước phát hành.
- Dùng hàm verify của thư viện, rehash sau đăng nhập thành công khi policy tăng. Không dùng SHA-256 trực tiếp cho mật khẩu.
- Tài khoản không tồn tại/sai email vẫn chạy một dummy Argon2id verify tương đương trước lỗi credentials; không trả nhanh theo việc account có tồn tại.

## 4. Schema server tối thiểu

| Thực thể | Trường/bất biến |
| --- | --- |
| `User` | `id: UUID`, `owner_slot = 1 UNIQUE`, `email_canonical UNIQUE` binary, `email_delivery`, `password_hash`, `email_verified_at`, `auth_version`, `created_at`, `updated_at`. Chỉ account đã xác minh mới được tạo thành account sử dụng được. |
| `Session` | `id: UUID` công khai, `kind: anonymous/authenticated`, `token_hash: BINARY(32) UNIQUE`, `owner_id` nullable chỉ với anonymous, `csrf_token`, `auth_version`, `password_authenticated_at`, `remember_me`, `created_at`, `last_activity_at`, `idle_expires_at`, `absolute_expires_at`, `revoked_at`. |
| `EmailToken` | `id`, `purpose: verify_email/password_reset`, `token_hash UNIQUE`, `email_canonical`, `owner_id` nullable cho khởi tạo, `created_at`, `expires_at`, `consumed_at`, `invalidated_at`. Token gắn purpose, email và chủ đích; không nhận owner từ client. |
| `OwnerLocalKey` | `owner_id UNIQUE`, `key_id: UUID`, `algorithm = A256GCM`, `wrapped_key`, `kek_version`, `created_at`. Khóa dữ liệu random 32 byte, không dẫn xuất từ mật khẩu. |
| `AuthRateLimit` | Khóa bucket theo action/email pseudonym/IP pseudonym, cửa sổ, count và thời điểm hết hạn; cập nhật nguyên tử giữa các worker. Không lưu mật khẩu hoặc token đầu vào. |

ID và timestamp trả JSON là UUID chuẩn và RFC 3339 UTC có hậu tố `Z`. Thời hạn kiểm tra bằng đồng hồ server; hết hạn khi `now >= expires_at`.
`auth_version` của phiên phải bằng bản hiện hành của chủ. Server suy ra `owner_id` từ phiên và kiểm tra verified ở mọi API riêng, bootstrap, push, pull và local-key.
Các mutation auth, tăng version/thu hồi và consume token phải commit nguyên tử; session không hợp lệ không được vào mutation nghiệp vụ.

## 5. Cookie, phiên và thời hạn

| Hằng số | Giá trị |
| --- | --- |
| `SESSION_TOKEN_BYTES` | 32 byte CSPRNG, base64url không padding; cookie mang token opaque, DB chỉ lưu SHA-256 verifier. |
| `ANONYMOUS_SESSION_TTL` | 30 phút tuyệt đối; chỉ cấp CSRF context, không có quyền lịch. |
| `SESSION_IDLE_STANDARD` / `SESSION_ABSOLUTE_STANDARD` | 30 phút / 12 giờ khi bỏ ghi nhớ. Cookie không có `Max-Age`/`Expires`; server vẫn áp hạn độc lập. |
| `SESSION_IDLE_REMEMBERED` / `SESSION_ABSOLUTE_REMEMBERED` | 7 ngày / 30 ngày khi ghi nhớ. Cookie `Max-Age` không vượt thời gian tuyệt đối còn lại. |
| `LOCAL_KEY_RECENT_PASSWORD_WINDOW` | 5 phút tính từ lần kiểm tra mật khẩu thành công, không kéo dài bởi polling hoặc sync. |
| `VERIFY_EMAIL_TOKEN_TTL` / `PASSWORD_RESET_TOKEN_TTL` | 24 giờ / 30 phút. |
| `EMAIL_TOKEN_BYTES` / `CSRF_TOKEN_BYTES` | Mỗi loại 32 byte CSPRNG. |

Cookie tên `__Host-dayforge-session`, `Secure; HttpOnly; SameSite=Lax; Path=/`, không `Domain`. Production chỉ HTTPS cùng origin; không có token bearer trong localStorage hoặc payload sync.
Đăng nhập thành công luôn tạo token/CSRF mới và vô hiệu session context cũ được trình; không nâng quyền một anonymous token sẵn có. Cookie không chứa email, owner hoặc quyền tự xác nhận.
Idle được gia hạn bởi request đã xác thực thành công; không vượt absolute. Timeout và thu hồi đều do server kiểm tra, không tin bộ đếm client.
Đóng browser không được mô tả là thu hồi chắc chắn: browser có thể khôi phục session cookie; server timeout và đăng xuất chủ động mới là cơ chế kiểm soát.
Không tự xoay cookie mỗi lần polling để tránh race giữa tab; đăng nhập/reset là ranh giới xoay/thu hồi. Không thêm refresh JWT hoặc hệ thống auth riêng trong Next.js.

## 6. Hợp đồng HTTP

Các path bên dưới có tiền tố **`/api/v1`**. JSON dùng `snake_case`; không nhận `owner_id` ở request auth thông thường. Mọi POST nhận JSON, yêu cầu Origin/CSRF như mục 7.
Schema từ chối trường ngoài hợp đồng; không tự coercion chuỗi thành boolean. `email` tối đa 254 byte sau canonical hóa; `token` là 43 ký tự base64url của 32 byte, `logout_ticket` là 64 ký tự base64url của 48 byte.

`SessionView` gồm `authenticated: boolean`, `owner: {id,email,email_verified_at} | null`, `session: {id,remember_me,idle_expires_at,absolute_expires_at,password_authenticated_at} | null`, `csrf_token: string`, `server_time: timestamp` và `logout_ticket: string | null`.
`AcceptedEmailRequest` luôn là `{status:"accepted", resend_after_seconds:60}`; UI nói “Nếu email phù hợp, hệ thống sẽ gửi hướng dẫn”, không khẳng định thư đã tới inbox.

| Method và path | Request | Response thành công |
| --- | --- | --- |
| `GET /auth/session` | Không body. | `200 SessionView`; chưa có phiên hợp lệ thì `authenticated=false`, owner/session/ticket null và cấp anonymous CSRF context. Không trả dữ liệu lịch. |
| `POST /auth/register` | `{email}` | `202 AcceptedEmailRequest`, giống nhau cho ngoài allowlist/đã đăng ký/hợp lệ. |
| `POST /auth/verification/resend` | `{email}` | `202 AcceptedEmailRequest`; cùng kiểm tra và giới hạn với register. |
| `POST /auth/verification/confirm` | `{token,password}` | `200 {status:"verified"}`; tạo verified owner và key trong cùng transaction; không cấp phiên đăng nhập. |
| `POST /auth/login` | `{email,password,remember_me}`; boolean bắt buộc, UI mặc định true. | `200 SessionView` với owner/session/ticket khác null, cookie mới. |
| `POST /auth/password/forgot` | `{email}` | `202 AcceptedEmailRequest`; chỉ verified owner hợp lệ được gửi link reset. |
| `POST /auth/password/reset` | `{token,password}` | `200 {status:"password_reset"}`; đổi hash, tăng auth version, thu hồi mọi phiên/reset link; không tự login. |
| `POST /auth/logout` | `{logout_ticket?: string}`; không có ticket thì nhắm phiên cookie hiện tại. | `204`, idempotent; revoke phiên đích và xóa cookie nếu cookie đang trỏ chính phiên đó. |
| `GET /auth/local-key` | Không body; phiên verified, đã kiểm tra mật khẩu trong 5 phút. | `200 {owner_id,key_id,algorithm:"A256GCM",key_base64url}`; 32 byte key base64url không padding. |

UI xác nhận mật khẩu mới hai lần; chỉ gửi một trường `password` sau khi hai ô khớp. Mật khẩu không được đi qua query string hoặc GET.
`GET /auth/local-key` không cấp key từ cookie cũ chỉ vì `/auth/session` còn thành công. Quá 5 phút trả `403 reauthentication_required`; client đăng nhập rõ ràng bằng mật khẩu rồi gọi lại.
Không mở API đổi email, public user listing hoặc quản trị nhiều account. Nếu sau này có đổi mật khẩu trực tiếp, phải kiểm tra mật khẩu hiện tại và dùng cùng quy tắc thu hồi như reset.

## 7. Origin và CSRF

- `GET /auth/session` cấp CSRF random gắn session context; token ổn định trong context để nhiều tab không vô hiệu lẫn nhau. Server lưu secret này ngoài log; so sánh constant time.
- Client gửi `X-CSRF-Token` ở mọi POST, kể cả register, login, confirm, forgot, reset và logout. Token thiếu/sai không được thực hiện nghiệp vụ.
- Mọi API riêng dùng POST/PUT/PATCH/DELETE, gồm sync push, áp cùng Origin/CSRF gate trước khi vào service; đọc GET không thay quyền hoặc dữ liệu nghiệp vụ.
- Chỉ chấp nhận `Content-Type: application/json`; không nhận form URL-encoded, multipart hoặc text/plain cho auth.
- Origin phải bằng chính xác `PUBLIC_ORIGIN` được cấu hình, gồm scheme/host/port; không kiểm tra kiểu suffix. Không suy origin từ `Host`/forwarded header chưa tin cậy.
- Nếu thiếu Origin, chỉ chấp nhận Referer có origin bằng cấu hình và CSRF vẫn đúng. `Origin: null`, khác origin hoặc thiếu cả hai bị từ chối.
- Chặn `Sec-Fetch-Site: cross-site` cho POST; không coi thiếu Fetch Metadata là đã qua kiểm tra. Không bật CORS cho origin khác hoặc wildcard credentials.
- SameSite là lớp bổ sung; không thay CSRF. GET/HEAD không đổi mật khẩu, xác minh account, consume email token hoặc logout.
- Anonymous context cho phép thao tác token email trên browser khác mà vẫn chống login CSRF; xác minh email không phải là phiên đăng nhập.

## 8. Token email và reset

- Token email random 32 byte, base64url không padding; DB chỉ lưu SHA-256. Hash này phù hợp với token entropy cao, không thay cho Argon2id của mật khẩu.
- Link tạo từ `PUBLIC_ORIGIN` cố định: `/verify-email#token=...` hoặc `/reset-password#token=...`; không lấy host/return URL từ request.
- Callback đọc fragment vào memory rồi `history.replaceState` bỏ token khỏi URL. Không đưa token vào localStorage, IndexedDB, telemetry hoặc response lỗi.
- Callback không có script/analytics bên thứ ba, dùng `Referrer-Policy: no-referrer`, không cache. Chỉ POST sau thao tác xác nhận; trình quét link GET không tiêu thụ token.
- Consume bằng transaction có khóa/conditional update: kiểm tra purpose, chủ/email, chưa dùng, chưa invalidated và chưa hết hạn; chỉ đánh dấu dùng khi toàn bộ thao tác thành công.
- Chỉ sau khi token hợp lệ mới xử lý policy/hash mật khẩu. Giữ digest đã dùng/hết hạn thêm 7 ngày để trả trạng thái link rõ ràng, rồi xóa; link quá cũ trả invalid, không giữ bearer plaintext.
- Resend tạo token mới nhưng **không vô hiệu token còn hạn trước đó**: người ngoài không thể liên tục hủy link chủ đang giữ. Thành công verify/reset vô hiệu mọi token còn lại cùng mục đích của chủ/installation.
- Reset hợp lệ tăng `auth_version`, revoke tất cả authenticated session và mọi reset token trong cùng transaction. Giữ nguyên `owner_id`, local key và dữ liệu/outbox; gửi thông báo reset qua email, không gửi mật khẩu.
- Request forgot/resend không khóa account hoặc thu hồi phiên. Mất response sau consume không được lặp tác dụng; link đã dùng trả trạng thái đã dùng và đường về đăng nhập.
- Hàng đợi email, nếu cần retry, chỉ giữ payload token đã mã hóa dưới khóa server và xóa sau gửi/hết hạn; không biến email outbox thành log token plaintext. Lỗi nhà cung cấp không làm response tiết lộ eligibility.

## 9. Vault local và đăng xuất offline

- Mỗi chủ có key AES-256-GCM ổn định, server wrap dưới KEK riêng theo version; KEK nằm ngoài MySQL/source/bundle. Backup cần cả dữ liệu wrapped key và KEK trong nơi được bảo vệ để restore đọc được pending ciphertext.
- Chỉ `/auth/local-key` với phiên recent-password hợp lệ trả key qua HTTPS/no-store. Client import thành `CryptoKey` nonextractable, usage encrypt/decrypt; không giữ raw key trong app storage hoặc log.
- Trong trạng thái unlocked, lưu `CryptoKey` bằng structured clone trong IndexedDB để reload/offline vẫn dùng được. Hết phiên không xóa key hoặc khóa lịch: giữ đúng T02.
- Mã hóa payload lịch, outbox, shadow, cursor, bản nháp giữ lại và undo data trước khi ghi IDB. Chỉ để metadata kỹ thuật tối thiểu như opaque ID, key version, lock state ở ngoài; không để bản rõ song song trong cache hoặc store phụ.
- Mỗi encryption dùng IV random CSPRNG 96 bit mới, tag 128 bit; không reuse IV/key. AAD gắn `owner_id`, `key_id`, store và record ID để ciphertext không bị tráo giữa chủ/loại bản ghi.
- Mọi thao tác đọc/ghi/sync đi qua owner gate, kiểm tra owner và `lock_epoch`; không chỉ ẩn DOM. Phiên owner khác không được mở key, hydrate cache hoặc gửi outbox cũ.
- Khi đăng xuất, xử lý bản nháp bẩn/cảnh báo pending theo T02; lấy mutex liên tab, dừng sync và request mới, commit `locked=true`, tăng `lock_epoch`, xóa key IDB nguyên tử; giữ ciphertext và outbox.
- Broadcast lock tới mọi tab, bỏ key/data/query cache trong memory và điều hướng/reload sang shell khóa. Worker không giữ key riêng. Tab nền kiểm tra epoch khi resume trước khi đọc/ghi/render, loại response/callback có epoch cũ.
- Trạng thái khóa bền phải được kiểm tra khi khởi động; không tự gọi local-key/unlock chỉ vì còn cookie. Chỉ hành động đăng nhập bằng mật khẩu đúng chủ mới cho phép lấy key rồi chuyển unlocked.
- Khi online, gọi logout rồi xác nhận server revoke. Khi offline, khóa local ngay và giữ một pending logout job cùng `logout_ticket`; UI nói rõ chưa thu hồi server cho đến khi nối lại.
- Trước login/sync mới, chạy pending logout; có thể lấy anonymous CSRF context rồi gửi ticket. Job không chứa dữ liệu lịch, mật khẩu, key hoặc session bearer.
- Ticket chỉ có quyền revoke đúng một session: `base64url(session_id_bytes || HMAC-SHA256(K_LOGOUT, "logout-v1" || session_id_bytes))`. Giữ `K_LOGOUT` riêng, có version/khả năng kiểm tra key cũ đến hết hạn phiên. GET session và login trả cùng ticket của session.
- Invalid/đã revoke/đã hết hạn đều logout `204`. Ticket phiên cũ không xóa cookie của phiên mới khác. Ticket không được dùng để login, gia hạn, đọc lịch hoặc lấy key.
- Reset không xoay local key nên đăng nhập lại đúng owner mở được pending cũ. Không remote wipe; thiết bị offline chưa biết server revoke vẫn có local đã chuẩn bị.
- Đây là khóa truy cập ứng dụng kèm mã hóa local; không cam kết E2EE, bảo vệ khỏi XSS/browser/OS đã bị chiếm hoặc xóa vật lý không thể phục hồi. Web Crypto không bảo đảm zeroization khi xóa tham chiếu key.
- Cách đơn giản hơn như giấu DOM hoặc giữ key plaintext bên cạnh ciphertext không đáp ứng khóa local; không chọn. Không thêm PIN/offline password verifier hoặc bắt người dùng quản lý khóa mới.

## 10. Lỗi, giới hạn và quyền riêng tư

Mọi response lỗi dùng `Content-Type: application/problem+json` theo [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html), cùng hợp đồng với API sync:
`{type,title,status,detail,instance,code,request_id,retryable,server_time,field_errors?:[{path,code}],retry_after_seconds?}`.
`type` là URI loại lỗi ổn định của registry chung T03; `status` khớp HTTP status; `instance` là URI định danh lần lỗi, không chứa input riêng tư. `code`, `request_id`, `retryable`, `server_time` và hai trường optional là extension của Problem Details.
`field_errors.path` luôn là JSON Pointer tính từ gốc request body, như `/password` hoặc `/operations/0/commands/0/payload/title`; dùng escape `~0` cho `~`, `~1` cho `/`, không dùng dotted path. Không echo password/token/input riêng tư trong detail hoặc field errors.
`retry_after_seconds` chỉ có ở 429, là số giây nguyên khớp `Retry-After`; nếu nhiều bucket chặn thì lấy thời gian phải chờ lớn nhất. `retryable=true` chỉ cho 429/503; lỗi credentials/quyền/validation/token yêu cầu hành động sửa hoặc đăng nhập lại, không tự retry request không đổi. Frontend dịch từ code; server không trả stack trace. Payload thành công giữ như mục 6.

| HTTP | `code` và nghĩa |
| --- | --- |
| `401` | `invalid_credentials` cho mọi email/password không khớp; `authentication_required` cho API riêng khi phiên thiếu/sai/hết hạn/revoke. Không phân biệt email tồn tại. |
| `403` | `csrf_failed`, `origin_forbidden`, `reauthentication_required`; `owner_forbidden` cho session không có quyền verified owner, không kèm dữ liệu. |
| `400` | `email_token_invalid` cho token không tìm thấy/sai purpose; không echo token. |
| `409` | `email_token_used` khi token khớp đã consume/được thay thế bởi lần thành công khác; không áp lại hành động. |
| `410` | `email_token_expired` khi token khớp đã hết hạn. |
| `413` / `415` | `payload_too_large` / `unsupported_media_type`. |
| `422` | `validation_error`, `password_policy_violation`, `password_blocklisted`; không dùng lỗi email eligibility hoặc duplicate account ở public request. |
| `429` | `rate_limited`, có `Retry-After` số giây và `retry_after_seconds`; không consume token hoặc thay account. |
| `503` | `service_unavailable` khi auth store/crypto dependency không dùng được; không giả thành sai mật khẩu hoặc báo gửi email thành công chắc chắn. |

<a id="auth-rate-limits"></a>

Default rate limits, thực thi nguyên tử trên server và dùng cả bucket email lẫn IP. Cửa sổ là rolling window; một phút/15 phút/giờ/ngày tương ứng 60/900/3.600/86.400 giây:

| Nhóm | Giới hạn |
| --- | --- |
| Login thất bại | 5/15 phút/email canonical, 30/15 phút/IP; không khóa account vĩnh viễn. Cùng chính sách cho email không tồn tại; lần vượt ngưỡng trả 429. |
| Register + resend + forgot cộng gộp | Tối thiểu 60 giây/email, tối đa 5/giờ và 10/ngày/email; 30/giờ và 100/ngày/IP. Mọi email có bucket tương đương dù không eligible. |
| Confirm/reset token | 10/phút/token digest, 60/phút/IP, gồm thử sai. Validation password thất bại không consume token. |
| Session/local-key | 60/phút/session và 120/phút/IP; không kéo dài `password_authenticated_at`. |

Rate key email/IP dùng HMAC với khóa server, không đưa email đầy đủ vào log. IP chỉ lấy từ peer hoặc proxy đã được cấu hình tin cậy; không tin `X-Forwarded-For` client tự gửi.
Giới hạn số Argon2 job đang chạy/đợi theo ngân sách worker; không để request spam tạo queue CPU/RAM vô hạn. Cấu hình triển khai phải đo lại tải và delivery limits.
Login lỗi dùng cùng status/body và lượng công việc hash gần tương đương; email request đi qua cơ chế bất đồng bộ/đệm nhất quán, không lộ account qua nhánh trả nhanh.
Log chỉ event, request ID, kết quả, owner UUID sau auth và pseudonym cần thiết; mặc định giữ auth event 30 ngày, rate bucket tối đa 48 giờ. Không log Cookie, Authorization, password, CSRF, local key, token, ticket hoặc full link.

## 11. Không cache dữ liệu auth

Tất cả `/api/v1/auth/*` và API riêng: `Cache-Control: private, no-store`, `Pragma: no-cache`; proxy/CDN không override hoặc cache response có cookie. `Vary: Cookie` là lớp bổ sung, không thay no-store.
Service worker dùng network-only cho `/api/**` và callback verify/reset; không precache/fallback bằng response auth cũ. Generic shell offline chỉ chứa mã/tài nguyên không riêng tư.
Next.js fetch auth/private dùng `cache: "no-store"`; không đưa owner/key/token vào shared HTML/RSC, Data Cache hoặc Full Route Cache. Không có hệ auth thứ hai trong Next.js.
Logout không dùng `Clear-Site-Data` để xóa IDB: thao tác đó sẽ mất ciphertext/outbox đã hứa giữ. Cache UI/memory phải được dọn theo lock epoch.

## 12. Kiểm chứng triển khai và nguồn

T09/T13 và nghiệm thu phải kiểm tra bằng fixture: đua verify chỉ một owner; allowlist/normalization nhất quán; link scanner không consume; token retry/hết hạn/sai purpose; reset revoke mọi phiên nhưng giữ key/pending.
Kiểm tra session absolute/idle bằng clock giả, CSRF/Origin thiếu/null/sai, no-store thực qua proxy/SW/Next build, đăng xuất offline rồi reload, nhiều tab và callback trễ, cookie cũ không tự unlock, recent-password quá 5 phút bị chặn.
Kiểm tra vault trên sản phẩm: import nonextractable, structured clone qua IDB/reload, mất key local vẫn lấy lại đúng key sau login/reset, restore KEK+wrapped key và lỗi quota không báo khóa/lưu thành công giả.
Đây là tiêu chí phải thực hiện khi có sản phẩm; chưa phải kết quả chạy kiểm thử.

- [NIST SP 800-63B-4 §3.1.1](https://pages.nist.gov/800-63-4/sp800-63b.html#passwordver): password-only có “minimum of 15 characters in length”; cho phép ít nhất 64 ký tự tối đa, Unicode code point, NFC, blocklist, không composition rule/đổi định kỳ. DAYFORGE chọn max 128 và không tuyên bố chứng nhận NIST.
- [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html): baseline “m=19456 (19 MiB), t=2, p=1”; phải benchmark work factor. Cấu hình 64 MiB/3/1 ở đây là lựa chọn T03 cao hơn baseline.
- [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html): “Session timeout management and expiration must be enforced server-side.” OWASP yêu cầu idle/absolute timeout và session ID ngẫu nhiên; thời hạn ngày/giờ ở đây do T03 chọn theo ghi nhớ đăng nhập.
- [OWASP Forgot Password](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html): token phải “Single use and expire after an appropriate period”; response trung tính, giới hạn lạm dụng, reset xong đăng nhập theo luồng thường và thu hồi phiên. TTL 30 phút là lựa chọn T03.
- [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html): synchronizer token riêng/khó đoán theo session; kiểm tra Origin/Referer chính xác, không dùng SameSite đơn độc.
- [OWASP Email Validation and Verification](https://cheatsheetseries.owasp.org/cheatsheets/Email_Validation_and_Verification_Cheat_Sheet.html): domain lowercase, chính sách local-part rõ ràng, không biến đổi alias tùy tiện; chỉ kích hoạt sau xác minh và không log token/full link.
- [MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie): `__Host-` cần Secure, Path=/ và không Domain; HttpOnly bổ sung riêng. Session restore có thể giữ cookie khi mở lại browser.
- [W3C Web Cryptography](https://www.w3.org/TR/webcrypto/#security-considerations): CryptoKey có thể lưu IndexedDB; nonextractable không bảo vệ khỏi script sử dụng key và chuẩn không bảo đảm zeroization. [MDN AesGcmParams](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams) yêu cầu IV không lặp với cùng key, khuyến nghị 96 bit.

Không còn lựa chọn sản phẩm bắt buộc phải hỏi người dùng để triển khai contract này. Nhà cung cấp email/domain/backup đã được giao đợt deploy; mọi thay đổi làm khác hành vi T01/T02 phải được ghi rõ trước khi thực hiện.
