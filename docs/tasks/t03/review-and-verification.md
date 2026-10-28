# T03 — rà soát và kiểm chứng hợp đồng

Ngày **28/10/2026** · Phạm vi: [hợp đồng T03](design.md), không phải kiểm thử sản phẩm.

## 1. Phương pháp

- Đối chiếu T01/T02, 48 FR, convention và Git Flow; không thêm tính năng ngoài phạm vi.
- Tách rà soát dữ liệu/lặp, tài khoản và đồng bộ; một builder reviewer độc lập đọc bản viết để tìm quyết định còn thiếu trước khi triển khai.
- Dùng JSON Schema Draft 2020-12 cho DTO và fixture hợp lệ/không hợp lệ. Kiểm tra đủ ví dụ cho mọi action, định dạng ngày, enum, null, giới hạn Unicode và chống coercion kiểu.
- Kiểm tra đường dẫn tài liệu, UTF-8, dấu conflict, whitespace và phạm vi Git trước khi commit.

## 2. Các điểm đã được đưa vào hợp đồng sau rà soát

| Rủi ro | Quy tắc được khóa |
| --- | --- |
| Một occurrence edit từ snapshot cũ phục hồi rule đã dừng | Replay intent theo edit order; occurrence retired không restart, structural intent rõ ràng mới có thể đổi lại future. |
| Ngoại lệ dời/xóa bị trùng hoặc sống lại khi đổi rule | Danh tính ngày gốc, deterministic child ID, suppression theo original date, không theo ngày đích. |
| Lệnh structural mới bị từ chối chỉ vì source segment đã cắt | SegmentOrigin lịch sử và áp dụng vào current canonical future; kết quả không theo thứ tự HTTP. |
| Sync rejection làm biến mất dữ liệu đã lưu local | Blocked/quarantine vẫn ở optimistic overlay và pending; không tự bỏ sửa. |
| HLC tương lai bị mắc kẹt dù đã sửa đồng hồ | Lane device/HLC mới, explicit reauthor causal chain chưa recorded, giữ bản gốc và không sửa receipt. |
| ACK trễ bỏ mất event của thiết bị khác | ACK không đẩy pull cursor; giữ ack-waiting overlay đến khi pull nhận đúng event/hash. |
| Cursor tự tăng bỏ qua giao dịch commit trễ | Khóa owner sequence tới commit; cấp cursor cùng event, projection và receipt. |
| Rebalance/Undo ghi một phần hoặc dựa trên snapshot cũ | Precondition semantic root/bucket trước group, inverse cùng phạm vi, kiểm tra live references. |
| Undo-create làm mất provenance hoặc mở ID tái sử dụng | Tombstone giữ ID/payload/catalog; không có API xóa plan/family mới. |
| Đăng xuất chỉ ẩn DOM nhưng dữ liệu vẫn tự mở | Vault mã hóa, xóa key/khóa cross-tab, gate password gần đây trước khi lấy lại key. |
| Đăng ký trước email proof dùng password do kẻ khác đặt | Email-first; đặt password sau khi xác minh link và tạo owner nguyên tử. |

Những thay đổi trên là làm rõ cách triển khai trong phạm vi T03; không phải lựa chọn nghiệp vụ mới của người dùng.

## 3. Kiểm tra có thể chạy lại

Từ thư mục repo, dùng Python với công cụ phát triển `jsonschema` hỗ trợ Draft 2020-12:

```powershell
python docs/tasks/t03/verify_contract.py
git diff --check
```

Validator chỉ đọc schema/fixture/Markdown tại T03; không gọi mạng, server, tài khoản hay email. Nó không thay implementation test. Môi trường rà soát có Python 3.12 và `jsonschema` 4.25.1; không cài hoặc khóa dependency ứng dụng trong T03.

Kết quả thực chạy:

- Schema hợp lệ: **42 definition**, **64 fixture**; 41 payload được chấp nhận và 23 payload sai bị từ chối đúng kỳ vọng; đủ ví dụ cho **18 action**.
- Bốn giá trị dẫn xuất UUIDv5 và một vector byte canonical JSON/SHA-256 khớp giá trị chuẩn đã ghi trong fixture. Đây là dữ liệu đối chiếu cho implementer, không thay test JCS/reducer của sản phẩm.
- Validator kiểm tra **35 liên kết local** trong bộ Markdown T03, không có đích bị thiếu.
- Builder reviewer đọc lại sau khi sửa các vấn đề clock recovery, provenance, Undo và transport; kết luận cuối: **“nothing important left”**.
- `git diff --check` không ghi nhận lỗi whitespace; trước commit kiểm tra thêm diff đã stage và đúng phạm vi tài liệu T03/mục lục chịu ảnh hưởng.

T03 hoàn thành phần hợp đồng kỹ thuật theo quyền đã giao. Các kết quả trên không xác nhận API hoặc thuật toán sản phẩm đã chạy.

## 4. Kịch bản bắt buộc khi triển khai

| Mã | Case và kết quả mong đợi | Task chính |
| --- | --- | --- |
| CT-01 | Null/Unicode/NFC/date/enum/limits frontend và server giống nhau; không cắt note. | T04–T08, T15/T17 |
| CT-02 | Task completed bật lặp giữ lần đầu; weekday không khớp bị từ chối; không tạo hai root. | T21/T22 |
| CT-03 | Original trước cutoff dời sau cutoff vẫn giữ; original sau cutoff dời trước cutoff bị detach/stop đúng phạm vi. | T21–T23 |
| CT-04 | Deleted, completed và order-only override; successor không trùng child hoặc hồi sinh deleted slot. | T21–T23 |
| CT-05 | Hai edit ở occurrence khác nhau giữ cả hai; cùng target nhận payload K mới nhất; hoán vị arrival/retry cho cùng projection. | T10–T12, T23 |
| CT-06 | Newer structural intent dùng historical source; stop sau edit và edit sau stop có kết quả đã định nghĩa. | T12/T22/T23 |
| CT-07 | Equal-HLC delete tie, clock lùi/tới trước/offline lâu, lane repair và dependency mapping không bỏ dữ liệu. | T08/T11/T12 |
| CT-08 | Mất response sau commit, retry cùng ID/hash, đổi body cùng ID bị từ chối; no-op receipt không phải thắng vĩnh viễn. | T10–T12 |
| CT-09 | ACK/pull đảo thứ tự khi local có edit mới; blocked vẫn hiện; không đẩy cursor theo ACK. | T11/T12 |
| CT-10 | Owner lock rollback, hai worker commit trái tốc độ; pull không bỏ cursor thấp commit trễ. | T10 |
| CT-11 | Bootstrap/pull nhiều trang trong lúc có ghi; token/epoch thay đổi giữ toàn bộ event/outbox, không mất pending. | T10–T13, T31/T35 |
| CT-12 | Undo create/enable/edit/stop/rebalance; late old event hoặc live reference làm inverse không còn an toàn thì từ chối cả nhóm. | T12/T19/T22 |
| CT-13 | Rebalance bucket lớn, có insert root khác cạnh tranh; fingerprint sai không làm thay đổi một phần. | T19/T28 |
| CT-14 | Email allowlist, token hết hạn/reuse/race, reset revoke, CSRF/Origin, no-store và log không có secret. | T09/T13/T28 |
| CT-15 | Hết phiên vẫn xem/sửa; offline logout khóa mọi tab/late callback; login đúng owner mở lại nguyên pending. | T09/T13/T25/T28 |
| CT-16 | KEK/key/DB backup phục hồi, reset không đổi vault key, delivery email tới inbox thật. | T30–T32/T35 |

Các case này **chưa chạy trên sản phẩm** trong T03. Chưa có FastAPI/Next.js/MySQL/IndexedDB thật, SMTP/provider, Cốc Cốc production hoặc CI sản phẩm để nghiệm thu 38 AC.

## 5. Phạm vi Git

Commit trên `feature/project-design` bằng message tiếng Anh dạng `docs: ...`, không thêm scope số task. Chỉ push nhánh feature. Merge vào `develop`/`main` phải theo PR và review trong [Git Flow](../../GITFLOW.md).
