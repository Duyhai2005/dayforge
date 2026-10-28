# T02 — giao diện và luồng tương tác DAYFORGE

Ngày bắt đầu và duyệt: **28/10/2026** · Trạng thái: **Đã được người dùng duyệt — T02 hoàn thành**.

**Đọc bản hiện hành:** [Đặc tả T02](design.md) · [Rà soát và kiểm tra](review-and-verification.md) · [Giao diện tổng hợp](prototypes/t02-consolidated-preview-v3.html). Phần dưới là nhật ký các lựa chọn và bản thử trước đó; các nhãn đề xuất cũ được hiểu theo thời điểm trao đổi, dùng đặc tả để triển khai.

Cơ sở: [T01 đã duyệt](../t01/design.md), [hướng UX hiện tại](../../project-definition/03-ux-and-interactions.md), [kế hoạch task](../README.md).

## 1. Thông tin mới từ người dùng

Trong một buổi bận, người dùng ước lượng **khoảng 4–5 công việc là nhiều nhất**, nhưng chưa xác định chắc chắn. Đây là tình huống thử bố cục, **không phải giới hạn số công việc**.

Giữ các hướng đã chọn: toàn cảnh tuần theo ba buổi, nền tối, màu theo kế hoạch, widget nổi, không header/sidebar cố định. A/B ở bước này chỉ là hai kiểu mật độ thẻ, không thay đổi kiến trúc B đã duyệt trong T01.

## 2. Mật độ lịch tuần đã chọn

| Kiểu | Khác biệt | Đánh đổi |
| --- | --- | --- |
| A — Thẻ thoáng | Khoảng đệm và khoảng cách rộng, nhãn “Ước tính … phút”. | Lịch dài hơn và cần cuộn chung trang nhiều hơn. |
| B — Thẻ gọn | Giảm khoảng đệm/khoảng cách và chữ phụ; giữ cỡ chữ tên việc. | Nhiều công việc hơn trong cùng khung nhìn, ít khoảng trống hơn. |

Hai kiểu dùng **cùng 23 công việc**, trong đó chiều thứ tư có 5 việc, tối thứ năm có 3 việc và sáng thứ năm có 2 việc. Không ẩn công việc, không tạo vùng cuộn riêng trong từng ngày/buổi, không thay kích thước thẻ theo số phút.

- [Mở prototype HTML](prototypes/weekly-density-comparison-v2.html).
- [Ảnh toàn cảnh A](assets/weekly-density-airy.jpg).
- [Ảnh toàn cảnh B](assets/weekly-density-compact.jpg).

**Người dùng chọn B — thẻ gọn ngày 28/10/2026.** Giữ cỡ chữ tên việc, giảm khoảng đệm/khoảng cách và chữ phụ; dùng cuộn chung trang khi cần, không ẩn các việc còn lại hoặc đặt vùng cuộn riêng cho từng ngày/buổi. A là phương án đã so sánh. Các màu và trạng thái trong mẫu kế thừa hướng trước, chưa phải toàn bộ bộ token cuối cùng.

## 3. Cách đánh dấu hoàn thành đã chọn

Người dùng chọn **mở thẻ rồi mới đánh dấu hoàn thành** ngày 28/10/2026. Bấm thẻ trên lịch mở biểu mẫu công việc; không đặt thao tác tích hoàn thành trực tiếp trên thẻ lịch. Dấu kết quả trên thẻ vẫn giữ màu kế hoạch như T01 đã duyệt.

Mặc định thiết kế đề xuất: biểu mẫu có mục “Đã hoàn thành”, lưu cùng nút “Lưu thay đổi”; bỏ dấu hoàn thành cũng thực hiện trong biểu mẫu. Chi tiết hình thức trình bày của mục này tiếp tục được hoàn thiện cùng biểu mẫu.

## 4. Vị trí xem của hai lịch đã chọn

Người dùng chọn **mỗi lịch nhớ khoảng thời gian đã xem riêng** ngày 28/10/2026. Chuyển trang bằng widget không tự đưa cả hai lịch về cùng ngày/tháng. Ví dụ lịch công việc đang ở tuần hiện tại, lịch dấu mốc đang xem tháng 12: chuyển qua lại sẽ trở về khoảng riêng của từng lịch.

Mặc định thiết kế đề xuất: lịch dấu mốc giữ cả quy mô tuần/tháng/năm vừa dùng, mỗi lịch giữ vị trí cuộn riêng. Hành động rõ ràng “Xem tuần liên quan” trên dấu mốc cập nhật lịch công việc tới tuần chứa dấu mốc; điều này khác chuyển trang thông thường.

## 5. Widget và điều hướng đã chọn

Vẫn giữ vị trí giữa cạnh dưới của hướng prototype trước. Khi thu gọn, widget là một pill cho biết đang ở lịch nào, kèm nút thêm nhanh nhỏ bên cạnh. Khi mở, panel gồm:

- Hàng thêm nhanh: công việc, dấu mốc, kế hoạch.
- Hai lựa chọn chuyển lịch.
- Quy mô tuần/tháng/năm chỉ hiện khi đang ở lịch dấu mốc.
- Về hôm nay, lùi/tiến theo khoảng và nhãn khoảng đang xem.

Đổi lịch xong thì widget thu lại; lùi/tiến thời gian hoặc đổi quy mô giữ widget mở để có thể điều chỉnh liên tục. Mỗi lịch giữ khoảng xem riêng. Giữ thêm vị trí cuộn và quy mô dấu mốc vẫn là mặc định do người thiết kế đề xuất tại mục 4.

- [Prototype widget và hai lịch](prototypes/compact-calendar-widget-v3.html).
- [Widget trên lịch công việc](assets/widget-work-open.jpg).
- [Widget trên lịch dấu mốc](assets/widget-milestone-open.jpg).
- [Biểu mẫu mở thẻ để đánh dấu hoàn thành](assets/task-editor-completion.jpg).

**Người dùng đồng ý bố trí và cách mở/thu widget theo bản v3 ngày 28/10/2026: “oke rồi”.** Tại lượt này mới xác nhận phần widget; sau đó toàn bộ bản tổng hợp T02 đã được duyệt theo ghi nhận cuối tài liệu.

## 6. Đóng biểu mẫu và thay đổi chưa lưu đã chọn

Người dùng đồng ý ngày 28/10/2026 với cách xử lý được trình bày:

- Bấm **Lưu** mới áp dụng nội dung thêm/sửa lên lịch.
- Biểu mẫu chưa có thay đổi thì đóng ngay.
- Nếu đã nhập hoặc sửa, yêu cầu đóng bằng Escape hoặc bấm nền sẽ hiện nhắc nhỏ với **Tiếp tục sửa** và **Bỏ thay đổi**. Chỉ bỏ nội dung khi người dùng chủ động chọn bỏ.

Mặc định do người thiết kế đề xuất: nút đóng biểu mẫu dùng cùng cơ chế; lỗi ghi dữ liệu cục bộ giữ nguyên nội dung và biểu mẫu để thử lại, không báo lưu thành công. Lưu cục bộ và đồng bộ là hai trạng thái riêng theo T01. Bản thử biểu mẫu mới đã minh họa nhắc chưa lưu; kiểm tra hiện tại gồm nút đóng, Escape và quay lại từ cấu hình lặp, chưa phải nghiệm thu mọi đường điều hướng của sản phẩm.

## 7. Sửa từng lần và quản lý lịch lặp đã chọn

Người dùng đồng ý ngày 28/10/2026 với cách tách thao tác:

- Mở thẻ để sửa hoặc đánh dấu hoàn thành: mặc định chỉ tác động lần đang mở.
- Kéo sang ngày/buổi khác: chỉ chuyển lần đó.
- Mục riêng **Lịch lặp…** cho đổi các ngày lặp, buổi mặc định hoặc dừng lặp. Trước khi áp dụng, hiển thị rõ ngày bắt đầu và tác động theo quy tắc T01. Không bắt chọn lại phạm vi mỗi lần lưu một chỉnh sửa đơn lẻ.

Không thay đổi chính sách đã duyệt trong T01: sửa quy tắc từ mốc giữ lịch sử trước mốc, tách các lần tương lai đã chỉnh riêng thành việc một lần; dừng chuỗi gỡ các lần từ mốc còn thuộc chuỗi, kể cả đã dời, giữ việc đã tách từ trước. Bản thử biểu mẫu mới minh họa lời giải thích/phản hồi này; T03 chốt ranh giới ngày gốc và dữ liệu.

### Bản minh họa biểu mẫu và lịch lặp — ghi nhận trước lượt duyệt tổng hợp

- Biểu mẫu sửa một lần có nhãn “Đang sửa riêng lần này”, dấu hoàn thành, nút lưu và mục riêng “Lịch lặp…”. Với lần lặp thuộc kế hoạch, ẩn phần xem trước màu trùng lặp để giữ thao tác chính trong khung nhìn; vẫn hiển thị tên kế hoạch và màu kế thừa.
- “Lịch lặp” có hai chế độ **Đổi lịch lặp** và **Dừng lặp**, trường ngày áp dụng và khối giải thích tác động trước nút áp dụng. Đổi lịch cho chọn ngày trong tuần và buổi mặc định; dừng dùng nút có nhãn rõ và sắc nhấn khác.
- Khối giải thích đổi lịch nêu số lần tương lai đã chỉnh riêng được giữ thành việc một lần, giữ lịch sử và không khôi phục lần đã gỡ. Dừng giải thích việc gỡ các lần còn thuộc chuỗi, bao gồm lần đã dời, và giữ việc đã tách từ trước.
- Mặc định thiết kế trong bản thử: lấy ngày gốc của lần đang chọn làm mốc ban đầu; nếu đã dời thì hiển thị cả ngày gốc lẫn ngày hiện tại. T03 tiếp tục khóa chi tiết ranh giới theo T01. Nút áp dụng lịch mới chỉ hoạt động khi có thay đổi.
- Tạo kế hoạch từ công việc/dấu mốc đang nhập giữ bản nháp phía trước. Tạo xong quay lại và chọn kế hoạch mới; hủy tạo kế hoạch trở về bản nháp cũ. Thay đổi chưa lưu trong từng biểu mẫu vẫn có nhắc trước khi bỏ. Kế hoạch đã bấm tạo là đối tượng đã lưu riêng, không bị hủy khi sau đó bỏ bản nháp công việc.

Tại thời điểm dựng bản này, luồng/chính sách nền đã chọn và hình thức còn chờ nhận xét; sau đó được gom vào [đặc tả T02 1.0 đã duyệt](design.md). Không lấy một lần đồng ý prototype nhỏ làm lần duyệt toàn bộ.

- [Bản thử biểu mẫu/lịch lặp v3](prototypes/editor-and-repeat-flows-v3.html).
- [Sửa riêng một lần](assets/editor-single-occurrence-v2.jpg).
- [Nhắc khi chưa lưu](assets/editor-unsaved-prompt.jpg).
- [Giải thích đổi lịch](assets/repeat-change-preview-v3.jpg).
- [Giải thích dừng lặp](assets/repeat-stop-preview-v3.jpg).

## 8. Ngày có nhiều dấu mốc — đã chọn

Lịch dấu mốc theo tháng: mỗi ngày hiện tối đa **hai tên dấu mốc**; nếu còn thêm, nút **+N dấu mốc** hiển thị số mục chưa hiện. Đây là giới hạn phần xem nhanh, không phải giới hạn dữ liệu. Bấm nút mở danh sách đầy đủ trong panel nổi, giữ nguyên tháng phía sau.

Danh sách có tên đầy đủ, màu và tên kế hoạch; dấu mốc độc lập ghi “Không thuộc kế hoạch”. Bấm mục mở biểu mẫu sửa; có đường trở lại danh sách. Nút thêm dấu mốc điền đúng ngày đang xem. Tên dài xuống dòng trong danh sách; bản xem nhanh tháng giới hạn hai dòng, vẫn có tên đầy đủ trong nhãn truy cập. Ngày rỗng vẫn có thể thêm như luồng trước.

- [Bản thử tương tác](prototypes/milestone-density.html).
- [Toàn cảnh lịch tháng](assets/milestone-crowded-month.jpg).
- [Danh sách đủ sáu dấu mốc trong ngày](assets/milestone-day-list.jpg).

Tình huống mẫu ngày 28/10 có sáu dấu mốc: hai tên hiện trên lịch, nút “+4 dấu mốc”, danh sách có đủ sáu mục. **Người dùng đồng ý ngày 28/10/2026: “được rồi”**, sau khi xem bản thử và hình danh sách. Đã chốt cách giữ lịch tháng gọn và mở danh sách đầy đủ; quy mô tuần/năm chưa được tinh chỉnh cho trường hợp nhiều dấu mốc trong lượt này.

## 9. Quy tắc và bảng chọn màu — đã chọn

Người dùng đồng ý với đề xuất ngày 28/10/2026:

- Mục thuộc kế hoạch tự dùng màu kế hoạch; đổi màu kế hoạch cập nhật các việc và dấu mốc liên quan trên cả hai lịch.
- Công việc/dấu mốc độc lập mặc định màu trung tính, có thể chọn màu riêng bằng bảng màu nhanh trong biểu mẫu.

Câu trả lời “được” được hiểu là đồng ý đề xuất trên. Mục thuộc kế hoạch không có màu ghi đè riêng ở giai đoạn đầu. Sau đó người dùng đã xem và đồng ý bảng màu/cách chọn trong bản thử v2: **“được rồi” ngày 28/10/2026**.

### Bảng chọn màu nhanh đã xem và đồng ý

Một hàng chín ô chọn: trung tính và tám màu dịu. Chọn một ô đổi phần xem trước ngay; ô đang chọn có viền và dấu tích, có tên màu và hỗ trợ radio/bàn phím. Khi chọn kế hoạch, ẩn bảng chọn màu riêng và hiện “Dùng màu của…” cùng tên kế hoạch; chỉnh màu chung qua biểu mẫu kế hoạch.

| Màu | Chữ/nhấn | Nền thẻ |
| --- | --- | --- |
| Trung tính | `#CED7D8` | `#334148` |
| Cam đất | `#E4BD98` | `#493E32` |
| Xanh lá | `#B0D5C0` | `#2B4138` |
| Xanh ngọc | `#A7D6D1` | `#294442` |
| Xanh lam | `#ABC9E8` | `#2E4053` |
| Tím | `#CAB8E1` | `#3D354D` |
| Hồng | `#E6B6C8` | `#493641` |
| San hô | `#E5B2AB` | `#4B3634` |
| Vàng cát | `#DFD096` | `#48432E` |

Đây là bộ màu do người thiết kế đề xuất và **đã được người dùng đồng ý qua bản thử v2**. Giai đoạn đầu dùng bộ màu có sẵn để chọn nhanh, không cần nhập mã màu tùy ý. Phần xem trước chỉ minh họa màu/nội dung, không thêm đối tượng lên lịch trước khi lưu. Các cặp mã ở bảng ghi lại màu của bản thử; khi triển khai vẫn kiểm tra tương phản của toàn bộ trạng thái.

- [Bản thử chọn màu](prototypes/quick-color-picker-v2.html).
- [Màu riêng của dấu mốc độc lập](assets/color-picker-standalone-v2.jpg).
- [Kế thừa màu kế hoạch](assets/color-picker-inherited.jpg).
- [Chỉnh màu kế hoạch](assets/color-picker-plan.jpg).

## 10. Bổ sung dấu mốc có buổi và ghi chú

Người dùng yêu cầu trực tiếp trong T02 ngày 28/10/2026: **dấu mốc có thể hiện ở các buổi trong ngày nếu muốn** và **có ô note ghi chú liên quan**. Đây là bổ sung cho giai đoạn đầu. Trang ghi chú nhanh độc lập vẫn để đợt sau; vẫn có hai trang lịch chính.

Người dùng đã xem bản thử và xác nhận **“giữ như vậy đi” ngày 28/10/2026** khi được hỏi về cách hiển thị ghi chú. Chốt: trên lịch chỉ có ký hiệu báo có ghi chú; mở dấu mốc mới đọc/sửa đầy đủ, không hiện đoạn trích ngay trên lịch. Giữ cách chọn buổi và biểu mẫu như bản vừa xem; các mặc định chi tiết được ghi dưới đây.

- Buổi không bắt buộc: **Cả ngày / Sáng / Chiều / Tối**; chọn một buổi tương đối, không cần giờ bắt đầu/kết thúc hoặc thời lượng. Dữ liệu cũ không có buổi tiếp tục hiện cả ngày.
- Trên lịch công việc, dấu mốc đã bật hiển thị nằm trong buổi tương ứng, vẫn là ký hiệu dấu mốc có màu kế hoạch/màu riêng. Mốc cả ngày ở dưới tiêu đề ngày. Dấu mốc không trở thành công việc và không có ô tích hoàn thành.
- Lịch dấu mốc theo tuần nhóm theo cả ngày và các buổi có dữ liệu. Theo tháng giữ giới hạn xem nhanh hai tên, thêm tên buổi nếu đã chọn. Theo năm vẫn mở tháng để đọc chi tiết.
- Ghi chú là văn bản nhiều dòng trong biểu mẫu dấu mốc. Trên lịch có ký hiệu nhỏ khi có nội dung; **chỉ đọc đầy đủ khi mở dấu mốc**, không hiện đoạn trích ngay trên lịch.
- Ngày, buổi, ghi chú, kế hoạch/màu và cờ hiện trên lịch công việc thuộc cùng bản ghi, cùng cơ chế lưu local và đồng bộ. Sửa/xóa nội dung ghi chú cũng được bảo vệ bởi nhắc chưa lưu. Không tự thay đổi công việc chuẩn bị cùng kế hoạch.
- Bản thử ẩn phần xem trước màu trùng lặp khi dấu mốc đã thuộc kế hoạch, giữ nhãn màu kế thừa; mục độc lập vẫn có bảng màu và xem trước. Giữ điều chỉnh bố cục của bản vừa xem để thêm ô ghi chú mà biểu mẫu vẫn gọn.

- [Bản thử dấu mốc có buổi và ghi chú](prototypes/milestone-period-and-note.html).
- [Biểu mẫu dấu mốc](assets/milestone-period-note-editor.jpg).
- [Dấu mốc nằm trong buổi trên lịch công việc](assets/milestone-period-work-week.jpg).
- [Lịch dấu mốc theo tuần có nhóm buổi](assets/milestone-period-milestone-week.jpg).

Đã cập nhật phạm vi, trường dữ liệu, T17/T18 và tiêu chí **AC-37/AC-38** trong hồ sơ hiện hành. Bản T01 đã duyệt được giữ làm mốc lịch sử và có chú thích về bổ sung sau đó. Nội dung ghi chú không được tách thành chức năng/trang notes riêng.

## 11. Tài khoản và phản hồi dữ liệu — đã đồng ý

Giữ phạm vi tài khoản đã duyệt T01: email chủ sở hữu, xác minh email, mật khẩu riêng, ghi nhớ đăng nhập, quên/đặt lại mật khẩu; không Google hoặc đăng ký công khai. Phần này chốt cách trình bày, không tự chọn giao thức phiên/token hoặc nhà cung cấp email.

### Màn hình tài khoản

Đề xuất cùng nền tối, chữ và màu nhấn của hai lịch. Trang vào gồm nhận diện DAYFORGE gọn ở trái và biểu mẫu phải, không header/sidebar cố định; không hiển thị lịch riêng tư phía sau màn hình đăng nhập lần đầu hoặc sau đăng xuất. Các màn hình chia sẻ một bố cục:

- Đăng nhập: email, mật khẩu có nút hiện/ẩn, ghi nhớ đăng nhập và quên mật khẩu. Đề xuất ghi nhớ được chọn sẵn trên ứng dụng cá nhân. Lỗi email/mật khẩu dùng thông báo ngắn trong biểu mẫu.
- Thiết lập lần đầu: email chủ sở hữu đã cấu hình, mật khẩu mới và nhập lại; chỉ dùng khi chưa thiết lập tài khoản, không phải liên kết đăng ký công khai trên màn hình đăng nhập thông thường.
- Chờ xác minh email, gửi lại liên kết, xác minh thành công, liên kết hết hạn/đã sử dụng và đường yêu cầu liên kết mới.
- Quên mật khẩu, thông báo đã yêu cầu liên kết, đặt mật khẩu mới và trở về đăng nhập. Thông báo yêu cầu liên kết không khẳng định email có tài khoản.
- Lần đầu trên thiết bị chưa được chuẩn bị cần kết nối. Đăng nhập lại sau hết phiên giải thích rằng dữ liệu chờ vẫn được giữ và có nút trở lại lịch; email cố định theo chủ dữ liệu đang mở.

Mật khẩu/giới hạn gửi lại/lỗi server/callback và việc bảo vệ thật sự do T03 quy định. Bản minh họa chỉ có trạng thái giao diện và không xác thực, gửi email hoặc thay đổi mật khẩu thật.

### Trạng thái dữ liệu và tài khoản trong widget

Đề xuất thêm ký hiệu nhỏ trong pill thu gọn và một hàng trạng thái ở cuối widget mở. Hàng này mở panel **Dữ liệu và tài khoản**, phân biệt đã lưu trên thiết bị, máy chủ đã xác nhận hay chưa, và số thay đổi đang chờ; có đường đăng xuất. Không thêm header/sidebar.

| Tình huống | Nội dung và thao tác |
| --- | --- |
| Đã đồng bộ | Chỉ báo gọn; chỉ dùng khi máy chủ đã xác nhận. |
| Offline, có pending | Nêu đã lưu trên thiết bị và số thay đổi chờ; tiếp tục xem/sửa, tự đồng bộ khi có mạng và app đang mở/mở lại. |
| Phiên hết hạn | Nêu pending được giữ; **Đăng nhập lại** hoặc **Tiếp tục với lịch**. Không khóa việc xem/sửa local của phiên đang mở. |
| Ghi local thất bại | Nêu rõ chưa lưu; giữ nội dung trong biểu mẫu để thử lại, không đóng form hoặc báo thành công. |
| Ghi local thành công, sync lỗi | Nêu đã lưu trên thiết bị nhưng máy chủ chưa xác nhận; **Thử đồng bộ lại**, vẫn tiếp tục làm việc được. |
| Đăng xuất còn pending | Nêu số thay đổi chờ, khóa truy cập local sau đăng xuất và giữ pending đúng chủ; **Ở lại với lịch** hoặc **Đăng xuất và khóa dữ liệu**. |

Trong sản phẩm, thay đổi mạng/hết phiên chỉ cập nhật chỉ báo, không tự bật panel chiếm lịch; người dùng chủ động mở chi tiết. Tình huống lỗi ghi phải phản hồi ngay tại thao tác lưu. Dùng chữ/ký hiệu ngoài màu và thông báo truy cập ngắn khi trạng thái thay đổi; không toast liên tục khi offline.

**Người dùng xác nhận nhóm này ổn ngày 28/10/2026**, đồng thời yêu cầu tự chốt phần còn lại một lượt trước khi chạy giao diện, tránh hỏi/chạy từng câu. Bộ chọn “BẢN THỬ” ở góc trái dưới chỉ chuyển tình huống minh họa, không phải công cụ/đường đăng nhập của sản phẩm. Pending/email là dữ liệu mẫu; chuyển trạng thái thành công không phải ACK thật. Nghiệm thu auth/cache/owner/outbox thuộc triển khai.

- [Bản thử tài khoản và trạng thái dữ liệu v4](prototypes/account-and-sync-preview-v4.html).
- [Đăng nhập](assets/account-login.jpg).
- [Trạng thái trong widget](assets/account-sync-widget.jpg).
- [Phiên hết hạn](assets/account-session-expired.jpg).
- [Offline](assets/account-offline-status.jpg).
- [Đăng xuất còn thay đổi chờ](assets/account-logout-pending.jpg).

## 12. Kiểm tra bản minh họa

Đã mở bản thử trong trình duyệt xem trước, chuyển A/B, mở/đóng một thẻ và kiểm tra có đủ 23 việc, tối đa 5 việc trong một buổi, tên việc cùng cỡ chữ 14px và không tràn ngang tại khung nhìn thử 1204 × 746. Không ghi nhận lỗi JavaScript trong lượt thử.

Với bản widget mới, đã kiểm tra: lịch dấu mốc đi tới tháng 12 rồi đổi sang lịch công việc vẫn ở tuần 26/10–01/11; đổi lại dấu mốc vẫn ở tháng 12. Từ dấu mốc thuyết trình 06/11, “Xem tuần liên quan” mở đúng tuần 02/11–08/11; đổi lại dấu mốc vẫn ở tháng 11 vừa xem. Đổi tháng liên tục giữ panel mở. Lịch tuần có đủ 23 thẻ, cuộn chung trang, không còn vùng cuộn riêng trong bảng tuần.

Đã thử mở “Ôn phần ABC”, tích hoàn thành trong biểu mẫu rồi lưu: thẻ có dấu hoàn thành và giữ màu kế hoạch; hoàn tác khôi phục mẫu ban đầu. Không ghi nhận lỗi JavaScript trong lượt thử này.

Với bản thử nhiều dấu mốc, đã kiểm tra qua trình duyệt xem trước: đúng hai tên và “+4 dấu mốc” trên lịch, mở đủ sáu mục, tên dài xuống dòng không tràn ngang, mở sửa rồi trở lại danh sách/lịch, thêm mới có ngày 28/10/2026. Panel sáu mục nằm trong khung nhìn thử, không ghi nhận lỗi JavaScript. Không thay đổi dữ liệu mẫu trong lượt kiểm tra.

Với bản thử chọn màu v2, đã thử màu trung tính mặc định, đổi màu riêng và cập nhật xem trước; chọn kế hoạch ẩn bảng màu riêng và dùng đúng màu kế hoạch; bỏ lựa chọn kế hoạch trong cùng bản nhập khôi phục màu riêng vừa chọn. Đã lưu/mở lại dấu mốc độc lập màu xanh lam, thêm công việc độc lập màu san hô và đổi kế hoạch tiếng Anh sang xanh ngọc: các thẻ công việc và dấu mốc trên cả hai lịch cập nhật đúng màu. Sau kiểm tra đã tải lại để khôi phục dữ liệu mẫu. Không tràn ngang hoặc ghi nhận lỗi JavaScript trong lượt này.

Đã tính tương phản cho chín cặp chữ/nền thẻ ở bảng trên từ mã màu thực của bản thử. Đây chỉ là kiểm tra các cặp màu thẻ, chưa phải nghiệm thu toàn bộ chữ phụ, focus hoặc trạng thái giao diện. Luồng tạo kế hoạch ngay trong bản nháp chưa được thử lại trong lượt chọn màu này.

Với lượt biểu mẫu/lịch lặp, đã thử qua trình duyệt xem trước:

- Nhập tên rồi đóng: hiện nhắc; tiếp tục sửa giữ tên đã nhập; bỏ thay đổi giữ tên cũ trên lịch. Escape cũng có nhắc khi còn nội dung chưa lưu.
- Tạo/hủy kế hoạch trong công việc đang nhập: giữ tên, buổi, thời lượng; tạo thành công quay lại đúng kế hoạch và màu mới; bản nháp cha vẫn được bảo vệ khi đóng.
- Đánh dấu hoàn thành một lần lặp chỉ thêm dấu cho lần đó, giữ màu; lần kế tiếp không bị đánh dấu. Hoàn tác khôi phục.
- Đổi lịch từ 28/10 sang tối T2/T4/T6: giữ lịch sử trước mốc, giữ lần 30/10 đã dời sang 31/10 thành việc một lần cùng màu, không sinh bản trùng ở ngày gốc và không khôi phục lần đã gỡ 02/11. Có hoàn tác.
- Dừng từ 28/10: gỡ các lần còn thuộc chuỗi từ mốc, gồm lần 30/10 đã dời; giữ lịch sử và công việc đã tách trước đó vào 04/11.
- Chọn lần đã dời hiển thị ngày gốc 30/10, ngày hiện tại 31/10 và mốc mặc định 30/10. Quay lại khi cấu hình lặp chưa lưu có nhắc; tiếp tục sửa giữ ngày trong tuần và buổi vừa chọn.

Các hành vi đã thử trong chuỗi bản v1/v2; v3 giữ cùng logic và rút gọn trình bày, đã kiểm tra lại ngày gốc, quay lại khi chưa lưu và bố cục. Biểu mẫu sửa lần lặp v2 hiển thị đủ nút lưu/mục lịch lặp; cấu hình đổi lịch v3 không tràn ngang, không cần cuộn trong tình huống minh họa và có nút áp dụng trong khung nhìn thử. Không ghi nhận lỗi JavaScript. Lượt này không kiểm chứng API, lưu bền vững, đồng bộ, mọi tổ hợp ngoại lệ hoặc cơ chế giao dịch sản phẩm.

Với bản dấu mốc có buổi và ghi chú, đã thử: mốc sáng/chiều nằm đúng buổi trên lịch công việc; đổi sáng sang tối chỉ có một vị trí, mở từ lịch tháng giữ cùng buổi và ghi chú nhiều dòng. Đã thử bỏ buổi và xóa nội dung: mốc trở lại phần cả ngày, ký hiệu ghi chú biến mất. Lịch dấu mốc theo tuần nhóm mốc sáng/chiều đúng; nội dung có ký tự góc nhọn vẫn là văn bản trong textarea. Nhập ghi chú rồi Escape hiện nhắc; bỏ thay đổi giữ nội dung đã lưu trước đó. Đã tải lại để khôi phục dữ liệu mẫu. Không tràn ngang hoặc ghi nhận lỗi JavaScript trong lượt kiểm tra. Biểu mẫu dấu mốc thuộc kế hoạch có nút lưu trong khung nhìn thử. Chưa thử lại tạo kế hoạch lồng trong bản nháp dấu mốc có ghi chú ở lượt này.

Trong lượt tài khoản/trạng thái dữ liệu, đã mở bản minh họa qua trình duyệt và thử: hiện/ẩn trường mật khẩu trống, đường quên mật khẩu tới thông báo yêu cầu liên kết bằng email mẫu, gửi lại liên kết xác minh, màn hình thiết lập email cố định, đường từ link đặt lại hết hạn về quên mật khẩu, màn hình mật khẩu mới/nhập lại và lỗi đăng nhập. Lần đầu offline vô hiệu hóa thao tác đăng nhập. Không nhập mật khẩu hoặc đăng nhập tài khoản thật, không gửi email thật.

Đã kiểm tra: đóng đăng nhập lại sau hết phiên vẫn mở biểu mẫu công việc được; tình huống local lỗi giữ tên vừa nhập và giữ thẻ cũ, không đóng biểu mẫu; nút thử sync đổi qua trạng thái chờ rồi thành công mô phỏng. Từ hàng trạng thái trong widget mở panel, ở lại sau cảnh báo đăng xuất vẫn dùng lịch; chọn đăng xuất thì lịch bị ẩn và quay về màn hình đăng nhập. Không có header/sidebar, widget mở nằm trong khung nhìn thử, không ghi nhận lỗi JavaScript. Chưa kiểm chứng bảo vệ local/owner thật hoặc đăng nhập sau khi logout; các tình huống dùng mô hình UI mẫu.

Các prototype chỉ là dữ liệu mẫu trong bộ nhớ; tải lại trở về ví dụ ban đầu. Đây không phải sản phẩm Next.js/FastAPI, chưa kiểm chứng offline/sync hay nghiệm thu trên Cốc Cốc. Các bản widget/nhiều dấu mốc/chọn màu trước bản biểu mẫu vẫn kế thừa luồng sửa/lặp cũ, không dùng làm đặc tả cho nhắc chưa lưu hoặc quản lý chuỗi. Bản biểu mẫu v3 minh họa mới các phần đó; bản buổi/ghi chú dấu mốc kế thừa v3 và bản tài khoản kế thừa phần lịch. Có thêm dữ liệu mẫu về lần đã dời/đã gỡ/đã tách, không phải toàn bộ số liệu của mẫu so mật độ ban đầu. Bộ chọn tình huống tài khoản chỉ là điều khiển bản thử, không được mang vào sản phẩm.

## 13. Xác nhận hoàn thành T02

Các phần đã chọn và các chi tiết còn lại do người thiết kế chốt theo ủy quyền đã được gom vào [đặc tả T02](design.md), gồm lịch năm nhiều nhóm/màu, chữ/khoảng cách/chuyển động, trạng thái rỗng, thao tác biên/Undo và tài khoản/phản hồi dữ liệu. Bản tổng hợp đã qua builder check độc lập, không còn câu hỏi quan trọng; đã chạy một lượt kiểm tra giao diện chung, ghi trong [báo cáo](review-and-verification.md).

Người dùng xác nhận **“được rồi chốt T02” ngày 28/10/2026**. Đặc tả tổng hợp 1.0 đã được duyệt và T02 được đánh dấu hoàn thành. Bước tiếp theo theo lộ trình là T03 — hợp đồng dữ liệu/API và thuật toán; chưa bắt đầu T03 hoặc viết code sản phẩm trong lượt chốt này.
