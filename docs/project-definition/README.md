# DAYFORGE — hồ sơ định nghĩa dự án

Ngày cập nhật: **28/10/2026** · Phiên bản: **0.5 — T01 và T02 đã duyệt** · Ngôn ngữ: **Tiếng Việt**

DAYFORGE là ứng dụng lập kế hoạch cá nhân, tập trung vào việc nhìn toàn cảnh công việc theo tuần và các dấu mốc sắp tới. Bộ hồ sơ này lưu lại kết quả trao đổi và hướng prototype đã xem, để có thể tiếp tục thiết kế và lập kế hoạch triển khai mà không phải hỏi lại từ đầu.

## Trạng thái tài liệu

- Nhu cầu và các lựa chọn trực tiếp của người dùng đã được tổng hợp.
- Hướng giao diện và các thao tác thêm/sửa/kéo thả được người dùng đánh giá **tạm thời phù hợp**.
- FastAPI/Python, React/Next.js và MySQL là công nghệ người dùng đã chọn.
- **T01 đã hoàn thành ngày 28/10/2026.** Người dùng đã duyệt [bản tổng hợp T01](../tasks/t01/design.md), gồm kiến trúc B — Next.js server, tài khoản email/xác minh/mật khẩu, LWW, quy tắc chuỗi, Cốc Cốc và các mặc định nêu trong bản tổng hợp.
- **T02 hoàn thành ngày 28/10/2026:** người dùng duyệt đặc tả giao diện/tương tác 1.0 bằng xác nhận “được rồi chốt T02”. Các mặc định UI được trình bày trong bản tổng hợp cũng được duyệt cùng lần này.
- Nhà cung cấp AWS/Oracle chọn khi deploy; thư viện phụ và hợp đồng dữ liệu/API tiếp tục ở T03/T04. Các chi tiết kỹ thuật chưa chốt vẫn có nhãn **đề xuất**.
- Hồ sơ có thiết kế T01/T02 đã duyệt; T03–T36 chưa hoàn thành. Đây không phải bằng chứng ứng dụng đã được xây dựng.

## Cách phân biệt quyết định

| Nhãn | Ý nghĩa |
| --- | --- |
| **Đã chốt** | Người dùng đã nêu hoặc xác nhận trực tiếp trong trao đổi. |
| **Hướng tạm chấp nhận** | Người dùng đã xem prototype và đồng ý tiếp tục theo hướng đó; chi tiết vẫn có thể điều chỉnh. |
| **Đề xuất** | Lựa chọn do người viết đề nghị để làm rõ thiết kế, có thể thay đổi. |
| **Còn mở** | Cần quyết định trước bước triển khai có liên quan. |

Các nhãn áp dụng ở mức từng mục. Không hiểu việc chấp nhận một prototype là chấp nhận mọi chi tiết kỹ thuật trong bộ hồ sơ.

## Danh mục và thứ tự đọc

| Tài liệu | Nội dung |
| --- | --- |
| [01 — Tổng quan sản phẩm](01-product-brief.md) | Mục tiêu, tình huống sử dụng, phạm vi và điều cần tránh. |
| [02 — Yêu cầu chức năng](02-functional-requirements.md) | Hai lịch, kế hoạch, công việc, dấu mốc, lặp, trạng thái và offline. |
| [03 — Giao diện và tương tác](03-ux-and-interactions.md) | Hướng thị giác, chuyển trang, biểu mẫu, kéo thả và phản hồi. |
| [04 — Kiến trúc kỹ thuật](04-technical-architecture.md) | Phương án B đã chọn, công nghệ phụ đề xuất, tài khoản, vận hành và offline. |
| [05 — Dữ liệu và đồng bộ đề xuất](05-data-and-sync.md) | Thực thể, ngày/buổi, quy tắc lặp, outbox, revision và xung đột. |
| [06 — Lộ trình và nghiệm thu](06-delivery-and-acceptance.md) | Các mốc bàn giao và tình huống kiểm chứng quan trọng. |
| [07 — Quyết định và điểm còn mở](07-decisions-and-open-questions.md) | Nguồn quyết định, các mặc định được đề xuất và những điểm cần chốt. |

## Tài liệu task

- [Danh sách 36 task giai đoạn 1](../tasks/README.md).
- [Hồ sơ T01 đã duyệt](../tasks/t01/design.md).
- [Đặc tả T02 1.0 đã duyệt](../tasks/t02/design.md), [bản xem tổng hợp](../tasks/t02/prototypes/t02-consolidated-preview-v3.html) và [kết quả rà soát/kiểm tra](../tasks/t02/review-and-verification.md).

Tài liệu tổng hợp và hồ sơ riêng từng task được quản lý trong `docs/tasks/`; thư mục hiện tại lưu hồ sơ thiết kế dự án.

## Nguồn và phạm vi sử dụng

Nguồn nghiệp vụ là các câu trả lời của người dùng trong quá trình brainstorming. Các ảnh trong [assets](assets/) là ảnh chụp prototype dùng để minh họa hướng đã xem; dữ liệu trong ảnh là dữ liệu mẫu. Prototype chỉ phục vụ thảo luận, chưa có backend hoặc lưu trữ/đồng bộ thực.

Nguồn kỹ thuật chính thức được dẫn ngay trong tài liệu kiến trúc. Không khóa phiên bản thư viện ở giai đoạn này; phiên bản phải được chọn, kiểm tra tương thích và ghi vào lockfile khi bắt đầu triển khai.

## Cách cập nhật

1. Khi người dùng chốt một mục còn mở, cập nhật [sổ quyết định](07-decisions-and-open-questions.md) trước.
2. Cập nhật các tài liệu chức năng, UX, kiến trúc và nghiệm thu chịu ảnh hưởng.
3. Giữ rõ phần nào là yêu cầu, phần nào là đề xuất của người thực hiện.
4. Sau khi thiết kế được duyệt, viết kế hoạch triển khai chi tiết riêng; không mặc nhiên coi các mốc bàn giao hiện tại là kế hoạch đã được duyệt.

T01/T02 đã duyệt; bước tiếp theo là T03 — hợp đồng dữ liệu/API và thuật toán. Các mục T03/deploy được theo dõi trong [sổ quyết định](07-decisions-and-open-questions.md#3-các-quyết-định-còn-mở-và-nơi-xử-lý).

Để tổ chức triển khai, dùng [kế hoạch 36 task giai đoạn 1](../tasks/README.md); T01 bao gồm chốt những quyết định còn mở và duyệt thiết kế trước khi xây sản phẩm.
