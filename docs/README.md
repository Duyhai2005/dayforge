# DAYFORGE — mục lục tài liệu

| Nhóm | Nơi đọc |
| --- | --- |
| Thiết kế dự án | [Hồ sơ định nghĩa và thiết kế](project-definition/README.md) |
| Tổng hợp task | [Kế hoạch 36 task giai đoạn 1](tasks/README.md) |
| Hồ sơ từng task | [T01 — Thiết kế đã duyệt](tasks/t01/design.md) |
| Thiết kế T02 đã duyệt | [T02 — Đặc tả giao diện và tương tác](tasks/t02/design.md) |
| Kiểm tra bản T02 | [Rà soát và kiểm tra giao diện tổng hợp](tasks/t02/review-and-verification.md) |
| Hợp đồng T03 | [Dữ liệu, tài khoản, API và đồng bộ 1.0](tasks/t03/design.md) |
| Kế hoạch T04 | [Tổ chức dự án và môi trường phát triển](tasks/t04/plan.md) |
| Kế hoạch T05 | [Dựng nền FastAPI và MySQL](tasks/t05/plan.md) |
| Dựng môi trường local | [Hướng dẫn Windows/PowerShell](development.md) |
| Kiểm chứng T04 | [Rà soát, kết quả và giới hạn](tasks/t04/review-and-verification.md) |
| Quy ước phát triển | [Coding convention](CONVENTION.md), [Git Flow](GITFLOW.md) |

## Quy ước tổ chức

- `project-definition/`: mục tiêu, yêu cầu, UX, kiến trúc, dữ liệu, nghiệm thu và sổ quyết định của dự án.
- `tasks/README.md`: danh sách task tổng thể, thứ tự, phụ thuộc và trạng thái hoàn thành.
- `tasks/tXX/`: tài liệu riêng của từng task, ví dụ `tasks/t01/design.md`.

T01–T03 hoàn thành phần thiết kế/hợp đồng ngày **28/10/2026**. T04 hoàn thành bộ khung môi trường local ngày **29/10/2026**; direct check trong Cốc Cốc được người dùng miễn và được ghi là chưa xác minh. T05–T36 chưa hoàn thành. Bước tiếp theo là T05 — kết nối FastAPI với MySQL; chưa triển khai các luồng sản phẩm.
