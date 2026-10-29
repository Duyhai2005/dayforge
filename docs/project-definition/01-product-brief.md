# DAYFORGE — tổng quan sản phẩm

Trạng thái ngày **28/10/2026**: **T01 và [T02 1.0](../tasks/t02/design.md) đã được người dùng duyệt, cả hai task hoàn thành; T03 chưa thực hiện, chưa xây code sản phẩm.** Các mặc định T01 và thiết kế T02 là cơ sở hiện hành, gồm buổi/ghi chú dấu mốc; hợp đồng kỹ thuật tiếp tục ở T03.

## 1. Mục đích

Người dùng có nhiều việc diễn ra song song: ôn thi giữa kỳ, chuẩn bị báo cáo tiến độ hằng tuần, làm thuyết trình và duy trì việc học mỗi ngày. DAYFORGE cần giúp nhìn được những việc sắp tới, tự chia việc để chuẩn bị và biết mình dự định làm gì trong từng buổi của cả tuần.

Ứng dụng phục vụ **một người dùng cá nhân**. Ưu tiên cách sử dụng nhanh, trực quan và phù hợp thói quen riêng; chưa cần xây hệ thống quản lý nhiều người.

## 2. Thành công trông như thế nào

Các kết quả mong muốn đã được xác nhận:

- Mở lịch công việc là thấy ngay công việc của cả tuần, theo sáng/chiều/tối.
- Đổi sang lịch dấu mốc để thấy các kỳ thi, ngày báo cáo, buổi thuyết trình trong tuần/tháng/năm.
- Nhận ra các việc cùng kế hoạch qua một màu nhất quán.
- Tự bổ sung việc cần làm cho ngày mai mà không phải nhập giờ bắt đầu chính xác.
- Tạo việc học lặp lại một lần, rồi chỉ điều chỉnh từng hôm khi cần.
- Xem và chỉnh sửa được khi mất mạng; dữ liệu tự đồng bộ khi ứng dụng đang mở hoặc được mở lại và kết nối máy chủ khả dụng.
- Truy cập dữ liệu cá nhân bằng email đã xác minh và mật khẩu riêng; máy chủ vẫn hoạt động khi máy tính cá nhân tắt.
- Có một không gian làm việc tối, thoáng, hiện đại và chuyển động tinh tế, không bị header/sidebar cố định chiếm diện tích.

Tiêu chí vận hành bổ sung được đề xuất: thao tác lưu dựa trên dữ liệu cục bộ, không phải đợi một chuyến mạng mới thấy kết quả trên lịch.

## 3. Các tình huống cốt lõi

### 3.1. Chuẩn bị cho kỳ thi

Tạo kế hoạch “Ôn thi giữa kỳ”, chọn một màu. Thêm dấu mốc “Thi giữa kỳ”. Tự thêm các công việc “Ôn phần ABC”, “Ôn phần XYZ”, ước lượng thời lượng và đặt vào những buổi phù hợp. Các công việc và dấu mốc liên quan giữ chung màu kế hoạch.

Hệ thống không tự suy ra nội dung cần ôn hoặc tự chia lịch ôn; việc lập kế hoạch này do người dùng quyết định.

### 3.2. Duy trì học tiếng Anh

Tạo một việc lặp hằng ngày hoặc vào các ngày chọn trong tuần, chọn trước buổi dự định làm. Việc tiếp tục xuất hiện cho đến khi người dùng dừng. Việc học tiếng Anh dùng màu kế hoạch riêng, khác với ôn thi.

### 3.3. Chuẩn bị báo cáo và thuyết trình

Ngày báo cáo/buổi thuyết trình là dấu mốc. Các việc chuẩn bị có thể được đặt ở những ngày trước đó. Nhìn lịch dấu mốc để nhận biết việc gì đang tới; nhìn lịch công việc để biết các bước đã dự định làm.

Việc báo cáo diễn ra hằng tuần là bối cảnh sử dụng. Cơ chế lặp cho **dấu mốc** chưa được xác nhận là tính năng của đợt đầu.

### 3.4. Một việc phát sinh độc lập

Thêm một việc như “Gửi hồ sơ”, đặt vào một buổi trong tuần và lưu mà không cần tạo kế hoạch. Công việc độc lập là một phần chính thức của phạm vi.

## 4. Phạm vi đợt đầu

| Thành phần | Phạm vi |
| --- | --- |
| Lịch công việc | Toàn cảnh tuần; công việc theo ngày và buổi; thêm/sửa/xóa, đánh dấu hoàn thành, kéo thả. |
| Lịch dấu mốc | Tạo dấu mốc riêng, độc lập hoặc thuộc kế hoạch; chọn buổi trong ngày nếu muốn và ghi chú liên quan ngay trong dấu mốc; xem tuần/tháng/năm, điều hướng các năm khác; cùng một dấu mốc có thể xuất hiện trong cả hai lịch. |
| Kế hoạch | Nhóm công việc và dấu mốc, dùng màu người dùng chọn. |
| Việc lặp | Hằng ngày hoặc các thứ đã chọn, có thể đặt trước buổi, lặp đến khi dừng; giữ lịch sử trước mốc khi sửa/dừng từ một mốc. |
| Dữ liệu | Lịch local-first với IndexedDB, xem/sửa offline; tự đồng bộ khi ứng dụng đang mở/mở lại. Xung đột tự chọn bản có thời điểm sửa đã ghi mới nhất. |
| Tài khoản | Có trong giai đoạn 1: đăng nhập bằng email, xác minh email, mật khẩu riêng; không có đăng nhập Google. Vẫn phục vụ một người dùng cá nhân. |
| Nền tảng | Web desktop trước. |
| Máy chủ | Next.js server/Node chạy production, FastAPI và MySQL trên máy chủ độc lập với PC cá nhân. Chọn AWS hoặc Oracle vào lúc triển khai. |

Đợt đầu có **hai trang lịch chính**. Cách nhập liệu được phát triển thành biểu mẫu nổi trên lịch; không cần một trang nhập liệu thứ ba riêng. Một chế độ xem ngày chi tiết, nếu giữ lại, chỉ là tiện ích bổ sung chứ không phải điều kiện để thấy việc trong tuần.

Khi sửa quy tắc lặp từ một mốc, các lần tương lai đã chỉnh riêng được tách thành công việc một lần, vẫn giữ kế hoạch/màu; áp dụng cho mọi lần đã chỉnh riêng trong phạm vi, không chỉ các lần lệch thứ của quy tắc mới. Khi dừng lặp, gỡ tất cả lần từ mốc còn thuộc chuỗi, kể cả đã dời ngày; giữ lịch sử trước mốc và các công việc một lần đã tách.

Các mặc định tài khoản **đã duyệt cùng T01**: chỉ email chủ sở hữu được cấu hình có thể tạo tài khoản, không đăng ký công khai; xác minh qua liên kết và có gửi lại; quên/đặt lại mật khẩu; ghi nhớ đăng nhập; đăng nhập lần đầu/xác minh/đặt lại mật khẩu cần online. Dữ liệu cục bộ được tách theo chủ sở hữu và các thay đổi chờ đồng bộ không bị mất khi phiên hết hạn. Đăng xuất khóa truy cập local và cảnh báo nếu còn thay đổi chờ gửi; dữ liệu chờ được giữ đúng chủ tài khoản, không tự gửi dưới tài khoản khác. T02 sẽ thiết kế các luồng tài khoản; T03 sẽ cụ thể hóa kỹ thuật.

Các mặc định nhỏ đã duyệt gồm: thời lượng không bắt buộc; kế hoạch ban đầu chỉ có tên/màu; đánh dấu việc chưa xong sau hết ngày và không tự dời; tuần thứ hai–chủ nhật theo UTC+07:00; có hoàn tác và đổi lịch qua form/bàn phím. Chi tiết ngày chỉ là tùy chọn bổ sung; bảng màu và thông số chuyển động được chốt ở T02.

## 5. Để sau

- Trang ghi chú nhanh độc lập và các chức năng phụ khác. Ghi chú gắn ngay trong dấu mốc đã được bổ sung vào đợt đầu theo yêu cầu trong T02 ngày 28/10/2026.
- Thiết kế riêng và triển khai mobile app với đầy đủ tính năng tương ứng.
- Đóng gói ứng dụng desktop.
- Quản trị nhiều người dùng, phát triển thành SaaS và xác thực đa yếu tố (MFA).

Thông báo nhắc việc, thống kê thói quen, điểm thưởng, AI tự chia lịch, tệp đính kèm và tích hợp lịch bên ngoài chưa được yêu cầu; không tự đưa vào phạm vi đợt đầu.

## 6. Những điều làm sản phẩm sai hướng

- Chỉ thấy tên ngày trong tuần, phải mở từng ngày mới đọc được công việc.
- Biến sáng/chiều/tối thành những cuộc hẹn có giờ bắt đầu bắt buộc.
- Dùng lưới ô kẻ đậm, dày hoặc nhiều khung phụ lấn át nội dung lịch.
- Animation liên tục hoặc quá nhiều hiệu ứng làm việc sắp lịch hằng ngày chậm đi.
- Thay toàn bộ màu công việc khi hoàn thành/chưa hoàn thành, khiến mất liên hệ với kế hoạch.
- Không có mạng thì chỉ xem được, không sửa được.
- Coi “đã hủy” và “chưa hoàn thành” là cùng một khái niệm.

## 7. Ràng buộc đã chốt

- Tên hiển thị: **DAYFORGE**; thư mục dự án: `dayforge`.
- Backend: **Python + FastAPI**.
- Frontend: **React + Next.js server/Node chạy production** (phương án B đã chọn; xuất tĩnh không phải kiến trúc hiện hành).
- Cơ sở dữ liệu phía máy chủ: **MySQL**.
- Máy chủ độc lập với PC cá nhân; dùng và đồng bộ được từ thiết bị khác khi PC tắt. Việc chọn **AWS hoặc Oracle hoãn đến lúc triển khai**, không phải điều kiện hoàn thành T01.
- Lịch **local-first với IndexedDB**; cơ chế cache/mở lại offline phải được kiểm chứng trên Next.js server/Node production.
- Chỉ yêu cầu tự đồng bộ khi ứng dụng đang mở hoặc mở lại; không yêu cầu đồng bộ khi ứng dụng đã đóng hẳn.
- Xung đột tự chọn bản chỉnh sửa mới nhất theo thời điểm sửa đã ghi; không bắt người dùng chọn giữa hai bản. Đồng hồ, trường hợp bằng thời điểm, phạm vi áp dụng và xóa–sửa được cụ thể hóa tại T03.
- Công nghệ phụ do người thực hiện đề xuất, ưu tiên đơn giản và phục vụ dùng riêng.

Xem [kiến trúc đề xuất](04-technical-architecture.md) để biết cách bổ sung lưu trữ cục bộ cho yêu cầu offline mà vẫn giữ MySQL ở máy chủ.
