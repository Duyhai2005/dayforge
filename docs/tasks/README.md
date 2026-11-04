# DAYFORGE — Phase 1 Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` when implementation is requested. Track tasks with the checkboxes below. This is a high-level task plan; expand only the task being implemented when more detail is needed.

**Goal:** Xây dựng web DAYFORGE giai đoạn đầu đủ tính năng, dùng ổn định trên máy tính, chỉnh sửa offline, tự đồng bộ và triển khai để dùng riêng.

**Architecture:** Đã chốt **phương án B: Next.js chạy server/Node + FastAPI + MySQL**, dữ liệu làm việc offline trong IndexedDB. Phương án A xuất tĩnh chỉ là lựa chọn đã cân nhắc. Tài khoản email đã xác minh + mật khẩu và session thay cho ghép thiết bị bằng mã; LWW tự giữ bản sửa mới nhất theo lúc chỉnh. Server chạy độc lập với PC cá nhân; chọn AWS hoặc Oracle và hệ thống gửi email ở T29/T30, không chặn T01.

**Tech Stack:** Đã chốt Python/FastAPI, React/Next.js và MySQL. TypeScript, Dexie, Workbox, Motion, dnd-kit, SQLAlchemy/Alembic cùng công cụ kiểm thử vẫn là đề xuất theo tài liệu kiến trúc.

**Spec:** [Thiết kế T01 đã duyệt](t01/design.md), [tổng quan hồ sơ](../project-definition/README.md), [yêu cầu chức năng](../project-definition/02-functional-requirements.md), [UX](../project-definition/03-ux-and-interactions.md), [kiến trúc](../project-definition/04-technical-architecture.md), [dữ liệu và đồng bộ](../project-definition/05-data-and-sync.md), [nghiệm thu](../project-definition/06-delivery-and-acceptance.md).

Ngày cập nhật: **04/11/2026** · Trạng thái: **T01–T03 hoàn thành thiết kế/hợp đồng; T04–T09 hoàn thành nền theo các báo cáo kiểm chứng liên kết bên dưới. T10–T13 đã có lõi sync server/client, reducer và offline shell; còn kiểm chứng lại sau khi tích hợp với nền `develop`, nghiệm thu UX lịch và môi trường đích. T14–T27 đã merge PR #14–#27 sau khi CI xanh. T28 có ma trận 35 PASS/3 TARGET_PENDING và PR #28 đã qua cả hai workflow CI. T29–T36 còn lại; email tới inbox production thuộc T30/T32.**

## 1. Cách dùng kế hoạch

Tài liệu riêng của từng task đặt trong `docs/tasks/tXX/`. Hồ sơ hiện có: [T01 — Thiết kế đã duyệt](t01/design.md), [T02 — UI và tương tác đã duyệt](t02/design.md), [T03 — Hợp đồng dữ liệu 1.0, API/sync 1.1](t03/design.md). Các task tiếp theo dùng cùng quy ước khi có tài liệu.

- Có **36 task**, chia thành **8 nhóm**, đi từ dự án hiện chỉ có tài liệu đến bản production được kiểm chứng.
- Mỗi task chỉ mô tả ngắn đầu việc; không liệt kê file code, chữ ký hàm hoặc lệnh thực hiện ở giai đoạn này, theo yêu cầu người dùng.
- Mỗi task lập trình bao gồm kiểm chứng hành vi mình tạo ra và cập nhật tài liệu chịu ảnh hưởng. T28 là kiểm thử tích hợp/nghiệm thu, không thay cho việc kiểm tra từng task.
- Đánh dấu xong khi có kết quả chạy/kiểm chứng được, không chỉ khi viết xong code.
- Người dùng đã duyệt [Thiết kế T01](t01/design.md) và [Đặc tả T02 1.0](t02/design.md). [T03](t03/design.md) khóa hợp đồng dữ liệu/API và thuật toán theo quyền chọn kỹ thuật đã giao trong T01/T02; có rà soát và kiểm chứng schema, không diễn giải thành một lần phê duyệt riêng của người dùng. T01–T03 hoàn thành về thiết kế/hợp đồng. T04 hoàn thành bộ khung và hướng dẫn local; T06 hoàn thành shell lịch/widget; T08 hoàn thành lưu trữ cục bộ mã hóa; T09 hoàn thành tài khoản, session và lifecycle mở/khóa vault local. Đồng bộ dữ liệu và cache offline vẫn thuộc các task sau; xem các báo cáo T06, T08 và T09.

## 2. Ràng buộc chung

- Dùng riêng một người trên desktop; tài khoản **email + xác minh email + mật khẩu riêng** thuộc phạm vi đầu, không Google login, chưa mở nhiều người dùng. Trang ghi chú nhanh độc lập, mobile app và desktop app hoãn; buổi tùy chọn và ghi chú trong dấu mốc được bổ sung ở T02, thuộc đợt đầu.
- Hai trang lịch: công việc và dấu mốc. Toàn cảnh tuần đọc được công việc ngay, theo sáng/chiều/tối; không bắt nhập giờ bắt đầu chính xác.
- Công việc được phép độc lập. Các mục cùng kế hoạch cùng màu; hoàn thành/chưa hoàn thành giữ màu gốc; hủy thì gỡ khỏi lịch.
- Dấu mốc tạo riêng, không chuyển công việc thành dấu mốc; cùng bản ghi được hiển thị ở hai lịch. Việc lặp hằng ngày/theo thứ tiếp tục đến khi dừng; sửa quy tắc từ mốc tách các lần tương lai đã chỉnh riêng thành việc một lần cùng kế hoạch/màu, giữ lịch sử. Dừng từ mốc gỡ thành viên tương lai kể cả ngoại lệ đã dời, giữ lịch sử trước mốc và việc đã tách.
- Không header/sidebar cố định; nền tối, bố cục thoáng, công cụ widget, animation mượt và có chế độ giảm chuyển động.
- Xem và các thao tác ghi chính phải dùng được offline, tồn tại qua tải lại trang; tự đồng bộ khi app mở/mở lại, không yêu cầu chạy nền khi đóng hẳn. LWW theo lúc chỉnh tự hội tụ, không chọn conflict thủ công; chỉ báo lưu/đồng bộ đúng trạng thái thực.
- **Đã duyệt cùng T01:** owner-email allowlist/signup, link xác minh, quên/đặt lại mật khẩu, ghi nhớ phiên, cách ly local theo owner, giữ pending khi hết phiên và cảnh báo đăng xuất. Hash/cookie/token TTL, clock skew, tie-break và xóa–sửa được khóa trong [T03](t03/design.md).
- Server phải chạy độc lập với PC cá nhân. AWS hoặc Oracle, tài nguyên sẵn có và hệ thống gửi email được chọn tại T29/T30; không tự mua hạ tầng. Email xác minh/reset phải tới inbox thực tế, không chỉ có log hoặc email giả lập.

## 3. Vùng trách nhiệm dự kiến

| Vùng | Trách nhiệm |
| --- | --- |
| `frontend/` | Hai lịch, widget, biểu mẫu, nghiệp vụ client, lưu cục bộ, đồng bộ và cache offline. |
| `backend/` | FastAPI, nghiệp vụ máy chủ, MySQL/migration, tài khoản/xác minh email/mật khẩu/session và API đồng bộ. |
| `deploy/` | Cấu hình chạy production, reverse proxy, phát hành, sao lưu và phục hồi. |
| `docs/` | Thiết kế đã chốt, kế hoạch, hướng dẫn chạy/deploy/vận hành và kết quả nghiệm thu. |

Đây là ranh giới dự kiến, chưa phải thư mục code đã tồn tại. T04 chốt cấu trúc thực tế; không cần biến một ứng dụng cá nhân thành nhiều dịch vụ độc lập.

## 4. Các tình huống cần chú ý xuyên suốt

1. **Đồng bộ trễ hoặc gửi lại:** phản hồi cũ không đè bản sửa mới; retry không tạo bản trùng — kiểm chứng ở T10–T12 và T28.
2. **Lần lặp đã dời/đã chỉnh ngoại lệ:** vẫn thấy ở tuần đích; sửa quy tắc từ mốc tách ngoại lệ tương lai thành việc một lần, dừng gỡ thành viên tương lai kể cả đã dời và giữ việc đã tách — T21–T23.
3. **Nâng cấp khi còn dữ liệu offline:** đổi service worker, schema hoặc phiên bản API không làm mất outbox/bản nhập — T13 và T33.
4. **Tài khoản/phiên và cache riêng:** email được giao thực, hết phiên/đăng xuất giữ pending theo chính sách, dữ liệu local không lẫn owner; báo lỗi đúng khi không lưu được — T09, T13, T25 và T28.
5. **Ranh giới ngày và mật độ lớn:** đúng khi qua nửa đêm/cuối tháng/chuyển năm; ngày nhiều việc vẫn đọc và thao tác được — T16, T18, T20, T27 và T28.

## 5. Danh sách task

### Nhóm 1 — Chốt nền thiết kế · T01–T03

- [x] **T01 — Duyệt thiết kế tổng hợp.** Người dùng đã duyệt [thiết kế T01](t01/design.md) cùng các mặc định được nêu và yêu cầu đánh dấu hoàn thành ngày **28/10/2026**. Kiến trúc B, tài khoản, LWW và quy tắc dấu mốc/lặp đã chốt; host/email provider để T29/T30.
- [x] **T02 — Chốt giao diện để triển khai.** Người dùng đã duyệt [đặc tả tổng hợp 1.0](t02/design.md) bằng xác nhận “được rồi chốt T02” ngày 28/10/2026. Có [bản xem chung](t02/prototypes/t02-consolidated-preview-v3.html) và [rà soát/kiểm tra](t02/review-and-verification.md); chỉ hoàn thành thiết kế, chưa nghiệm thu sản phẩm.
- [x] **T03 — Chốt hợp đồng dữ liệu, tài khoản và API.** Hoàn thành [hợp đồng 1.0](t03/design.md) ngày **28/10/2026**, API/sync được cập nhật lên 1.1 trước phát hành để biểu diễn receipt `not_evaluated`: ngày/buổi/limits/ID, recurrence và Undo, typed command replay theo edit-time, clock repair, receipt/cursor/bootstrap/ACK, auth/session/local vault, HTTP và tương thích. Có JSON Schema, fixture và [rà soát/kiểm chứng](t03/review-and-verification.md). Đây là hoàn thành đặc tả kỹ thuật, chưa phải code hoặc nghiệm thu sản phẩm.

**Kết quả nhóm:** thiết kế đủ rõ để triển khai, không còn lựa chọn nghiệp vụ hoặc kiến trúc quan trọng bị bỏ cho người lập trình tự đoán. T02 và T03 có thể làm song song sau T01.

### Nhóm 2 — Dựng nền dự án · T04–T07

- [x] **T04 — Tổ chức dự án và môi trường phát triển.** Hoàn thành ngày **29/10/2026**: cấu trúc frontend/backend, runtime/dependency/image pins, cấu hình mẫu không chứa secrets, HTTPS cùng-origin và hướng dẫn tái lập trên Windows. Xem [kế hoạch và checklist](t04/plan.md), [runbook](../development.md) và [báo cáo kiểm chứng](t04/review-and-verification.md).
- [x] **T05 — Dựng FastAPI và MySQL.** Hoàn thành kết nối, schema/migration ban đầu, validation, xử lý lỗi, health/version và log; nghiệm thu MySQL, HTTPS trên DB cô lập và final review đã đạt. Xem [kế hoạch chi tiết](t05/plan.md), [runbook](../development.md) và [báo cáo kiểm chứng/giới hạn](t05/review-and-verification.md). Khả năng tương thích với volume DB dev và browser trust vẫn chưa xác minh.
- [x] **T06 — Dựng khung Next.js server.** Hoàn thành shell ngày **29/10/2026**: hai route lịch, widget, URL/history và sở thích riêng từng lịch, route tài khoản/callback trung tính; không có dữ liệu riêng trong shell. Browser suite dev/production, build và kiểm tra môi trường đạt; HTTPS same-origin smoke chưa chạy trong checkout T06 do thiếu cấu hình local/API. Xem [kế hoạch](t06/plan.md) và [kiểm chứng, giới hạn, bàn giao](t06/review-and-verification.md).
- [x] **T07 — Thiết lập kiểm tra tự động.** Hoàn thành ngày **31/10/2026**: lint (ESLint, Ruff), format check (Black), typecheck (TypeScript strict, mypy), test runners chuẩn hóa, MySQL runner cô lập không phụ thuộc .env, production Playwright runner kiểm tra nghiêm ngặt callback headers và GitHub Actions CI. Xem [kế hoạch chi tiết](t07/plan.md) và [báo cáo kiểm chứng](t07/review-and-verification.md).

**Kết quả nhóm:** chạy được bộ khung frontend/backend và cơ sở dữ liệu từ hướng dẫn; các kiểm tra nền chạy được. T05 và T06 có thể làm song song sau T04.

### Nhóm 3 — Làm nền offline và đồng bộ · T08–T13

- [x] **T08 — Lưu dữ liệu cục bộ bền vững.** Hoàn thành ngày **31/10/2026**: dựng IndexedDB native adapter, mã hóa AES-256-GCM với AAD theo owner, migration có versioning bảo toàn zero-deletion, unit of work commit nguyên tử (outbox + overlays + sequence + clock), và xử lý lỗi quota/blocked/unavailable. Đạt 20/20 kịch bản kiểm thử ST-01 đến ST-20 và 89 tests Playwright. Xem [kế hoạch chi tiết](t08/plan.md) và [báo cáo kiểm chứng](t08/review-and-verification.md).
- [x] **T09 — Làm tài khoản và phiên đăng nhập.** Hoàn thành ngày **01/11/2026**: account email/mật khẩu một owner, xác minh/reset, session có CSRF/Origin protection, Mailpit SMTP adapter, login/remember, local-key gate và local logout liên tab/offline giữ nguyên dữ liệu mã hóa. Chạy 60 kiểm thử MySQL, 132 browser tests, production callback/auth 14 tests và build thành công; Mailpit delivery/link đã smoke-test. Email tới inbox thật vẫn thuộc T30/T32. Xem [plan](t09/plan.md), [runbook](../development.md) và [báo cáo kiểm chứng](t09/review-and-verification.md).
- [ ] **T10 — Xây API đồng bộ phía máy chủ.** Có clock, push idempotent, bootstrap/pull theo watermark và lưu event/receipt/cursor nguyên tử. Lõi API đã tích hợp reducer ở T12 để ghi outcome thật cùng receipt. Xem [kế hoạch](t10/plan.md), [tài liệu API/server](t10/sync-api.md) và [báo cáo kiểm chứng/handoff](t10/review-and-verification.md); cần chạy lại bộ MySQL sau rebase.
- [ ] **T11 — Xây bộ đồng bộ phía client.** Đã có coordinator theo owner, retry byte-identical, pull/bootstrap theo trang, ACK tách khỏi pull, leader lease/fencing, reconnect, clock repair, epoch recovery và multi-tab takeover. Runner Chromium hai device lane/MySQL đã bao phủ offline reconnect, stale/lost response, quota IndexedDB, process death và suspend; sau khi gộp với T10 trên `develop`, cần chạy lại integration runner. Chưa có biểu mẫu nghiệp vụ lịch; UX lưu nội dung thuộc T14–T23. Xem [plan](t11/plan.md) và [trạng thái](t11/implementation-status.md).
- [ ] **T12 — Làm LWW và khôi phục đồng bộ.** Đã có reducer v1 ở Python/TypeScript, parity trên fixture 18 action và 1.724 arrival permutations; server tính `applied`/`superseded`/`no_op` trong transaction tạo receipt. Clock calibration/reauthor và epoch recovery giữ union operation đã ACK. Còn chạy lại MySQL/browser runner sau khi bỏ persistence T10 trùng lặp; chưa diễn tập lệch giờ OS trên hai máy vật lý và quota ngay tại generation publish. Xem [plan](t12/plan.md), [trạng thái](t12/implementation-status.md) và [runbook](t12/recovery-runbook.md).
- [ ] **T13 — Làm cache offline cho Next.js server.** Đã có production service worker cho shell hai lịch, asset cache theo build, network-only cho auth/API/callback, build gate, schema resume và giữ pending/draft khi update. Offline browser suite và quota thật đã chạy trên Chromium trước khi rebase; cần chạy lại sau khi gộp provider tài khoản với provider sync. Chưa nghiệm thu trên browser/OS đích; UI thao tác lịch vẫn thuộc T14–T23. Xem [plan](t13/plan.md), [trạng thái](t13/implementation-status.md) và [runbook update](t13/offline-update-runbook.md).

**Kết quả nhóm khi nghiệm thu T08–T13:** đăng nhập cùng tài khoản đã xác minh trên hai thiết bị, sửa offline → reload → có mạng → thiết bị khác nhận đúng; retry không sinh trùng, LWW giữ bản chỉnh mới nhất. Lõi đa thiết bị/offline đã có kiểm chứng ở runner; re-run sau tích hợp rebase và UX biểu mẫu lịch vẫn còn. T09 đã kiểm chứng token/link qua hộp thư phát triển và cách ly owner; email production tới inbox được nghiệm thu sau ở T30/T32.

**Phụ thuộc chính:** T08 cần T03/T06; T09 cần T03/T05/T06 và email adapter/hộp thư phát triển, không phụ thuộc lựa chọn nhà cung cấp production ở T29/T30; T10 cần T03/T05/T09; T11 cần T08/T10; T12 cần T11; T13 cần T06/T08/T09 và được kiểm chứng cùng T11.

### Nhóm 4 — Hoàn thiện hai lịch và công việc · T14–T20

- [x] **T14 — Làm kế hoạch và màu.** Tạo/sửa tên, chọn màu nhanh, cập nhật màu dùng chung; hỗ trợ việc/dấu mốc độc lập theo thiết kế đã chốt. [Báo cáo kiểm chứng](t14/review-and-verification.md); PR #14 đã merge sau khi CI xanh.
- [x] **T15 — Làm thêm/sửa công việc nhanh.** Biểu mẫu nổi điền sẵn ngày/buổi, nhập thời lượng và kế hoạch; tạo kế hoạch trong luồng vẫn giữ bản nháp. PR #15 đã merge sau khi CI xanh; xem [báo cáo kiểm chứng](t15/review-and-verification.md).
- [x] **T16 — Làm lịch công việc tuần với dữ liệu thật.** Hiện đủ công việc theo ngày và ba buổi, điều hướng tuần/hôm nay; xử lý ngày trống, ngày đông và tuần bắc qua tháng/năm. PR #16 đã merge sau khi CI xanh; xem [báo cáo kiểm chứng](t16/review-and-verification.md).
- [x] **T17 — Làm thêm/sửa/xóa dấu mốc.** Tạo riêng với ngày, buổi tùy chọn, ghi chú liên quan, kế hoạch/màu và lựa chọn hiện trên lịch công việc; không chuyển từ task, cả hai lịch đọc cùng bản ghi; lưu offline và đồng bộ đầy đủ các trường. PR #17 đã merge sau khi CI xanh; xem [báo cáo kiểm chứng](t17/review-and-verification.md).
- [x] **T18 — Làm lịch dấu mốc tuần/tháng/năm.** Điều hướng các năm, thể hiện dấu mốc cả ngày hoặc theo buổi, xem ngày nhiều dấu mốc và mở tuần công việc liên quan mà vẫn giữ ngữ cảnh; mở được ghi chú liên quan. PR #18 đã merge sau khi CI xanh; xem [báo cáo kiểm chứng](t18/review-and-verification.md).
- [x] **T19 — Làm kéo thả và đổi thứ tự.** Đổi ngày/buổi/thứ tự, có vùng thả rõ, hủy kéo sai, hoàn tác và cách đổi lịch tương đương bằng form/bàn phím. PR #19 đã merge sau khi CI và Offline web shell xanh; xem [báo cáo kiểm chứng](t19/review-and-verification.md).
- [x] **T20 — Làm trạng thái và gỡ công việc.** Hoàn thành/bỏ hoàn thành, đánh dấu chưa xong đúng theo ngày UTC+07:00 và tự cập nhật qua nửa đêm, giữ màu kế hoạch; xóa và hoàn tác qua mutation sync, tồn tại offline và sau khi tải lại. PR #20 đã qua CI; xem [báo cáo kiểm chứng](t20/review-and-verification.md).

**Kết quả nhóm:** hai lịch dùng được với công việc một lần, kế hoạch và dấu mốc; toàn bộ thao tác ghi đi qua nền offline/sync. T17 cần T14/T16; T18 cần T17; T19 và T20 có thể làm song song sau T15/T16.

### Nhóm 5 — Hoàn thiện việc lặp · T21–T23

Kế hoạch triển khai, phụ thuộc và tiêu chí nghiệm thu chi tiết: [kế hoạch nhóm 5](group5-plan.md).

- [x] **T21 — Làm quy tắc lặp và ngoại lệ.** Tạo lặp hằng ngày/theo thứ hoặc bật lặp cho task đang có; khai triển theo tuần đang xem, giữ task đầu tiên (kể cả trạng thái hoàn thành), hiển thị lần đã dời/việc đã tách mà không trùng bản gốc. PR #21 đã qua CI và Offline web shell; xem [báo cáo kiểm chứng](t21/implementation-status.md).
- [x] **T22 — Làm thao tác với từng lần và cả chuỗi.** Nối các thao tác từng lần; sửa quy tắc từ mốc tách ngoại lệ tương lai thành việc một lần cùng kế hoạch/màu; dừng gỡ thành viên tương lai kể cả đã dời, giữ lịch sử trước mốc và việc đã tách. PR #22 đã qua CI và Offline web shell rồi squash-merge; xem [kế hoạch nhóm](group5-plan.md#t22--thao-tác-với-từng-lần-và-cả-chuỗi) và [báo cáo trạng thái](t22/implementation-status.md).
- [x] **T23 — Kiểm chứng lặp qua lưu trữ và đồng bộ.** Đã kiểm tra occurrence edits, offline/reconnect, retry/LWW, detached exception, stop/undo và hash hội tụ qua hai browser cùng MySQL. PR #23 đã qua CI và Offline web shell; xem [kế hoạch nhóm](group5-plan.md#t23--nghiệm-thu-lưu-trữ-và-đồng-bộ-lặp) và [báo cáo trạng thái](t23/implementation-status.md).

**Kết quả nhóm:** dùng được lịch học lặp thực tế, điều chỉnh từng hôm không làm đổi nhầm lịch các hôm khác. T21 cần T03/T08/T10; T22 cần T15/T19/T20/T21; T23 cần T11/T12/T22.

### Nhóm 6 — Làm web đủ ổn để dùng hằng ngày · T24–T28

- [x] **T24 — Hoàn thiện chất lượng thị giác và chuyển động.** Hoàn thành và merge PR #24 sau CI xanh; xem [báo cáo kiểm chứng](t24/review-and-verification.md).
- [x] **T25 — Hoàn thiện trạng thái lỗi, tài khoản và sync.** Hoàn thành và merge PR #25 sau CI xanh; trạng thái sync, Retry-After, phiên hết hạn, pending theo owner và logout khi form bẩn đã được kiểm tra trên PR.
- [x] **T26 — Hoàn thiện khả năng thao tác.** Hoàn thành và merge PR #26 sau CI xanh; xem [báo cáo kiểm chứng](t26/review-and-verification.md).
- [x] **T27 — Tối ưu hiệu năng desktop.** Hoàn thành và merge PR #27 sau CI xanh; xem [kết quả benchmark](t27/performance-results.md).
- [x] **T28 — Kiểm thử tích hợp, nghiệm thu và sửa lỗi.** Ma trận [AC-01–AC-38](t28/acceptance-results.md) có 35 PASS và 3 TARGET_PENDING (AC-31/32 inbox thật tại T32; AC-36 host độc lập tại T32/T36). PR #28 đã qua cả hai workflow CI.

**Kết quả nhóm:** T24–T27 đã merge qua CI; T28 đã hoàn tất ma trận, và PR #28 đã qua cả hai workflow. AC-31/32 vẫn cần inbox thật và AC-36 cần host độc lập ở T32/T36; chưa coi các case đó đã đạt, và Group 6 chưa phải xác nhận production. T24/T25 cần các luồng tính năng hoàn chỉnh; T26/T27 có thể chạy song song sau đó; T28 chốt đối chiếu trước deploy.

### Nhóm 7 — Chuẩn bị và diễn tập deploy · T29–T33

Kế hoạch chi tiết ngày **04/11/2026**: [plan tổng nhóm 7](../superpowers/plans/2026-11-04-group7-deployment-rehearsal.md), gồm phụ thuộc, hợp đồng artifact/config, lựa chọn hạ tầng cần chốt và các cổng kiểm chứng. PR #29 hoàn tất package code và CI smoke; T29 vẫn mở vì chưa chọn target/nguồn ngân sách và chưa đo sizing. T30 đã bổ sung code/runbook cho bootstrap, deploy sequencing, health, smoke và SMTP probe; [báo cáo](t30/infrastructure-results.md) ghi riêng kiểm thử cục bộ và các cổng host/DNS/inbox còn mở. T31–T33 chưa nghiệm thu.

- [ ] **T29 — Chọn phương án deploy và đóng gói production.** Package code và smoke CI đã qua PR #29; còn thiếu target cloud, registry, SMTP, budget/domain/inbox và số đo sizing nên T29 chưa được ký nghiệm thu. [Kế hoạch chi tiết](t29/plan.md), [decision record](t29/deployment-decision.md), [kiểm chứng và giới hạn](t29/review-and-verification.md).
- [ ] **T30 — Chuẩn bị hạ tầng chạy độc lập.** Đã chuẩn bị code/runbook cho bootstrap Debian/Ubuntu, mạng ingress tách biệt, quyền DB, deploy/migration có maintenance gate, health/restart, HTTP smoke và owner-only SMTP probe. Chưa có host, budget, domain/DNS, SMTP account hay inbox để chạy nghiệm thu staging thật; xem [kế hoạch](t30/plan.md) và [báo cáo](t30/infrastructure-results.md).
- [ ] **T31 — Thiết lập sao lưu và thử khôi phục.** Có backup MySQL tự động, nơi giữ/thời hạn giữ rõ; restore vào DB sạch và kiểm tra dữ liệu bằng app, không coi outbox chưa gửi là đã được backup. [Kế hoạch chi tiết](t31/plan.md).
- [ ] **T32 — Deploy thử bản ứng viên.** Staging cô lập DB/secrets/origin; kiểm tra route/HTTPS/API, đăng nhập tài khoản đã xác minh trên hai thiết bị, email thực, callback/cache owner, offline và dịch vụ khi PC tắt. [Kế hoạch chi tiết](t32/plan.md), [ma trận acceptance](t32/acceptance-results.md) và [kịch bản thủ công](t32/manual-scenarios.md).
- [ ] **T33 — Diễn tập nâng cấp và rollback.** Thử migration MySQL/IndexedDB, client/API cũ–mới và cập nhật service worker khi còn outbox; rollback phải tương thích dữ liệu, không mặc định restore backup cũ. [Kế hoạch chi tiết](t33/plan.md).

**Kết quả nhóm:** phát hành và khôi phục được bằng quy trình đã chạy thử; không chỉ build thành công trên máy phát triển. T29 có thể chuẩn bị sớm sau T07/T13; host và email production được chọn tại T29/T30, không chặn duyệt T01. T31 cần T05/T30; T32 cần T28/T29/T30; T33 cần T31/T32.

Staging có thể cùng host với production để giảm vận hành, nhưng phải tách dữ liệu/quyền và dùng origin riêng để không đụng cache hay IndexedDB của bản dùng thật.

### Nhóm 8 — Bàn giao, production và dùng thực tế · T34–T36

- [ ] **T34 — Hoàn thành hướng dẫn và checklist phát hành.** Ghi cài/chạy/deploy, tài khoản/xác minh/reset/session, chẩn đoán lỗi và backup/restore/rollback; đối chiếu kết quả AC-01–AC-38, chốt checklist sẵn sàng deploy.
- [ ] **T35 — Deploy production.** Backup trước thay đổi nếu có dữ liệu, migration và phát hành bản đã nghiệm thu; kiểm tra HTTPS/API/DB, đăng nhập tài khoản đã xác minh, email inbox/callback và cách ly cache dùng thật.
- [ ] **T36 — Kiểm chứng sau deploy và bàn giao sử dụng.** Hai thiết bị đăng nhập thật kiểm tra việc/lặp/màu, offline→sync và các case AC-01–AC-38 trên môi trường đích; thử PC tắt, email inbox, restart/log/backup, sửa lỗi chặn sử dụng.

**Kết quả nhóm:** DAYFORGE chạy ở địa chỉ thật, dữ liệu riêng được bảo vệ, các luồng dùng hằng ngày và vận hành đã được kiểm chứng. T34 cần T31/T33; T35 cần T28/T33/T34; T36 cần T35.

## 6. Hai mốc hoàn thành cần phân biệt

| Mốc | Điều kiện |
| --- | --- |
| **Sẵn sàng deploy để dùng** | Xong T01–T34: bản ứng viên đạt nghiệm thu trên staging, có đối chiếu AC-01–AC-38, artifact/config, môi trường đích, email giao thực, backup/restore và nâng cấp/rollback đã thử. |
| **Đã triển khai và dùng được** | Xong thêm T35–T36: production hoạt động, thiết bị thật truy cập được và kiểm chứng sau deploy đạt. |

Chỉ xong giao diện hoặc chạy `build` thành công chưa đạt một trong hai mốc này. Các bước production trong tài liệu là công việc cần làm khi triển khai, không phải tuyên bố đã deploy trong lần lập kế hoạch này.

## 7. Đối chiếu phạm vi để tránh bỏ việc

| Phần cần có | Task chịu trách nhiệm chính |
| --- | --- |
| Thiết kế tổng hợp, UI và hợp đồng kỹ thuật đã khóa | T01–T03 hoàn thành; T04–T06 đã dựng nền; tiếp tục T07 |
| FastAPI, Next.js, MySQL và môi trường chạy | T04–T07, T29–T30 |
| Kế hoạch, màu, công việc độc lập và nhập nhanh | T14–T15 |
| Lịch công việc sáng/chiều/tối | T16, T19–T20 |
| Dấu mốc tuần/tháng/năm và cùng dữ liệu ở hai lịch | T17–T18 |
| Lặp, ngoại lệ, sửa phạm vi, dừng và lịch sử | T21–T23 |
| Tài khoản email/xác minh/mật khẩu/session, email giao thực và cách ly owner | T03, T09, T13, T25, T28–T30, T32, T35–T36 |
| Lưu offline, tự sync khi mở/mở lại và LWW theo lúc chỉnh | T08–T13, T23, T25 |
| UX, animation, bàn phím, màn hình desktop và hiệu năng | T02, T24–T27 |
| AC-01–AC-38 và bảo vệ truy cập | T28 lập đối chiếu; kiểm chứng môi trường thật ở T32/T36 |
| Build, cấu hình, migration, cache upgrade và secrets | T07, T13, T29–T30, T33 |
| Backup/restore, rollback, health/log và hướng dẫn vận hành | T30–T34 |
| Production và dùng thử thực tế | T35–T36 |

Sau khi duyệt danh sách này, có thể triển khai theo từng task hoặc mở rộng riêng task kế tiếp. Không cần viết một bản hướng dẫn code rất dài cho cả dự án ngay từ đầu.
