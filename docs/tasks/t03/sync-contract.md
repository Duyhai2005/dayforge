# DAYFORGE — hợp đồng đồng bộ T03

Ngày: **28/10/2026** · Phiên bản kỹ thuật **1.0** · Trạng thái: **lựa chọn kỹ thuật T03 theo phạm vi được giao; chưa phải phê duyệt T03 hoặc kết quả chạy sản phẩm**.

Tài liệu này dùng cùng [hợp đồng dữ liệu](data-contract.md) và [hợp đồng tài khoản](auth-contract.md).
T01/T02 đã duyệt: sửa offline, tự sync khi mở, lấy mốc sửa thay vì thứ tự nhận, tự phân xử, nhóm lặp nguyên tử, giữ pending và hoàn tác an toàn.
Clock, command log, reducer, cursor và receipt bên dưới là lựa chọn kỹ thuật mới của T03, không diễn giải thành lựa chọn người dùng đã trả lời trước đó.

## 1. Ba thứ tự khác nhau

- **Edit order `K`**: mốc ghi lúc sửa; quyết định kết quả nghiệp vụ.
- **Commit cursor**: số thứ tự server đã ghi bền vững; dùng tải event và xác nhận.
- **Thứ tự nhận HTTP**: chỉ ảnh hưởng lúc biết kết quả, không quyết định bản thắng.

Mọi dữ liệu, log, receipt, device, shadow và outbox có phạm vi owner.
`owner_id` trong wire là assertion chống gửi nhầm; server bắt buộc so với owner của phiên, không dùng nó cấp quyền.
Ngày/buổi lịch dùng quy tắc trong hợp đồng dữ liệu, không chuyển thành timestamp chỉnh sửa.

## 2. Operation và command

```json
{
  "protocol_version": 1,
  "reducer_version": 1,
  "operation_id": "uuid",
  "owner_id": "uuid",
  "device_id": "uuid",
  "device_sequence": "123",
  "edit_time": {
    "physical_ms": 1793140000000,
    "logical": 0,
    "calibration_id": "uuid",
    "raw_wall_ms": 1793140000000,
    "quality": "offline_estimate"
  },
  "dependencies": ["operation-uuid"],
  "commands": [
    {
      "root": {"kind": "work_item", "id": "uuid"},
      "action": "occurrence.replace",
      "payload": {},
      "precondition": null
    }
  ]
}
```

- `commands`: 1–1.000 command, thứ tự array có nghĩa; thông thường chỉ một command.
- `root.kind`: `plan`, `milestone`, `work_item`; settings triển khai cục bộ theo hợp đồng dữ liệu, không tự thêm root sync.
- UUID tạo trên client; ID operation và toàn bộ envelope bất biến sau khi tạo outbox.
- `device_sequence`: unsigned 64-bit truyền chuỗi thập phân, cấp cùng giao dịch IndexedDB; không dùng thay mốc sửa.
- `physical_ms`: số nguyên Unix UTC milliseconds an toàn trong JavaScript; `logical`: unsigned 32-bit.
- Evidence `calibration_id`, `raw_wall_ms`, `quality` đều bắt buộc; quality là `calibrated`, `offline_estimate` hoặc `untrusted`.
- API có thể nhận quality `untrusted` nhưng phải từ chối `422 time_invalid`, không đưa vào log chính thức.
- Hash là SHA-256 của byte UTF-8 canonical JSON theo JCS, ràng buộc envelope gốc gồm owner/version/evidence. [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html).
- Dùng đúng JCS, không tự định nghĩa cách sort key; key schema đã biết dùng ASCII, chuỗi giữ nguyên Unicode và array giữ thứ tự.
- Không chuẩn hóa lại payload khi retry; validation/chuẩn hóa trường phải hoàn tất trước giao dịch lưu local.
- Server metadata `commit_cursor`, receipt và diagnostics nằm ngoài envelope được hash.
- Giới hạn push: 100 operation, 8 MiB UTF-8/request; một operation tối đa 2 MiB, không cắt nhóm.

`dependencies` nêu operation tạo root/kế hoạch hoặc bước nghiệp vụ mà operation này dựa vào.
Dependency phải cùng owner, đã recorded, và có HLC nhỏ hơn operation phụ thuộc.
Các command trong cùng operation có thể dùng root vừa tạo bởi command đứng trước.
ID đã thuộc owner khác không bao giờ trở thành reference hợp lệ; response không tiết lộ dữ liệu owner đó.
`base_revision` nếu có ở diagnostics không tham gia edit order hoặc quyết định bản thắng.
`command.precondition` là null hoặc `{expected_root_hash?:64hex, expected_bucket?:{date,period,order_hash:64hex}}`; không nhận key khác.
Hash biểu diễn 64 ký tự hex chữ thường; tất cả precondition được kiểm tra trên state **trước toàn bộ commands của operation**.
Bucket hash dùng DTO chính xác `{date,period,cards:[{root_id,card_id,date,period,order_key}]}` từ hợp đồng dữ liệu; sort rank theo giá trị số nguyên rồi card ID, giữ rank dạng chuỗi thập phân trong JCS, phát hiện cả card được root khác chèn vào.

## 3. Đồng hồ và phân xử bằng nhau

Thứ tự toàn phần cố định:

```text
K = (physical_ms, logical, delete_rank, device_id_bytes, operation_id_bytes)
delete_rank = 1 nếu operation chứa *.delete hoặc series.stop_future; còn lại = 0
```

So sánh số theo giá trị, UUID theo 16 byte chuẩn network order; không dùng collation chuỗi MySQL.
Delete/stop thắng replacement khi **cả physical và logical bằng nhau**; các trường hợp còn lại dùng UUID.
Một nhóm có delete và update dùng cùng `K`, cùng rank; không cấp timestamp riêng cho từng command.

Client giữ HLC theo owner/device, cập nhật từ những event đã biết và nguồn UTC đã hiệu chỉnh.
Khi tạo thao tác mới, đặt physical bằng max của UTC ước lượng, physical local và physical đã quan sát.
Nếu max trùng physical local/đã quan sát, logical vượt mọi logical tương ứng; nếu UTC mới lớn hơn hết, logical về 0.
Clock state, sequence, operation và dữ liệu local commit trong cùng transaction.
Không đẩy timestamp của operation cũ lên khi nhận server time hoặc event mới.
HLC theo dõi quan hệ nhân quả, không chứng minh thứ tự thực của hai thiết bị offline có đồng hồ sai. [Nguồn HLC gốc](https://cse.buffalo.edu/~demirbas/publications/hlc.pdf).

**Hiệu chỉnh và phát hiện:**

- `/sync/clock` trả `calibration_id`, `server_time_ms`, `server_time` và `max_future_skew_ms=300000`; calibration là bookkeeping phép đo, không phải bằng chứng xác thực thời gian quá khứ.
- Server có thể giữ calibration theo owner/device để chẩn đoán; row lịch sử không tồn tại sau restore không tự làm event cũ bất hợp lệ, không cần endpoint phục hồi calibration.
- Lần chuẩn bị online đầu, đăng nhập và reconnect lấy ba mẫu HTTPS `server_time_ms`; dùng mẫu RTT nhỏ nhất không quá 10 giây.
- Offset ước lượng = server time trừ midpoint wall-clock gửi/nhận; lưu calibration ID, offset và RTT.
- RTT/asymmetry/drift khiến đây là ước lượng, không phải bảo đảm thời gian chính xác.
- Trong process dùng elapsed monotonic tính từ anchor đã hiệu chỉnh; kiểm tra wall elapsed với monotonic elapsed.
- Chênh tuyệt đối lớn hơn 120.000 ms là clock jump; dừng dùng interval đó như thời gian tin cậy.
- Sau restart offline dùng wall time + offset lưu; lùi quá 120.000 ms so với observation đã lưu là nghi vấn.
- Một khoảng offline dài hoặc nhảy tới trước khi browser đóng không thể luôn phân biệt; không hứa phát hiện hết.
- Nếu offset đo lại lệch quá 120.000 ms, đánh dấu các operation chưa gửi từ calibration cũ là cần kiểm tra clock.
- Nếu không thể xác định interval có thời gian hợp lệ, giữ operation với trạng thái `time_invalid`; không tự chọn giờ reconnect.

**Guard server ở lần ghi đầu:**

- `physical_ms <= server_now_ms + 300000` và `physical_ms >= account_created_ms - 300000`.
- Không áp dụng giới hạn tuổi trong quá khứ: thiết bị offline lâu vẫn gửi mốc sửa gốc.
- Logical/version và cú pháp calibration UUID phải hợp lệ; overflow, quality `untrusted`, dependency HLC không tăng trả lỗi rõ.
- Row calibration còn tồn tại phải khớp owner/device; thiếu row lịch sử vẫn dùng owner/device từ phiên/envelope và các guard thời gian như thường, không tin historical claim của client.
- Calibration cũ không tự hết hạn chỉ vì thiết bị lâu không kết nối.
- Kiểm tra receipt có sẵn trước guard clock, để retry hợp lệ vẫn trả receipt cũ.
- Khi server clock mất tính tin cậy do bước nhảy lớn đã phát hiện, tạm ngừng nhận mutation bằng `503 clock_unhealthy`.

Một timestamp đã nhận chỉ có thể tới trước thời gian server tối đa năm phút; không cho lỗi năm xa áp đảo vô hạn.
Timestamp chưa hợp lệ giữ nguyên trong outbox; retry không đổi ID/nội dung/mốc.
Nếu mốc không thể sửa bằng dữ kiện đã ghi, người dùng Lưu lại sau sửa giờ thiết bị thành **operation mới**; giữ bản lỗi để chẩn đoán và đánh dấu được thay thế local.
Không tự chuyển bản sửa cũ thành mới khi mạng trở lại; không cam kết biết thứ tự ngoài đời khi clock offline sai.

**Phục hồi HLC local bị nhiễm mốc lỗi:**

1. Chặn gửi các operation chưa recorded thuộc interval lỗi và mọi hậu duệ dependency; giữ chúng hiển thị/pending cùng snapshot local trong vùng quarantine, operation độc lập tiếp tục sync.
2. Nếu một request trước mất response, retry **nguyên envelope** trước để biết receipt hay rejection; không coi timeout là bằng chứng chưa recorded.
3. Operation có receipt không bao giờ được viết lại; receipt lookup trước time guard vẫn áp dụng. Chỉ tập xác định chưa recorded mới được reauthor.
4. Sau thao tác rõ ràng của người dùng **Lưu lại sau sửa giờ thiết bị**, lấy calibration tin cậy và tạo `device_id` mới, sequence/HLC lane mới.
5. Seed lane chỉ từ calibration mới và event recorded của server đã xác thực; không lấy max từ HLC/local event bị nhiễm trong quarantine.
6. Stage causal chain chưa recorded theo thứ tự dependency với operation ID/time mới; map **mọi operation reference** gồm dependencies, `undo.original_operation_id`, cùng segment/provenance reference dẫn xuất từ operation cấu trúc thay thế/command index; giữ root/occurrence/detached ID và ID root của create.
7. Replay original quarantine chain trên canonical pre-state đã lưu để xác minh guard gốc; replay replacement staging và so semantic pre-state/target dưới ID mapping tường minh, gồm catalog/provenance. Đổi dependency ID đơn thuần không sửa được hash guard.
8. Chỉ khi khôi phục được đúng pre-state và chứng minh tương đương mới tính lại `precondition.expected_root_hash`, `precondition.expected_bucket.order_hash` và `undo.expected_states[].hash` từ canonical pre-state của replacement group; không sao chép hash cũ sau đổi ID, không bỏ/nới guard để ép áp dụng.
9. Nếu không tương đương, thiếu pre-state hoặc recorded data đã đổi, giữ group đó và hậu duệ trong quarantine/pending cùng original snapshot; cho phép người dùng mở dữ liệu hiện hành để sửa/Lưu thành thao tác mới, không tự chọn xung đột.
10. Giao dịch local chuyển overlay sang replacement chain đã được kiểm tra nguyên tử; giữ original envelope/snapshot với `superseded_by` để chẩn đoán, không sửa timestamp hoặc giả thành retry. Nhánh chưa đủ điều kiện giữ overlay gốc.
Nếu chưa đủ dữ kiện/đã mất phiên để làm bước phụ thuộc, tiếp tục giữ overlay gốc và báo chờ sửa; không làm biến mất dữ liệu đã lưu local.

## 4. Canonical replay và độ hạt LWW

Server và client giữ tập operation bất biến; canonical reducer gấp **toàn bộ operation của owner theo `K` tăng dần**.
Mỗi operation kiểm tra mọi precondition trên state trước nhóm, rồi chạy commands trên working copy; reference/target được kiểm tra tại chính vị trí replay đó.
Nếu một command không thể áp dụng, cả operation thành `no_op`; không xuất bản nửa nhóm.
Nếu hợp lệ, xuất bản toàn bộ working copy cùng lúc; operation sau có thể sửa riêng một đối tượng của nhóm trước.
Tối ưu chỉ replay root độc lập phải chứng minh tương đương global fold, gồm dependency, nhóm nhiều root và undo.

Plan/milestone/single/occurrence/detached replacement chứa toàn bộ trường nghiệp vụ của target.
Trong cùng target còn tồn tại, replacement mới nhất thắng toàn bộ payload; không tự trộn ngày/buổi/nội dung.
Delete là event cùng edit order; replacement mới hơn có thể phục hồi target nếu loại target đó còn addressable.
Plan/single/milestone replacement có thể phục hồi tombstone còn addressable; root family đã tombstone trả `target_retired` cho mọi command thường, chỉ undo hợp lệ mới phục hồi family.
Không dùng full snapshot cả family để thay cho một occurrence edit: cách đó có thể vô tình khôi phục rule/stop cũ.
Các occurrence khác nhau được giữ riêng; sửa một detached child không thay rule hoặc detached child khác.

Action cố định phiên bản 1:

| Action | Nội dung |
| --- | --- |
| `plan.create`, `plan.replace` | Tạo/sửa toàn bộ kế hoạch; không có plan delete ở đợt đầu. |
| `milestone.create`, `milestone.replace`, `milestone.delete` | Một dấu mốc dùng chung hai lịch. |
| `work_item.create_single`, `work_item.create_recurrence` | Tạo root mới bằng ID ổn định. |
| `work_item.enable_recurrence` | Chuyển single thành family cùng root ID, giữ lần đầu/kết quả. |
| `single.replace`, `single.delete` | Sửa/xóa single trước khi target đó được chuyển loại. |
| `occurrence.replace`, `occurrence.delete` | Target theo root + original date; payload có source segment provenance. |
| `detached.replace`, `detached.delete` | Chỉ child standalone đã tách. |
| `series.edit_future`, `series.stop_future` | Một command cấu trúc nguyên tử. |
| `set_order` | Chỉ thay rank; bắt buộc root hash và bucket hash theo mục 5. |
| `undo` | Tính inverse từ canonical log theo mục 6. |

Create trùng ID đang có là `no_op duplicate_target`; retry cùng operation đã được receipt xử lý trước đó.
Reference nghiệp vụ vắng ở vị trí replay là `no_op reference_unavailable`, không xét theo thời điểm HTTP nhận.
Hết target do chuyển loại/rule/stop là `no_op target_retired`; không ngầm tạo target khác.
Operation no-op vẫn được ghi; event cũ đến sau có thể làm kết quả replay thay đổi, mọi client phải tính lại.
Retry chính operation đó không tạo tác dụng mới hoặc đổi timestamp.

## 5. Nhóm lặp và thứ tự thẻ

Family có số segment/override/detached child hữu hạn; chỉ khai triển occurrence trong khoảng xem.
Occurrence identity là root + ngày gốc; đổi ngày đích không đổi identity.
`source_segment_id` chỉ xác thực/provenance theo lịch sử; tra mapping detached bằng root/ngày gốc trước khi báo retired.
Không từ chối child đã tách chỉ vì segment nguồn nay đã kết thúc.
Command cấu trúc mang target segment, cutoff original date và rule/template mới; không mang danh sách detach do client tính sẵn.
WorkItem root giữ `segment_origins[]` lịch sử: segment ID, born-from date, operation tạo và command index, kể cả khi segment không còn active hoặc undo chuyển root về single.
Command cấu trúc cần root hiện là family; source phải là origin cùng root do operation trước theo `K` tạo, cutoff không trước born-from date; không bắt nằm trong active interval hoặc khớp weekday.
Edit/stop áp dụng lên **tương lai canonical hiện hành** từ cutoff; `series.edit_future` tường minh mới hơn có thể tiếp tục sau stop, occurrence edit không có quyền đó.

`series.edit_future(C)` thực hiện trong một working copy:

1. Giữ phần trước `C`; cắt các interval nguồn tại `C` và thay phần rule tương lai thuộc phạm vi bằng successor.
2. Tìm mọi override còn attached có original date từ `C`, kể cả đã dời sang tuần khác.
3. Live replacement thành detached child với ID xác định từ root/ngày gốc, giữ toàn bộ dữ liệu/kết quả/kế hoạch.
4. Slot ngày gốc của mỗi child vừa tách được suppress trong successor, kể cả ngày đó vẫn khớp weekday mới.
5. Deleted override giữ suppression, không sinh child sống; giữ mọi detached child có từ trước.

`series.stop_future(C)` cắt các interval trong phạm vi và gỡ mọi attached member có original date từ `C`.
Nó gồm occurrence đã dời/hoàn thành; không xóa lịch sử trước `C` hoặc detached child.
Sửa occurrence sau rule edit theo mapping vào child đã tách; nếu không có child/slot hợp lệ thì `target_retired`.
Sửa một occurrence sau stop không tự restart series; một cấu trúc mới phải là command hợp lệ riêng.
Một occurrence cũ tới trễ nhưng có `K` trước rule edit được replay trước và tham gia detach đúng quy tắc.

Ordinary reorder dùng `set_order` trên một target; giữ lịch/ngày/buổi ngoài rank.
Mỗi `set_order` cần `expected_root_hash`; operation phải có `expected_bucket` cho từng bucket bị tác động, có thể đặt một lần trên command đầu tương ứng.
Khi cần rebalance, một operation chứa nhiều `set_order`; kiểm tra các root hash và bucket hash một lần trên state trước nhóm.
Một hash khác tại vị trí replay làm **cả nhóm** `no_op precondition_failed`; bucket guard phát hiện phantom insert từ root khác, không dùng revision/arrival.
Rank prep chia nhóm giới hạn theo hợp đồng dữ liệu; mọi nhóm vẫn được ghi bền vững và ACK, không biến wire cap thành giới hạn số thẻ UI.
Rebalance không có quyền thay lịch hoặc ghi đè payload task/milestone.

## 6. Hoàn tác

Operation undo có duy nhất một command `undo`, root neo thuộc operation gốc và dependency trỏ operation gốc.
Payload chính xác: `{original_operation_id:UUID, expected_states:[{root:{kind,id},hash:64hex}]}`; array chứa **đúng toàn bộ root đã bị operation gốc thay đổi**, mỗi root một lần.
Semantic hash gồm dữ liệu/identity theo schema; loại cursor, receipt và server timestamp.
Reducer xác định lại tập root, state ngay trước operation gốc và kết quả của nó từ canonical log; không tin inverse snapshot client gửi.
Tại vị trí undo phải thỏa cả hash dự kiến và latest effective modifying operation của từng root vẫn là operation được undo.
Nếu không đủ điều kiện: toàn bộ undo `no_op undo_not_applicable`, trả thông báo rõ, không ghi đè mù.
Nếu đủ: khôi phục business projection trước operation gốc bằng mutation mới; tạo/xóa/chuyển loại/nhóm được hoàn tác cùng phạm vi, giữ provenance `SegmentOrigin` bất biến của lịch sử recorded.
Ngoại lệ undo root-create: giữ root ID đã dành, payload/catalog cuối và `deleted:true`, không trả `state:null` hoặc xóa ID khỏi lịch sử; hash DTO Plan/family vì vậy dùng deleted boolean.
Tombstone do undo-create là nghiệp vụ nội bộ, không mở public API xóa Plan hoặc family.
Undo Plan-create phải thất bại `undo_not_applicable` nếu còn bất kỳ business reference sống nào trỏ Plan, gồm task, template, override, detached child hoặc milestone, dù Plan root chưa đổi.
Mọi inverse group phải kiểm tra lại toàn bộ bất biến tham chiếu trên working copy sau inverse; nếu vi phạm thì không áp dụng cả nhóm, không tự gỡ kế hoạch hoặc làm reference mồ côi.
Một event cũ đến trễ có thể làm undo mất điều kiện; replay lại phải an toàn và hội tụ.
Không quay lùi cursor, xóa receipt hoặc sửa lịch sử event để hoàn tác.

## 7. Lưu server và commit cursor

Các bảng tối thiểu, khóa đều có owner:

| Bảng | Khóa/nội dung |
| --- | --- |
| `OwnerSyncState` | `(owner_id)`, epoch UUID, head unsigned BIGINT. |
| `RecordedOperation` | Unique `(owner_id, operation_id)`; hash, envelope, `K`, commit cursor; immutable. |
| `OperationReceipt` | Cùng operation key; hash, cursor và effect tại commit; immutable. |
| `ChangeLog` | Unique `(owner_id, epoch, cursor)`; tham chiếu operation đã commit. |
| Projection tables | Root và các dòng con phục vụ đọc; derivable từ log; revision server riêng. |

Giữ event, receipt và dấu xóa trong đợt đầu; không prune hoặc checkpoint làm mất dữ kiện replay.
Tất cả mutation business, kể cả đường CRUD khác nếu có, phải qua cùng service/log.
Một operation mới dùng transaction InnoDB:

```text
BEGIN
SELECT OwnerSyncState WHERE owner_id = session_owner FOR UPDATE
check duplicate operation ID/hash; check declared dependencies and wire validity
insert immutable operation; replay owner operations ordered by K
publish complete derived projections, including all roots of the group
head := head + 1; assign cursor; insert ChangeLog and OperationReceipt
COMMIT
```

Mỗi operation recorded, kể cả no-op hoặc thua hiện tại, nhận một cursor; duplicate không nhận cursor mới.
Giữ khóa owner tới commit/rollback; transaction sau không cấp cursor cao hơn trước khi transaction trước kết thúc.
Rollback hoàn tác cả head/event/projection/receipt; không có cursor thấp còn chưa commit bị bỏ qua.
Không dùng raw `AUTO_INCREMENT`, `MAX(id)` hoặc server timestamp làm commit watermark.
MySQL mô tả `FOR UPDATE` cho counter và giữ khóa tới commit/rollback. [Locking reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html).
AUTO_INCREMENT có thể interleave và mất giá trị khi rollback; không tự cho thứ tự commit. [AUTO_INCREMENT](https://dev.mysql.com/doc/refman/8.4/en/innodb-auto-increment-handling.html).
Sync đọc từ primary; không dùng `SKIP LOCKED` hoặc replica có thể lag.

## 8. Receipt và outbox

```json
{
  "receipt": {
    "operation_id": "uuid", "request_hash": "sha256",
    "recorded": true, "commit_cursor": "251",
    "effect_at_commit": "applied", "reason_at_commit": null
  }
}
```

`recorded` xác nhận event bền vững, không hứa hiệu lực thắng mãi.
`effect_at_commit`: `applied` nếu thêm event đổi projection hiện hành; `superseded` nếu event hợp lệ đã bị thay thế trong kết quả; `no_op` nếu reducer không áp dụng do target/precondition.
`reason_at_commit` bắt buộc nhưng nullable; khi `no_op` dùng enum `duplicate_target|reference_unavailable|target_retired|precondition_failed|undo_not_applicable`.
Chẩn đoán này chỉ tại commit; event khác tới trễ có thể đổi ảnh hưởng hiện hành.
Retry cùng ID/hash trả cùng receipt; ID khác hash trả `409 operation_id_reused`, không sửa event.
Không dùng receipt cũ làm snapshot hiện tại; tải luồng event để có state hiện hành.

Client duy trì `recorded_shadow`, outbox `queued|sending|blocked|ack_waiting_pull` và cursor theo owner/epoch.
UI là reducer của union shadow events với **queued/sending/blocked/ack-waiting** events, khử trùng bằng operation ID/hash.
Blocked chỉ bị loại khỏi hàng gửi; vẫn giữ overlay/snapshot dữ liệu đã lưu và pending UI đến khi sửa hoặc thay thế rõ ràng, không biến lỗi sync thành mất thay đổi local.
Lưu local cùng outbox nguyên tử, chỉ xác nhận đã lưu sau commit IndexedDB.
ACK chỉ chuyển row sang `ack_waiting_pull`; không ghi projection, không đẩy pull cursor lên receipt cursor.
Giữ row đó trong optimistic union tới khi pull có đúng ID/hash; khi ấy chuyển vào shadow rồi bỏ row outbox nguyên tử.
Số pending UI đếm operation nghiệp vụ chưa ACK, **gồm blocked/quarantine chưa được thay thế**; không đếm command con, retry hoặc ack-waiting.
ACK/pull trễ không xóa event local mới, không sửa form đang gõ; thao tác Lưu form tạo event mới theo clock hiện tại.
Một leader sync theo owner giữa các tab, có recovery sau tab chết; tính đúng không phụ thuộc chỉ một HTTP request tồn tại.

## 9. Bootstrap và pull phân trang

Bootstrap capture `H=head` đã commit dưới khóa owner rồi nhả khóa; trả epoch, token và schema/reducer version.
Trang bootstrap đọc immutable operation có `cursor <= H`, sắp cursor tăng, không cần giữ transaction HTTP dài.
Client stage event/replay vào generation mới; chỉ swap shadow/epoch/cursor=`H` sau đủ trang và kiểm tra hash.
Giữ outbox đúng owner, gồm ack-waiting; trộn lại bằng ID/hash, không vứt pending khi snapshot đổi.
Khi epoch đổi do restore, giữ toàn bộ union event cũ cùng outbox trong journal phục hồi; rebootstrap không được xóa các event từng được ACK.
Đối chiếu theo owner/ID/hash với prefix mới; event cùng owner còn thiếu được gửi lại bằng envelope gốc bất biến, theo dependency, rồi pull đủ trước khi kết thúc phục hồi.
Hash trùng ID khác nội dung là lỗi integrity cần xử lý; không tự chọn một bản hoặc gửi event owner khác.
Response cũ phải có guard generation để không ghi vào bootstrap mới.

Pull đầu với `after=C` capture highwater `H`; continuation giữ nguyên `H` dù server tiếp tục nhận event.
Token ràng buộc owner, epoch, `H`, vị trí và version, hết hạn sau **30 phút**; token hết hạn khởi động phiên phân trang mới và giữ journal/outbox.
Trang bootstrap/pull trả `epoch`, `through_cursor=H`, `next_cursor`, `next_page_token` nullable, `has_more`, `groups:[{cursor,committed_at,operation}]`.
`committed_at` là timestamp server UTC để chẩn đoán, nằm ngoài author envelope và không tham gia `K`.
Giới hạn mặc định 200 group/8 MiB; không cắt operation; một nhóm hợp lệ luôn vừa giới hạn operation.
`next_cursor` là cursor cuối thực nhận; trang cuối không còn event trong khoảng có thể tiến tới `H`.
Ghi events, replay touched state và cursor trang trong một transaction IndexedDB.
Không lấy receipt/head cursor làm pull cursor vì có thể bỏ event thiết bị khác.
Các request HTTP riêng không chia sẻ InnoDB snapshot; immutable prefix tới `H` là cơ sở nhất quán. [Consistent reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-consistent-read.html).

## 10. Lỗi, version và kiểm chứng bắt buộc

Lỗi dùng `application/problem+json`: type/title/status/detail/instance cùng code, operation ID, retryable và field errors. [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html).
`401/403`: dừng sync tới khi đúng owner/phiên/quyền hợp lệ; giữ dữ liệu local.
`409 dependency_missing`: retry sau dependency; `409 operation_id_reused`: lỗi integrity, không đổi ID để giấu lỗi.
`409 client_update_required`: giữ queue, cập nhật client; `409 cursor_epoch_mismatch`: bootstrap giữ pending.
`422 validation_failed|time_invalid|invalid_causality`: giữ operation lỗi, hiển thị hành động phù hợp; không chặn operation độc lập.
`429/503`: exponential backoff có jitter, tối đa năm phút, tôn trọng Retry-After; trigger reconnect/mở app đánh thức retry.
Mất response sau commit là trạng thái chưa biết: retry cùng envelope, không tạo operation thay thế.
Batch trả kết quả từng operation; từng operation có transaction riêng; lỗi auth/envelope toàn request không báo operation thành công giả.
Lỗi semantic được reducer quyết định tại edit order thành no-op recorded; không từ chối dựa trên projection ở thứ tự arrival.
Protocol/reducer/command version tường minh; unknown version ngừng replay/push, giữ queue và yêu cầu update.
Adapter cho event cũ phải xác định, giữ envelope/hash/ID/time gốc; không thay nghĩa reducer đang tồn tại.
Migration IndexedDB giữ journal/outbox nguyên tử; triển khai server phải tiếp nhận authored v1 trong phạm vi hỗ trợ đã công bố.

Các kiểm chứng triển khai: hoán vị arrival/retry cho cùng tập event cho cùng projection; equal-time delete; clock lệch/offline lâu; occurrence trước/sau edit/stop; deleted override không sống lại; detached không trùng; nhiều root rebalance all-or-none; undo bị vô hiệu an toàn; ACK mất/trễ và local edit mới; owner lock rollback; bootstrap/pull đang có ghi mới; expiry/version/auth không mất queue.
Đây là tiêu chí bắt buộc cho các task triển khai, chưa phải tuyên bố test sản phẩm đã pass.
