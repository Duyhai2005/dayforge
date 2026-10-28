# T03 — HTTP API contract 1.0

Ngày: **28/10/2026** · Nguồn liên quan: [dữ liệu](data-contract.md), [tài khoản](auth-contract.md), [đồng bộ](sync-contract.md).

## 1. Quy ước chung

- Prefix `/api/v1`; cùng origin HTTPS với Next.js. Backend FastAPI là bên xác thực và quyết định quyền; proxy/SSR không được tạo đường nghiệp vụ bỏ qua hợp đồng.
- JSON UTF-8, khóa `snake_case`, UUID chữ thường, số nguyên lớn như cursor/device sequence/rank truyền bằng chuỗi thập phân. Không dùng số JavaScript có thể mất chính xác.
- Request body `application/json`; lỗi `application/problem+json`. Mọi API auth, key và sync trả `Cache-Control: no-store`; service worker và Next.js không cache riêng tư hoặc email callback.
- Từ chối duplicate object key, NaN/Infinity, Unicode surrogate đơn và JSON number vượt miền số đã khai báo; không để parser khác nhau tạo payload/hash khác nhau. Canonical JSON/hash theo RFC 8785 trong sync contract.
- Mọi POST kiểm tra Origin chính xác, CSRF context và `X-CSRF-Token`, gồm cả trước đăng nhập. Không bật CORS credential wildcard. GET không thay đổi nghiệp vụ, xác minh email hoặc reset mật khẩu.
- Cookie phiên chỉ dùng để xác thực, không phải payload đồng bộ. Mọi endpoint sync yêu cầu owner đã xác minh email. `owner_id` trong operation là assertion bắt buộc đối chiếu với phiên; không dùng nó để cấp quyền.
- Không log password, token email, cookie, CSRF, logout ticket, local key, note hoặc toàn bộ operation chứa dữ liệu cá nhân. Log được phép dùng request ID, mã lỗi và ID nội bộ cần thiết.
- [JSON Schema](contract.schema.json) mô tả DTO; [ví dụ](contract-examples.json) có cả trường hợp hợp lệ và từ chối. Validation ngữ nghĩa vẫn bắt buộc.

## 2. Health và tương thích

| Method/path | Request | Response |
| --- | --- | --- |
| `GET /health` | Không auth, không body. | `200 {"status":"ok"}` khi process phục vụ; `503` khi không sẵn sàng. Không trả cấu hình hay secret. |
| `GET /version` | Không auth. | `200 VersionInfo`: `api_major:1`, `protocol_versions:[1]`, `reducer_versions:[1]`, `server_time` UTC; các giới hạn truyền bên dưới. |
| `GET /sync/clock?device_id=UUID` | Phiên verified. | `200 {calibration_id,server_time_ms,server_time,max_future_skew_ms:300000}`; dùng phép đo RTT/offset theo sync contract. Calibration ID là bookkeeping, không chứng minh thời điểm sửa offline. |

Thay đổi không tương thích dùng API major mới. Operation giữ `protocol_version` và `reducer_version` bất biến. Client không hiểu reducer phải giữ hàng đợi và cập nhật; không diễn giải payload bằng thuật toán khác.

## 3. Tài khoản

Tất cả đường dẫn bên dưới có prefix `/api/v1`. TTL, giới hạn thử/gửi và password policy lấy từ [auth contract](auth-contract.md), không định nghĩa lại khác ở UI.

| Method/path | Body | Thành công |
| --- | --- | --- |
| `GET /auth/session` | Không body. | `200 SessionView`; chưa đăng nhập vẫn nhận CSRF context, `authenticated:false`. |
| `POST /auth/register` | `{email}` | `202 AcceptedEmailRequest` trung tính. Không đặt password trước khi chứng minh sở hữu email. |
| `POST /auth/verification/resend` | `{email}` | Cùng `202 AcceptedEmailRequest`. |
| `POST /auth/verification/confirm` | `{token,password}` | `200 {status:"verified"}`; tạo owner đã xác minh và password nguyên tử; không tự đăng nhập. |
| `POST /auth/login` | `{email,password,remember_me}` | `200 SessionView` authenticated; rotate cookie; `remember_me` mặc định UI là true. |
| `POST /auth/password/forgot` | `{email}` | `202 AcceptedEmailRequest` trung tính. |
| `POST /auth/password/reset` | `{token,password}` | `200 {status:"password_reset"}`; thu hồi các phiên, trở về đăng nhập. |
| `POST /auth/logout` | `{logout_ticket?}` hoặc `{}` | `204`, idempotent. Logout ticket chỉ thu hồi đúng phiên được chỉ định. |
| `GET /auth/local-key` | Phiên verified, đã nhập password trong 5 phút. | `200 {owner_id,key_id,algorithm:"A256GCM",key_base64url}`; import CryptoKey không extractable. |

`SessionView` có `authenticated`, `owner|null`, `session|null`, `csrf_token`, `server_time`, `logout_ticket|null`. Session gồm ID nội bộ, `remember_me`, `idle_expires_at`, `absolute_expires_at`, `password_authenticated_at`. Không trả raw cookie/token phiên.

`AcceptedEmailRequest = {status:"accepted",resend_after_seconds:60}`. Không phân biệt email tồn tại, chưa có hoặc không thuộc owner allowlist qua nội dung thành công. Frontend không diễn giải `202` là bằng chứng email đã tới inbox; delivery phải được kiểm chứng ở nhóm deploy.

## 4. Bootstrap và pull

| Method/path | Query | Thành công |
| --- | --- | --- |
| `GET /sync/bootstrap` | Request đầu không cần cursor; request tiếp chỉ dùng `page_token`. | `200 SyncPage` của prefix event bất biến đến watermark H. |
| `GET /sync/pull` | Request đầu `after=cursor`; tiếp theo dùng `page_token`, không trộn tham số mới. | `200 SyncPage` với `after < cursor <= H`. |

Cursor là số nguyên không âm dạng chuỗi, không phải timestamp. Cursor luôn đi kèm `epoch`; pull request đầu gửi `epoch=UUID` của local, trừ bootstrap. Token tiếp trang ràng buộc owner, epoch, H, vị trí tiếp, schema và hạn 30 phút; không chứa plaintext dữ liệu lịch.

```json
{
  "epoch": "11111111-1111-4111-8111-111111111111",
  "through_cursor": "0",
  "next_cursor": "0",
  "has_more": false,
  "next_page_token": null,
  "groups": []
}
```

Ví dụ là bootstrap của workspace chưa có event. Với `has_more:true`, page phải tiến và có ít nhất một group. Mỗi group là `{cursor,committed_at,operation}`. Không chia một operation/nhóm nghiệp vụ ra hai trang. `has_more:false` đòi `next_cursor=through_cursor` và `next_page_token:null`.

Đọc từ primary. H chỉ bao gồm giao dịch đã commit. Không dùng raw `AUTO_INCREMENT` hoặc cursor lấy từ ACK làm watermark pull. Nếu không có thay đổi, trả page rỗng với H bằng cursor hiện tại, không tạo cursor giả.

Token hết hạn trả `409 page_token_expired`; pull tiếp tục từ cursor đã commit local. Bootstrap giữ staging và dữ liệu cũ, có thể bắt đầu lại prefix mới; chỉ swap khi nhận đủ. Epoch không khớp trả `409 cursor_epoch_mismatch`, giữ toàn bộ local event/outbox để phục hồi theo sync contract.

## 5. Push

`POST /sync/push`, body `{operations:[Operation]}`. Mỗi operation là một hành động nghiệp vụ, chứa một hoặc nhiều command được áp dụng toàn bộ hoặc không áp dụng. Nhiều operation trong một HTTP request là các giao dịch độc lập; không gộp chúng thành một giao dịch chỉ vì gửi chung.

Giới hạn 100 operation/request, 8.388.608 byte UTF-8/request, 2.097.152 byte/operation và 1.000 command/operation. Pull/bootstrap tối đa 200 group và 8.388.608 byte/page; dừng trước group tiếp theo nếu vượt. Không cắt một nhóm. Các giới hạn được trả bởi `/version`; không được cắt note hoặc tự chia thao tác chuỗi để vừa request.

Vỏ request sai JSON hoặc vượt giới hạn trả `400`/`413`, không ghi operation. Phiên/quyền/CSRF sai trả lỗi HTTP trước khi xử lý. Body batch hợp lệ được xét từng operation theo thứ tự request; lỗi một operation không chặn các operation độc lập còn lại. Client gửi phụ thuộc trước; không đảo timestamp để vượt lỗi phụ thuộc.

```json
{
  "epoch": "11111111-1111-4111-8111-111111111111",
  "head_cursor": "26",
  "results": [
    {
      "operation_id": "22222222-2222-4222-8222-222222222222",
      "status": "recorded",
      "receipt": {
        "operation_id": "22222222-2222-4222-8222-222222222222",
        "request_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "recorded": true,
        "commit_cursor": "26",
        "effect_at_commit": "applied",
        "reason_at_commit": null
      }
    }
  ]
}
```

Mỗi item request có đúng một result theo cùng thứ tự, với `status: recorded|duplicate|deferred|rejected`. Hai trạng thái đầu có receipt; hai trạng thái sau có `problem` theo mục 6 và không ACK operation. `operation_id:null` chỉ dùng khi item sai cấu trúc đến mức không đọc được ID hợp lệ. `HTTP 200` không đồng nghĩa mọi operation đã ghi hoặc luôn thắng.

Operation trùng ID/hash trả receipt cũ, không cấp cursor mới. Trùng ID khác hash trả `operation_id_reused`. Receipt xác nhận event bền vững; client phải pull đến khi event đó có trong shadow trước khi bỏ lớp `ack_waiting_pull`. `head_cursor` không được gán trực tiếp cho pull cursor.

## 6. Lỗi thống nhất

Dùng [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html). `code` ổn định để chương trình xử lý; UI ánh xạ sang tiếng Việt, không phân tích `detail` để quyết định logic. `type` là URI-reference `/api/v1/problems/{code}`; `instance` là URI-reference gắn request, không chứa password/token/query nhạy cảm.

```json
{
  "type": "/api/v1/problems/validation_failed",
  "title": "Validation failed",
  "status": 422,
  "detail": "One or more fields are invalid.",
  "instance": "/api/v1/requests/33333333-3333-4333-8333-333333333333",
  "code": "validation_failed",
  "request_id": "33333333-3333-4333-8333-333333333333",
  "retryable": false,
  "server_time": "2026-10-28T12:00:00.000Z",
  "field_errors": [{"path":"/operations/0/commands/0/payload/title","code":"too_long"}]
}
```

| HTTP/code | Hành vi bắt buộc |
| --- | --- |
| `400 malformed_request` | Không đoán/cắt payload; giữ bản nhập hoặc operation lỗi. |
| `401 authentication_required` | Dừng sync, giữ local, đăng nhập lại; không khóa lịch vì hết phiên. |
| `403 owner_mismatch/email_not_verified/csrf_failed` | Không ghi dữ liệu; không tự đổi owner assertion. |
| `403 reauthentication_required` | Nhập lại password trước khi lấy key; không tự mở vault bằng cookie cũ. |
| `409 dependency_missing` | Gửi dependency trước rồi retry nguyên operation. |
| `409 operation_id_reused` | Lỗi integrity; giữ dữ liệu, không thay nội dung dưới cùng ID. |
| `409 client_update_required/cursor_epoch_mismatch/page_token_expired` | Cập nhật/bootstrap/tiếp trang đúng tình huống; giữ event và pending. |
| `413 payload_too_large` | Không chia nhóm nguyên tử hoặc cắt trường; giữ dữ liệu, báo lỗi kỹ thuật. |
| `422 validation_failed/invalid_causality/time_invalid` | Giữ operation và chi tiết lỗi; các operation độc lập vẫn sync. |
| `429 rate_limited`, `503 service_unavailable` | Tôn trọng `Retry-After`; giữ ID/body/time khi retry. |

Các mã chi tiết link/password/rate limit trong auth contract cũng dùng cùng Problem schema. `field_errors[].path` là JSON Pointer. `retry_after_seconds` nếu có phải khớp `Retry-After`.

## 7. Không mở thêm API ngoài phạm vi

Không có `/tasks`/`milestones` CRUD riêng, Google login, chia sẻ, quản trị nhiều owner hoặc endpoint đổi múi giờ trong đợt đầu. Lịch đọc projection local; bootstrap/pull/push là đường truyền dữ liệu chuẩn. Health/version không được xem là bằng chứng API/auth/database nghiệp vụ đã nghiệm thu.
