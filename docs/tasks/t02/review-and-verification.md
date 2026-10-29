# T02 — rà soát và kiểm tra bản tổng hợp

Ngày **28/10/2026** · Thiết kế: [design.md](design.md) · Bản xem: [HTML tổng hợp v3](prototypes/t02-consolidated-preview-v3.html).

## 1. Rà soát độc lập

Sau khi viết thiết kế đầy đủ, một reviewer độc lập chỉ đọc tài liệu và tìm câu hỏi quan trọng còn thiếu trước khi lập kế hoạch. Reviewer bỏ qua lựa chọn nhỏ và phần đã giao builder/T03, không mở lại chuỗi hỏi từng chi tiết.

Kết quả: **“nothing important left”**. Không còn câu hỏi quan trọng phải đưa lại người dùng. Đây là rà soát độ rõ/đủ của thiết kế, không phải code review hoặc nghiệm thu sản phẩm.

Các lựa chọn theo ủy quyền được ghi riêng trong thiết kế: tổng quan năm khi nhiều nhóm màu, chữ/khoảng cách/chuyển động, vị trí xem qua reload theo thiết bị/owner, trạng thái rỗng và thao tác biên/Undo. Không coi chúng là câu trả lời trước đây của người dùng; chúng nằm trong bản duyệt tổng hợp cuối.

## 2. Môi trường và giới hạn

Trình duyệt xem trước trong app, viewport thử **1204 × 746**. HTML/CSS/JavaScript dùng dữ liệu mẫu; không phải Next.js/FastAPI/MySQL production. Không cài dependency/scaffold sản phẩm, không đăng nhập/gửi email/ACK thật.

Chỉ **trạng thái xem của mẫu** được lưu trong khóa riêng của prototype để kiểm tra reload. Công việc, dấu mốc, ghi chú và mutation vẫn trong bộ nhớ; reload trở về dữ liệu mẫu. Pending/trạng thái tài khoản là mô phỏng. Bộ chọn BẢN THỬ không được đưa vào sản phẩm.

## 3. Kết quả lượt kiểm tra chung

| Hạng mục | Quan sát trực tiếp | Kết quả trong prototype |
| --- | --- | --- |
| Mật độ tuần | 23 thẻ; chiều thứ tư có 5 việc; đủ bảy ngày; week overflow visible, không tràn ngang. | Đạt |
| Dấu mốc theo buổi | Thi giữa kỳ ở sáng thứ sáu; báo cáo ở chiều thứ tư; cả ngày ở vùng riêng. | Đạt |
| Tổng quan năm | 12 tháng; tháng 10 có 10 mốc/5 nhóm, hiện 3 nhãn và +2 nhóm. Ngày 28 có 6 mốc/5 màu, chấm nhiều phần. | Đạt |
| Năm → tháng → danh sách | Mở tháng 10 từ năm; +4 mở đủ 6 mục và quay lại được. | Đạt |
| Khoảng xem độc lập | Dấu mốc tháng 12, công việc vẫn tuần 26/10–01/11; reload rồi đổi lịch vẫn giữ tháng 12. | Đạt |
| Rỗng | Tuần 14–20/09 có 0 task, 7 cột/21 điểm thêm; năm 2030 có 12 tháng đều tổng 0. | Đạt |
| Giảm chuyển động | Chế độ mô phỏng bật reduced, animation tính toán none; sau đó trả về thường. | Đạt trong mô phỏng |
| Kéo thả qua UI | Kéo Cập nhật số liệu từ sáng 29/10 sang chiều 26/10; chỉ một thẻ chuyển, tổng vẫn 23. | Đạt |
| Undo trong widget | Hoàn tác lần sửa gần nhất đưa thẻ trở về sáng 29/10; tổng vẫn 23. | Đạt |
| Bản nháp ghi chú | Sửa note, Escape có nhắc; Bỏ thay đổi rồi reload không còn cảnh báo bản nháp đã bỏ. | Đạt |
| Kết thúc | Khôi phục dữ liệu mẫu, lịch công việc ở tuần chính; không tràn ngang hoặc lỗi JavaScript được ghi nhận. | Đạt |

Các luồng biểu mẫu/lặp/màu/buổi–ghi chú/tài khoản đã kiểm tra ở các lượt trước trong [nhật ký](README.md#12-kiểm-tra-bản-minh-họa); không lặp toàn bộ nếu phần tương ứng không đổi. Lượt chung kiểm tra phần còn lại và thao tác chính nối với chúng.

## 4. Bằng chứng

- [Lịch công việc](assets/consolidated-work-week.jpg).
- [Lịch dấu mốc tháng](assets/consolidated-milestone-month.jpg).
- [Lịch dấu mốc năm](assets/consolidated-milestone-year.jpg).
- [Sau kéo thả trước Undo](assets/consolidated-drag-result.jpg).
- [Tài khoản đã đồng ý](assets/account-login.jpg).
- [Dấu mốc có buổi/ghi chú đã đồng ý](assets/milestone-period-note-editor.jpg).

## 5. Kiểm chứng còn thuộc triển khai

Không dùng lượt này để đánh dấu 38 AC sản phẩm đã đạt. Chưa kiểm chứng auth/email/owner/cache thật, IndexedDB/outbox bền vững, LWW/đồng hồ/cursor/nhóm chuỗi/Undo xuyên sync, Back/Forward qua route Next.js, ngắt mạng/lỗi lưu trữ thật, mọi trường hợp ngày/ngoại lệ hoặc hiệu năng/AA toàn UI.

[Thiết kế T02](design.md) là nguồn cho hành vi đã chốt, kể cả đường tương tác chi tiết chưa cài đầy đủ trong bản mẫu. T03 và nhóm triển khai thực hiện/kiểm chứng chúng. UI-01–UI-12 trong thiết kế là bộ kiểm chứng cho sản phẩm, không phải nhãn đã vượt qua đầy đủ bằng prototype.

## 6. Bàn giao

Đã có đặc tả, builder check và một lượt kiểm tra giao diện chung theo yêu cầu gom việc. Người dùng xác nhận **“được rồi chốt T02” ngày 28/10/2026**; đặc tả 1.0 đã được duyệt và **T02 hoàn thành**. T03–T36 chưa hoàn thành; việc duyệt thiết kế không thay kết quả nghiệm thu sản phẩm. Không bắt đầu code sản phẩm trong lượt chốt này.
