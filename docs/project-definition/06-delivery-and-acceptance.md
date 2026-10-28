# DAYFORGE — lộ trình và tiêu chí nghiệm thu

Ngày cập nhật: **28/10/2026** · Trạng thái: **T01 và [T02 1.0](../tasks/t02/design.md) đã được duyệt, cả hai task hoàn thành; T03 chưa thực hiện, chưa xây code sản phẩm.** Có 38 tiêu chí nghiệm thu cho triển khai; kiểm tra prototype T02 không đồng nghĩa các tiêu chí sản phẩm đã đạt.

Danh sách công việc tổng thể được bổ sung tại [Kế hoạch task giai đoạn 1](../tasks/README.md), gồm 36 task từ chốt thiết kế đến deploy production và kiểm chứng sử dụng. Tài liệu hiện tại giữ vai trò bộ tiêu chí nghiệm thu.

## 1. Thứ tự đề xuất

| Mốc | Kết quả | Điều kiện chuyển tiếp |
| --- | --- | --- |
| M0 — Chốt thiết kế | T01/T02 đã duyệt; có đặc tả, bản xem chung và builder check. Stack Next.js server/Node + FastAPI + MySQL, email/xác minh/mật khẩu, offline/LWW và lặp giữ theo T01; thêm buổi/ghi chú dấu mốc theo T02. | Tiếp theo khóa hợp đồng dữ liệu/API/thuật toán trong T03. AWS/Oracle và gửi email chọn tại T29/T30. |
| M1 — Chứng minh nền offline/sync | Thử nghiệm hẹp: đăng nhập tài khoản đã xác minh, lưu cục bộ, mở lại offline, sửa hai thiết bị, chống gửi trùng và LWW tự động. | Kiểm chứng dữ liệu, phiên, cách ly owner và token/link qua hộp thư phát triển. Email production thực sự tới inbox phải đạt ở T30/T32, trước go-live. |
| M2 — Hai lịch dùng được với dữ liệu thật | Lịch tuần, lịch dấu mốc, kế hoạch và màu, thêm/sửa, kéo thả; dữ liệu đi qua lớp lưu cục bộ. | Các luồng chính dùng được và giữ dữ liệu qua reload. |
| M3 — Việc lặp và lịch sử | Lặp hằng ngày/theo thứ, ngoại lệ, hoàn thành, sửa quy tắc từ mốc và dừng chuỗi. | Sửa quy tắc tách các lần tương lai đã chỉnh riêng thành việc một lần cùng kế hoạch/màu; dừng gỡ các thành viên tương lai kể cả đã dời, giữ lịch sử trước mốc và các việc đã tách. |
| M4 — Bản dùng riêng hoàn chỉnh | Đồng bộ xuyên suốt các luồng, đăng nhập cùng tài khoản trên nhiều thiết bị, khôi phục lỗi, hoàn thiện motion/accessibility, backup/restore. | Đạt AC-01–AC-38 trên Cốc Cốc desktop; production chạy độc lập với PC cá nhân. |
| Sau đợt đầu | Trang ghi chú nhanh độc lập; thiết kế mobile app; desktop app. | Ghi chú ngay trong dấu mốc đã bổ sung ở T02 và thuộc đợt đầu; các phần còn lại bàn riêng phạm vi/thứ tự. |

Các mốc có thể được chia nhỏ khi lập kế hoạch. M1 là kiểm chứng kỹ thuật tiếp theo thiết kế đã duyệt; chưa thực hiện và chưa phải sản phẩm đã có sẵn.

Phạm vi đầu đã có tài khoản **email + xác minh email + mật khẩu riêng**, không đăng nhập Google và chưa mở đăng ký nhiều người dùng. Đăng nhập/session thay cho ghép thiết bị bằng mã. **Đã duyệt cùng thiết kế T01:** giới hạn email chủ sở hữu được đăng ký (owner-email allowlist), xác minh bằng link và gửi lại link, quên/đặt lại mật khẩu, ghi nhớ phiên, đăng nhập lần đầu/xác minh/reset cần online, cách ly local theo chủ sở hữu và giữ thay đổi chờ gửi khi phiên hết hạn. Đăng xuất khóa truy cập local, cảnh báo nếu còn pending và giữ pending đúng owner, không gửi dưới tài khoản khác. Chi tiết hash, cookie, token/TTL, đồng hồ lệch, phân xử khi cùng thời điểm và xóa–sửa LWW được chốt tại T03. Những case nghiệm thu tương ứng bên dưới kiểm chứng hành vi đã duyệt; chưa có kết quả chạy sản phẩm.

## 2. Bộ dữ liệu kiểm chứng đề xuất

- Kế hoạch “Ôn thi giữa kỳ”: hai việc ôn ABC/XYZ và một ngày thi cùng màu.
- Kế hoạch “Học tiếng Anh”: một việc lặp hằng ngày và một việc lặp thứ hai/thứ tư/thứ sáu.
- Kế hoạch “Báo cáo tiến độ”: các việc chuẩn bị và dấu mốc báo cáo.
- Một việc “Gửi hồ sơ” không thuộc kế hoạch.
- Một ngày trống, một ngày nhiều việc và một ngày có nhiều dấu mốc.
- Hai thiết bị đăng nhập cùng tài khoản email đã xác minh, có thể ngắt mạng độc lập; có inbox nhận được email xác minh và đặt lại mật khẩu thực tế.
- Tài khoản/owner kiểm thử thứ hai trong môi trường cô lập để kiểm chứng cách ly dữ liệu; đây không phải mở đăng ký nhiều người dùng cho sản phẩm.

Ngày cụ thể chọn tương đối theo thời điểm chạy kiểm chứng để không phụ thuộc ảnh mẫu tháng 10/2026.

## 3. Nghiệm thu sản phẩm và giao diện

| ID | Tình huống | Kết quả cần thấy | Liên quan |
| --- | --- | --- | --- |
| AC-01 | Mở lịch công việc ở một tuần có dữ liệu. | Đọc được công việc của cả bảy ngày theo sáng/chiều/tối mà không phải mở từng ngày. | FR-W01 |
| AC-02 | Thêm “Ôn ABC” từ vùng chiều thứ ba. | Ngày/buổi đã có sẵn; không yêu cầu giờ bắt đầu; lưu ra đúng vùng. | FR-W03, FR-E01–02 |
| AC-03 | Thêm việc độc lập. | Không cần tạo/chọn kế hoạch; không lỗi liên kết hoặc mất màu trung tính. | FR-P04 |
| AC-04 | Tạo kế hoạch khi đang nhập việc. | Quay lại vẫn còn tên, ngày, buổi và ước lượng đã nhập; kế hoạch mới được chọn. | FR-E04 |
| AC-05 | Kéo một việc sang ngày/buổi khác, rồi đổi thứ tự. | Vị trí và dữ liệu lưu đúng; không sinh giờ cụ thể; có cách sửa tương đương bằng bàn phím. | FR-W04–05 |
| AC-06 | Đánh dấu hoàn thành và xem một việc chưa xong ở ngày đã qua. | Cả hai giữ màu kế hoạch, dùng hai dấu kết quả phân biệt. | Trạng thái |
| AC-07 | Hủy/xóa một việc. | Thẻ biến mất; không xuất hiện như trạng thái chưa hoàn thành. | Trạng thái |
| AC-08 | Sửa tên/màu kế hoạch. | Công việc và dấu mốc liên quan đổi nhất quán, các kế hoạch khác giữ nguyên. | FR-P02, FR-P05 |
| AC-09 | Chuyển giữa hai lịch và đổi tuần/tháng/năm. | Không có header/sidebar cố định; widget mở/thu được; ngữ cảnh thời gian có thể nhận biết. | FR-M01, UX |
| AC-10 | Sửa một dấu mốc hiện trong cả hai lịch. | Tên/ngày/màu cập nhật ở cả hai; không có hai bản ghi lệch nhau. | FR-M03–04 |
| AC-11 | Tạo riêng ngày thi, rồi dời “Ôn ABC”. | Dấu mốc được tạo riêng, không chuyển từ công việc; ngày thi không dời theo công việc. Một dấu mốc hiện ở hai lịch vẫn là cùng bản ghi. | Quan hệ công việc–dấu mốc |
| AC-12 | Mở nhiều việc/dấu mốc trong một ngày. | Không chồng mất nội dung; có thể xem và thao tác tất cả, chữ không bị thu quá nhỏ. | UX |

## 4. Nghiệm thu việc lặp

| ID | Tình huống | Kết quả cần thấy |
| --- | --- | --- |
| AC-13 | Tạo hằng ngày hoặc chỉ các thứ đã chọn. | Chỉ đúng các ngày phát sinh, đúng buổi mặc định, không có mốc kết thúc tự ý. |
| AC-14 | Hoàn thành hoặc dời một lần lặp. | Chỉ lần đó thay đổi; không nhân đôi ở ngày gốc/ngày đích. |
| AC-15 | Dời một lần sang tuần khác rồi mở tuần đích. | Vẫn thấy lần đã dời dù ngày gốc ngoài khoảng đang xem. |
| AC-16 | Sửa quy tắc chuỗi từ một lần về sau khi đã chỉnh riêng một số lần tương lai. | Lịch sử trước mốc giữ nguyên; các lần tương lai đã chỉnh riêng được tách thành việc một lần, giữ kế hoạch/màu; các thành viên còn lại theo quy tắc mới, không sinh trùng. |
| AC-17 | Dừng chuỗi từ một mốc có lần tương lai đã dời và việc một lần đã tách; thử xóa riêng một lần. | Dừng gỡ mọi thành viên từ mốc trở đi kể cả ngoại lệ đã dời; giữ lịch sử trước mốc và các việc một lần đã tách. Xóa một lần không dừng cả chuỗi. |
| AC-18 | Qua nửa đêm rồi mở lại app. | Dấu chưa hoàn thành chỉ xuất hiện sau hết ngày dự định theo UTC+07:00; không tự dời việc, không phụ thuộc cron hoặc mạng. |

## 5. Nghiệm thu offline và đồng bộ

Kiến trúc đã chốt là Next.js server/Node + FastAPI + MySQL; phương án xuất tĩnh chỉ là lựa chọn đã cân nhắc. App phải xem/sửa offline sau lần tải hợp lệ; tự đồng bộ khi app đang mở hoặc mở lại, không yêu cầu chạy nền khi đã đóng hẳn. LWW tự giữ bản sửa mới nhất theo lúc chỉnh, không yêu cầu chọn conflict thủ công; hợp đồng timestamp, đồng hồ lệch, cùng thời điểm và xóa–sửa do T03 quy định.

| ID | Tình huống | Kết quả cần thấy |
| --- | --- | --- |
| AC-19 | Đã tải ứng dụng Next.js server và đăng nhập hợp lệ, ngắt mạng rồi mở lại cả hai route lịch. | Shell và dữ liệu local đã có vẫn xem/sửa được; không phụ thuộc phản hồi SSR mới và không chỉ mở trang fallback trắng. |
| AC-20 | Offline tạo/sửa/xóa/đổi buổi/hoàn thành, đóng và mở lại trang. | Các thay đổi còn nguyên trong local và outbox. |
| AC-21 | Có mạng trở lại khi app mở hoặc mở lại app sau khi đã đóng hẳn. | Tự đồng bộ khi app mở và phiên hợp lệ, không cần lưu lại từng việc; không đòi đồng bộ nền khi app đã đóng hẳn. |
| AC-22 | Máy chủ đã commit nhưng phản hồi bị mất; client gửi lại. | Operation không tạo tác dụng lần hai. |
| AC-23 | Sửa tiếp trong lúc một lần push đang chờ trả lời. | ACK không ghi đè mất bản sửa mới hơn. |
| AC-24 | Hai thiết bị offline sửa cùng một việc ở hai thời điểm rồi online theo thứ tự ngược lại. | LWW tự giữ bản sửa mới nhất theo lúc chỉnh, không theo thứ tự gửi/nhận; không xuất hiện bước chọn conflict thủ công. Kiểm tra đồng hồ lệch/cùng thời điểm theo hợp đồng T03. |
| AC-25 | Thiết bị A xóa, thiết bị B còn bản sửa offline; đổi thứ tự thời điểm chỉnh và thứ tự gửi. | Xóa–sửa áp dụng cùng hợp đồng LWW T03 một cách xác định, các thiết bị hội tụ và dấu xóa không bị bỏ qua bởi retry/bản cũ; không phải chọn thủ công. |
| AC-26 | Pull trúng đối tượng đang có outbox local. | So thời điểm chỉnh theo LWW: bản local mới hơn không bị bản remote cũ đè; bản remote mới hơn được nhận nhất quán, ACK không làm mất bản sửa phát sinh sau đó. |
| AC-27 | Nhiều tab, retry và hai giao dịch máy chủ ghi gần nhau. | Không mất operation, không bỏ sót change qua cursor hoặc báo đồng bộ sai. |
| AC-28 | Cập nhật service worker hoặc schema cục bộ. | Giữ dữ liệu chưa đồng bộ; không ép bỏ bản nhập chưa lưu. |
| AC-29 | Thiết bị lâu không online cần bootstrap lại. | Snapshot/cursor nhất quán và giữ được các sửa local chưa gửi. |
| AC-30 | Phiên đăng nhập hết hạn/bị thu hồi hoặc hết dung lượng local. | Báo đúng trạng thái và dừng thao tác máy chủ không được phép; không giả báo lưu/đồng bộ thành công. |
| AC-31 | Tạo tài khoản email/mật khẩu theo chính sách dùng riêng, nhận và dùng email xác minh. | Không có Google login hoặc ghép mã; email xác minh thực sự tới inbox và link hoàn tất đúng tài khoản; tài khoản chưa xác minh không được đồng bộ dữ liệu riêng. Allowlist/signup/link đã duyệt cùng T01. |
| AC-32 | Đăng nhập cùng tài khoản đã xác minh trên hai thiết bị; quên và đặt lại mật khẩu. | Hai thiết bị truy cập cùng dữ liệu bằng email/mật khẩu; email reset thực sự tới inbox, link hợp lệ đổi được mật khẩu và mật khẩu cũ không còn đăng nhập được. Reset đã duyệt cùng T01. |
| AC-33 | Mở lại app với phiên được ghi nhớ; để phiên hết hạn khi còn thay đổi offline. | Phiên còn hiệu lực dùng tiếp được; hết hạn yêu cầu đăng nhập lại, giữ dữ liệu/outbox chưa gửi và tiếp tục sync sau đăng nhập đúng owner. Ghi nhớ phiên/giữ pending đã duyệt cùng T01. |
| AC-34 | Đăng xuất khi còn bản nháp hoặc outbox chưa gửi, rồi đăng nhập lại. | Cảnh báo rõ phần chưa đồng bộ trước khi đăng xuất, khóa truy cập local; không báo đã backup/sync và không âm thầm xóa pending; đăng nhập lại đúng owner khôi phục được theo chính sách T03. Hành vi này đã duyệt cùng T01. |
| AC-35 | Dùng lần lượt hai owner kiểm thử trên cùng browser; mở route đăng nhập, link email/callback và route lịch qua HTTPS. | Owner sau không đọc được cache/IndexedDB/outbox/dữ liệu phiên của owner trước; cache shell offline không lưu chung nội dung riêng hoặc phản hồi auth. Auth route/callback HTTPS hoạt động và không bị service worker/cache phục vụ sai. Cách ly local đã duyệt cùng T01; chi tiết bảo vệ T03. |
| AC-36 | Tắt PC cá nhân và truy cập production từ thiết bị khác đã đăng nhập. | Next.js server, FastAPI, MySQL và luồng gửi email vẫn hoạt động trên host độc lập; xem/sửa/sync được. Host AWS hoặc Oracle và hệ thống gửi email được chọn, cấu hình và kiểm chứng tại T29/T30. |

### Bổ sung theo yêu cầu T02 ngày 28/10/2026

| ID | Tình huống | Kết quả cần đạt | Liên hệ |
| --- | --- | --- | --- |
| AC-37 | Tạo dấu mốc chỉ có ngày, sau đó chọn sáng/chiều/tối và bỏ lựa chọn buổi. | Có thể hiện cả ngày hoặc đúng buổi đã chọn, nhất quán ở hai lịch khi bật hiện trên lịch công việc; không cần giờ chính xác hoặc thời lượng. | FR-M07 |
| AC-38 | Nhập ghi chú nhiều dòng tiếng Việt trong dấu mốc, sửa/xóa nội dung offline, mở lại và đồng bộ sang thiết bị khác. | Ghi chú giữ đúng nội dung/xuống dòng, bản sửa được lưu/sync cùng dấu mốc theo hợp đồng LWW; không cần trang ghi chú độc lập. Nội dung được hiển thị như văn bản. | FR-M08 |

## 6. Chất lượng trước khi dùng hằng ngày

- Thử trên **Cốc Cốc desktop** ở các kích thước thực tế, gồm ít nhất một màn hình laptop và một màn hình lớn.
- Không dùng mạng để chặn việc mở form, kéo thả hoặc lưu cục bộ.
- Quan sát chuyển trang, kéo thả và mở form trên máy mục tiêu; không có animation nền liên tục gây giật.
- Có thể tạo, sửa, đổi lịch, hoàn thành và đổi trang bằng bàn phím; focus được quản lý đúng trong overlay.
- `prefers-reduced-motion` vẫn cho dùng đầy đủ chức năng.
- Kiểm tra lỗi ngày cuối tháng, chuyển năm, khoảng tuần bắc qua tháng/năm và thứ hai/chủ nhật.
- Thử lưu và đọc tiếng Việt có dấu trong tên việc, kế hoạch, dấu mốc.
- Kiểm chứng migration, backup và khôi phục MySQL trước khi nhập dữ liệu quan trọng.
- Chưa đo được trên máy mục tiêu thì không tuyên bố số FPS/thời gian đáp ứng như cam kết đã đạt.

## 7. Điều kiện kết thúc đợt đầu

Hai lịch và tài khoản email đã xác minh đáp ứng phạm vi đã duyệt; AC-01–AC-38 đạt trên môi trường đích, gồm buổi tùy chọn và ghi chú liên quan trong dấu mốc được bổ sung ở T02. Email thực sự được giao tới inbox, các thao tác chính giữ dữ liệu và đồng bộ theo LWW. Production chạy độc lập với PC cá nhân; backup/restore và rollback đã kiểm chứng. Mobile, desktop app và trang ghi chú nhanh độc lập không phải điều kiện hoàn thành đợt đầu.

Các bước lập trình, file cần sửa, lệnh chạy và trình tự kiểm thử chi tiết sẽ nằm trong kế hoạch triển khai riêng theo thiết kế T01 đã duyệt và kết quả T02/T03 sắp thực hiện.
