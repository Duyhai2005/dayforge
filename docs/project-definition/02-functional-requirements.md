# DAYFORGE — yêu cầu chức năng

Trạng thái ngày **28/10/2026**: **T01/T02 đã được duyệt; [T03](../tasks/t03/design.md) đã khóa hợp đồng kỹ thuật; T01–T03 hoàn thành, chưa xây code sản phẩm.** Có 48 yêu cầu chức năng; các lựa chọn trực tiếp và mặc định UI được phân biệt trong T02. T03 cụ thể hóa schema/API và thuật toán theo phạm vi được giao, không mở thêm yêu cầu chức năng. Những nhãn đề xuất cũ bên dưới được đọc cùng hai đặc tả hiện hành.

## 1. Thuật ngữ

| Thuật ngữ | Ý nghĩa |
| --- | --- |
| Kế hoạch | Nhóm định hướng/chủ đề, ví dụ “Ôn thi giữa kỳ”, mang một màu do người dùng chọn. |
| Công việc | Một việc cụ thể dự định làm vào một ngày và buổi; có thể thuộc kế hoạch hoặc độc lập. |
| Dấu mốc | Đối tượng được tạo riêng cho một ngày cần nhìn thấy trong toàn cảnh, ví dụ ngày thi hoặc ngày báo cáo; có thể thuộc kế hoạch hoặc độc lập. |
| Buổi | Sáng, chiều hoặc tối; là khoảng tương đối, không phải giờ bắt đầu chính xác. |
| Việc lặp | Mẫu công việc tạo ra các lần thực hiện theo ngày hoặc các thứ chọn trong tuần. |
| Lần thực hiện | Một lần xuất hiện của việc lặp tại một ngày gốc cụ thể. |

## 2. Lịch công việc

| ID | Yêu cầu | Trạng thái |
| --- | --- | --- |
| FR-W01 | Thấy ngay các công việc của cả tuần theo ngày, được bố trí vào sáng/chiều/tối. | Đã chốt |
| FR-W02 | Điều hướng sang tuần trước/sau và quay về thời điểm hiện tại. | Đề xuất thao tác cơ bản |
| FR-W03 | Hiển thị ước lượng thời lượng của công việc; không bắt nhập giờ bắt đầu/kết thúc. | Đã chốt |
| FR-W04 | Kéo thả công việc để đổi thời điểm dự định làm. | Đã chốt |
| FR-W05 | Phạm vi kéo thả gồm đổi ngày, đổi buổi và đổi thứ tự trong một buổi. | Hướng tạm chấp nhận |
| FR-W06 | Dấu mốc được chọn hiển thị ở lịch công việc phải hiện rõ, không bị hiểu thành một việc có thời lượng. | Đã chốt mục tiêu; cách hiển thị là đề xuất |
| FR-W07 | Có thể mở chi tiết ngày để thao tác dễ hơn, nhưng toàn cảnh tuần vẫn đủ đọc công việc. | Đã duyệt là tùy chọn bổ sung; không bắt buộc có trang riêng |

Vị trí trong một buổi thể hiện **thứ tự tương đối**. Kích thước thẻ không ngầm biểu thị giờ bắt đầu hoặc số phút. Không tự gán 08:00 cho “Sáng” hay dùng thuật toán tự lấp lịch. Mặc định đã duyệt: tuần từ thứ hai đến chủ nhật, dùng một múi giờ làm việc UTC+07:00.

## 3. Kế hoạch và màu

| ID | Yêu cầu | Trạng thái |
| --- | --- | --- |
| FR-P01 | Tạo kế hoạch với tên và một màu. | Đã duyệt cùng T01; ban đầu chỉ có hai trường này |
| FR-P02 | Công việc và dấu mốc cùng kế hoạch dùng chung màu kế hoạch. | Đã chốt |
| FR-P03 | Người dùng chọn màu khi tạo; cần thao tác chọn nhanh. | T02 đã đồng ý bảng chín màu có sẵn, dấu chọn và xem trước |
| FR-P04 | Công việc có thể không thuộc kế hoạch nào. | Đã chốt |
| FR-P05 | Sửa tên/màu kế hoạch cập nhật những phần tử liên quan trên cả hai lịch. | Đã xác nhận cách cập nhật màu trong T02 |

Đã xác nhận trong T02 ngày 28/10/2026: công việc/dấu mốc độc lập mặc định màu trung tính và có thể chọn màu riêng nhanh trong biểu mẫu. Những phần tử đã thuộc kế hoạch kế thừa màu, không có màu ghi đè riêng ở đợt đầu. Đổi màu kế hoạch cập nhật các việc/dấu mốc liên quan trên cả hai lịch. Không dùng màu làm cách duy nhất để nhận biết kế hoạch: vẫn có tên/nhãn khi cần. Người dùng đã xem và đồng ý bảng chín màu có sẵn, dấu chọn và phần xem trước tại T02; không cần nhập mã màu tùy ý ở đợt đầu.

Không tự động xóa các công việc khi bỏ một kế hoạch. Hành vi lưu trữ/xóa kế hoạch chưa được chốt; đề xuất chưa đưa thao tác xóa kế hoạch vào đợt đầu, chỉ cho sửa tên và màu.

## 4. Tạo và chỉnh sửa

| ID | Yêu cầu | Trạng thái |
| --- | --- | --- |
| FR-E01 | Thêm công việc nhanh ngay trong lịch và qua widget công cụ. | Hướng tạm chấp nhận |
| FR-E02 | Ngày/buổi được điền sẵn từ nơi bấm để giảm nhập lại. | Hướng tạm chấp nhận |
| FR-E03 | Mở một công việc/dấu mốc để chỉnh sửa mà vẫn giữ ngữ cảnh lịch. | Hướng tạm chấp nhận |
| FR-E04 | Cho phép tạo kế hoạch ngay khi đang nhập công việc, rồi quay lại bản nháp đang nhập. | Hướng tạm chấp nhận |
| FR-E05 | Lưu, sửa, hoàn thành, gỡ khỏi lịch và kéo thả đều làm được khi offline. | Đã chốt về khả năng sửa offline |
| FR-E06 | Các thao tác xóa/di chuyển có phản hồi ngắn và có thể hoàn tác. | Đã duyệt hoàn tác cùng T01; phản hồi chi tiết T02 |

Các trường dưới đây là cơ sở cho T02/T03; thời lượng không bắt buộc và kế hoạch ban đầu chỉ có tên/màu đã được duyệt cùng T01:

| Đối tượng | Bắt buộc | Không bắt buộc |
| --- | --- | --- |
| Công việc | Tên, ngày, buổi | Ước lượng thời lượng, kế hoạch, quy tắc lặp |
| Dấu mốc | Tên, ngày | Buổi, ghi chú liên quan, kế hoạch/màu, lựa chọn hiện thêm trên lịch công việc |
| Kế hoạch | Tên, màu | Chưa thêm mục tiêu, mô tả dài hoặc cấu trúc phân cấp |

Ước lượng thời lượng **đã được duyệt là không bắt buộc** để không cản thao tác ghi nhanh. Đề xuất cho T02/T03: khi nhập, dùng số phút dương; chưa nhập hiển thị là “Chưa ước lượng”, không tính như 0 phút trong các tổng.

Nếu đóng biểu mẫu có nội dung chưa lưu, đề xuất hỏi giữ lại để tiếp tục sửa hoặc bỏ thay đổi. Không cần xác nhận khi đóng một biểu mẫu chưa thay đổi.

## 5. Trạng thái công việc

| Trạng thái/điều kiện | Hiển thị | Cơ sở |
| --- | --- | --- |
| Chưa hoàn thành, ngày chưa kết thúc | Giữ màu kế hoạch; chưa có dấu kết quả cuối ngày. | Đã duyệt cùng T01 |
| Đã hoàn thành | Giữ màu gốc, thêm dấu hoàn thành ở góc hoặc ký hiệu tương đương. | Đã chốt |
| Ngày đã qua, chưa hoàn thành | Giữ màu gốc, thêm dấu chưa hoàn thành khác dấu hoàn thành. | Đã chốt cách phân biệt; mốc cuối ngày đã duyệt cùng T01 |
| Bị hủy/xóa thật sự | Gỡ khỏi lịch; không để lại thẻ “đã hủy”. | Đã chốt |

Các mặc định đã duyệt cùng T01:

- Việc chưa hoàn thành chỉ bị đánh dấu sau khi **ngày dự định** kết thúc theo múi giờ làm việc, không phải ngay khi buổi sáng kết thúc.
- Việc chưa xong ở lại ngày cũ cho đến khi người dùng tự đổi lịch; không tự chuyển sang hôm sau.

Các đề xuất bổ sung cho T02/T03:

- Cho phép đánh dấu hoàn thành muộn hoặc bỏ dấu hoàn thành.
- Dấu mốc mang ngày và có thể chọn thêm buổi; không có trạng thái hoàn thành của công việc trong đợt đầu. Buổi và ghi chú được người dùng bổ sung trong T02 ngày 28/10/2026.

“Hủy” và “chưa hoàn thành” phải là hai hành vi khác nhau trong nhãn, dữ liệu và kiểm thử.

## 6. Việc lặp

| ID | Yêu cầu | Trạng thái |
| --- | --- | --- |
| FR-R01 | Tạo một lần, lặp hằng ngày hoặc các thứ người dùng chọn. | Đã chốt |
| FR-R02 | Có thể chọn trước buổi làm và tiếp tục lặp đến khi dừng. | Đã chốt |
| FR-R03 | Hoàn thành một lần không hoàn thành cả chuỗi. | Đề xuất cần giữ để phù hợp mục đích |
| FR-R04 | Sửa/kéo thả/xóa một lần mặc định chỉ ảnh hưởng lần đó. | Đã duyệt mặc định cùng T01; tương tác chi tiết T02 |
| FR-R05 | Sửa quy tắc lặp từ một mốc giữ lịch sử trước mốc; tách mọi lần tương lai đã chỉnh riêng trong phạm vi thành công việc một lần, vẫn cùng kế hoạch/màu. Không chỉ tách khi thứ cũ không hợp lệ với quy tắc mới. | Đã chốt chính sách; chi tiết kỹ thuật T03 |
| FR-R06 | Dừng lặp gỡ tất cả lần từ mốc còn thuộc chuỗi, kể cả lần đã dời ngày; giữ lịch sử trước mốc và các công việc một lần đã tách. | Đã chốt chính sách; chi tiết kỹ thuật T03 |

Không yêu cầu quy tắc lặp phức tạp như ngày âm, ngày làm việc có nghỉ lễ hoặc “thứ hai thứ ba của mỗi tháng”. Không tự thêm lặp cho dấu mốc chỉ vì dữ liệu mẫu có nhiều buổi báo cáo.

Quy ước kỹ thuật đề xuất cho T03: phạm vi “từ lần này về sau” bám vào **ngày gốc của lần lặp**, kể cả khi lần đó đã được chuyển sang ngày khác; T03 quyết định chi tiết định danh, ranh giới và dữ liệu liên quan theo chính sách đã duyệt. Các công việc một lần đã tách không còn thuộc chuỗi nên không bị gỡ khi dừng chuỗi về sau. Xem [mô hình lặp](05-data-and-sync.md#4-mô-hình-lặp-và-lịch-sử).

## 7. Lịch dấu mốc

| ID | Yêu cầu | Trạng thái |
| --- | --- | --- |
| FR-M01 | Có các quy mô tuần, tháng, năm và điều hướng tới các năm khác. | Đã chốt |
| FR-M02 | Tạo dấu mốc riêng, có thể độc lập hoặc thuộc một kế hoạch. “Riêng” nghĩa là đối tượng riêng, không bắt buộc độc lập khỏi kế hoạch. | Đã chốt |
| FR-M03 | Cho phép chọn dấu mốc xuất hiện ở cả lịch dấu mốc và lịch công việc. | Đã chốt mục tiêu |
| FR-M04 | Cùng một dấu mốc hiện ở hai lịch phải nhất quán về tên, ngày và màu. | Yêu cầu suy ra từ tính nhất quán |
| FR-M05 | Từ dấu mốc có thể mở tuần công việc chứa ngày đó. | Hướng tạm chấp nhận |
| FR-M06 | Chỉ tạo dấu mốc qua luồng tạo dấu mốc; không tự đánh dấu/chuyển một công việc thành dấu mốc. | Đã chốt |
| FR-M07 | Dấu mốc có buổi sáng/chiều/tối không bắt buộc để hiển thị trong buổi tương ứng; vẫn tạo được dấu mốc chỉ có ngày. | Người dùng yêu cầu bổ sung trong T02 |
| FR-M08 | Dấu mốc có ô ghi chú liên quan, có thể thêm/sửa/xóa nội dung; được lưu offline và đồng bộ cùng dấu mốc. | Người dùng yêu cầu ô ghi chú trong T02; áp dụng nguyên tắc lưu/sync chung |

Dấu mốc là đối tượng riêng. Việc hiện ở hai lịch là hai cách trình bày **cùng một bản ghi dấu mốc**, không nhân bản dữ liệu. Dời việc “Ôn ABC” không tự dời “Thi giữa kỳ”. Không thêm cơ chế tự sinh dấu mốc từ công việc trong đợt đầu.

Bổ sung T02: chọn một buổi tùy ý hoặc để không chọn; nhãn “Cả ngày” cho trường hợp không gắn buổi, không suy ra giờ bắt đầu/kết thúc. Ô ghi chú thuộc bản ghi dấu mốc, không phải trang ghi chú nhanh đã hoãn. Sau khi xem bản thử, người dùng xác nhận giữ ghi chú nhiều dòng và chỉ đọc/sửa đầy đủ khi mở dấu mốc; trên lịch chỉ có ký hiệu báo có nội dung, không hiện đoạn trích.

## 8. Offline, đồng bộ và nền tảng

| ID | Yêu cầu | Trạng thái |
| --- | --- | --- |
| FR-S01 | Sau khi thiết bị đã tải và lưu ứng dụng, vẫn mở/xem dữ liệu đã có khi mất mạng. | Đã chốt mục tiêu; điều kiện tải lần đầu là giới hạn kỹ thuật |
| FR-S02 | Tạo/sửa/xóa/đổi lịch/đánh dấu kết quả offline, lưu qua việc tải lại trang. | Đã chốt mục tiêu |
| FR-S03 | Tự đồng bộ khi ứng dụng đang mở hoặc được mở lại và kết nối máy chủ khả dụng; không yêu cầu đồng bộ khi ứng dụng đã đóng hẳn. | Đã chốt |
| FR-S04 | Hiển thị trạng thái lưu trên máy, chờ đồng bộ, đã đồng bộ hoặc cần xử lý. | Đề xuất |
| FR-S05 | Khi xung đột, tự chọn bản chỉnh sửa mới nhất theo thời điểm sửa đã ghi, không có UI bắt người dùng chọn giữa hai bản. Đồng hồ, trường hợp bằng thời điểm, phạm vi áp dụng và xóa–sửa do T03 cụ thể hóa. | Đã chốt chính sách và [thuật toán T03](../tasks/t03/sync-contract.md) |
| FR-S06 | Có tài khoản ứng dụng trong giai đoạn 1: email đăng nhập đã xác minh và mật khẩu riêng; không đăng nhập Google. | Đã chốt |
| FR-S07 | Truy cập và đồng bộ dữ liệu cá nhân qua tài khoản; không dùng ghép mã thiết bị hoặc phương án không tài khoản. | Đã chốt hướng; kỹ thuật phiên/quyền truy cập T03 |
| FR-S08 | Cốc Cốc desktop là trình duyệt nghiệm thu chính; kiểm chứng cache/mở lại offline trên kiến trúc Next.js server/Node production. | Đã chốt |
| FR-S09 | Máy chủ hoạt động độc lập với PC cá nhân; vẫn dùng và đồng bộ từ thiết bị khác khi PC tắt. | Đã chốt |

Đợt đầu ưu tiên web desktop với lịch local-first trong IndexedDB, Next.js server/Node chạy production + FastAPI + MySQL. Xuất tĩnh không phải kiến trúc hiện hành. Chọn AWS hoặc Oracle khi triển khai, không chặn T01; xem [kiến trúc và giới hạn offline](04-technical-architecture.md).

## 9. Tài khoản cá nhân

| ID | Yêu cầu | Trạng thái |
| --- | --- | --- |
| FR-A01 | Đăng nhập bằng email và mật khẩu riêng của ứng dụng. | Đã chốt |
| FR-A02 | Có xác minh email qua liên kết và gửi lại liên kết. | Đã duyệt cùng T01; chi tiết kỹ thuật T03 |
| FR-A03 | Không có đăng nhập Google; không mở rộng thành hệ thống nhiều người dùng/SaaS. | Đã chốt phạm vi |
| FR-A04 | Chỉ email chủ sở hữu được cấu hình có thể tạo tài khoản; không có đăng ký công khai. | Đã duyệt cùng T01 |
| FR-A05 | Có quên/đặt lại mật khẩu và ghi nhớ đăng nhập. | Đã duyệt cùng T01 |
| FR-A06 | Đăng nhập lần đầu, xác minh email và đặt lại mật khẩu cần online. | Đã duyệt cùng T01 |
| FR-A07 | Dữ liệu cục bộ tách theo chủ sở hữu; phiên hết hạn không làm mất dữ liệu hoặc thay đổi đang chờ đồng bộ. Đăng xuất khóa truy cập local, cảnh báo nếu còn pending; giữ pending đúng owner, không gửi dưới tài khoản khác. | Đã duyệt cùng T01; chi tiết bảo vệ và phiên T03 |

T02 đã chốt luồng tài khoản ở mức UI/UX; [T03](../tasks/t03/auth-contract.md) đã cụ thể hóa bảo mật phiên, lưu trữ và đồng bộ. MFA và quản trị nhiều người dùng không thuộc phạm vi giai đoạn 1.
