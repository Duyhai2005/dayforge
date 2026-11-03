# T23 — Nghiệm thu đồng bộ chuỗi lặp

Trạng thái: đã hoàn tất kiểm chứng trên `feature/recurring-sync-acceptance`; PR #23 vào `develop`, mọi job CI và Offline web shell đều xanh. PR sẵn sàng squash merge.

## Đã bổ sung

- Harness có thể tạo recurrence, thay một occurrence, sửa quy tắc tương lai, dừng chuỗi, undo mutation cấu trúc và đọc family hash/card projection trực tiếp từ client reducer.
- Two-browser scenario dùng cùng owner đã xác minh nhưng storage/device lane riêng, IndexedDB/outbox thật, API thật và MySQL cô lập.
- Tạo các lần ngoại lệ từ hai browser; đưa một device offline rồi reconnect; xác nhận operation ID và request hash giữ nguyên.
- Tạo hai edit cùng target với timestamp có thứ tự xác định; xác nhận edit mới hơn thắng khi event cũ đến muộn, đồng thời edit khác occurrence vẫn được giữ.
- Làm mất response sau khi MySQL ghi `series.edit_future`; xác nhận client retry body byte-identical và cả hai browser hội tụ.
- Xác nhận detached exception giữ effective date, plan ID, plan color và standalone color sau khi đổi rule; dừng theo ngày gốc gỡ occurrence đã dời, giữ history và detached children; undo stop khôi phục projection/hash trên cả hai thiết bị.
- Toàn bộ 12 recurrence operations được ghi nhận trên cả hai device; ba detached exceptions được giữ; same-target LWW chọn edit mới hơn; root hash sau undo giống nhau trên A và B.
- Full sync acceptance tiếp tục qua lost push response, stale pull transaction abort, leader takeover, stale ACK, process death, clock repair, hai epoch recovery, owner lock và quota transaction abort.

## Kiểm chứng

| Kiểm tra | Kết quả |
| --- | --- |
| `pnpm typecheck:web` | Passed |
| `pnpm lint:web` | Passed |
| `node --check scripts/test_sync_browser.cjs` | Passed |
| `git diff --check` | Passed |
| `pnpm test:sync:browser` local | Chưa chạy: Docker Desktop Linux Engine không hoạt động; named pipe `dockerDesktopLinuxEngine` không tồn tại |
| GitHub CI quality | Passed — run [#41674982176](https://github.com/Duyhai2005/dayforge/actions/runs/41674982176) |
| GitHub CI frontend dev/prod | Passed — run [#41674982176](https://github.com/Duyhai2005/dayforge/actions/runs/41674982176) |
| GitHub CI MySQL integration + two-browser sync acceptance | Passed — run [#41674982176](https://github.com/Duyhai2005/dayforge/actions/runs/41674982176) |
| Offline web shell | Passed — run [#41674982174](https://github.com/Duyhai2005/dayforge/actions/runs/41674982174); companion run [#41674974916](https://github.com/Duyhai2005/dayforge/actions/runs/41674974916) also passed |

PR: [#23 — Verify recurring task sync across devices](https://github.com/Duyhai2005/dayforge/pull/23). CI evidence is for code commit `1f706c57794bda173cef2ef2bb809a34d63bef7a`; this documentation update does not change the implementation.

Giới hạn môi trường: runner T23 local dừng trước khi tạo container vì Docker Desktop Linux Engine không hoạt động. MySQL/two-browser suite đã chạy thành công trong CI cô lập.
