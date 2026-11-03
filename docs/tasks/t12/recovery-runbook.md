# T12 — Runbook clock repair và sync recovery

Ngày cập nhật: **03/11/2026** · Phạm vi: hướng dẫn vận hành hiện trạng; chưa thay cho runbook production ở T33.

## Sửa operation bị từ chối do clock

1. Giữ nguyên dữ liệu site và mở app khi có mạng, đăng nhập đúng owner rồi mở vault.
2. Kiểm tra giờ hệ điều hành và bật đồng bộ giờ tự động. Không tự sửa `edit_time` hay envelope đã được lưu.
3. Dùng thao tác **“Lưu lại sau sửa giờ thiết bị”** trong tài khoản để lấy calibration mới và tạo operation semantic replacement trên lane mới.
4. Chờ replacement được ghi nhận và pull về thiết bị khác. Operation cũ phải nằm trong diagnostics; không xóa hoặc gửi lại thủ công.
5. Nếu operation đã có receipt hoặc kết quả push chưa rõ, không reauthor thủ công. Giữ vault/outbox nguyên trạng và chuyển log không nhạy cảm cùng request ID cho người vận hành.

Client chỉ tự reauthor nhánh chưa recorded có đủ pre-state để chứng minh tương đương. Originals được mã hóa trong diagnostics và không tính pending.

## Server restore / epoch mismatch

- Để app trực tuyến và giữ vault local. Coordinator tự tạo recovery journal từ shadow cùng active outbox, bootstrap epoch mới, rồi reupload envelope đã ACK trước đó.
- Đợi trạng thái pull/recovery kết thúc trên từng thiết bị trước khi khóa hoặc đóng tab. Không xóa IndexedDB, journal, outbox hay cache để “sửa” trạng thái.
- Nếu recovery dừng lặp lại, giữ nguyên thiết bị và báo lỗi/request ID; không reset epoch thủ công trên DB dùng thật. Chỉ runner test được phép xóa event và cấp epoch mới trong MySQL cô lập.
- Diagnostics/journal không chứa khóa trong plaintext. Không gửi ciphertext hay browser profile ra ngoài kênh hỗ trợ đã được duyệt.

## Kiểm chứng trong môi trường phát triển

- `pnpm test:sync:browser` chạy trên disposable MySQL và Chromium HTTPS local, có ca mất response, stale response sau fencing/takeover, pull xen local save, clock rejection/reauthor, hai lần epoch restore trong một lượt recovery, owner lock và chuỗi create/edit/delete offline rồi reconnect. Runner dùng `uv` nếu có hoặc Python trong `backend/.venv`.
- `backend\.venv\Scripts\python.exe scripts\test_backend.py --mysql -- tests/integration/test_sync_log.py` chạy integration sync log trên MySQL dùng riêng cho lượt test.
- Runner abort transaction IndexedDB khi persist journal, bootstrap staging và recovery publish, xác nhận revision/cursor/shadow/journal rollback rồi reload để resume. Recovery reupload được thử bằng cách giữ response sau server commit, đóng leader tab và xác nhận tab mới retry body byte-identical, nhận `duplicate` rồi hoàn tất recovery. Quota thật được ép trên local mutation writer, recovery journal (copy draft mã hóa 600 KB) và bootstrap staging (200 event lớn); quota ngay tại generation publish chưa được thử. Hai Chromium device lane đã chạy sáu calibration qua `/sync/clock` với browser wall-clock skew có kiểm soát; đây không phải thay đổi đồng hồ OS trên hai máy vật lý. Hai epoch restore đã chạy trong integration test, nhưng không thay thế diễn tập khôi phục production.
