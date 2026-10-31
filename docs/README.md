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
| Kiểm chứng T05 | [FastAPI/MySQL, HTTPS và giới hạn còn lại](tasks/t05/review-and-verification.md) |
| Khung Next.js T06 | [Kế hoạch chi tiết](tasks/t06/plan.md), [kiểm chứng và bàn giao](tasks/t06/review-and-verification.md) |
| Kiểm tra tự động T07 | [Kế hoạch chi tiết](tasks/t07/plan.md), [kiểm chứng và bàn giao](tasks/t07/review-and-verification.md) |
| Quy ước phát triển | [Coding convention](CONVENTION.md), [Git Flow](GITFLOW.md) |

## Quy ước tổ chức

- `project-definition/`: mục tiêu, yêu cầu, UX, kiến trúc, dữ liệu, nghiệm thu và sổ quyết định của dự án.
- `tasks/README.md`: danh sách task tổng thể, thứ tự, phụ thuộc và trạng thái hoàn thành.
- `tasks/tXX/`: tài liệu riêng của từng task, ví dụ `tasks/t01/design.md`.

T01–T03 hoàn thành phần thiết kế/hợp đồng ngày **28/10/2026**. T04 hoàn thành bộ khung môi trường local ngày **29/10/2026**. T05 hoàn thành nền FastAPI/MySQL, với nghiệm thu và review trên DB test cô lập đã đạt; các giới hạn còn lại nằm trong [báo cáo T05](tasks/t05/review-and-verification.md). T06 hoàn thành khung Next.js ngày **29/10/2026**, gồm shell hai lịch/widget và callback trung tính; kết quả và ngoại lệ nằm trong [báo cáo T06](tasks/t06/review-and-verification.md). T07 hoàn thành thiết lập kiểm tra tự động, quality gates và CI ngày **31/10/2026** theo [báo cáo T07](tasks/t07/review-and-verification.md). T08–T36 và các luồng sản phẩm còn lại chưa hoàn thành; dữ liệu lịch, tài khoản và offline thực chưa được triển khai.
