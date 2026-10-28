# DAYFORGE — thiết kế tổng hợp T01

Ngày duyệt: **28/10/2026** · Phiên bản **0.3** · Trạng thái: **Đã được người dùng duyệt — T01 hoàn thành**.

Tài liệu này chốt phạm vi và các lựa chọn vận hành của T01. Giao diện chi tiết thuộc T02; hợp đồng dữ liệu/API và thuật toán thuộc T03. Chưa xây code sản phẩm hoặc triển khai hạ tầng.

**Bổ sung sau khi duyệt T01:** trong T02 ngày 28/10/2026, người dùng yêu cầu dấu mốc có buổi tùy chọn và ô ghi chú liên quan. Nội dung bên dưới giữ lại bản tổng hợp tại thời điểm duyệt T01; yêu cầu bổ sung được ghi trong [T02](../t02/README.md) và hồ sơ hiện hành. Trang ghi chú nhanh độc lập vẫn để đợt sau; T01 giữ trạng thái hoàn thành.

## 1. Ý định và mục tiêu

DAYFORGE giúp một người nhìn toàn cảnh công việc cần chuẩn bị cho kỳ thi, báo cáo, thuyết trình và các việc học lặp lại. Mở lịch tuần là thấy những việc dự định làm theo sáng/chiều/tối; lịch dấu mốc cho thấy các ngày quan trọng ở quy mô tuần/tháng/năm.

Giai đoạn đầu phải dùng được hằng ngày trên máy tính, xem/sửa offline, đồng bộ giữa thiết bị và chạy trên server độc lập với PC cá nhân. Cốc Cốc desktop là browser nghiệm thu chính.

## 2. Phạm vi đã chốt

| Phần | Quyết định |
| --- | --- |
| Lịch công việc | Toàn cảnh tuần, ba buổi; ước lượng thời lượng, không bắt giờ bắt đầu; thêm/sửa/kéo thả. |
| Lịch dấu mốc | Tạo dấu mốc riêng; xem tuần/tháng/năm và các năm khác; có thể hiện cùng dấu mốc ở cả hai lịch. |
| Kế hoạch/màu | Các việc và dấu mốc cùng kế hoạch cùng màu người dùng chọn; có công việc không thuộc kế hoạch. |
| Kết quả công việc | Hoàn thành/chưa hoàn thành có ký hiệu riêng, giữ màu kế hoạch; hủy thì gỡ khỏi lịch. |
| Việc lặp | Hằng ngày hoặc các thứ chọn; chọn sẵn buổi; tiếp tục đến khi dừng. |
| Tài khoản | **Email, xác minh email, mật khẩu riêng; không Google. Có trong đợt đầu.** |
| Offline/sync | Xem/sửa trên thiết bị đã chuẩn bị; tự sync khi web đang mở hoặc mở lại; đóng hẳn thì chờ lần mở sau. |
| Trình bày | Bố cục lịch A, nền tối B; thoáng, widget mở khi cần, không header/sidebar cố định; motion tinh tế. |

Không làm ghi chú, mobile app, desktop app, mạng xã hội/cộng tác hoặc quản lý nhiều người dùng trong giai đoạn này. Không tự lập lịch ôn thi hay biến các buổi thành lịch giờ chính xác.

## 3. Các hướng kiến trúc và phương án đã chọn

| Phương án | Đánh đổi | Kết quả |
| --- | --- | --- |
| A — Next.js xuất tĩnh + FastAPI | Ít runtime server hơn; hạn chế tính năng cần Next.js server. Vẫn cần lưu offline/sync. | Đã cân nhắc. |
| **B — Next.js server + FastAPI** | Vận hành Node.js cùng Python và MySQL; có khả năng xử lý/render của Next.js server. Vẫn cần lưu offline/sync. | **Người dùng chọn B.** |

Frontend **React/Next.js server**, backend **FastAPI/Python**, server database **MySQL**. Lịch vẫn đọc/ghi dữ liệu cục bộ trên client; Next.js server không thay vai trò của IndexedDB hoặc bộ đồng bộ.

Đề xuất tách trách nhiệm: Next.js lo trải nghiệm web; FastAPI quản lý tài khoản và nghiệp vụ/sync; MySQL là bản dữ liệu đã đồng bộ. Phục vụ qua cùng origin HTTPS, MySQL chỉ mở cho backend. Cache offline chỉ giữ shell/tài nguyên phù hợp, không dùng chung response chứa dữ liệu riêng.

## 4. Tài khoản — yêu cầu và mặc định đã duyệt

Người dùng đã chọn email có xác minh và mật khẩu riêng. Các mặc định sau do người viết đề xuất và đã được người dùng **duyệt cùng bản tổng hợp ngày 28/10/2026**:

- Chỉ email chủ sở hữu được cấu hình tạo tài khoản; giữ phạm vi dùng riêng.
- Xác minh bằng link email, có gửi lại link, quên/reset mật khẩu và ghi nhớ đăng nhập.
- Lần đầu đăng nhập/xác minh/reset cần mạng. Sau đăng nhập hợp lệ, thiết bị có thể dùng bản dữ liệu local offline; gửi/nhận dữ liệu cần phiên server hợp lệ.
- Hết phiên không xóa thay đổi chưa gửi. Đăng nhập lại đúng tài khoản để tiếp tục sync.
- Đăng xuất khóa truy cập local, báo nếu còn pending; dữ liệu chờ được giữ theo chủ tài khoản, không tự gửi dưới tài khoản khác.
- FastAPI quản lý phiên và bảo vệ API; mật khẩu/token lưu an toàn, có hạn chế lạm dụng. T03 quyết định chi tiết thực hiện.

Nhà cung cấp email, domain và thông số phiên/token giao T03 và nhóm deploy; không yêu cầu người dùng chọn thuật toán ở T01.

## 5. Dữ liệu và xung đột — đã chọn

**Tự giữ bản chỉnh sửa mới nhất.** Lấy thời điểm chỉnh sửa đã ghi làm cơ sở so sánh, kể cả khi sửa offline. Việc nhận operation trễ không tự làm nó thắng. Không có yêu cầu màn hình chọn xung đột thủ công.

T03 phải định nghĩa cách xử lý đồng hồ lệch, hai mốc bằng nhau, xóa–sửa, revision/cursor và các nhóm mutation nguyên tử. Phải giữ ID/mốc sửa khi retry và kiểm chứng các thiết bị hội tụ. Chính sách này giữ bản thắng làm dữ liệu hiện hành; không cam kết giữ cả hai bản cho người dùng lựa chọn như đề xuất cũ.

## 6. Dấu mốc và công việc — đã chọn

Chỉ tạo dấu mốc riêng, không có thao tác đánh dấu task thành milestone. Có thể gắn dấu mốc với kế hoạch để dùng màu chung. Hai lịch hiển thị cùng một dữ liệu dấu mốc khi được bật.

Dời một việc ôn không dời ngày thi. Đổi ngày dấu mốc cập nhật hai lịch, không tự dời các việc chuẩn bị.

## 7. Sửa và dừng việc lặp — đã chọn

- Sửa một lần chỉ ảnh hưởng lần đó theo mặc định của hướng prototype.
- Khi đổi quy tắc lặp từ mốc chọn: giữ lịch sử phía trước; các lần tương lai đã chỉnh riêng được giữ thành công việc một lần, cùng kế hoạch/màu; phần còn lại theo quy tắc mới.
- Khi dừng: gỡ từ mốc dừng những lần còn thuộc chuỗi, kể cả đã dời riêng. Giữ lịch sử trước mốc và các công việc đã tách khỏi chuỗi từ trước.
- Một lần bị dời chỉ xuất hiện một nơi; các thao tác tách/dừng không được ghi dở qua đồng bộ.

Đề xuất T03 dùng ngày gốc làm định danh lần và mốc phạm vi; T02 thể hiện rõ ngày áp dụng khi lần đang chọn đã dời. Không biến ngoại lệ đã xóa thành một việc sống.

## 8. Các mặc định nhỏ khác đã duyệt cùng T01

- Thời lượng không bắt buộc; kế hoạch ban đầu chỉ tên/màu.
- Việc chưa xong được đánh dấu sau hết ngày và không tự dời sang hôm sau.
- Tuần thứ hai–chủ nhật; một múi giờ làm việc UTC+07:00.
- Có hoàn tác và đường đổi lịch bằng form/bàn phím; chi tiết ngày chỉ là tùy chọn bổ sung.
- Bảng màu, màu mục độc lập và các thông số chuyển động chốt T02.

## 9. Những gì hoãn có chủ ý

- **AWS hay Oracle Cloud:** chọn khi deploy, ưu tiên chi phí thấp. Không phụ thuộc PC cá nhân.
- Cấu hình máy chủ chọn sau đo bản Next.js server + FastAPI + MySQL thực tế; chưa cam kết mức RAM/giá cụ thể.
- Domain, dịch vụ gửi email, region và nơi backup chọn ở T29/T30, thử thật ở staging.
- T02 làm thiết kế UI chi tiết, bao gồm màn hình tài khoản phù hợp hai lịch.
- T03 khóa schema/API, auth/session, LWW và thuật toán chuỗi. Các lựa chọn kỹ thuật phải đúng hành vi đã duyệt, không tự mở thêm scope.

## 10. Xác nhận hoàn thành T01

Các lựa chọn đã được phản ánh trong hồ sơ và [kế hoạch 36 task](../README.md); bản tổng hợp đã qua builder check trước khi bàn giao. Người dùng xác nhận: **“Tôi duyệt bản tổng hợp này, hãy đánh dấu T01 hoàn thành.”** Vì vậy **T01 đã hoàn thành ngày 28/10/2026**. Tại thời điểm duyệt T01, T02–T36 chưa hoàn thành; trạng thái hiện hành được theo dõi trong kế hoạch task (T02 đã được duyệt ở lượt sau).

Kết quả rà soát độc lập ngày 28/10/2026: không còn câu hỏi quan trọng cho phạm vi T01, không phát hiện mâu thuẫn lớn hoặc vòng phụ thuộc cản lập kế hoạch. Các chi tiết đã giao T02/T03/deploy tiếp tục được xử lý trong những task đó. Đây là kết quả rà soát tài liệu, chưa phải kiểm chứng sản phẩm đã chạy.
