# T22 — Thao tác occurrence và chuỗi lặp

Trạng thái: hoàn tất; PR #22 đã squash-merge vào `develop` sau khi CI và Offline web shell đều xanh.

## Đã triển khai

- Thẻ occurrence và task đã tách mở được biểu mẫu chỉnh sửa; định danh mục tiêu ổn định giúp chỉnh trạng thái/nội dung/xóa đúng occurrence.
- Thao tác sửa/xóa có thể hoàn tác. Sibling của occurrence không đổi khi chỉ sửa hoặc gỡ một lần.
- Biểu mẫu cho chọn phạm vi chỉ occurrence này hoặc sửa quy tắc/mẫu từ ngày gốc. Sửa phần tương lai tạo segment mới và bảo toàn exception đã tách, gồm kế hoạch/màu.
- Có thể chỉnh task đã tách như task một lần.
- Có thể dừng chuỗi từ ngày gốc; occurrence tương lai đã dời được xác định qua ngày gốc, lịch sử trước cutoff và task đã tách vẫn còn, thao tác dừng có thể hoàn tác.
- Reorder/reschedule hỗ trợ bucket lẫn task một lần, occurrence và task đã tách.

## Kiểm chứng local

| Kiểm tra | Kết quả |
| --- | --- |
| `pnpm typecheck:web` | Passed |
| `pnpm lint:web` | Passed |
| `git diff --check` | Passed |
| Sửa/xóa/undo một occurrence, sibling không đổi | Passed |
| Sửa quy tắc theo cutoff, giữ exception/plan/color, sửa detached, dừng qua occurrence đã dời | Passed |
| Di chuyển và sắp xếp bucket trộn | Passed |
| Regression tạo task và nested plan | Passed |
| GitHub CI #83 | Passed: quality, development/production browser suites, production build/API check, MySQL integration và two-browser sync acceptance |
| Offline web shell #70 | Passed: production offline suite và same-origin A/B update suite |

T23 vẫn sẽ kiểm tra lại các hành vi này qua hai thiết bị, retry, lost response, MySQL và quy tắc hội tụ client/server. Local browser test T22 xác minh luồng UI với backend test hiện tại, không thay thế nghiệm thu đồng bộ đa thiết bị.
