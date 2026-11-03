# T12 — LWW và khôi phục đồng bộ

Ngày lập: **02/11/2026** · Cập nhật **03/11/2026**: **Reducer parity, clock repair, hai epoch recovery, crash khi reupload, sáu calibration có browser wall-clock skew và quota thật trong journal/bootstrap staging đã kiểm chứng; còn thiếu quota generation publish và diễn tập clock OS vật lý**. Xem [trạng thái triển khai](implementation-status.md).

Bản chỉnh sau review **02/11/2026**: tách originals đã được thay thế khỏi active union, dùng revision guard cho recovery và kiểm chứng observed HLC cùng T11.

**Mục tiêu:** Cùng một tập operation phải hội tụ về một kết quả trên client/server, bất kể thứ tự gửi/retry; phục hồi clock lỗi, bootstrap và server restore mà vẫn giữ dữ liệu đã lưu local.

**Căn cứ:** [Sync contract T03](../t03/sync-contract.md), [data contract T03](../t03/data-contract.md), [HTTP contract](../t03/api-contract.md), [schema/ví dụ](../t03/design.md), [plan T11](../t11/plan.md), [nghiệm thu](../../project-definition/06-delivery-and-acceptance.md).

## 1. Điều kiện bắt đầu và ranh giới

T12 cần T11 đã vận chuyển/nhận event an toàn, canonical reducer v1 chạy được trên client, T08 lưu transaction mã hóa và T10 có event log/receipt/reducer server. Trong checkout khảo sát lúc lập kế hoạch (`65480f2`), các phần này chưa tồn tại. Nền đó và một phần T11/T12 đã được triển khai sau đó; xem [trạng thái hiện tại](implementation-status.md).

T11 chịu trách nhiệm đường sync và các bất biến ngay từ đầu. T12 mở rộng kiểm chứng hội tụ, sửa sai khác reducer giữa hai runtime và hoàn thiện recovery. Không triển khai một thuật toán LWW thứ hai; local save, remote ingest, bootstrap, undo và recovery đều dùng cùng semantics T03. Nếu fixture phát hiện schema/Markdown mâu thuẫn, sửa bộ hợp đồng có đối chiếu trước khi thay semantics.

UI tạo/chỉnh chuỗi hoàn chỉnh thuộc T21–T22; T12 vẫn phải kiểm tra mọi action v1 mà server chấp nhận bằng fixture/harness. Không lùi tính nguyên tử và semantics chuỗi tới khi có UI.

## 2. Những quy tắc phải giữ

| Quy tắc | Yêu cầu |
| --- | --- |
| Edit order | `K = (physical_ms, logical, delete_rank, device_id_bytes, operation_id_bytes)`; delete/stop chỉ được ưu tiên khi cả physical và logical bằng nhau. |
| Replay | Fold toàn bộ tập event owner theo K; late event chèn về vị trí đúng. Semantic no-op vẫn recorded và có thể đổi ảnh hưởng sau replay. |
| Replacement | Thay toàn bộ payload target, không trộn trường. Sửa occurrence không thay snapshot cả family. |
| Atomic group | Kiểm tra precondition trên state trước cả operation; mọi command cùng áp dụng hoặc toàn nhóm no-op. |
| Xóa/phục hồi | Plan/single/milestone còn addressable có thể phục hồi theo replacement mới hơn; family tombstone chỉ hồi bằng undo hợp lệ. Không tự restart chuỗi từ occurrence edit. |
| Receipt | Chỉ xác nhận recorded; `effect_at_commit` không quyết định projection hiện tại. ACK/retry không đổi K hoặc cursor pull. |
| Integrity | Cùng ID khác hash dừng nhánh có vấn đề và giữ evidence; không tự chọn bản hoặc đổi ID để lờ lỗi. |
| Recovery | Giữ cả shadow event từng ACK, outbox, bản nháp/overlay và hash gốc; không xóa IDB hoặc reauthor âm thầm. |
| Active và diagnostics | Union nghiệp vụ chỉ gồm recorded shadow + active outbox theo T11. Originals chưa recorded đã được reauthor hợp lệ chuyển sang kho chẩn đoán mã hóa với `superseded_by`; không replay/push/tính pending/gửi lại khi restore. Không lọc event recorded chỉ vì receipt có `effect_at_commit: superseded`. |
| Snapshot và clock | Recovery dùng prepare/compare-and-swap theo `local_state_revision` T11; crypto ngoài transaction commit. HLC chỉ observe recorded event hợp lệ; lane mới không lấy clock từ quarantine/diagnostics. |

Không có màn hình chọn bản xung đột. Thao tác **Lưu lại sau sửa giờ thiết bị** là hành động sửa lỗi thời gian đã quy định ở T03, không phải yêu cầu người dùng phân xử hai bản LWW.

## 3. Bản đồ thay đổi dự kiến

| Vùng/file | Trách nhiệm |
| --- | --- |
| `frontend/lib/sync/reducer.ts` và helpers chuẩn hóa/hash | Hoàn thiện cùng reducer đã dùng ở T11; giữ semantics authored v1. |
| `frontend/lib/sync/clock.ts`, `clock-recovery.ts` | Phát hiện interval lỗi, quarantine, staging reauthor có guard và lane mới. |
| `frontend/lib/sync/recovery.ts`, `bootstrap.ts` | Journal theo owner, đối chiếu ID/hash và phục hồi khi đổi epoch. |
| Storage modules/migration T08 thực tế | Journal, staging, kho chẩn đoán originals với `superseded_by`; commit/swap mã hóa qua owner/lock gate và revision CAS T11. Chọn schema version kế tiếp từ code bàn giao. |
| `frontend/tests/sync-lww.spec.ts`, `sync-recovery.spec.ts`, fixture dùng chung | Arrival permutations, cross-runtime hash, clock và restore/crash. |
| Tests sync/reducer backend T10 thực tế | Chạy cùng corpus fixture, sửa parity bugs ở nguồn; không chỉ điều chỉnh phía client cho test qua. |
| Provider trạng thái và `docs/tasks/t12/review-and-verification.md` | Pending/quarantine/recovery rõ ràng, bằng chứng và giới hạn. |

## 4. Các bước triển khai

### Bước 1 — Corpus đối chiếu client/server

- [ ] Dùng JSON Schema/ví dụ T03 làm đầu vào cấu trúc; bổ sung fixture ngữ nghĩa có envelope, thứ tự K, projection, root/bucket hash và expected no-op reason.
- [ ] Mỗi fixture chạy qua reducer Python T10 và TypeScript T11, so cùng canonical DTO/hash. Expected state phải được đối chiếu hợp đồng, không sinh từ chính reducer đang kiểm tra.
- [ ] Phủ mọi action v1, uint64/rank lớn, UUID byte-order, null/default tường minh, Unicode tiếng Việt, segment provenance và tombstone; không dùng locale/string sort thay số/byte.
- [ ] Hoán vị toàn bộ arrival cho tập nhỏ, thêm retry/duplicate; với tập lớn dùng seed cố định và giữ seed gây lỗi. So final state, hash và danh tính target, không đòi receipt effect lịch sử phải giống nhau giữa các arrival.

**Đạt khi:** hai runtime cho cùng kết quả chuẩn; test có thể phát hiện reducer chỉ append theo arrival hoặc dùng cursor làm LWW.

### Bước 2 — Sửa–sửa, xóa–sửa và nhóm nhiều root

- [ ] Kiểm tra edit-time cũ đến muộn, hai HLC bằng nhau, logical khác nhau và delete-rank/UUID tie-break đúng thứ tự; không ưu tiên delete khi logical thấp hơn.
- [ ] Kiểm tra replacement toàn payload: ngày/buổi/title/note/kết quả không thành một bản lai. Sửa hai target độc lập phải cùng được giữ.
- [ ] Kiểm tra replacement mới hơn tombstone còn addressable, family đã retired và root-create được undo; ID reservation/payload/catalog không biến mất.
- [ ] Kiểm tra precondition trước nhóm, dependency causality và lỗi một command làm cả nhóm no-op; operation độc lập không bị chặn.
- [ ] Kiểm tra rebalance nhiều root: root hash + bucket hash phát hiện phantom insert; `user_reorder` và `rank_maintenance` giữ đúng content exception/rank-only semantics.

**Đạt khi:** hội tụ đúng qua cả push thật và replay local, không phụ thuộc một request leader duy nhất.

### Bước 3 — Chuỗi, provenance và undo

- [ ] Occurrence identity luôn theo root + original date; occurrence đã dời vẫn tìm thấy ở đích và không xuất hiện hai lần.
- [ ] `series.edit_future`: detach mọi live replacement tương lai theo original date, kể cả đã dời/hoàn thành; giữ dữ liệu/kế hoạch/kết quả, suppress slot gốc; deleted override không thành child sống.
- [ ] Rank-maintenance không tạo detached child; carry rank-only override chỉ khi successor vẫn sinh slot và giữ period/order template đúng T03.
- [ ] `series.stop_future`: gỡ attached member tương lai kể cả đã dời, giữ lịch sử trước cutoff và detached child. Occurrence edit mới hơn đi theo detached mapping hoặc `target_retired`, không tự tiếp tục chuỗi.
- [ ] Kiểm tra source origin đã kết thúc, cutoff theo born-from date và edit cấu trúc mới hợp lệ sau stop; không đòi source vẫn nằm trong active interval.
- [ ] Undo: toàn bộ root/hash và latest effective modifying operation phải hợp lệ; inverse không làm reference sống mồ côi. Late event có thể vô hiệu undo an toàn; không sửa event/receipt cũ hoặc quay lùi cursor.

**Đạt khi:** fixture chuỗi cho cùng projection/hash ở client/server qua các arrival; sẵn sàng bàn giao T21–T23 mà không cần UI chuỗi ở T12.

### Bước 4 — Clock lỗi và quarantine

- [ ] Test guard server: tối đa năm phút tương lai; không trước account-created trừ biên năm phút; không giới hạn tuổi offline hợp lệ. Receipt lookup phải đi trước clock guard.
- [ ] Test wall/monotonic jump trên 120 giây, restart offline lùi giờ và recalibration lệch trên 120 giây; giữ đúng evidence/calibration gốc, không tự đẩy timestamp.
- [ ] Kiểm chứng đường observe T11: pull event recorded có HLC hợp lệ đi trước UTC local, rồi sửa tiếp sau reload/từ tab khác phải có HLC/K lớn hơn event đã thấy. Bootstrap/recovery publish merge observed HLC cùng cursor và revision; diagnostics/quarantine không được nhiễm vào lane mới.
- [ ] Quarantine interval nghi vấn cùng mọi descendant dependency; giữ nguyên envelope/snapshot/overlay, pending vẫn tính; nhánh độc lập tiếp tục sync. Không cho HLC nhiễm lỗi trở thành seed của operation độc lập mới.
- [ ] Với request có thể đã recorded nhưng mất response, retry **nguyên envelope** để xác định receipt/rejection trước khi xét reauthor; timeout không chứng minh chưa ghi.
- [ ] Sau hành động rõ ràng **Lưu lại sau sửa giờ thiết bị**, lấy calibration tin cậy, tạo device ID/lane HLC/sequence mới; chỉ seed từ clock tin cậy và recorded server event đã xác thực.
- [ ] Stage replacement chain cho tập xác định chưa recorded, theo dependency; đổi ID/time operation và remap mọi operation reference, gồm undo original ID cùng segment/provenance reference dẫn xuất. Giữ root/occurrence/detached ID.
- [ ] Dựng canonical pre-state gốc, kiểm tra guard gốc và so semantic state/target dưới mapping tường minh. Chỉ tính lại root/bucket/undo hash khi chứng minh tương đương; không sao chép hash cũ hoặc bỏ guard.
- [ ] Prepare replacement chain cùng ciphertext ngoài transaction; commit bằng revision CAS T11, kiểm tra lại canonical pre-state/owner/lock/lane/generation và update gate nếu có. State đổi giữa lúc kiểm chứng và commit thì abort staging write set, đọc lại và chứng minh tương đương lại; không xuất bản projection chuẩn bị từ snapshot cũ.
- [ ] Trong cùng commit, đưa replacement chain đã kiểm chứng vào active outbox/overlay, chuyển originals chưa recorded sang kho chẩn đoán mã hóa với `superseded_by`, cập nhật references/revision và pending count. Originals giữ nguyên envelope/hash/snapshot để tra cứu, ngoài replay, push và recovery-upload; không còn nằm trong active outbox. Chỉ semantic receipt `superseded` của server không cho phép chuyển event recorded sang diagnostics.
- [ ] Thiếu pre-state, mất phiên hoặc chưa chứng minh tương đương thì giữ nhánh đó cùng các nhánh phụ thuộc trong quarantine active với overlay gốc; cho mở dữ liệu hiện hành để sửa thành thao tác mới, không tự chọn conflict. Không archive originals khi replacement chưa commit thành công.

**Đạt khi:** không mất bản local và không biến bản sửa cũ thành mới chỉ vì reconnect; một operation có receipt không bao giờ bị reauthor.

### Bước 5 — Epoch restore, rebootstrap và tương thích

- [ ] Trước rebootstrap do epoch mismatch, ghi journal bền gồm toàn bộ union active cũ: recorded shadow, active outbox kể cả ack-waiting, cursor/epoch và dữ kiện phục hồi của đúng owner; vẫn mã hóa theo vault. Kho diagnostics được giữ nguyên riêng để tra cứu, không đưa originals có `superseded_by` vào danh sách replay/gửi lại.
- [ ] Tải prefix server mới vào generation riêng, giữ projection/overlay cũ cho tới khi đủ dữ kiện; guard response owner/lock/generation.
- [ ] Đối chiếu theo owner + operation ID + hash, gồm mọi recorded event đã ACK trước restore và active pending. Recorded event thiếu ở server mới cùng active operation đủ điều kiện phải gửi lại bằng envelope gốc theo dependency; quarantine/blocked chưa được thay thế tiếp tục giữ overlay nhưng không tự gửi khi chưa giải quyết lỗi. Không lấy originals chẩn đoán làm recovery candidate và không chỉ xét row còn trong outbox.
- [ ] Nếu push recovery đổi epoch giữa chừng, giữ journal và lặp đối chiếu an toàn. Trùng ID khác hash giữ evidence/báo integrity; không merge hoặc overwrite tự động.
- [ ] Trước swap generation/dọn journal, đọc active outbox mới nhất và dùng revision CAS T11. Local save/draft/ACK/ingest xảy ra trong lúc tải prefix phải được merge hoặc làm write set cũ bị abort và tính lại; không chỉ dựa journal snapshot lúc bắt đầu recovery. Publish observed HLC từ recorded prefix cùng transaction.
- [ ] Chỉ kết thúc recovery khi các event đủ điều kiện cần khôi phục đã recorded và pull vào shadow đúng epoch, replay hội tụ, cùng các nhánh blocked được giữ rõ ràng; dọn staging/journal theo giao dịch có thể resume sau crash. Diagnostics vẫn nằm ngoài queue/pending và không bị kích hoạt lại sau reload.
- [ ] Unknown reducer/protocol giữ queue và ngừng replay/push; adapter cũ xác định và giữ nguyên envelope/hash/time. Migration thất bại rollback, không reset schema để chạy tiếp.

**Đạt khi:** restore server không làm biến mất event từng ACK chỉ còn trên thiết bị; reload/lock/mất mạng ở mọi checkpoint đều tiếp tục phục hồi được.

### Bước 6 — Nghiệm thu và bàn giao

- [ ] Chạy kịch bản hai thiết bị offline sửa cùng target, reconnect theo hai thứ tự ngược nhau, thêm mất response/ACK trễ và pull chồng local edits.
- [ ] Chạy server restore/epoch mới trên DB test cô lập có chủ đích; kiểm tra nội dung event thực và local journal trước/sau, không dùng DB cá nhân.
- [ ] Chạy corpus reducer ở cả hai runtime cùng integration suite; ghi bằng chứng từng nhóm cùng case chưa chạy và lý do.
- [ ] Cập nhật runbook recovery, mapping lỗi cho T25, fixture T23/T28 và dữ liệu upgrade/rollback cho T33; chỉ đánh dấu T12 khi phạm vi bắt buộc có kết quả.

## 5. Ma trận kiểm chứng bắt buộc

| Nhóm | Ca tối thiểu / bằng chứng |
| --- | --- |
| Hội tụ | A sửa trước, B sửa sau; đảo arrival, duplicate và retry; cùng final DTO/hash trên hai client và server. |
| Tie-break | Physical bằng/logical khác; cả HLC bằng và delete/replace; UUID gần nhau để phát hiện string/locale sort sai. |
| Xóa–sửa | Cũ không phục hồi xóa mới; mới hơn phục hồi đúng loại target; retired family không sống lại do edit thường. |
| Atomic | Command thứ hai lỗi; phantom insert vào bucket; không có projection nửa nhóm. |
| Chuỗi | Dời khác tuần, edit-future, stop, deleted override, detached mapping và rank-only override qua nhiều arrival. |
| Undo | Có sửa xen vào; Plan vẫn được tham chiếu; undo-create giữ tombstone/catalog; late event làm undo no-op an toàn. |
| Clock | Fast/slow/jump/restart offline lâu; receipt cũ sau clock guard đổi; invalid interval + dependency descendants. |
| Reauthor | Nhánh có receipt không đổi; nhánh chưa recorded đổi lane/refs/hash đúng; thiếu pre-state phải giữ quarantine. |
| Originals đã thay thế | A lỗi clock được thay bằng B, sau đó sửa C: A chỉ còn diagnostics; B/C ở active union, C thắng đúng K; reload/restore không gửi lại hoặc đếm pending cho A. |
| Revision recovery | Local save/draft/ACK xen giữa prepare và swap/reauthor làm CAS retry; dữ liệu mới không mất và originals không bị archive nửa chừng. |
| Observed HLC | Event remote đi trước UTC local được observe bền; thao tác sau reload/tab khác lớn hơn event đã thấy, lane sửa clock không lấy max từ diagnostics/quarantine. |
| Restore | Event từng ACK mất ở server sau restore được gửi lại; hash collision không tự chọn bản; epoch đổi lần nữa vẫn resume. |
| Crash/owner | Crash trước/sau stage/swap; logout tab khác; quota; không mất ciphertext/pending hoặc ghi qua epoch cũ. |
| Version | Client không hiểu reducer mới, migration lỗi, page token hết hạn: giữ dữ liệu, không fake sync success. |

Liên quan chính: **AC-24–AC-26, AC-29**, đồng thời củng cố AC-22/AC-23/AC-27/AC-30/AC-33–AC-35. Phần UI lặp và nghiệm thu đầy đủ vẫn cần T23/T28.

## 6. Lệnh nghiệm thu và điều kiện hoàn thành

Dùng `pnpm lint`, `pnpm typecheck`, `pnpm test:api`, `pnpm test:api:mysql`, `pnpm test:web`, `pnpm build:web`, `pnpm test:web:prod`; gắn corpus cross-runtime và fault/recovery runner vào CI, ghi entrypoint thực sau khi bổ sung. Schema validator T03 chỉ kiểm tra tài liệu/payload, không thay test semantics.

T12 hoàn thành khi parity/hội tụ và recovery thật đạt ma trận, không có nhánh silently dropped, có báo cáo tái lập. Không tuyên bố biết chính xác thứ tự ngoài đời khi hai đồng hồ offline sai, hoặc đã nghiệm thu deploy/restore production từ test cô lập.
