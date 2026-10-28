# DAYFORGE — quyết định và điểm còn mở

Cập nhật **28/10/2026 — T01–T03 hoàn thành thiết kế/hợp đồng**. Người dùng đã duyệt [T01](../tasks/t01/design.md) và [T02 1.0](../tasks/t02/design.md). [T03](../tasks/t03/design.md) khóa lựa chọn kỹ thuật theo quyền đã giao; không diễn giải thành một lần người dùng duyệt riêng. T04–T36 triển khai và deploy chưa hoàn thành.

## 1. Các quyết định đã chốt

| ID | Quyết định hiện hành | Căn cứ |
| --- | --- | --- |
| D-01 | DAYFORGE, thư mục `dayforge`. | Người dùng đặt tên và cung cấp thư mục. |
| D-02 | Vẫn phục vụ dùng riêng một người; **có tài khoản ngay giai đoạn đầu**. | Quyết định mới “tạo cơ chế tài khoản cho dễ quản lý” thay yêu cầu chưa làm tài khoản ban đầu. |
| D-03 | Web desktop trước; mobile app/desktop app sau. | Yêu cầu nền tảng đã xác nhận. |
| D-04 | Hai trang lịch chính: công việc và dấu mốc. | Yêu cầu trực tiếp. |
| D-05 | Toàn tuần thấy ngay công việc theo sáng/chiều/tối. | Không bắt mở từng ngày mới đọc việc. |
| D-06 | Ước lượng thời lượng, không bắt giờ bắt đầu chính xác. | Yêu cầu trực tiếp. |
| D-07 | Dấu mốc có tuần/tháng/năm, đi sang năm khác. | Yêu cầu trực tiếp. |
| D-08 | Cùng kế hoạch cùng màu do người dùng chọn. | Ví dụ ôn ABC/XYZ/ngày thi, tiếng Anh. |
| D-09 | Có việc không thuộc kế hoạch. | Người dùng xác nhận. |
| D-10 | Hoàn thành/chưa hoàn thành giữ màu gốc và thêm dấu. | Người dùng chỉnh yêu cầu trạng thái. |
| D-11 | Hủy thật thì gỡ khỏi lịch. | Người dùng phân biệt hủy với chưa hoàn thành. |
| D-12 | Lặp hằng ngày/theo thứ, chọn sẵn buổi, đến khi dừng. | Yêu cầu trực tiếp. |
| D-13 | Kéo thả đổi lịch; hướng thêm/sửa/kéo thả được tạm chấp nhận. | Phản hồi sau prototype. |
| D-14 | Không header/sidebar cố định, widget mở khi cần. | Yêu cầu trực tiếp. |
| D-15 | Bố cục thị giác A và nền tối B; thoáng, motion mượt/tinh tế. | Lựa chọn UI. Không nhầm với phương án kiến trúc A/B. |
| D-16 | Xem/sửa offline và tự đồng bộ. | Người dùng xác nhận. |
| D-17 | FastAPI/Python, React/Next.js và MySQL. | Bộ công nghệ do người dùng chọn. |
| D-18 | Trang ghi chú nhanh độc lập để đợt sau. Ghi chú gắn trong dấu mốc thuộc đợt đầu theo bổ sung D-31 trong T02. | Người dùng hoãn trang ghi chú, sau đó yêu cầu thêm ô ghi chú trong dấu mốc. |
| D-19 | Hồ sơ Markdown trong thư mục con `docs`. | Yêu cầu lưu tài liệu. |
| D-20 | Server chạy độc lập PC; thiết bị khác vẫn dùng/sync khi PC tắt. | Trả lời “Vẫn hoạt động bình thường”. |
| D-21 | AWS hoặc Oracle Cloud chọn khi tới deploy, ưu tiên chi phí thấp. | Người dùng chủ động hoãn lựa chọn nhà cung cấp. |
| D-22 | Xung đột tự giữ bản chỉnh sửa mới nhất, không chọn thủ công. | “tự chọn bản sửa mới nhất là được”. Mốc sửa offline được ghi lại để so sánh. |
| D-23 | Chỉ tạo dấu mốc riêng; có thể gắn kế hoạch và hiện ở cả hai lịch. | “chỉ cần cách tạo dấu mốc riêng thôi”. |
| D-24 | Đổi quy tắc lặp: giữ các lần tương lai đã chỉnh riêng thành task một lần, cùng kế hoạch/màu. | Người dùng đồng ý tình huống dời thứ sáu sang thứ bảy rồi đổi các thứ lặp. |
| D-25 | Dừng chuỗi: gỡ từ mốc dừng những lần còn thuộc chuỗi kể cả đã dời; giữ lịch sử và task đã tách. | Người dùng đồng ý đề xuất dừng. |
| D-26 | Email làm tài khoản, xác minh email, mật khẩu riêng, không Google. | Lựa chọn phương thức đăng nhập trực tiếp. |
| D-27 | Cốc Cốc desktop là trình duyệt chính. | “tôi dự định dùng cốc cốc”. |
| D-28 | Tự sync khi mở/đang mở; đóng hẳn trình duyệt chờ lần mở lại. | Người dùng đồng ý cơ chế này. |
| D-29 | **Kiến trúc B: Next.js server + FastAPI + MySQL.** | Người dùng chọn “B” sau khi so sánh hai phương án. |
| D-30 | **Phê duyệt bản tổng hợp T01 và đánh dấu T01 hoàn thành ngày 28/10/2026.** | “Tôi duyệt bản tổng hợp này, hãy đánh dấu T01 hoàn thành.” Bao gồm các mặc định đã nêu trong thiết kế T01; không đánh dấu các task tiếp theo hoàn thành. |
| D-31 | Dấu mốc có thể chọn buổi trong ngày và có ô ghi chú liên quan. Đây là bổ sung phạm vi trong T02; trang ghi chú nhanh độc lập vẫn để sau. | Yêu cầu trực tiếp ngày 28/10/2026: “dấu mốc cũng có thể hiện ở các buổi trong ngày nếu muốn” và “một ô note ghi chú liên quan”. |
| D-32 | Nhóm tài khoản/lưu/sync đã được đồng ý; chi tiết UI còn lại giao người thiết kế tự chốt và gom một lượt trước khi chạy bản xem chung. Đây không phải phê duyệt tài liệu T02 chưa được gửi. | “Tôi thấy ổn rồi, tiếp tục những phần còn lại của T02 đi, chốt một lượt rồi mới chạy giao diện…”. |
| D-33 | **Phê duyệt đặc tả T02 1.0 và chốt T02 hoàn thành ngày 28/10/2026.** Bao gồm hai lịch, biểu mẫu, màu, dấu mốc có buổi/ghi chú, lặp, tài khoản/phản hồi dữ liệu và các mặc định UI được gom trong bản duyệt cuối. T03–T36 chưa hoàn thành. | “được rồi chốt T02”. |
| D-34 | Tuân thủ `docs/CONVENTION.md` và `docs/GITFLOW.md`; branch có mô tả tiếng Anh, commit message tiếng Anh không thêm scope số task. | Yêu cầu trực tiếp trong lượt thiết lập Git và thêm hai file quy ước. |
| D-35 | T03 khóa dữ liệu, tài khoản, HTTP và sync 1.0 theo thuật toán được giao: immutable command replay, HLC, cursor commit-order, safe Undo, owner/session và local vault. Đây là lựa chọn kỹ thuật của người thực hiện, không mở scope sản phẩm. | Yêu cầu “tiếp tục Task 3… chốt hợp đồng dữ liệu và API”, cùng quyền chọn thuật toán đã ghi trong T02/sổ quyết định. |

Các lựa chọn mới ngày 28/10/2026 được ghi thêm, không diễn giải là đã tồn tại từ đầu. Các mặc định nêu trong thiết kế T01 được chấp nhận cùng lần phê duyệt T01; thư viện, UI và thuật toán chưa chốt tiếp tục có nhãn đề xuất cho task liên quan.

## 2. Mặc định của người viết và trạng thái sau khi duyệt T01

Các mặc định về hành vi/tài khoản có trong thiết kế T01 đã được duyệt cùng T01. P-01 và những chi tiết UI, kỹ thuật chưa khóa vẫn được chốt trong T02/T03/T04.

| ID | Mặc định và lý do |
| --- | --- |
| P-01 | TypeScript, Dexie, Workbox, CSS Modules/variables, Motion, dnd-kit, SQLAlchemy/Alembic; chọn phiên bản sau thử nghiệm. |
| P-02 | Thời lượng không bắt buộc; kế hoạch tối thiểu tên/màu; chưa thêm xóa kế hoạch. Giữ thao tác nhập gọn. |
| P-03 | T02 đã xác nhận mục độc lập mặc định màu trung tính, được chọn màu riêng nhanh trong biểu mẫu; bảng màu cụ thể tiếp tục chốt T02. |
| P-04 | Chỉ đánh dấu chưa hoàn thành sau hết ngày dự định; không tự dời việc. |
| P-05 | Sửa/kéo/xóa một lần mặc định chỉ lần đó; mốc từ lần này theo ngày gốc, T03 cụ thể hóa ranh giới khi đã dời. |
| P-06 | Thứ hai bắt đầu tuần, một múi giờ làm việc UTC+07:00. |
| P-07 | Có hoàn tác, đường thao tác bằng form/bàn phím; chi tiết ngày tùy chọn. |
| P-08 | Chỉ email chủ sở hữu cấu hình được đăng ký; chưa mở đăng ký công khai/quản lý nhiều người. |
| P-09 | Xác minh qua link email, gửi lại link, quên/reset mật khẩu, ghi nhớ đăng nhập. |
| P-10 | Phiên do FastAPI quản lý, cookie phù hợp; hash mật khẩu, token email một lần, chống lạm dụng và bảo vệ Origin/CSRF. T03 chọn chi tiết. |
| P-11 | Local/outbox tách theo chủ; hết phiên giữ dữ liệu chờ, đăng xuất khóa truy cập và cảnh báo pending. |

## 3. Các quyết định còn mở và nơi xử lý

| ID | Trạng thái sau T01 | Nơi xử lý |
| --- | --- | --- |
| O-01 — Kiến trúc A/B | **Đã đóng:** chọn B, D-29. | Hồ sơ kiến trúc đã cập nhật. |
| O-02 — Nhà cung cấp/cấu hình | **Hoãn có chủ ý:** AWS/Oracle khi deploy; server độc lập đã chốt. Không chặn duyệt T01. | T29/T30, theo ngân sách và đo bản build. |
| O-03 — Quyền truy cập | **Đã đóng hợp đồng:** tài khoản email/xác minh/mật khẩu, phiên và local vault theo [T03](../tasks/t03/auth-contract.md). | T09/T13 thực hiện và kiểm chứng. |
| O-04 — Xung đột | **Đã đóng hợp đồng:** tự giữ sửa mới nhất theo [T03](../tasks/t03/sync-contract.md), bao gồm clock repair/tie-break/nhóm/xóa–sửa. | T10–T12 thực hiện và kiểm chứng. |
| O-05 — Task–milestone | **Đã đóng:** chỉ tạo milestone riêng. | T03/T17 triển khai cùng một record ở hai lịch. |
| O-06 — Ngoại lệ lặp | **Đã đóng hợp đồng:** D-24/D-25 và [T03](../tasks/t03/data-contract.md), ngày gốc/detach/suppression/stop/Undo nguyên tử. | T21–T23 thực hiện và kiểm chứng. |
| O-07 — Browser và sync khi đóng | **Đã đóng về mục tiêu:** Cốc Cốc; sync khi mở/mở lại. | Ghi phiên bản/hệ điều hành thực khi nghiệm thu. |
| O-08 — Palette/mục độc lập | **Đã chốt trong T02:** trung tính mặc định và chọn màu riêng cho mục độc lập; đã đồng ý bảng chín màu có sẵn, dấu chọn và xem trước qua bản thử v2. | T02 ghi bộ token; kiểm chứng toàn bộ trạng thái khi triển khai. |
| O-09 — Email delivery/domain | **Hoãn cùng deploy:** chọn SMTP/API, địa chỉ gửi, domain, hạn mức và thử inbox thật. | T29/T30/T32. |

Không đẩy các chi tiết thuật toán thuộc T03 thành câu hỏi lựa chọn cho người dùng. Người thực hiện phải đưa ra quy tắc xác định và kiểm chứng được, đúng hành vi đã chọn.

## 4. Những cách hiểu cần giữ đúng

- **Có tài khoản** thay thế quyết định chưa có tài khoản. Phạm vi dùng riêng vẫn giữ nguyên.
- **Kiến trúc B** không phải nền tối B. Bố cục lịch A vẫn giữ.
- Server độc lập khi PC tắt khác với yêu cầu sync khi đóng hẳn browser; chỉ yêu cầu thứ nhất và sync khi mở/mở lại.
- Milestone tạo riêng vẫn có thể thuộc kế hoạch; “riêng” không bắt buộc nó vô nhóm.
- LWW thay thế đề xuất giữ hai bản để chọn. Retry đến muộn không làm bản cũ thành mới.
- Task một lần đã tách vẫn giữ khi chuỗi cũ dừng; các lần còn thuộc chuỗi bị gỡ theo phạm vi dừng.

## 5. Xác nhận kết thúc T01

Người dùng đã duyệt [bản thiết kế T01](../tasks/t01/design.md), bao gồm các mặc định đã nêu, và yêu cầu đánh dấu T01 hoàn thành ngày **28/10/2026**. Trạng thái này được giữ nguyên.

## 6. Xác nhận kết thúc T02

Người dùng xác nhận **“được rồi chốt T02” ngày 28/10/2026**, duyệt [đặc tả T02 1.0](../tasks/t02/design.md) sau builder check và bản xem tổng hợp. Kế hoạch đã cập nhật T02 thành hoàn thành. T03 — hợp đồng dữ liệu/API và thuật toán — là bước tiếp theo, chưa bắt đầu trong lượt chốt; các task triển khai và deploy cũng chưa hoàn thành.

## 7. Kết thúc đặc tả T03

Ngày 28/10/2026, T03 khóa [hợp đồng 1.0](../tasks/t03/design.md) theo phạm vi kỹ thuật đã được giao, có JSON Schema/ví dụ, validator tài liệu và [rà soát độc lập](../tasks/t03/review-and-verification.md). T03 hoàn thành phần hợp đồng; T04–T36 chưa hoàn thành. Không tuyên bố người dùng đã duyệt riêng tài liệu T03 hoặc sản phẩm đã chạy/đạt AC. Các nguồn phê duyệt T01/T02 ở trên giữ đúng thời điểm lịch sử.
