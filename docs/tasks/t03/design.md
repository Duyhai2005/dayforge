# DAYFORGE — T03: hợp đồng dữ liệu và API

Ngày: **28/10/2026** · Phiên bản: **1.0** · Trạng thái: **Đã khóa hợp đồng kỹ thuật — T03 hoàn thành phần đặc tả**.

T03 khóa hợp đồng để các task triển khai có cùng cách hiểu về dữ liệu, tài khoản, API và đồng bộ. Đây là đặc tả, chưa phải backend, frontend hoặc kết quả nghiệm thu sản phẩm.

## 1. Căn cứ và quyền quyết định

- Giữ nguyên phạm vi, kiến trúc và hành vi đã duyệt trong [T01](../t01/design.md) và [T02](../t02/design.md).
- T02 mục 13 và [sổ quyết định](../../project-definition/07-decisions-and-open-questions.md#3-các-quyết-định-còn-mở-và-nơi-xử-lý) giao thuật toán, schema, limits, phiên và đồng bộ cho T03; không yêu cầu người dùng chọn thuật toán.
- Các thông số kỹ thuật trong bộ hợp đồng này là lựa chọn của người thực hiện theo phạm vi đó. Không diễn giải chúng thành một lần phê duyệt riêng mà người dùng chưa thực hiện.
- Tuân thủ [coding convention](../../CONVENTION.md) và [Git Flow](../../GITFLOW.md). Công việc hiện ở `feature/project-design`, xuất phát từ `develop`. Không push trực tiếp vào `main` hoặc `develop`; tích hợp bằng PR theo Git Flow.

## 2. Bộ hợp đồng

| Tài liệu | Nguồn chuẩn cho |
| --- | --- |
| [Dữ liệu](data-contract.md) | Trường, giới hạn, màu, ngày/buổi, danh tính lần lặp và thuật toán thay đổi chuỗi. |
| [Tài khoản](auth-contract.md) | Password, owner, session, email token, CSRF, local vault và đăng xuất. |
| [Đồng bộ](sync-contract.md) | Operation bất biến, thứ tự LWW, replay, atomic group, receipt, cursor, bootstrap và ACK. |
| [HTTP API](api-contract.md) | Endpoint, status, lỗi, phân trang, tương thích và ví dụ trao đổi. |
| [Schema payload](contract.schema.json) | JSON Schema của các payload chuẩn và ví dụ kiểm tra. |
| [Ví dụ hợp đồng](contract-examples.json) | Payload hợp lệ và payload phải bị từ chối. |
| [Rà soát và kiểm chứng](review-and-verification.md) | Phạm vi đã kiểm tra ở T03 và những case phải chạy khi triển khai. |

Schema kiểm tra cấu trúc; các quy tắc ngữ nghĩa trong Markdown vẫn bắt buộc. Nếu schema và quy tắc mâu thuẫn, phải sửa bộ hợp đồng trước khi triển khai, không tự chọn một cách hiểu khác ở frontend/backend.

## 3. Những gì được khóa

1. API JSON dùng `snake_case`; DTO phía frontend chuyển sang biến/hàm `camelCase` theo convention. Tên file/thư mục mới dùng tiếng Anh, `kebab-case`; file Python dùng `snake_case` theo convention backend.
2. Ngày nghiệp vụ là ngày lịch, tách khỏi thời điểm UTC dùng đồng bộ. Một workspace UTC+07:00, tuần thứ hai–chủ nhật. Không tự thêm giờ bắt đầu/kết thúc.
3. Giới hạn tên việc/mốc 120, kế hoạch 100, note 4.000 code point; thời lượng `null` hoặc nguyên 1–1.440 phút. Không cắt dữ liệu âm thầm.
4. Owner được xác định từ phiên. Mọi operation mang owner assertion để server đối chiếu; assertion không cấp quyền. Local/outbox không được đi qua phiên của owner khác.
5. Task một lần và họ việc lặp có một root ổn định. Bật lặp không tạo một root mới rồi bỏ mất việc cũ. Danh tính lần lặp theo ngày gốc, không theo ngày sau khi dời.
6. Ghi lệnh bất biến, xử lý theo thứ tự thời điểm sửa đã ghi. Revision/cursor chỉ theo dõi việc server đã commit, không quyết định bản sửa nào mới hơn.
7. Lệnh đổi/dừng chuỗi tính phạm vi từ trạng thái replay chuẩn, thực hiện nguyên tử; không dùng danh sách ngoại lệ tính sẵn trên một thiết bị có thể đã cũ.
8. Mật khẩu riêng, xác minh email, phiên opaque cookie, local vault mã hóa; hết phiên vẫn được dùng local, đăng xuất chủ động mới khóa local. Không thêm Google, MFA, PIN local hoặc nhiều người dùng.
9. Toàn bộ mutation lịch đi qua cùng sync/business reducer; không có đường CRUD trực tiếp bỏ qua LWW, receipt hoặc cursor.
10. Không dọn event log, receipt hoặc tombstone ở giai đoạn đầu. Không thay semantics của lệnh cũ khi nâng reducer.

## 4. Phương án đã cân nhắc

| Phương án | Đánh đổi | Kết luận kỹ thuật |
| --- | --- | --- |
| Mỗi dòng tự LWW, thao tác chuỗi cập nhật nhiều dòng độc lập | Dễ viết CRUD nhưng có thể tách/dừng dở và cho kết quả khác nhau theo thứ tự nhận. | Loại. |
| Thay toàn bộ snapshot họ việc lặp bằng bản mới nhất | Atomic đơn giản nhưng sửa một lần từ snapshot cũ có thể khôi phục lịch đã dừng hoặc mất sửa ở lần khác. | Loại. |
| Nhật ký lệnh bất biến, replay theo thời điểm sửa và commit projection theo nhóm | Cần reducer xác định và giữ lịch sử; đổi lại giữ đúng phạm vi từng lệnh, kết quả không phụ thuộc thứ tự gửi lại. | Chọn. |

Đây là lựa chọn thuật toán của người thực hiện trong T03, không mở thêm một sản phẩm hoặc luồng UI mới. Đợt đầu ưu tiên cách làm dễ chứng minh đúng cho ứng dụng cá nhân; tối ưu replay/checkpoint chỉ được làm khi giữ nguyên kết quả chuẩn.

## 5. Hành vi cần hiểu rõ

- Một lệnh sửa mới hơn vào lần vẫn tồn tại thay bản của chính lần đó. Nó không thay mẫu của cả chuỗi.
- Nếu lần đã được tách, lệnh sau đó đi theo danh tính gốc đến việc đã tách. Nếu lần đã bị dừng và không có việc tách tương ứng, lệnh thành no-op `target_retired`; không khởi động lại chuỗi.
- Một lệnh cũ đến muộn được chèn về vị trí theo thời điểm sửa rồi replay. Vì vậy kết quả chẩn đoán ban đầu của một lệnh không phải cam kết nó luôn thắng về sau.
- Xóa task/mốc và sửa tham gia cùng thứ tự. Việc phục hồi, suppression của lần lặp và Undo được định nghĩa riêng trong hợp đồng, không dựa vào thời điểm request đến.
- Không thể biết chính xác thứ tự ngoài đời của hai thiết bị offline có đồng hồ sai. Hợp đồng giới hạn sai lệch hợp lệ, giữ dữ liệu khi có lỗi thời gian và không tự sửa timestamp để thắng.
- Giới hạn kích thước request/phân trang là giới hạn truyền dữ liệu, không phải giới hạn số thẻ hiển thị trong một buổi hoặc số lần lặp được sinh trước.

## 6. Ranh giới bàn giao

T04 chọn và khóa phiên bản thư viện/công cụ trong stack đã duyệt. T05–T13 dựng dữ liệu, tài khoản, event store, reducer, IndexedDB và đồng bộ. T14–T23 nối nghiệp vụ lịch/lặp; T25/T28 kiểm tra lỗi và nghiệm thu xuyên hệ thống. T29–T32 chọn hạ tầng, dịch vụ email và giao thư thật; T31/T35 kiểm tra backup, phục hồi và nâng cấp.

Các quyết định AWS/Oracle, domain, email provider, RAM/giá, lockfile và tối ưu hiệu năng không bị tự chốt trong T03. Chưa tạo scaffold, cài dependency sản phẩm, chạy migration, gửi email hoặc thao tác tài khoản thật.

T03 đã hoàn thành hợp đồng sau rà soát độc lập và kiểm tra schema/ví dụ; kết quả nằm trong [báo cáo](review-and-verification.md). Đây là chốt kỹ thuật theo quyền đã giao, không ghi nhận một lần người dùng duyệt riêng chưa có. Không dùng kết quả kiểm tra tài liệu để đánh dấu các AC sản phẩm đã đạt.
