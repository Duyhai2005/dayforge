# DAYFORGE — đặc tả giao diện và tương tác T02

Ngày duyệt: **28/10/2026** · Phiên bản **1.0** · Trạng thái: **Đã được người dùng duyệt — T02 hoàn thành**.

Tài liệu này là thiết kế hiện hành đã được duyệt để người triển khai lập kế hoạch UI. [Nhật ký trao đổi](README.md) giữ nguồn lựa chọn và các prototype trước; khi có khác biệt về chi tiết UI, dùng tài liệu này. T01 và T02 đã hoàn thành; T03–T36 chưa hoàn thành. Đây là thiết kế và bản thử dùng dữ liệu mẫu, chưa có sản phẩm Next.js/FastAPI hoặc đồng bộ thật.

## 1. Ý định và phạm vi

DAYFORGE giúp một người nhìn rõ việc cần chuẩn bị cho thi, báo cáo, thuyết trình và học tập hằng ngày. Mở lịch công việc là đọc được cả tuần theo sáng/chiều/tối; lịch dấu mốc cho thấy các ngày quan trọng ở quy mô tuần/tháng/năm. Không buộc chia việc theo giờ chính xác.

Giai đoạn đầu có hai trang lịch chính, biểu mẫu nổi trong ngữ cảnh, kế hoạch/màu, công việc một lần/lặp, dấu mốc có buổi tùy chọn và ghi chú liên quan, tài khoản email/xác minh/mật khẩu và trải nghiệm local/offline/sync. Máy chủ độc lập với PC; FastAPI/Python + Next.js server/React + MySQL như T01. T03 khóa schema/API, phiên và đồng bộ.

Trang ghi chú nhanh độc lập, mobile app với giao diện riêng, desktop app, cộng tác/nhiều người dùng, Google login và tự lập lịch học để sau. Không thêm giờ bắt đầu/kết thúc, kéo giãn thẻ theo thời lượng, trạng thái hoàn thành cho dấu mốc hoặc tự biến task thành dấu mốc.

Thành công về UI: dễ đọc và thao tác hằng ngày, thoáng và có cá tính, không header/sidebar cố định, không giấu công việc tuần, không mất nội dung do đóng nhầm, không báo lưu/sync thành công khi chưa được xác nhận. Không dùng animation nền liên tục hoặc thu nhỏ chữ để nhét lịch.

## 2. Phương án đã so sánh và nguồn quyết định

| Phần | Phương án và đánh đổi | Kết quả |
| --- | --- | --- |
| Hướng tổng thể | Bố cục A: tuần mở, đọc trực tiếp; nền tối B tạo không gian tập trung. | Người dùng chọn kết hợp A + nền tối B. |
| Mật độ thẻ | A thoáng hơn nhưng lịch dài; B giảm đệm/khoảng cách/chữ phụ, giữ tên việc 14px. Cùng mẫu 23 việc và buổi có 5 việc. | Người dùng chọn **B gọn**; không phải giới hạn 5 việc. |
| Hoàn thành | Tích ngay trên thẻ nhanh hơn; mở biểu mẫu giảm bấm nhầm khi xem/kéo. | Người dùng chọn **mở thẻ rồi hoàn thành**. |
| Ngữ cảnh hai lịch | Dùng chung ngày tạo liên hệ; nhớ riêng cho phép xem công việc hiện tại và dấu mốc tương lai đồng thời. | Người dùng chọn **mỗi lịch nhớ khoảng xem riêng**. |
| Ghi chú dấu mốc | Đoạn trích trên lịch đọc nhanh nhưng thêm nhiễu; ký hiệu nhỏ và mở để đọc giữ lịch gọn. | Người dùng chọn **chỉ đọc đầy đủ khi mở dấu mốc**. |

Các phần đã được người dùng đồng ý qua trao đổi/prototype: widget giữa cạnh dưới và cách mở/thu; cảnh báo chưa lưu; sửa riêng một lần và mục Lịch lặp riêng; hai tên dấu mốc trên lịch tháng và +N; bảng chín màu/xem trước; buổi/ghi chú của dấu mốc; nhóm màn hình tài khoản và phản hồi lưu/đồng bộ. Câu trả lời mới nhất xác nhận nhóm tài khoản ổn và yêu cầu **gom phần còn lại, tự chốt một lượt trước khi chạy giao diện**, không tiếp tục chuỗi hỏi nhỏ/chạy thử từng câu.

Các thông số ở mục 3, chi tiết lịch năm, lưu vị trí xem, quy tắc thao tác biên và trạng thái rỗng bên dưới là **lựa chọn của người thiết kế theo ủy quyền**, không diễn giải thành câu trả lời trước đây của người dùng. Chúng đã được người dùng duyệt cùng bản tổng hợp cuối bằng xác nhận **“được rồi chốt T02” ngày 28/10/2026**; không còn câu hỏi lựa chọn nhỏ riêng lẻ.

## 3. Ngôn ngữ thị giác và thông số mặc định

Nền tối hơi xanh, chữ sáng dịu; màu kế hoạch là màu nhận diện của nội dung. Tên DAYFORGE không kéo thiết kế sang hiệu ứng lửa/kim loại.

| Token | Giá trị chốt cho triển khai UI |
| --- | --- |
| Nền | `#141C22`; lớp nền ngoài `#10171C` |
| Panel | `#202C30`; trường nhập `#142226` |
| Chữ | Chính `#E6ECE7`, phụ `#B8C8BC`, nhãn nhẹ `#9AAEA3` |
| Nhấn điều khiển | Nền `#C4D7C5`, chữ `#203328` |
| Font | Hệ thống: Segoe UI, Arial, sans-serif; đầy đủ tiếng Việt, không phụ thuộc tải font mạng để dùng offline. |
| Cỡ chữ | Tiêu đề trang 30–34px; số ngày 26px; tên việc/nội dung nhập 14px; meta/nhãn 12px; kicker trang trí 10–11px. |
| Khoảng cách | Nhịp 4/8/12/16/24/32px; cột ngày 10–14px; thẻ đệm khoảng 8–10px, cách nhau 5–7px. |
| Bo góc | Thẻ 10–13px; trường/nút 10–11px; panel 20–24px; pill tròn. |
| Vùng thao tác | Nút chữ tối thiểu 36px cao, nút chính 42–44px; nút đóng/icon tối thiểu 32px; ô màu khoảng 40px. |
| Focus | Viền sáng 2px, offset 3px; có trạng thái bằng chữ/ký hiệu ngoài màu. |

Tên việc xuống dòng tự nhiên, không cắt số công việc. Bố cục desktop linh hoạt ở khoảng 1024–1920px, tối đa vùng nội dung khoảng 1540px. Khi hẹp hơn mức đọc rõ bảy cột, giữ cỡ chữ và cho cuộn ngang vùng lịch; widget/biểu mẫu vẫn truy cập được. Đây là phương án tránh vỡ web desktop, không phải thiết kế mobile app. Biểu mẫu rộng khoảng 460–480px và cuộn trong panel nếu cao hơn viewport, không cắt nút lưu khỏi đường thao tác.

Bộ màu đã được người dùng xem và đồng ý:

| Tên | Chữ/nhấn | Nền thẻ |
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

Mục có kế hoạch kế thừa màu, không ghi đè riêng. Mục độc lập mặc định trung tính và được chọn màu riêng; không cần nhập mã màu tùy ý. Trong cùng bản nhập, chọn kế hoạch rồi bỏ chọn khôi phục màu độc lập vừa chọn, nếu chưa có thì trung tính. Đổi tên/màu kế hoạch cập nhật các mục liên quan ở hai lịch, không đổi nội dung hay lịch làm việc.

## 4. Hai trang và widget

Lịch công việc và lịch dấu mốc là hai route chính; không có trang nhập liệu riêng. Lần đầu chưa có lựa chọn xem: lịch công việc mở tuần chứa hôm nay; lịch dấu mốc mở tháng hiện tại. Tuần từ thứ hai đến chủ nhật, một múi giờ làm việc UTC+07:00 như T01.

Widget ở giữa cạnh dưới. Thu gọn có nút thêm nhanh, tên lịch hiện tại và ký hiệu trạng thái dữ liệu. Khi mở gồm thêm công việc/dấu mốc/kế hoạch, hai lựa chọn chuyển lịch, quy mô tuần/tháng/năm chỉ cho lịch dấu mốc, về hôm nay/lùi/tiến/nhãn khoảng và hàng dữ liệu–tài khoản. Có khoảng đệm cuối trang để widget không che phần cuối của lịch.

Chuyển lịch thu panel; đổi khoảng hoặc quy mô giữ panel mở. Click ra ngoài/Escape thu widget; không làm thay đổi lịch. Focus vào nội dung/ngữ cảnh đích sau chuyển trang và trả về nút mở sau đóng panel.

Mỗi lịch giữ ngày neo và vị trí cuộn riêng; dấu mốc giữ thêm quy mô. **Mặc định tự chốt:** lưu trạng thái xem theo thiết bị/chủ tài khoản qua reload, không đồng bộ vị trí xem giữa thiết bị. Nếu trạng thái chưa có/không hợp lệ dùng mặc định hôm nay. Chuyển lịch thường không ép hai lịch cùng ngày. “Xem tuần liên quan” chủ động đưa lịch công việc đến tuần chứa dấu mốc, nhấn ngày ngắn một lần và giữ khoảng riêng của lịch dấu mốc.

Back/Forward phục hồi route, khoảng và quy mô trước đó. Khi có bản nhập bẩn, điều hướng bỏ nó phải đi qua cơ chế ở mục 7; chưa xử lý xong thì giữ nguyên form. Vị trí xem là dữ liệu giao diện, không phải sửa lịch nghiệp vụ.

## 5. Lịch công việc

Bảy cột ngày; sáng/chiều/tối tạo thành những dải nhẹ bằng khoảng cách, không vạch giờ. Các buổi tương ứng giữa bảy ngày được căn hàng; chiều cao hàng tăng theo nội dung lớn nhất. Một vùng cuộn dọc chung, không scrollbar riêng trong ngày/buổi và không ẩn việc còn lại bằng +N.

Thẻ có tên, thời lượng nếu có, ký hiệu lặp và dấu kết quả khi cần. Thời lượng là ước tính, không quyết định chiều cao/độ dài hay vị trí thẻ. Bỏ trống ghi “Chưa ước lượng”; không coi là 0. Không bắt đầu/đến giờ cụ thể. Bản đầu không thêm bảng tổng thời lượng hoặc tính giờ kết thúc.

Dấu mốc bật hiện trong lịch công việc dùng ký hiệu hình thoi/tên/màu, không có checkbox hoàn thành/thời lượng. Buổi được chọn thì hiện trong dải tương ứng; cả ngày thì dưới tiêu đề ngày. Không tự gắn một buổi cho dấu mốc cũ. Không cắt số dấu mốc ở lịch tuần; hàng cao lên và cuộn chung nếu nhiều.

Click khoảng trống/nút + của buổi mở thêm việc với đúng ngày/buổi; thêm nhanh từ widget lấy ngày neo đang xem, buổi vẫn cần chọn. Click thẻ mở sửa; chỉ hoàn thành/bỏ hoàn thành trong form rồi Lưu. Dấu ✓ ở góc cho hoàn thành, ký hiệu đồng hồ cho ngày đã qua mà chưa hoàn thành; giữ màu gốc. Chỉ đánh dấu chưa hoàn thành sau hết ngày dự định, không tự dời việc. Gỡ khỏi lịch làm thẻ biến mất, không dùng “hủy” thay trạng thái chưa xong.

Click tiêu đề ngày có thể mở overlay tập trung ba buổi như prototype đã xem; không phải bước bắt buộc để đọc tuần. Đóng quay về đúng tuần/cuộn. Không có route quản trị ngày riêng trong giai đoạn đầu.

## 6. Lịch dấu mốc và trường buổi/ghi chú

### Tuần

Bảy ngày, nhóm Cả ngày/Sáng/Chiều/Tối; chỉ hiện nhóm có dữ liệu. Các mốc đều đọc và mở được; không cắt số mục hoặc đặt cuộn riêng trong cột. Nút thêm/ngày rỗng mở form ngày đó; buổi chọn trong form.

### Tháng

Lưới ngày nhẹ, nhấn hôm nay vừa đủ. Mỗi ngày hiện tối đa hai tên mốc, mỗi tên tối đa hai dòng; thêm nhãn buổi nếu đã chọn và ký hiệu ghi chú nếu có. Nếu còn thêm, “+N dấu mốc” là số chưa hiện, mở danh sách đầy đủ trong panel trên cùng ngữ cảnh tháng. Không giới hạn số mốc dữ liệu.

Danh sách có đủ tên, buổi/cả ngày, tên kế hoạch hoặc độc lập và màu; không đưa nội dung ghi chú ra đây. Click mục mở sửa, có đường trở về danh sách; thêm mới từ danh sách điền ngày đó. Click ngày để thêm; ngày ngoài tháng dùng đúng ngày thực, chuyển tới tháng tương ứng khi cần và không ghi vào nhầm tháng đang neo.

### Năm — mặc định tự chốt cho phần còn lại

Mười hai cụm tháng, mỗi cụm có các chấm ngày, **tổng số dấu mốc**, tối đa ba nhãn nhóm kế hoạch/màu và “+N nhóm” nếu còn. Nhãn nhóm là tên kế hoạch; mục độc lập dùng nhãn độc lập kèm tên màu. Không chọn tùy tiện một tên dấu mốc làm đại diện cho cả nhóm.

Ngày có một màu dùng một chấm; ngày có nhiều màu dùng chấm nhiều phần/vòng để nhận biết có nhiều nhóm, hiển thị tối đa ba màu đại diện. Tổng số tháng không bị giới hạn theo số chấm/nhãn; tooltip có tổng số trong ngày. Chấm không phải nút nhỏ duy nhất: cả cụm tháng có tên truy cập gồm tháng/năm/tổng số mốc, dùng được bàn phím và click để mở tháng đọc tất cả. Không có mục nào chỉ truy cập được qua hover. Không cố đọc tên mốc/ghi chú ngay trong tổng quan năm.

Đi lùi/tiến các năm bằng widget; không tự quay về năm hiện tại khi chuyển lịch. Tháng/năm rỗng vẫn hiện cấu trúc và thông báo nhẹ, có đường thêm mốc qua tháng/widget.

### Biểu mẫu dấu mốc

Tên và ngày bắt buộc; buổi Cả ngày/Sáng/Chiều/Tối không bắt buộc; có ghi chú nhiều dòng, kế hoạch/màu và cờ hiện trên lịch công việc. Cả ngày là không gắn buổi, không cam kết chiếm cả 24 giờ. Dấu mốc không có thời lượng, lặp hoặc trạng thái hoàn thành trong đợt đầu.

Ghi chú **chỉ đọc/sửa đầy đủ khi mở dấu mốc**; trên lịch chỉ ký hiệu nhỏ, không đoạn trích. Ngày/buổi/ghi chú/màu thuộc cùng bản ghi dù mở từ lịch nào. Sửa ngày/buổi mốc không tự dời các việc chuẩn bị; kéo việc chuẩn bị không dời mốc. Ô ghi chú này thuộc giai đoạn đầu, khác trang ghi chú nhanh đã hoãn.

## 7. Thêm/sửa, bản nháp và kế hoạch

Form công việc: tên, ngày, buổi bắt buộc; thời lượng, kế hoạch/màu và lặp không bắt buộc. Khi mở từ một buổi, ngày/buổi có sẵn. Form kế hoạch: tên và màu; chỉ tạo/sửa tên/màu, chưa có xóa/lưu trữ kế hoạch. Đặt kế hoạch mới ngay trong bản nhập việc/mốc; quay lại giữ tất cả trường, cả ghi chú dấu mốc.

Nút Lưu mới áp dụng lên lịch. Có lỗi ghi local thì giữ form/nội dung và báo sát thao tác; không đóng hoặc báo thành công. Nếu chỉ mạng/sync lỗi nhưng giao dịch local đã thành công thì đóng form bình thường và chỉ báo phần chờ đồng bộ.

Form sạch đóng ngay. Form bẩn đóng bằng X/Escape/nền/chuyển tab loại form/quay lại/điều hướng thì nhắc **Tiếp tục sửa** hoặc **Bỏ thay đổi**; không ngầm bỏ. Escape trong lời nhắc là tiếp tục, không đồng nghĩa bỏ. So sánh giá trị với bản mở ban đầu, sửa rồi trả đúng giá trị ban đầu không cần nhắc. Áp dụng cùng nguyên tắc cho ghi chú và cấu hình lặp. Đóng tab/reload trình duyệt dùng cảnh báo native khi có bản nhập bẩn; không hứa tự lưu bản nháp qua browser bị đóng/crash trong giai đoạn đầu.

Tạo kế hoạch lồng là một tầng con: hủy/tạo xong trở lại đúng bản nhập cha. Hủy tầng con không bỏ bản nhập cha. Kế hoạch đã bấm Tạo là bản ghi đã lưu riêng; bỏ bản nháp công việc sau đó không xóa kế hoạch. Focus về điểm phù hợp khi quay lại. Sau Lưu, focus đến thẻ đã tạo/sửa; sau gỡ đến vị trí lân cận hoặc nút thêm của buổi/ngày.

Bảng màu chín ô có tên, viền/dấu chọn, radio dùng được bàn phím và xem trước. Có kế hoạch thì thay bảng màu riêng bằng “Dùng màu của…” và tên kế hoạch. Ẩn xem trước trùng lặp ở form sửa lần lặp/mốc đã có kế hoạch để giữ thao tác chính gọn; nội dung độc lập vẫn có xem trước khi chọn màu.

**Giới hạn mặc định của người thiết kế cho UI, T03 giữ frontend/server thống nhất:** tên việc/mốc 120 ký tự, tên kế hoạch 100, ghi chú 4.000, thời lượng nguyên dương 1–1.440 phút hoặc để trống. Không cắt âm thầm dữ liệu dài; báo rõ sát trường. Chữ tiếng Việt/xuống dòng giữ đúng, ghi chú hiển thị như văn bản. Không biến việc trùng tên thành cùng ID.

## 8. Kéo thả, đổi thứ tự và hoàn tác

Kéo công việc trong tuần đang xem để đổi ngày, buổi hoặc thứ tự. Có tay kéo/chỉ dẫn; ngưỡng di chuyển nhỏ phân biệt click với kéo. Ghost nhẹ, thẻ nguồn dịu xuống; vùng nhận có nền/viền, nhãn ngày/buổi và điểm chèn, không chỉ đổi màu. Một lần lặp chỉ chuyển lần đó. Thả vào cùng vị trí là không thay đổi; thả ra ngoài/Escape/pointer cancel trả về chỗ cũ.

Cuộn chung trang khi kéo gần mép trên/dưới. Không kéo qua tuần khác tự động ở đợt đầu; dùng ngày/buổi trong form cho ngày ngoài tuần. Form cũng là cách tương đương bằng bàn phím. Dấu mốc đổi ngày/buổi bằng form, chưa thêm kéo thả dấu mốc hoặc thay đổi thời lượng bằng kéo giãn.

Ghi local thành công mới chốt vị trí; lỗi giữ/khôi phục vị trí trước, phản hồi rõ. Sau thao tác có thông báo ngắn như “Đã chuyển sang chiều thứ năm”, với Hoàn tác. Hoàn tác một lần lặp hoặc nhóm đổi/dừng chuỗi phải có cùng phạm vi với thao tác gốc.

**Mặc định tự chốt:** thông báo hiển thị khoảng 8 giây, dừng đếm khi hover/focus; thao tác hoàn tác gần nhất còn ở widget cho đến thay đổi kế tiếp, đổi owner hoặc reload. T03 thiết kế nó thành mutation mới sau đồng bộ, không quay lùi cursor/server snapshot. Nếu dữ liệu đích đã thay đổi và không còn áp dụng an toàn, báo rõ không thể hoàn tác lần này; không ghi đè mù dữ liệu mới.

## 9. Công việc lặp

Tạo mới chọn không lặp/hằng ngày/các thứ trong tuần và buổi. Không thêm ngày kết thúc mặc định; lặp đến khi dừng. Với mẫu theo thứ, ngày bắt đầu là mốc sớm nhất, lần đầu là ngày khớp đầu tiên; form cho biết nếu không nằm ngay ngày bắt đầu.

Mở thẻ lặp: chỉ sửa lần đang mở; có nhãn này và mục **Lịch lặp…** riêng. Hoàn thành/đổi tên/ngày/buổi/kế hoạch/gỡ lần đó không hỏi lại phạm vi. Màn Lịch lặp có Đổi lịch lặp hoặc Dừng lặp, ngày áp dụng và khối giải thích trước nút lưu. Nếu lần đang chọn đã dời, hiển thị cả ngày gốc và ngày hiện tại; mặc định mốc theo ngày gốc phù hợp hướng T01, T03 khóa ranh giới.

| Hành động | Tác động phải giải thích và thực hiện |
| --- | --- |
| Đổi lịch từ mốc | Giữ lịch sử trước mốc; những lần tương lai đã chỉnh riêng thành việc một lần, giữ dữ liệu/kế hoạch/màu; phần còn lại theo quy tắc mới; không trùng và không khôi phục ngoại lệ đã gỡ. |
| Dừng từ mốc | Gỡ mọi lần từ mốc còn thuộc chuỗi, kể cả đã dời; giữ lịch sử trước mốc và việc đã tách từ trước. |
| Gỡ một lần | Chỉ lần đó biến mất, không dừng chuỗi. |

Khối giải thích nêu số lần đã chỉnh riêng chịu tác động nếu có, không đếm vô hạn số lần chuỗi. Không áp dụng khi chưa chọn thứ hoặc không có thay đổi. Giữ nhắc chưa lưu khi quay về form lần đơn. Nhóm đổi/dừng là một hành động có Hoàn tác; atomic/retry/ID thuộc T03.

Khi bật lặp cho một việc một lần đang sửa, giữ ngày/buổi/kết quả của lần đầu; nếu lịch theo thứ không chứa ngày việc đang chọn, báo lỗi để sửa ngày/các thứ thay vì làm mất hoặc âm thầm dời việc đó. Bỏ cấu hình trước khi lưu không đổi loại bản ghi. T03 khóa phép chuyển này cùng mô hình ngoại lệ; không có task-to-milestone.

## 10. Tài khoản và dữ liệu — nhóm đã được người dùng đồng ý

Trang tài khoản dùng nền tối, nhận diện DAYFORGE và form gọn; không hiện dữ liệu lịch riêng sau đăng xuất hoặc trước đăng nhập lần đầu. Luồng đăng nhập không có Google/đăng ký công khai. Thiết lập lần đầu chỉ cho email chủ sở hữu cấu hình, sau đó xác minh bằng link. Có gửi lại và đường xử lý link hết hạn/đã dùng.

Đăng nhập có hiện/ẩn mật khẩu, ghi nhớ được chọn sẵn và quên mật khẩu. Quên mật khẩu trả thông báo trung tính, đặt lại cần mật khẩu mới/nhập lại, thành công về đăng nhập. Lỗi sát form, gửi đang chờ khóa thao tác lặp; gửi lại theo thời gian chờ server cung cấp, có chữ giải thích và khôi phục nút khi hết chờ. Trạng thái link thành công/lỗi rõ ràng, không cache callback riêng tư như shell lịch. Không có tiêu chuẩn mật khẩu tự phát trong UI khác hợp đồng T03.

Lần đầu/verify/reset cần online. Trên thiết bị đã mở đúng owner và có local, mất mạng hoặc hết phiên không chặn xem/sửa lịch. Hết phiên chỉ cập nhật chỉ báo; đăng nhập lại có nút về lịch và giữ pending. Chỉ đăng xuất chủ động mới khóa truy cập local theo T01.

| Trạng thái | Hiển thị và hành vi |
| --- | --- |
| Đã lưu trên máy/chờ sync | Xác nhận sau commit local; có số pending, tiếp tục làm việc. |
| Đang sync | Nhãn chờ ngắn, không khóa lịch. |
| Đã đồng bộ | Chỉ khi máy chủ ACK; không đồng nghĩa một bản backup độc lập. |
| Offline | Đã lưu local/chờ, tự thử khi online và app mở/mở lại; không toast lặp. |
| Hết phiên | Local giữ nguyên, đăng nhập lại để sync; không tự bật modal cản lịch. |
| Lỗi local | Giữ form/nội dung, không báo đã lưu hoặc đã sync; lỗi ngay tại thao tác. |
| Lỗi sync | Local vẫn đã lưu, chưa được server xác nhận; có thử lại và tự retry theo T03. |

Chi tiết mở từ hàng trạng thái của widget: trên thiết bị/máy chủ/số pending, tài khoản và đăng xuất. Pending nêu các mutation nghiệp vụ chưa được xác nhận; số lượng hiển thị theo định nghĩa thống nhất của sync engine T03, không đếm lần retry thành thay đổi mới.

Đăng xuất khi có pending hoặc bản nháp bẩn phải cảnh báo; bản nháp bẩn xử lý giữ/bỏ trước, pending vẫn giữ đúng owner. Đăng xuất khóa local, không tự xóa pending; đăng nhập lại cùng owner tiếp tục. Không bao giờ gửi dữ liệu dưới owner khác. Hash/cookie/CSRF/TTL/allowlist/link/cách ly và cơ chế bảo vệ local do T03 thiết kế, không coi ẩn một DOM node là bảo vệ dữ liệu thật.

## 11. Trạng thái rỗng, lỗi và tải

| Tình huống | Phản hồi chốt |
| --- | --- |
| Tuần/ngày/buổi rỗng | Giữ cấu trúc ngày/buổi, điểm thêm nhẹ; không bắt tạo kế hoạch trước. |
| Tháng/năm rỗng | Vẫn điều hướng bình thường, tổng 0 và đường thêm qua ngày/widget. |
| Chưa có kế hoạch | Có lựa chọn độc lập và Tạo kế hoạch mới trong form; không màn onboarding dài. |
| Đang mở local | Skeleton nhẹ nếu cần; không hiện “trống” giả trước khi đọc xong dữ liệu. |
| API chưa phản hồi nhưng local sẵn | Hiện local ngay, chỉ báo sync, không spinner chặn toàn lịch. |
| Local chưa chuẩn bị và offline | Nêu cần mở trực tuyến lần đầu; không hứa dữ liệu chưa tải có thể dùng offline. |
| Sai trường | Chữ sát trường, đưa focus đến lỗi đầu tiên, giữ các trường khác. |
| Lỗi thao tác/không đủ lưu trữ | Không xác nhận thành công; giữ bản nhập hoặc khôi phục vị trí, có thử lại. |
| Sửa từ thiết bị khác đang mở form | Không âm thầm thay nội dung đang gõ; khi lưu đi qua hợp đồng LWW và phản hồi T03, không có màn chọn conflict thủ công. |

## 12. Chuyển động và khả năng tiếp cận

**Thông số tự chốt:** hover/nhấn 120ms, widget/modal 180ms, chuyển trang/quy mô 260ms, thẻ ổn định sau thả 160ms; nhấn ngày liên quan khoảng 500ms một lần. Dùng opacity/transform, dịch ngắn khoảng 6–10px; không blur toàn canvas khi chuyển và không hiệu ứng lặp trang trí. Không bắt đợi xong animation mới được thao tác; yêu cầu điều hướng mới thay thế chuyển cảnh cũ.

Theo prefers-reduced-motion: bỏ dịch/scale và xung nhấn, chuyển trạng thái ngay hoặc fade ngắn tối đa khoảng 80ms. Nền/overlay có thể dùng blur tĩnh nhẹ khoảng 6px, có fallback nền đặc; không bắt GPU gánh nhiều lớp blur liên tục.

Tab/Shift+Tab tới được hành động chính, Enter/Space kích hoạt native, radio màu dùng phím mũi tên. Modal giữ focus tầng trên cùng và trả focus đúng; Escape chỉ đóng tầng trên sau xử lý bản bẩn. Ô nhập có label, icon có tên truy cập, thông báo lỗi/status có live region phù hợp, không chỉ dựa vào hover/màu. Trường ghi chú dùng textarea, không render HTML người dùng nhập. Nút X/điểm kéo/mốc nhiều mục không quá nhỏ.

Màu chữ thường và trạng thái hướng AA; toàn bộ placeholder/focus/disabled phải kiểm tra trên sản phẩm, không lấy tính tương phản chín cặp thẻ làm bằng chứng đạt toàn UI. Kiểm tra Cốc Cốc desktop thật ở laptop/màn lớn; bản thử in-app không thay kiểm chứng đó.

## 13. Bàn giao cho người triển khai và nghiệm thu T02

Phạm vi dự án hiện có **48 FR và 38 AC** trong [yêu cầu](../../project-definition/02-functional-requirements.md) và [nghiệm thu](../../project-definition/06-delivery-and-acceptance.md); 36 task tổng thể không đổi. Các kiểm tra UI sau nối với FR/AC giai đoạn đầu, chưa phải kết quả chạy sản phẩm:

| Mã | Kịch bản phải kiểm chứng |
| --- | --- |
| UI-01 | Bảy ngày/ba buổi; có buổi 5 việc, tên dài, nhiều dấu mốc; không ẩn task hoặc cuộn riêng từng cột. |
| UI-02 | Mỗi lịch nhớ khoảng/scale/cuộn, reload và Back/Forward; link Xem tuần liên quan đổi đúng tuần mà giữ khoảng dấu mốc. |
| UI-03 | Thêm/sửa việc độc lập/có kế hoạch; lồng tạo kế hoạch giữ đầy đủ bản nháp việc và mốc có ghi chú. |
| UI-04 | Form sạch/bẩn, đóng/nền/Escape/điều hướng/đóng tab; chỉ bỏ bản bẩn khi chọn bỏ. |
| UI-05 | Kéo ngày/buổi/thứ tự, cuộn trang, thả sai/Escape, cách làm bằng bàn phím, lỗi ghi và Undo. |
| UI-06 | Hoàn thành riêng lần; quá ngày chưa xong; màu gốc giữ nguyên; gỡ thực sự biến mất. |
| UI-07 | Sửa/dừng lặp với ngoại lệ dời/xóa/hoàn thành và việc đã tách, ngày gốc/đích khác tuần; phạm vi/giải thích đúng T01/T03. |
| UI-08 | Mốc cả ngày/sáng/chiều/tối; note nhiều dòng/để trống/xóa/đóng chưa lưu; hai lịch cùng bản ghi. |
| UI-09 | Tháng có +N, đầy đủ danh sách; năm có nhiều màu/nhóm và số lượng đúng; mở tháng tới mọi mục. |
| UI-10 | Đăng nhập/setup/verify/resend/link hết hạn/forgot/reset/ghi nhớ/hết phiên/đăng xuất có pending theo T01. |
| UI-11 | Phân biệt chưa lưu/local đã lưu/pending/ACK/offline/lỗi phiên/lỗi sync; không báo thành công giả. |
| UI-12 | Keyboard/focus/live region, reduced motion, độ tương phản, laptop/desktop Cốc Cốc và kích thước ngày cuối tháng/chuyển năm. |

Builder được chọn cấu trúc component, thư viện/icon nội bộ, biện pháp hiệu năng và mã CSS trong stack đã chọn; được tinh chỉnh vài px/ms khi nghiệm thu nếu giữ hành vi và hướng này. Không tự thay chính sách recurrence, LWW, tài khoản hoặc tạo thêm trang notes. T03 khóa schema/API, chuyển đổi task→series, ngày gốc, limits/validation đồng nhất, owner/session/local unlock, revision/ACK/undo và lưu trạng thái xem; không cần hỏi người dùng chọn thuật toán.

## 14. Tình trạng rà soát và bản xem tổng hợp

- Bản tổng hợp được viết trước lượt chạy giao diện cuối theo yêu cầu mới nhất; phần tài khoản/lưu/sync vừa xem đã được người dùng đồng ý.
- Lượt builder check độc lập đã trả về **“nothing important left”**: không còn câu hỏi quan trọng cần người dùng trả lời trước khi lập kế hoạch.
- [Bản giao diện tổng hợp v3](prototypes/t02-consolidated-preview-v3.html), [lịch tuần](assets/consolidated-work-week.jpg), [lịch tháng](assets/consolidated-milestone-month.jpg), [lịch năm](assets/consolidated-milestone-year.jpg) và [báo cáo rà soát/kiểm tra](review-and-verification.md) là bộ bàn giao cho lần duyệt cuối. Không dùng kết quả prototype để tuyên bố sản phẩm hoặc toàn bộ AC đã hoàn thành.
- Sau rà soát và bản xem cuối, người dùng xác nhận **“được rồi chốt T02” ngày 28/10/2026**. Bản tổng hợp phiên bản 1.0 đã được duyệt, bao gồm các mặc định của người thiết kế được ghi rõ trong tài liệu. **T02 đã hoàn thành** trong danh sách 36 task; T03–T36 vẫn chưa hoàn thành. Không bắt đầu code sản phẩm trong lượt chốt này.
