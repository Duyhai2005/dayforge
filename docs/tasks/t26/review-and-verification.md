# T26 — Review và kiểm chứng

## Kết quả

Đã kiểm tra luồng lịch, widget, biểu mẫu và dialog bằng Playwright trên Windows với Chromium (Playwright 1.64.1).

| Kích thước viewport | Kết quả | Ghi chú |
| --- | --- | --- |
| 1024×768 | PASS | Không tràn ngang; widget và form vẫn thao tác được. |
| 1920×1080 | PASS | Không tràn ngang; các thao tác chính nằm trong vùng nhìn. |
| 512×384 | PASS | Dùng CSS viewport tương đương nội dung desktop ở 200% zoom; widget, editor và dialog cuộn trong panel. |

Kiểm thử bàn phím xác nhận Tab/Shift+Tab theo thứ tự hiển thị, focus trap ở dialog trên cùng, Escape chỉ đóng lớp trên, dirty form giữ nguyên bản nháp, focus được trả về trigger sau khi đóng. Các nút biểu tượng có tên truy cập được; trạng thái công việc có nhãn chữ; trường form có label. Bài audit đo tỷ lệ tương phản từ màu computed: chữ thường đạt ít nhất 4.5:1, chữ lớn và viền điều khiển đạt ít nhất 3:1. Focus ring rộng 2px, offset 3px. Reduced motion loại bỏ dịch chuyển/scale nhìn thấy được và giữ transition tối đa 80ms.

## Lệnh và kết quả

| Lệnh | Kết quả |
| --- | --- |
| `pnpm --filter @dayforge/frontend exec playwright test tests/calendar-widget.spec.ts tests/milestone-calendar.spec.ts tests/auth-session.spec.ts tests/accessibility.spec.ts` | PASS — 45/45 tests |
| `pnpm lint:web` | PASS |
| `pnpm typecheck:web` | PASS |
| `pnpm build:web` | PASS — Next.js production build |
| `git diff --check` | PASS |

## Phạm vi và giới hạn

- 512×384 là viewport CSS dùng để kiểm tra nội dung ở mật độ tương đương zoom 200%; không phải thao tác đổi mức zoom trình duyệt vật lý.
- Reduced motion được giả lập qua Playwright. Báo cáo không tuyên bố đã chạy thử bằng screen reader hoặc kiểm tra thủ công trên thiết bị khác.
- Playwright ghi cảnh báo kết nối tới API local `127.0.0.1:8000` trong một số test; các suite này mock/abort các API liên quan và cả 45 test vẫn đạt.
- Task chỉ đổi hành vi giao diện, focus/semantics và CSS; không đổi dữ liệu nghiệp vụ hoặc hợp đồng sync.
