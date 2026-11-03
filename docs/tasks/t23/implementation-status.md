# T23 — Nghiệm thu đồng bộ chuỗi lặp

Trạng thái: đã mở rộng runner/harness trên `feature/recurring-sync-acceptance`; typecheck, lint và kiểm tra cú pháp runner local đã xanh. PR/CI còn chờ.

## Đã bổ sung

- Harness có thể tạo recurrence, thay một occurrence, sửa quy tắc tương lai, dừng chuỗi, undo mutation cấu trúc và đọc family hash/card projection trực tiếp từ client reducer.
- Two-browser scenario dùng cùng owner đã xác minh nhưng storage/device lane riêng, IndexedDB/outbox thật, API thật và MySQL cô lập.
- Tạo các lần ngoại lệ từ hai browser; đưa một device offline rồi reconnect; xác nhận operation ID và request hash giữ nguyên.
- Tạo hai edit cùng target với timestamp có thứ tự xác định; xác nhận edit mới hơn thắng khi event cũ đến muộn, đồng thời edit khác occurrence vẫn được giữ.
- Làm mất response sau khi MySQL ghi `series.edit_future`; xác nhận client retry body byte-identical và cả hai browser hội tụ.
- Xác nhận detached exception giữ effective date, plan ID, plan color và standalone color sau khi đổi rule; dừng theo ngày gốc gỡ occurrence đã dời, giữ history và detached children; undo stop khôi phục projection/hash trên cả hai thiết bị.

## Kiểm chứng

| Kiểm tra | Kết quả |
| --- | --- |
| `pnpm typecheck:web` | Passed |
| `pnpm lint:web` | Passed |
| `node --check scripts/test_sync_browser.cjs` | Passed |
| `git diff --check` | Passed |
| `pnpm test:sync:browser` local | Chưa chạy: Docker Desktop Linux Engine không hoạt động; named pipe `dockerDesktopLinuxEngine` không tồn tại |
| GitHub CI | Chưa chạy; PR chưa mở |

Suite MySQL/two-browser được cấu hình trong GitHub CI và đã xanh trên PR #22. Runner T23 local dừng trước khi tạo container; chưa có kết quả local để báo cáo cho kịch bản recurrence mới.
