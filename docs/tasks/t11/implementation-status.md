# T11 — Trạng thái triển khai

Cập nhật: **03/11/2026** · Trạng thái: **Client sync, hai thiết bị, reconnect offline, quota IndexedDB và takeover sau suspend dài đã kiểm chứng; còn nghiệm thu luồng UI lịch và môi trường đích**.

## Đã triển khai

- Vault T08/T09 lưu owner metadata, shadow, projection, outbox, receipt, cursor, observed HLC, diagnostics và recovery journal dưới mã hóa AES-GCM; các writer dùng owner/lock/build/fence/revision guards.
- Auth T09 có session/cookie, CSRF, local-key, logout ticket và giao diện tài khoản. `AccountProvider` mở vault sau xác thực rồi khởi chạy coordinator cho đúng owner.
- API T10 có `/sync/clock`, `/sync/bootstrap`, `/sync/pull`, `/sync/push`; log operation, cursor, receipt và page token được lưu MySQL. Push kiểm tra envelope/hash/dependency/clock trước khi ghi.
- Client sync có leader lease/fencing với fencing token bền, push theo dependency, retry/backoff, pull/bootstrap theo trang, ACK tách khỏi pull, dedup, owner/epoch guard và wake-up theo tab/online/local commit.
- Outbox chỉ gửi operation active; timeout retry giữ nguyên envelope. Pull/rebuild replay recorded shadow cùng active outbox, lưu observed HLC/cursor nguyên tử và gọi recovery khi server epoch đổi.
- Lock event cùng origin dừng coordinator ngay trong handler trước khi chờ React effect cleanup; mutation tiếp theo bị owner/lock-epoch guard từ chối.

## Kiểm chứng đã chạy

- Backend API/unit: **238 passed**; MySQL integration: **45 passed**.
- Bổ sung `test_sync_log.py`: **3 passed** trên MySQL dùng riêng cho test (targeted rerun sau refactor). Hai session đã xác minh cùng owner nhưng device/lane khác nhau; A push plan, B pull rồi push work item phụ thuộc, A pull event mới; test còn kiểm tra duplicate/reused-ID, receipt, head cursor và exhaustion nguyên tử.
- Runner `pnpm test:sync:browser`: **passed** trên MySQL disposable và hai Chromium context HTTPS độc lập. Owner test được đăng ký/xác minh qua API; mỗi context đăng nhập, tạo device lane/IndexedDB riêng. Context A commit plan bằng `commitLocalMutation`; runner để API ghi MySQL rồi thay response đầu bằng 503. Coordinator retry cùng byte body, server trả `duplicate` với cùng hash/cursor. Runner còn giữ response pull của B sau khi server trả event, commit một local mutation B khi pull đang chờ rồi mới thả response; stale revision bị bỏ, B tải lại/chuẩn bị lại trang, giữ mutation local trong outbox và cuối cùng A/B đều có hai event trong shadow/projection. Một ca riêng abort transaction ngay tại commit pull page; trước retry, cursor, recorded shadow và projection của B không đổi, sau đó cùng trang được commit nguyên vẹn. Hai tab dùng chung profile kiểm tra clean leader shutdown và takeover. Ca response cũ tăng persisted fencing token trước khi callback về; callback cũ không thể ACK, successor retry envelope byte-identical và hai thiết bị hội tụ. Ca process death đóng tab leader sau khi server commit nhưng trước khi response push được giao; lease hết hạn, tab mới retry cùng envelope và server trả `duplicate`. Fault hook abort trực tiếp transaction IndexedDB ở lần ghi metadata cuối; local mutation không làm đổi revision/outbox/projection, và transaction persist recovery journal bị abort không làm đổi revision/cursor/shadow/journal. Tiếp đó test làm operation giờ tương lai bị từ chối `time_invalid`, chạy clock repair, cấp calibration cho lane mới và xác nhận bản gốc được archive còn operation replacement sync tới thiết bị kia. Runner xóa log sync trong DB disposable, đổi epoch, rồi xác nhận hai thiết bị upload/pull lại **10 operation** đã ACK với envelope/hash gốc; trong lúc bootstrap recovery đầu tiên đang chờ, server được restore lần hai. Journal được dọn khi publish recovery. Tab thứ ba khóa vault; tất cả tab dừng coordinator và tab cũ không thể commit mutation. Runner đối chiếu request hash, receipt, cursor, lock epoch, fencing token và số lần lấy lại trang. Lượt này cũng phát hiện Next rewrite chuyển media type của Problem sang `application/json`; transport chỉ chấp nhận body sau khi xác thực chặt schema Problem.
- Python reducer: **12 passed**; TypeScript reducer parity/protocol: **9 passed** trên fixture dùng chung cho **18 action v1**, gồm **1.724 arrival permutation** trên các tập nhỏ, biên rank int64 và wire uint64.
- Browser regression production trên corpus trước khi thêm clock drift spec: **45 passed**; offline service-worker suite hiện tại: **6/6 passed**. Clock drift/jump spec mới: **3/3 passed** trên Chromium dev runner.
- Playwright discovery hiện tại: dev **48**, production **48**, offline **6**; offline spec chỉ nằm trong runner offline.
- TypeScript, ESLint, Ruff, mypy và Black đã pass.

## Kiểm chứng bổ sung sau lượt triển khai

- Runner abort transaction tại bootstrap staging và epoch-recovery publish, reload từng checkpoint, rồi xác nhận hai thiết bị phục hồi union đã ACK qua hai epoch. Ca này phát hiện lỗi ghi/xóa shadow trùng khóa và đã được sửa.
- Runner `pnpm test:sync:browser` chạy thành công sau khi bổ sung: một mutation commit khi browser offline, rồi reconnect ghi MySQL và hội tụ ở thiết bị thứ hai; chuỗi create/edit/delete theo dependency giữ nguyên ID/hash; browser wall-clock skew thay đổi qua sáu lần `/sync/clock` trên hai device lane; idle leader bị pause JavaScript qua CDP ba TTL lease, leader kế nhiệm tự nhận lease/gia hạn, tab cũ resume nhưng không thể ghi ACK cũ. Kịch bản stale push response riêng vẫn kiểm tra fencing và retry byte-identical.
- Production Chromium quota scenario trong `pnpm test:web:offline:update`: fresh test origin bị giới hạn 256 KiB; mutation nghiệp vụ hợp lệ gồm 400 dấu mốc với ghi chú lớn nhận `QuotaExceededError`, không tăng revision và không để lại outbox/projection. Dữ liệu thử nằm trong browser profile cô lập.

## Còn thiếu để nghiệm thu hành vi sản phẩm

- Chưa có luồng tạo/sửa/xóa lịch qua biểu mẫu sản phẩm; UI đó thuộc T14–T23. Vì vậy test chứng minh sync/reconnect ở storage API/reducer, chưa chứng minh UX lưu form hoặc giữ nội dung đang nhập khi event remote tới.
- Chưa nghiệm thu trên browser/OS production target. Runner Chromium dùng API/MySQL disposable và local test origin.

**Kết luận:** lõi T11 đã được kiểm chứng qua hai browser context, MySQL thật trong DB test cô lập, reconnect create/edit/delete, quota IndexedDB thật, transaction rollback, response mất/trễ, epoch recovery, owner lock và takeover sau suspend dài. Phần UX biểu mẫu và tích hợp với dữ liệu lịch chờ T14–T23; browser/OS đích chờ môi trường nghiệm thu sau này.
