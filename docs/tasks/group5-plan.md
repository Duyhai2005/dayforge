# Kế hoạch chi tiết — Nhóm 5: Hoàn thiện việc lặp

Nhóm gồm T21–T23. T21 tạo và hiển thị chuỗi; T22 cung cấp thao tác theo phạm vi; T23 nghiệm thu tính nhất quán qua lưu trữ, retry và nhiều thiết bị. Mỗi task có nhánh và PR riêng vào `develop`; chỉ bắt đầu task sau khi PR trước đã merge để nhánh mới dựa trên đầu `develop` mới nhất.

## Trạng thái và thứ tự

| Task | Mục tiêu | Phụ thuộc | Trạng thái |
| --- | --- | --- | --- |
| T21 | Tạo quy tắc lặp và chiếu occurrence trong tuần đang xem | T03, T08, T10 | Hoàn tất; PR #21 đã merge và CI xanh |
| T22 | Sửa, dời, xóa, hoàn tác occurrence; sửa/dừng phần còn lại của chuỗi | T15, T19, T20, T21 | Đang triển khai trên `feature/recurring-series-actions`; kiểm tra local xanh, chờ PR/CI |
| T23 | Chứng minh hành vi lặp giống nhau qua hai thiết bị và MySQL | T11, T12, T22 | Chưa bắt đầu; dự kiến nhánh `feature/recurring-sync-acceptance` sau khi T22 merge |

## T21 — Quy tắc lặp và occurrence nhìn thấy được

### Các bước

- [x] Thêm lựa chọn lặp hằng ngày hoặc theo các thứ trong tuần; bắt đầu chuỗi từ ngày đầu phù hợp kể từ ngày người dùng chọn.
- [x] Cho phép bật lặp trên task hiện có, giữ nguyên occurrence đầu tiên, kể cả trạng thái hoàn thành; báo lỗi khi ngày đầu không khớp quy tắc.
- [x] Khai triển có giới hạn theo khoảng ngày đang xem, không tạo root riêng cho từng occurrence.
- [x] Chiếu occurrence đã dời ở ngày hiệu lực, việc đã tách như task một lần, và không hiển thị trùng hoặc hồi sinh occurrence đã xóa/tách.
- [x] Hiển thị dấu hiệu lặp và việc đã tách trên thẻ tuần.

### Nghiệm thu

- [x] Tuần bắt đầu giữa chuỗi, qua ranh giới tháng/năm, và thứ bắt đầu không khớp đều cho ngày occurrence chính xác.
- [x] Task đầu tiên đã hoàn thành vẫn giữ ngày, nội dung và trạng thái khi bật lặp.
- [x] Lần đã dời, occurrence gốc, occurrence đã xóa và task đã tách không tạo thẻ trùng.
- [x] Playwright, typecheck, lint và CI của PR #21 đều xanh.

## T22 — Thao tác với từng lần và cả chuỗi

### A. Thao tác một occurrence hoặc task đã tách

- [x] Dùng định danh mục tiêu ổn định gồm root/segment/ngày gốc (hoặc ID task đã tách); không suy ra mục tiêu chỉ từ ngày đang hiển thị.
- [x] Cho phép sửa nội dung/kế hoạch/màu, trạng thái, ngày/khung giờ và thứ tự của occurrence mà không đổi các occurrence anh em.
- [x] Cho phép xóa một occurrence hoặc task đã tách, hoàn tác đúng thao tác và giữ các mục còn lại của chuỗi.
- [x] Cho phép sửa task đã tách độc lập như task một lần.
- [x] Hỗ trợ kéo thả và phím thao tác để đổi ngày/khung giờ/thứ tự trong cùng bucket, gồm cả bucket có task thường, occurrence và task đã tách.

### B. Sửa quy tắc và mẫu từ ngày gốc

- [x] Cung cấp lựa chọn phạm vi “chỉ lần này” hoặc “quy tắc và mẫu từ ngày gốc”.
- [x] Khi sửa tương lai, cắt segment theo **ngày gốc** đã chọn; các occurrence trước mốc vẫn giữ lịch sử.
- [x] Từ mốc đó, cập nhật thứ lặp và mẫu công việc (tiêu đề, thời gian/khung giờ, kế hoạch, màu và nội dung liên quan).
- [x] Giữ ngoại lệ đã sửa như task một lần với dữ liệu và kế hoạch/màu hiện có; cho phép sửa ngoại lệ đó độc lập.
- [x] Hoàn tác thay đổi cấu trúc chuỗi theo một mutation nguyên tử.

### C. Dừng chuỗi từ ngày gốc

- [x] Xác nhận mốc dừng với người dùng và áp dụng theo ngày gốc, không theo ngày hiệu lực sau khi occurrence bị dời.
- [x] Gỡ các occurrence có ngày gốc từ mốc dừng trở đi, bao gồm occurrence đã dời sang ngày khác.
- [x] Giữ toàn bộ lịch sử trước mốc và giữ task đã tách khỏi chuỗi.
- [x] Cho phép hoàn tác dừng chuỗi mà không làm mất nội dung, thứ tự hoặc ngoại lệ.

### Nghiệm thu và cổng phát hành

- [x] Kiểm tra sửa/xóa/trạng thái/di chuyển một occurrence và hoàn tác, đồng thời xác nhận sibling không đổi.
- [x] Kiểm tra đổi quy tắc từ cutoff, giữ exception và plan/color, sửa task đã tách, dừng từ cutoff qua occurrence đã dời.
- [x] Kiểm tra thứ tự hỗn hợp trong bucket có nhiều loại thẻ.
- [x] Chạy typecheck, lint, `git diff --check` và các browser regression T22.
- [ ] Mở PR tiếng Anh vào `develop`, theo dõi CI, xử lý lỗi, rồi squash merge khi mọi job bắt buộc xanh.

## T23 — Nghiệm thu lưu trữ và đồng bộ lặp

### Thiết lập và luồng đồng thời

- [ ] Dùng hai browser context của cùng owner kết nối backend/MySQL kiểm thử thật, cùng một bộ dữ liệu chuỗi có occurrence thường, đã dời, đã tách và đã chỉnh.
- [ ] Chỉnh occurrence trên thiết bị A trong khi B đang mở; kiểm tra B nhận đúng projection sau pull/reconnect và không đổi nhầm sibling.
- [ ] Cho offline một thiết bị, thực hiện sửa/dời/tách/dừng, sau đó reconnect; thử retry byte-identical, response bị mất/trễ và cập nhật mới hơn ở thiết bị còn lại.
- [ ] Kiểm tra quy tắc LWW/intent cho cùng mục tiêu và các mutation cấu trúc chuỗi đến theo thứ tự khác nhau; xung đột phải được chấp nhận hoặc từ chối nguyên tử theo hợp đồng T12.

### Dữ liệu phải giữ đúng

- [ ] Việc đã tách tiếp tục là task một lần và giữ kế hoạch, màu, nội dung, trạng thái và thứ tự.
- [ ] Occurrence đã dời xuất hiện tại ngày hiệu lực; thao tác sửa quy tắc/dừng vẫn dựa trên ngày gốc.
- [ ] Lịch sử trước cutoff không đổi; occurrence sau cutoff bị gỡ đúng phạm vi; không có duplicate hoặc occurrence bị hồi sinh.
- [ ] Undo chuỗi là nguyên tử; nếu tham chiếu sống hoặc event mới làm inverse không còn an toàn, toàn mutation bị từ chối và dữ liệu không bị cập nhật một phần.
- [ ] Hai thiết bị hội tụ cùng projection/hash sau khi đồng bộ hoàn tất.

### Cổng hoàn tất nhóm

- [ ] Chạy suite T23 riêng trên MySQL và hai browser context; giữ log/job run để có thể tái lập.
- [ ] Chạy đầy đủ CI trên PR tiếng Anh của T23, sửa mọi failure và squash merge sau khi xanh.
- [ ] Cập nhật checklist nhóm 5 và báo cáo trạng thái với các giới hạn môi trường còn lại (nếu có).

## Kế hoạch nhánh/PR

| Task | Nhánh | PR base | Điều kiện hoàn tất |
| --- | --- | --- | --- |
| T21 | `feature/recurring-rules` | `develop` | PR #21 đã merge; CI và Offline web shell xanh |
| T22 | `feature/recurring-series-actions` | `develop` tại merge T21 | CI xanh, squash merge; sau đó tạo nhánh T23 từ `develop` mới |
| T23 | `feature/recurring-sync-acceptance` | `develop` tại merge T22 | Hai-browser/MySQL acceptance và CI xanh; squash merge |
