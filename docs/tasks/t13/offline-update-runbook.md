# T13 — Runbook offline và cập nhật web

Ngày cập nhật: **03/11/2026** · Phạm vi: hành vi hiện có và cách kiểm tra; chưa phải runbook phát hành production ở T33.

## Chuẩn bị và sử dụng offline

1. Khi còn mạng, mở `/work` và `/milestones` để production service worker chuẩn bị shell cùng asset của build hiện tại.
2. Đăng nhập và mở vault trên thiết bị đó trước khi ngắt mạng. Cookie/session không tự mở vault.
3. Khi offline, vào lịch qua URL hiện có; `/` được worker chuyển cục bộ tới `/work`. API/auth/callback vẫn cần mạng. Nếu shell hoặc local vault chưa sẵn sàng, kết nối lại mạng; không coi trang trắng hoặc lỗi API là lịch rỗng.
4. Khi có bản cập nhật, xử lý draft trước rồi chấp thuận update. Nếu tab còn draft chưa lưu, gate hoãn chuyển build. Giữ tab đang nhập và chờ hoàn tất; không đóng tab để ép update.
5. Sau khi build mới mở lại, kiểm tra local data và trạng thái đồng bộ. Reconnect để coordinator gửi pending theo envelope đã lưu.

## Chẩn đoán và khôi phục an toàn

- Kiểm tra browser đang điều khiển bởi worker đúng build qua DevTools → Application → Service Workers; shell được giữ trong Cache Storage theo `dayforge-shell:<build-id>`.
- API/auth cần online; cache shell không phải bản sao của session hoặc lịch riêng.
- Nếu update bị hoãn, xử lý draft trên tab đang sở hữu nội dung rồi thử lại. Nếu có lỗi IndexedDB/quota, giữ site data và pending, ghi lại lỗi/request ID, kết nối lại và thử sau khi giải phóng dung lượng theo chính sách thiết bị.
- Không dùng **Clear site data**, xóa IndexedDB, xóa cache thủ công hoặc bỏ qua update gate để khắc phục; các thao tác đó có thể làm mất dữ liệu local chưa gửi.
- Khi cần hỗ trợ, chỉ chia sẻ build ID, browser/OS version, URL route, thời điểm lỗi và request ID; không gửi cookie, token, khóa hoặc dữ liệu lịch.

## Kiểm chứng A/B hiện tại

- `pnpm test:web:offline` chạy service-worker suite production riêng (**6/6 passed**), gồm cold start sau restart, migration gate/checkpoint/rollback, migration resume sau khi tab schema cũ đóng kết nối và crash sau migration commit trước build approval.
- `pnpm test:web:offline:update` dựng build A rồi B trên cùng origin/profile; kiểm tra draft AES-GCM giữ nguyên, operation `ack_waiting_pull` giữ nguyên hash/ciphertext qua switch, tab mới gia nhập preparing, guarded reload sang B, Cache Storage không chứa owner/title/token/key/note sentinel, và install lỗi khi thiếu asset/quota Cache Storage không thay build A đang dùng. Runner giữ một RSC/Flight request qua thời điểm gate vào `switching`; response build B bị từ chối với 409 và marker build A. Handshake chờ callback drain writer trước khi chuyển; runner dùng writer fixture trì hoãn 750 ms để kiểm tra gate vẫn ở `preparing`. Client tab không phản hồi message handshake không được tính là đồng ý; gate hủy preparing và trở về build A. Ca lost-push mới dùng coordinator sản phẩm và API test in-memory: server ghi rồi giữ response lần đầu khi update bị hoãn; request byte-identical được retry. Server tiếp tục giữ response sau commit khi gate chuyển build; build B retry cùng envelope, nhận duplicate, pull hai event và client xóa outbox sau khi hội tụ. Cùng một operation không tạo thêm effect server. MySQL receipt/replay vẫn được kiểm tra riêng bằng `pnpm test:sync:browser`; A/B fault injection này không thay cho phép đo suspend OS.
- Cùng entrypoint chạy scenario IndexedDB quota riêng bằng Chromium production harness: quota 256 KiB làm mutation local hợp lệ lớn báo `QuotaExceededError`; revision, outbox và projection không đổi. Không dùng lỗi Cache Storage thay cho ca IndexedDB này.
- `pnpm test:sync:browser` kiểm tra API/storage mutation offline create/edit/delete theo dependency; sau reconnect, MySQL ghi event và hai browser context hội tụ với ID/hash gốc. Ca này dùng test harness, chưa là tương tác UI lịch.
- `pnpm verify:web-discovery` xác nhận spec offline tách khỏi dev/production suites thường.
- Đã kiểm tra bằng Playwright Chromium trên môi trường phát triển hiện tại. Chưa nghiệm thu OS/browser/HTTPS production target. Tab suspend ba lease TTL được kiểm tra cho takeover sync; update handshake với một tab không phản hồi được mô phỏng ở biên message protocol. ACK-waiting và push response mất trong lúc update được kiểm tra qua build switch; thao tác UI lịch vẫn thuộc T14–T23. `versionchange` blocked/resume được kiểm tra với tab cũ giữ connection; migration rollback được kiểm tra với gate revision exhaustion.
