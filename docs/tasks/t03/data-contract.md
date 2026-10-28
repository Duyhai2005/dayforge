# T03 — hợp đồng dữ liệu và thuật toán lịch

Ngày soạn: **28/10/2026** · Phiên bản kỹ thuật **1.0** · Trạng thái: **Đặc tả để rà soát, chưa được người dùng duyệt T03**.

Nguồn hành vi: [T01](../t01/design.md), [T02 1.0](../t02/design.md), [yêu cầu chức năng](../../project-definition/02-functional-requirements.md) và [dữ liệu nền](../../project-definition/05-data-and-sync.md). T03 chọn cách biểu diễn và thuật toán trong phạm vi đó; chưa triển khai sản phẩm.

Tài liệu này định nghĩa dữ liệu nghiệp vụ và projection. Envelope, thứ tự replay, ACK/cursor, nhóm nguyên tử và Undo dùng [hợp đồng đồng bộ](sync-contract.md); tài khoản/quyền dùng [hợp đồng tài khoản](auth-contract.md).

## 1. Quy ước chung

- Tên trường wire dùng English `snake_case`; frontend ánh xạ sang biến/hàm `camelCase` theo [CONVENTION](../../CONVENTION.md).
- `UUID` là chuỗi UUID chuẩn chữ thường; ID do client tạo, bất biến, không suy ra từ tên. Hai tên giống nhau vẫn là hai bản ghi.
- `owner_id` có trong dữ liệu server/projection, được suy ra từ phiên; client không được chọn owner để vượt quyền. Mọi tham chiếu phải cùng owner.
- `null` biểu diễn trường tùy chọn chưa có; không dùng `""`, `0` hoặc ID giả thay null. Ngoại lệ: ghi chú rỗng dùng `""`.
- Payload thay đối tượng chứa đầy đủ trường nghiệp vụ của chính đối tượng đích; không trộn trường từ hai bản sửa. Replay không nhận snapshot toàn bộ family từ client.
- Trường không có trong schema hoặc enum sai bị từ chối; không bỏ âm thầm. Metadata sync được tách khỏi trường người dùng sửa.

## 2. Chuẩn hóa và giới hạn

| Giá trị | Quy tắc canonical |
| --- | --- |
| `title` của task/milestone | NFC, bỏ khoảng trắng đầu/cuối, 1–120 Unicode code points, một dòng. |
| `name` của plan | NFC, bỏ khoảng trắng đầu/cuối, 1–100 code points, một dòng. |
| `note` | NFC; CRLF/CR thành LF; giữ khoảng trắng/xuống dòng; 0–4.000 code points; mặc định `""`. |
| `duration_minutes` | `null` hoặc số nguyên 1–1.440; không chấp nhận số thực, số dạng chuỗi, boolean hoặc 0. |
| `period` | `morning`, `afternoon`, `evening`; milestone cho phép thêm `null`. |
| `status` | `pending` hoặc `completed`; không có `cancelled`, `overdue` được lưu. |
| `color_id` | Một trong chín mã tại mục 4; không nhận mã hex tùy ý. |

Đếm code points sau chuẩn hóa, không dùng riêng `String.length` của JavaScript hoặc số byte UTF-8. UI/server dùng cùng quy tắc; báo lỗi sát trường, không cắt dữ liệu. Cấm NUL và ký tự điều khiển, trừ LF/tab trong `note`; ghi chú là văn bản, không render HTML. Nút Lưu kiểm tra canonical nhưng không làm mất bản nhập khi lỗi.

## 3. Ngày, múi giờ và trạng thái tính toán

- `LocalDate` là ngày Gregorian hợp lệ `YYYY-MM-DD`, từ `0001-01-01` đến `9999-12-31`; MySQL lưu `CHAR(10) CHARACTER SET ascii COLLATE ascii_bin`, không dùng `DATE` vốn không phủ năm trước 1000. Application kiểm tra cả ngày Gregorian, không chỉ regex.
- `WorkspaceSettings` có `time_zone: "Asia/Bangkok"`, `utc_offset_minutes: 420`, `week_start: 1`; cố định trong phase 1, không có form đổi múi giờ.
- Ngày nghiệp vụ không phải UTC instant. Không dùng `new Date("YYYY-MM-DD")` rồi suy ra ngày theo timezone của máy.
- Các phép cộng ngày/weekday/đầu tuần chạy trên ngày lịch; không cộng bội số 24 giờ vào instant. Tuần là thứ hai–chủ nhật.
- `today` lấy từ đồng hồ ứng dụng theo UTC+07:00; khi qua nửa đêm hoặc tab hoạt động lại thì tính lại. Metadata chỉnh sửa vẫn là instant theo hợp đồng sync.
- Hiển thị chưa hoàn thành khi `status == pending && effective_date < today`; không đánh dấu ngay khi hết buổi, không cron ghi trạng thái và không tự dời ngày.
- Hướng điều hướng chặn ở biên miền ngày; không cuộn vòng sang năm khác. Ngày 29/02, cuối tháng và đổi năm phải được kiểm chứng bằng phép ngày lịch.

## 4. Bộ màu

| `color_id` | Nhãn | Chữ/nhấn | Nền thẻ |
| --- | --- | --- | --- |
| `neutral` | Trung tính | `#CED7D8` | `#334148` |
| `earth` | Cam đất | `#E4BD98` | `#493E32` |
| `green` | Xanh lá | `#B0D5C0` | `#2B4138` |
| `teal` | Xanh ngọc | `#A7D6D1` | `#294442` |
| `blue` | Xanh lam | `#ABC9E8` | `#2E4053` |
| `purple` | Tím | `#CAB8E1` | `#3D354D` |
| `pink` | Hồng | `#E6B6C8` | `#493641` |
| `coral` | San hô | `#E5B2AB` | `#4B3634` |
| `sand` | Vàng cát | `#DFD096` | `#48432E` |

`standalone_color_id` luôn được giữ, mặc định `neutral`; khi `plan_id != null`, màu hiệu lực chỉ lấy từ plan hiện hành. Giá trị màu độc lập đang giữ không phải màu ghi đè plan. Chọn rồi bỏ plan trong cùng bản nhập khôi phục màu độc lập trước đó. Đổi tên/màu plan không sửa ngày, kết quả hoặc nội dung task/milestone.

## 5. Các đối tượng nghiệp vụ

| Type | Trường bắt buộc và mặc định |
| --- | --- |
| `PlanData` | `name`, `color_id`; tên trùng được phép. Chỉ tạo/sửa, không xóa/lưu trữ plan trong phase 1. |
| `TaskData` | `title`, `date`, `period`, `duration_minutes: null`, `plan_id: null`, `standalone_color_id: neutral`, `status: pending`, `order_key`. |
| `MilestoneData` | `title`, `date`, `period: null`, `note: ""`, `plan_id: null`, `standalone_color_id: neutral`, `show_in_work_calendar: true`. |
| `TaskTemplate` | Các trường `TaskData` trừ `date` và `status`; lần sinh mới mặc định `pending`. |
| `RecurrenceRule` | `weekdays`: mảng duy nhất, tăng dần, không rỗng, các số nguyên ISO 1–7; hằng ngày là `[1,2,3,4,5,6,7]`. |

Plan tham chiếu phải tồn tại cùng owner. Milestone không có `duration_minutes`, `status` hoặc recurrence; task không có `note` trong phase 1. Hai lịch đọc cùng một `Milestone` theo ID; cờ hiện ở lịch công việc chỉ thay presentation, không tạo bản ghi thứ hai. `show_in_work_calendar: true` là mặc định kỹ thuật theo bản thử T02, người dùng được tắt khi tạo/sửa.

## 6. Projection và ranh giới WorkItem

`Plan` và `Milestone` là các root riêng, chứa ID, payload trên và metadata sync. `WorkItem` là root ổn định cho công việc một lần hoặc một family lặp:

```text
WorkItem { id, owner_id, deleted, kind: single | recurrence_family,
  single: TaskData | null,
  segment_origins[],
  family: { segments[], overrides_by_original_date{}, detached_by_id{} } | null }
SegmentOrigin { segment_id, born_from_date, created_by_operation_id, command_index }
RuleSegment { segment_id, from_date, until_date: LocalDate | null, rule, template }
OccurrenceOverride { override_id, original_date, source_segment_id,
  kind: replacement | deleted | detached,
  replacement: TaskData | null, detached_task_id: UUID | null }
OccurrenceOrderOverride { original_date, source_segment_id, order_key }
DetachedTask { task_id, source_occurrence_id, original_date, data: TaskData, deleted }
```

Chỉ nhánh ứng với `kind` được có dữ liệu. `deleted` mặc định false, single delete đặt true và giữ payload; family chỉ có thể thành root tombstone do Undo-create, không có lệnh delete family. Root tombstone không khai triển thẻ; mọi non-create command nhắm family đã tombstone là `target_retired`, trừ Undo hợp lệ. Khoảng segment là `[from_date, until_date)`, `null` là chưa có giới hạn; các khoảng tăng dần và không chồng nhau. `source_segment_id` trong override ghi nguồn tạo ngoại lệ; original date thuộc family, không đổi khi segment về sau bị cắt.

`segment_origins` là catalog provenance bất biến ở root, ban đầu rỗng; create/enable/edit-future thêm origin của segment vừa tạo với `born_from_date` bằng start/cutoff lúc tạo. Cắt, stop hoặc Undo không xóa origin. Catalog được dựng từ prefix canonical replay, không từ server arrival; single sau Undo enable vẫn giữ catalog lịch sử nhưng không addressable như family.

Replacement chứa payload đầy đủ hiệu lực, gồm ngày đã dời; deleted không có payload sống; detached chỉ tới child đang giữ dữ liệu. `OccurrenceOrderOverride` chỉ giữ rank do rebalance cho một slot đang được sinh; nó không thay nội dung, ngày, trạng thái hay sự tồn tại của occurrence. Child có thể bị xóa riêng, không trở lại thành thành viên lặp. Các cấu trúc chỉ hữu hạn: không materialize vô hạn occurrence và không giới hạn số task bằng mật độ của prototype.

Projection là kết quả replay intent bất biến theo [sync](sync-contract.md), không phải snapshot family do client gửi. Lệnh sửa child chỉ thay child đó; lệnh sửa occurrence chỉ thay occurrence đó. Root nested storage giúp publish thay đổi structural nguyên tử, không làm một bản sửa muộn tự khôi phục snapshot rule cũ.

### DTO chính xác cho semantic hash

`root_hash = lowercase_hex(SHA256(UTF8(JCS({root: {kind, id}, state}))))`, JCS theo RFC 8785, không BOM. Root chưa từng tạo dùng `state: null`; root đã xóa hoặc Undo-create giữ state, ID reservation và payload/catalog cuối cùng với `deleted: true`. `owner_id` trong state là UUID owner của namespace đang replay; không có trường tùy ý ngoài DTO dưới đây.

| Root/state | Chính xác các trường được hash |
| --- | --- |
| Plan | `{owner_id, deleted: boolean, data: PlanData}`. |
| Milestone | `{owner_id, deleted: boolean, data: MilestoneData}`. |
| WorkItem single | `{owner_id, deleted: boolean, kind: "single", single: TaskData, segment_origins: SegmentOrigin[], family: null}`. |
| WorkItem family | `{owner_id, deleted: boolean, kind: "recurrence_family", single: null, segment_origins: SegmentOrigin[], family: {segments: RuleSegment[], overrides: OccurrenceOverride[], order_overrides: OccurrenceOrderOverride[], detached: DetachedTask[]}}`. |

Payload `PlanData`/`MilestoneData`/`TaskData`/`TaskTemplate`/`RecurrenceRule` chứa **đúng tất cả** trường mục 5, gồm null/default tường minh; các record con có **đúng tất cả** trường khối projection trên. `replacement` chỉ khác null cho kind replacement, `detached_task_id` chỉ khác null cho kind detached; child deleted giữ `data`. `order_overrides` chỉ chứa slot đang được rule hiện hành sinh, khóa duy nhất theo `original_date`; một slot không đồng thời có replacement/deleted/detached override. Map lưu nội bộ phải chuyển thành array DTO: origin tăng theo segment UUID, segment theo `(from_date, segment_id)`, override theo `original_date`, order override theo `original_date`, child theo `task_id`; UUID so 16 byte network order, ngày so ISO. Rule weekdays tăng dần.

Hash bao gồm tombstone, rank, rule hiện hành, rank override bảo trì, suppression, ID và provenance/catalog. **Không** đưa head/latest operation dẫn xuất, receipt, cursor/revision, arrival, server clock, LWW diagnostics, owner settings hoặc view state vào DTO. Reference plan chỉ hash `plan_id`, không nhúng màu/tên plan dẫn xuất. Latest effective modifying operation dùng guard Undo riêng, không phải một trường semantic root hash.

`bucket_hash` dùng cùng SHA-256/JCS trên `{date, period, cards: [{root_id, card_id, date, period, order_key}, ...]}`. Cards là **toàn bộ task còn hiện** trong bucket canonical, gồm single/occurrence/child, loại dấu mốc và thẻ bị xóa; sort `(order_key numeric, card_id UUID bytes)` tăng dần. Rank vẫn encode chuỗi signed int64 canonical trong DTO, không đổi thành JSON number. `card_id` của single là root ID, occurrence/child là ID tại mục 7; wrapper vẫn có date/period khi cards rỗng.

## 7. ID, provenance và target

- Root mới dùng UUID ngẫu nhiên, giữ nguyên qua chuyển `single` sang `recurrence_family`.
- `occurrence_id = UUIDv5(root_id, "occurrence:" + original_date)`; danh tính không phụ thuộc ngày đích hoặc segment hiện hành.
- `override_id = UUIDv5(root_id, "override:" + original_date)`.
- `segment_id = UUIDv5(root_id, "segment:" + operation_id + ":" + command_index)` của lệnh tạo/bật/sửa lịch; index bắt đầu 0 theo array wire bất biến; retry dùng cùng ID.
- `detached_task_id = UUIDv5(root_id, "detached:" + original_date)`; các lần replay không tạo child mới khác ID.
- Tham chiếu occurrence mang `root_id`, `source_segment_id`, `original_date`; tham chiếu detached mang `root_id`, `task_id`. Không định vị bằng tên, thứ tự hay effective date.

ID nguồn không tái sử dụng cho một công việc độc lập mới. Tạo trùng root bằng operation khác là `no_op duplicate_target`; retry cùng operation trả receipt cũ. Override chỉ được tạo cho một slot addressable tại vị trí của lệnh trong canonical replay.

## 8. Thứ tự thẻ và rebalance

`order_key` là signed int64, wire dùng chuỗi thập phân canonical, không dấu `+`/số 0 đầu hoặc `-0`; so sánh số, không so sánh chuỗi. Thẻ task trong một `(date, period)` sắp theo `(order_key numeric, card_id)` tăng dần; không có uniqueness constraint cho rank.

Tạo/đưa vào buổi mặc định nối cuối với khoảng 1.024; chèn giữa chọn một số nguyên ở giữa hai rank; trùng rank do đồng thời vẫn có kết quả xác định nhờ card ID. Với occurrence chưa có replacement override, rank lấy từ template, sau đó áp dụng `OccurrenceOrderOverride` nếu có. Reorder người dùng tạo replacement override; rebalance chỉ cập nhật rank override riêng. Không suy ra giờ hoặc thời lượng từ rank.

Khi hết khoảng hoặc gần tràn int64, rebalance bằng **một operation gồm nhiều command `set_order` nguyên tử**. Trên state **trước toàn operation**, kiểm tra `expected_root_hash` cho mọi root tham gia và ít nhất một `expected_bucket: {date, period, order_hash}` cho mỗi buổi bị ảnh hưởng. Bucket hash gồm danh sách có thứ tự của card ID, rank số, ngày/buổi và root reference; phát hiện cả một root khác mới được chèn vào buổi. Hash là SHA-256 của RFC 8785 JCS theo sync, không chứa arrival/cursor metadata.

Gán lại rank có khoảng trống theo trật tự hiện hành, kèm thao tác chèn/đổi chỗ nếu group khai báo nó. Command dùng `intent: "rank_maintenance"` cho rank chỉ do rebalance đổi và `intent: "user_reorder"` cho card người dùng chủ động di chuyển. Maintenance riêng phải giữ nguyên thứ tự card ID trong bucket; trong group có user reorder, kết quả phải đúng thứ tự do thao tác chủ động đó yêu cầu và giữ nguyên thứ tự tương đối của các card còn lại. Sai precondition thì toàn nhóm `no_op precondition_failed`; không rebalance từng phần hoặc tự ghi đè ngày/buổi/nội dung. Precondition không được kiểm tra lại trên state trung gian sau command trước trong cùng group.

Giới hạn số command trong wire không phải giới hạn số task trong buổi. Chọn cửa sổ liên tiếp vừa giới hạn group; nếu chưa có khoảng trống thì thực hiện nhiều group chuẩn bị chỉ đổi rank, đưa khoảng trống từ biên gần nhất về điểm chèn và giữ nguyên thứ tự card sau từng group. Group cuối mới thực hiện đổi chỗ; gặp precondition lỗi thì đọc lại/recompute, không tiếp tục theo số rank cũ. Không dùng chia nhỏ một thao tác di chuyển thành các bước UI nửa chừng.

Mọi group chuẩn bị vẫn là operation durable trong outbox/log, có pending/ACK như operation khác; không có rank local-only. Semantic hash chứa rank nên bước chuẩn bị có thể làm Undo trước đó không còn đủ điều kiện, dù thứ tự nhìn thấy chưa đổi. Undo gần nhất sau group cuối nhắm thao tác đổi chỗ; bước chuẩn bị chỉ đổi cách mã hóa rank.

Thứ tự milestone trong ngày là Cả ngày/Sáng/Chiều/Tối, rồi ID tăng dần trong từng nhóm; không thêm kéo thả milestone. Các nhóm năm sắp theo palette rồi plan ID, tổng số luôn đếm toàn bộ mốc, không theo số màu/nhãn được vẽ.

## 9. Danh mục intent nghiệp vụ

| Lệnh | Target và payload nghiệp vụ |
| --- | --- |
| `plan.create`, `plan.replace` | Plan root; `{data: PlanData}` đầy đủ. |
| `milestone.create`, `milestone.replace` | Milestone root; `{data: MilestoneData}` đầy đủ. |
| `milestone.delete` | Milestone root; `{}`. |
| `work_item.create_single` | Root mới; `{data: TaskData}`. |
| `work_item.create_recurrence` | Root mới; `{start_date, rule, template}`; lần sinh mới pending. |
| `work_item.enable_recurrence` | Root single; `{data: TaskData, rule}`; giữ ngày/kết quả lần đầu. |
| `single.replace`, `single.delete` | Root single; replace `{data: TaskData}`, delete `{}`. |
| `occurrence.replace`, `occurrence.delete` | `{source_segment_id, original_date, data?: TaskData}`; data bắt buộc chỉ với replace. |
| `detached.replace`, `detached.delete` | `{task_id, data?: TaskData}`; data bắt buộc chỉ với replace. |
| `series.edit_future` | `{source_segment_id, cutoff_original_date, rule, template}`. |
| `series.stop_future` | `{source_segment_id, cutoff_original_date}`. |
| `set_order` | `{target, order_key, intent}`; target là single, occurrence hoặc detached theo mục 7; intent là `user_reorder` hoặc `rank_maintenance`. |
| `undo` | Tham chiếu original operation và precondition; server tính inverse theo sync, client không gửi inverse payload. |

`set_order.target` là union `{kind: "single"}`, `{kind: "occurrence", source_segment_id, original_date}` hoặc `{kind: "detached", task_id}`; root luôn ở envelope command. `user_reorder` đổi thứ tự theo rank đích; nếu target là occurrence chưa có replacement thì tạo replacement từ dữ liệu hiệu lực tại bước replay, giữ mọi trường khác và bỏ rank-only override tương ứng. `rank_maintenance` chỉ đổi cách mã hóa rank: với occurrence implicit, tạo/cập nhật `OccurrenceOrderOverride`; với occurrence đã có replacement, chỉ đổi rank trong replacement; với single/detached thì chỉ đổi rank của task đó.

Đánh dấu hoàn thành/đổi ngày/đổi buổi dùng replace đúng target; **reorder chỉ đổi rank bắt buộc dùng `set_order`**, không gửi full replace từ form cũ. Chỉ `user_reorder` trên occurrence implicit mới materialize replacement và được detach khi edit-future. `rank_maintenance` không phải chỉnh sửa riêng; không nâng occurrence thành replacement hoặc detach. Không có endpoint viết tắt bỏ qua lớp nghiệp vụ, lệnh xóa toàn bộ family, task-to-milestone hoặc xóa plan. Thứ tự/receipt/error code thuộc sync; bảng này không nhân bản envelope API.

## 10. Tạo lặp và bật lặp cho task đang có

Tạo recurrence mới đặt segment đầu từ `start_date`, không có ngày kết thúc mặc định. Nếu start không khớp weekday, lần đầu là ngày khớp đầu tiên sau nó; form giải thích ngày đầu. Mẫu hằng ngày dùng cùng cơ chế weekday, không có thuật toán riêng.

Enable chỉ nhận root single còn sống tại bước replay đó. `TaskData.date` phải khớp weekday đã chọn; nếu không thì validation lỗi, không âm thầm chuyển ngày. Chuyển cùng root sang family, segment đầu bắt đầu đúng ngày đó và giữ title/buổi/thời lượng/plan/màu/rank của payload. Tạo replacement đầu tiên giữ đúng cả `status`, kể cả completed; không đánh dấu cả chuỗi hoàn thành. Bỏ cấu hình trước Lưu không phát sinh lệnh.

## 11. Sửa riêng và target đã nghỉ

Với slot còn tồn tại trong segment được chỉ ra, replace lưu đầy đủ dữ liệu tại `original_date`; đổi ngày chỉ đổi `replacement.date` và xóa rank-only maintenance override của slot vì payload đã chứa `order_key` có thẩm quyền. Delete tạo deleted override và xóa rank-only maintenance override. Sửa đến đúng dữ liệu mẫu không tự bỏ override: người dùng đã chỉnh riêng và ý định này phải còn để edit-future xử lý nhất quán.

Form không đổi và thả đúng vị trí cũ không tạo intent/override mới. `set_order` với `intent: "user_reorder"` và rank thực sự đổi là chỉnh sửa riêng, dù các trường nội dung vẫn giống template. `rank_maintenance` không thể dùng thay user reorder để đổi thứ tự card ID trong bucket.

Nếu occurrence đã có mapping detached, sửa/xóa qua ID nguồn được định tuyến tới chính child đó trước khi xét segment nguồn. Nếu không có mapping và segment đã nghỉ, slot không còn khớp rule hoặc đã bị stop, lệnh sửa đến sau là `no_op target_retired`, không dựng lại lịch. Source segment cũ không được tự ánh xạ sang slot successor mới có cùng ngày.

Delete riêng vẫn giữ danh tính: một replace mới hơn có thể phục hồi plan/single/milestone bị tombstone nếu target còn đúng loại và các reference hợp lệ; child bị xóa được phục hồi khi family root còn sống. Occurrence đã xóa riêng có thể phục hồi nếu source segment/slot còn addressable. Family root bị Undo-create không được revive bằng các lệnh sửa child/occurrence/series; chỉ Undo hợp lệ có thể restore root đó. Rule edit không tự khôi phục deleted suppression; muốn sửa một slot đã nghỉ không thể dùng replace để bỏ qua guard. Đây là kiểm tra tại vị trí canonical replay, không dựa vào thứ tự request đến server; delete/edit cùng K dùng tie-break của sync.

Một intent cũ đến server muộn được chèn trước structural intent nếu khóa thứ tự của nó nhỏ hơn; replay tính lại ngoại lệ trước khi detach/stop. Receipt xác nhận lưu intent không cam kết projection của intent sẽ vĩnh viễn còn hiệu lực.

## 12. Đổi lịch từ mốc

`C = cutoff_original_date` có thể không khớp weekday. Root phải **đang là family còn sống**; `source_segment_id` phải có trong catalog cùng root, được tạo bởi operation có `K` nhỏ hơn operation hiện tại và `C >= born_from_date`. Guard này xác thực nguồn người dùng đã thấy, **không yêu cầu C còn thuộc interval hiện hành** của nguồn. Source bị cắt/stop bởi intent trước đó không làm mất quyền của một structural intent mới hơn.

Áp dụng lên **toàn bộ tương lai canonical hiện tại từ C**, không chỉ interval cũ của nguồn. Một `series.edit_future` tường minh có thể tiếp tục lịch sau stop, kể cả dùng rule/template cũ; đây là thay đổi structural có chủ đích. Occurrence/single replace hoặc set_order không được resume. UI thể hiện ngày gốc/ngày hiện tại và phạm vi; chỉ bỏ gửi khi cả rule/template lẫn phạm vi tương lai đều không đổi.

Thực hiện một phép chuyển projection nguyên tử:

1. Giữ tất cả segment/slot có original date `< C`, kể cả replacement có ngày đích sau C.
2. Với mọi replacement còn sống và còn thuộc chuỗi có original date `>= C`, tạo/update child theo ID xác định, sao chép toàn bộ dữ liệu hiệu lực; đổi override thành detached suppression. Gồm ngoại lệ hoàn thành, đổi nội dung, ngày/buổi, plan/màu và user reorder tường minh.
3. Giữ deleted suppression; không biến một lần đã gỡ thành child sống. Giữ toàn bộ child đã tách từ trước, kể cả child đã xóa.
4. Giữ các khoảng kết thúc trước/ở C; cắt khoảng hiện hành băng qua C nếu có, bỏ mọi phần interval từ C, rồi thêm segment mới `[C, null)` với rule/template mới và origin mới trong catalog. C có thể nằm trong vùng đã stop/gap; không cần một segment hiện hành chứa C. Các segment rỗng không đưa vào projection hiện hành.
5. Tiếp tục suppress mọi original date đã deleted/detached, dù rule mới vẫn khớp ngày đó. Không suppress theo ngày đích: các task độc lập được phép cùng ngày/buổi.
6. Giữ rank-only maintenance override tại ngày `>= C` chỉ khi ngày đó vẫn được segment mới sinh; cập nhật provenance sang segment mới. Bỏ override cho ngày không còn khớp rule. Việc rebalance cũ không tạo child standalone và không suppress occurrence.

Template không lấy từ một replacement bất kỳ. Payload intent là giá trị người dùng lưu trong màn Lịch lặp; mọi detach dùng trạng thái canonical trước structural intent, không dùng danh sách override đóng băng trên thiết bị.

## 13. Dừng từ mốc

Kiểm tra root family, catalog nguồn/cutoff như edit-future; cắt và loại **mọi phần segment canonical hiện tại** original date `>= C`, không thêm segment hoặc origin mới. Stop sau stop chỉ gỡ phần còn sống, không phục hồi interval cũ hoặc dựng lại segment nguồn. Các replacement còn attached cùng phạm vi đổi thành deleted suppression; cả những lần đã dời trước C hoặc completed cũng bị gỡ vì vẫn là thành viên tương lai theo ngày gốc. Rank-only maintenance override tại ngày `>= C` bị bỏ cùng các slot bị cắt; chúng không trở thành child hoặc suppression.

Giữ original date `< C` bất kể ngày đích, giữ deleted suppression và mọi detached child có từ trước. Các task chưa materialize ở tương lai bị gỡ bằng biên segment, không sinh vô hạn tombstone. Stop không sửa/xóa child đã tách hoặc lấy effective date làm ranh giới. Undo hợp lệ có thể đảo stop; một structural edit-future mới có thể tạo tương lai mới, nhưng occurrence edit không khởi động lại series.

## 14. Khai triển một khoảng xem

1. Bỏ qua root `deleted: true`; với từng segment của family còn sống, duyệt ngày original nằm trong giao của `[view_from, view_until)` và khoảng segment, chỉ sinh những weekday khớp.
2. Nếu original có override thì không đưa bản mẫu vào; replacement chỉ được hiện theo ngày đích và trạng thái sống. Deleted/detached suppression không sinh thẻ mẫu.
3. Quét replacement còn thuộc segment theo **ngày đích** trong khoảng, kể cả original nằm ngoài khoảng; chỉ thêm một lần theo occurrence ID. Override của slot không còn sống không hiện.
4. Thêm mọi detached child còn sống và single còn sống có ngày trong khoảng; không áp dụng rule/stop cho chúng. Với occurrence sinh từ template, áp dụng rank-only maintenance override theo original date nếu còn tồn tại.
5. Sắp thẻ theo ngày/buổi/rank/ID; milestone lấy từ cùng root, sắp theo mục 8. Hai task cùng ngày hoặc trùng tên không bị deduplicate.

Range validation cấm `view_until <= view_from`; query năm chia khoảng tháng nếu cần, nhưng kết quả không bị cắt theo giới hạn thẻ UI. Tính tháng/năm bằng ngày lịch và biên exclusive; trường hợp đến biên `9999-12-31` dùng sentinel biên trên nội bộ, không phát sinh ngày năm 10000 trong payload.

## 15. Xóa và Hoàn tác

Xóa single/milestone/child tạo dấu xóa giữ ID và metadata; delete occurrence giữ suppression. Không dọn tombstone/intent trong phase 1. Ngày quá hạn chưa hoàn thành không phải dấu xóa. Undo là mutation mới sau ACK hoặc khi đang pending, không tua cursor/snapshot và không đổi timestamp của intent cũ.

Server tính inverse từ lịch sử canonical của original operation, giữ cùng phạm vi target/structural group và kiểm tra semantic hash cùng latest effective modifying operation của các root bị chạm theo sync. Client không tự gửi ảnh chụp hay inverse đáng tin. Có thay đổi xen vào trên phạm vi ảnh hưởng thì từ chối cả inverse, không khôi phục từng phần hoặc ghi đè dữ liệu mới. Undo child không phục hồi rule; Undo stop/edit-future phục hồi active interval, suppression, rank-only maintenance override và child do đúng thao tác đó tạo nếu precondition còn đúng.

Ngoại lệ inverse tường minh: **giữ toàn bộ SegmentOrigin đã biết tại điểm canonical Undo**, không xóa lịch sử catalog. Undo enable về single vẫn giữ catalog nhưng series command lúc đó `target_retired`; chỉ family hiện hành mới nhận structural command. Vì hash chứa catalog, state sau Undo không bắt buộc hash-equal state trước original operation; event cũ đến trễ thêm provenance có thể làm guard Undo mất điều kiện.

Undo root-create có before-state null không xóa root vật lý: giữ ID reservation, payload/catalog cuối cùng, đặt `deleted: true`, không khai triển. Plan/family không có API delete trực tiếp vẫn có thể mang tombstone theo ngoại lệ này. Mọi inverse, kể cả group nhiều root, phải kiểm tra bất biến reference trên **toàn bộ working copy sau inverse** trước khi publish. Riêng Undo plan-create, nếu bất kỳ WorkItem/task/replacement override/child/segment-template/milestone còn sống nào vẫn tham chiếu plan thì cả inverse là `no_op undo_not_applicable`, không để dangling reference. Không xét payload của root/child đã xóa như một tham chiếu sống; các replace phục hồi về sau phải kiểm tra lại plan còn sống.

Thông báo/đường Undo theo T02: khoảng 8 giây, dừng khi hover/focus; thao tác gần nhất còn ở widget đến thay đổi kế tiếp, đổi owner hoặc reload. Việc không còn Undo cục bộ không xóa lịch sử sync.

## 16. Trạng thái xem và tương thích dữ liệu cũ

`DeviceViewState` tách theo owner/device: work `anchor_date`, `scroll`; milestone `anchor_date`, `scale: week|month|year`, `scroll`. Lần đầu work là tuần hôm nay, milestone là tháng hôm nay; giá trị hỏng dùng mặc định, không làm lỗi dữ liệu lịch. Back/Forward dùng route state, không tạo intent sync.

Migration milestone cũ thiếu trường: `period -> null`, `note -> ""`; không tự gắn buổi. Field mặc định chỉ áp dụng theo phiên bản migration/schema khai báo, không lặng lẽ chữa payload v1 sai. Nâng schema không đổi root/occurrence ID hoặc vứt intent/outbox đang chờ.

## 17. Các ví dụ bắt buộc kiểm chứng

- Original thứ hai dời sang thứ sáu; cutoff thứ tư: cả edit-future/stop đều giữ vì ngày gốc trước mốc.
- Original thứ sáu dời về thứ hai; cutoff thứ tư: edit-future tách giữ ngày thứ hai, stop gỡ khỏi lịch.
- Original thứ sáu đã hoàn thành hoặc được user reorder: edit-future vẫn tách; stop gỡ khi nó chưa tách từ trước. Chỉ rank đổi do maintenance thì không tách.
- Một thứ sáu bị xóa riêng; rule mới vẫn có thứ sáu: không hồi sinh slot đó. Child cũ độc lập cùng ngày vẫn giữ.
- Original ngoài tuần xem dời vào tuần: chỉ một thẻ ở đích; không còn thẻ ở nguồn. Hai occurrence khác cùng đích vẫn là hai thẻ.
- Enable task completed giữ ngày/buổi/kết quả lần đầu, các lần tiếp theo pending; weekday không chứa ngày hiện tại bị báo lỗi.
- Intent sửa một lần K cũ đến sau stop: replay trước stop rồi bị stop gỡ. Intent K mới nhắm slot đã nghỉ: no-op, không phục hồi rule.
- Structural edit K mới từ nguồn đã bị edit trước cắt vẫn áp dụng lên tương lai hiện hành; stop K mới từ cùng nguồn vẫn gỡ đúng tương lai đó. Edit-future tường minh sau stop có thể resume; stop sau stop không resume.
- Hai intent sửa hai ngày khác nhau giữ được cả hai; hai replace cùng một occurrence lấy payload mới nhất, không trộn ngày của A với buổi của B.
- `set_order` user reorder không đè nội dung hoàn thành/đổi tên mới hơn và occurrence implicit được detach khi edit-future; `rank_maintenance` chỉ đổi rank override, giữ occurrence theo rule, không detach. Kiểm chứng rebalance Friday occurrence rồi edit-future sang Mondays: không tạo detached Friday, Monday vẫn sinh; nếu Friday vẫn khớp rule mới thì rank maintenance giữ nguyên. Root/bucket hash phải cùng kết quả ở Python/TypeScript, gồm order overrides, tombstone/catalog và loại mọi head-operation dẫn xuất.
- Undo-create giữ root tombstone/catalog và không sinh thẻ; lệnh sửa occurrence trên family tombstone bị retired. Undo plan-create khi task/milestone khác vẫn dùng plan bị từ chối nguyên nhóm, không tạo reference treo.
- Rebalance nhiều root bị fingerprint cũ: không target nào đổi; retry cùng operation/group không đổi ID hoặc tạo tác dụng mới.
- Lưu/sync/reload giữ nguyên note Unicode/xuống dòng; milestone hai lịch cùng ngày/buổi/màu; nửa đêm UTC+07 đổi dấu quá hạn đúng ngày.

Các lựa chọn kỹ thuật trên không mở thêm phạm vi sản phẩm. T03 chỉ có thể đánh dấu hoàn thành sau rà soát chéo hợp đồng, ví dụ biên và quyết định trạng thái của người phụ trách; tài liệu này chưa phải bằng chứng code hoặc nghiệm thu chạy thật.
