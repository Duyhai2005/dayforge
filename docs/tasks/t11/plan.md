# T11 — Bộ đồng bộ phía client

Ngày lập: **02/11/2026** · Cập nhật **03/11/2026**: **Client sync, MySQL/Chromium reconnect, quota IndexedDB và takeover sau khi tab idle suspend qua ba TTL đã kiểm chứng; còn thiếu thao tác lịch qua UI và nghiệm thu browser/OS đích**. Xem [trạng thái triển khai](implementation-status.md).

Bản chỉnh sau review **02/11/2026**: làm rõ active outbox/diagnostics, commit theo revision local và cập nhật HLC khi nhận event remote; bổ sung ca kiểm chứng cho từng điểm.

**Mục tiêu:** Khi app mở hoặc mở lại, tự gửi thay đổi local và nhận event server của đúng owner; retry, nhiều tab, reload và phản hồi trễ không làm mất dữ liệu hoặc tạo tác dụng trùng.

**Căn cứ:** [Danh sách task](../README.md), [sync contract T03](../t03/sync-contract.md), [HTTP contract T03](../t03/api-contract.md), [auth/vault contract](../t03/auth-contract.md), [data contract](../t03/data-contract.md), [quy ước code](../../CONVENTION.md).

## 1. Hiện trạng và điều kiện bắt đầu

Checkout được khảo sát lúc lập kế hoạch ở `develop`, commit `65480f2`. T07 đã có quality gates; frontend có shell hai lịch và callback trung tính. Tại snapshot đó chưa có code IndexedDB/vault T08, auth T09, sync API/reducer server T10 hoặc bộ sync client. Nền các task này và một phần T11 đã được triển khai sau đó; xem [trạng thái hiện tại](implementation-status.md). Bản kế hoạch T09 không tự nó là bằng chứng nghiệm thu.

| Đầu vào | Cần bàn giao trước khi tích hợp |
| --- | --- |
| T08 | Giao dịch mã hóa theo owner; outbox, shadow, cursor, HLC/sequence; owner gate, `lock_epoch` và revision local dùng chung mọi writer; prepare/encrypt ngoài transaction rồi kiểm tra revision khi commit; migration không mất dữ liệu; thông báo local commit. |
| T09 | Session verified owner, CSRF cùng origin, unlock/lock vault, pending logout ticket và lock hook liên tab; hết phiên vẫn dùng local. |
| T10 | `/version`, `/sync/clock`, `/sync/bootstrap`, `/sync/push`, `/sync/pull`; epoch, phân trang prefix, receipt bất biến; reducer v1 và fixture có expected projection/hash. |

Tên file/hàm của phần nhận từ T08–T10 phải đối chiếu code đã bàn giao, không tạo lớp lưu trữ hoặc xác thực thứ hai chỉ để khớp tên trong plan. Có thể chuẩn bị test/transport trước; chưa đánh dấu T11 xong khi các đầu vào này còn thiếu hoặc chỉ được mock.

## 2. Phạm vi và bất biến

- Dùng Next.js/TypeScript hiện có, IndexedDB/Web Crypto từ T08 và Playwright từ T07. Không thêm dependency nếu API sẵn có đáp ứng được.
- Mọi mutation vẫn được tạo và lưu nguyên tử qua T08; coordinator chỉ vận chuyển operation đã commit. Retry giữ nguyên ID, owner, hash, payload và edit-time.
- `K` quyết định nghiệp vụ; commit cursor chỉ dùng nhận event. Cursor/sequence uint64 xử lý không mất chính xác, wire vẫn là chuỗi thập phân.
- UI được tính bằng canonical replay của union `recorded_shadow` và **active outbox**: `queued|sending|blocked|ack_waiting_pull` chưa được thay thế local, gồm quarantine còn hiệu lực; khử trùng theo ID/hash. Originals đã được T12 thay thế có `superseded_by` chỉ nằm trong kho chẩn đoán mã hóa, ngoài active outbox; không replay, push, tính pending hoặc gửi lại khi restore. `effect_at_commit: superseded` là chẩn đoán server khác với `superseded_by` local: mọi event recorded vẫn giữ trong shadow/replay.
- ACK chỉ đổi outbox sang `ack_waiting_pull`; không cập nhật shadow hoặc pull cursor. Chỉ xóa row outbox khi pull/bootstrap đã có đúng ID/hash, trong cùng giao dịch nhận event.
- Mọi kết quả chuẩn bị từ snapshot local phải kiểm tra lại `local_state_revision`, owner, lock epoch, sync generation, cursor/epoch đầu vào và fencing token cần thiết trong transaction commit; khi có T13 còn kiểm tra build/update gate. Revision thay đổi thì bỏ write set cũ và tính lại từ snapshot mới. Abort request là tối ưu, không phải bảo đảm phản hồi cũ đã biến mất.
- Chỉ báo đã lưu sau commit local; pending đếm operation nghiệp vụ active chưa ACK, gồm blocked/quarantine chưa được thay thế, không đếm diagnostics, retry, command con hoặc ack-waiting. Trạng thái đang tải event/khôi phục tách khỏi xác nhận ACK.
- Nhận event recorded hợp lệ phải cập nhật mốc HLC đã quan sát cùng giao dịch nhận event/cursor. Operation mới có HLC lớn hơn mốc local và recorded đã quan sát theo T03; không đổi edit-time của operation cũ hoặc lấy originals/quarantine làm nguồn clock tin cậy.
- Hết phiên dừng sync, giữ vault/pending. Logout chủ động dừng coordinator, khóa qua T09 và bỏ dữ liệu trong memory. Không gửi outbox bằng session owner khác.
- T11 phải có canonical replay v1 hoạt động trước nghiệm thu; T12 bổ sung kiểm chứng hội tụ toàn diện và phục hồi. Không dùng reducer giả hoặc trì hoãn chống ghi đè ACK tới T12.

Ngoài phạm vi: cache/service worker (T13), UI nhập liệu/lặp hoàn chỉnh (T14–T23), hoàn thiện widget trạng thái (T25), background sync khi app đóng hẳn và email production.

## 3. Bản đồ thay đổi dự kiến

| Vùng/file | Trách nhiệm |
| --- | --- |
| `frontend/services/sync.ts` | HTTP cùng origin/no-store, CSRF, DTO và Problem; không để component tự gọi raw endpoint. |
| `frontend/lib/sync/protocol.ts`, `clock.ts` | Kiểu dữ liệu/validation wire, limits/version và calibration/HLC; tái sử dụng primitive T08 nếu đã có. |
| `frontend/lib/sync/coordinator.ts`, `leadership.ts`, `retry.ts` | Lifecycle, một leader mỗi owner, recovery khi tab chết và lịch thử lại. |
| `frontend/lib/sync/outbox.ts`, `ingestion.ts`, `bootstrap.ts` | Chọn dependency/batch; ACK, nhận trang và đổi generation nguyên tử. |
| `frontend/lib/sync/reducer.ts` | Canonical reducer v1, JCS/hash và adapter event dùng chung các luồng local/remote; dùng lại module T08 nếu đã có. |
| Storage facade/migration thực tế từ T08 | Active outbox và diagnostics tách biệt; `local_state_revision`, observed HLC và primitive prepare/compare-and-swap dùng chung local save, ACK, ingest, bootstrap và recovery. |
| Provider lịch và storage/auth modules đã bàn giao | Khởi động/dừng sync, phát trạng thái, kiểm tra lock epoch; giữ page tập trung composition. |
| `frontend/tests/sync-*.spec.ts`, helpers/fixtures | Test transport, nhiều tab, giao dịch và hai browser context với API thật. |
| `docs/tasks/t11/review-and-verification.md`, runbook, CI nếu cần | Bằng chứng chạy, giới hạn và cách tái lập môi trường test cô lập; xem [báo cáo kiểm chứng](review-and-verification.md). |

## 4. Các bước triển khai

### Bước 1 — Khóa đầu vào và bộ kiểm chứng

- [ ] Ghi lại phiên bản schema/storage/auth/reducer thực tế của T08–T10; chốt adapter tại ranh giới thay vì đổi hợp đồng T03.
- [ ] Chốt snapshot/revision contract với T08: mọi writer làm đổi union/projection, outbox/receipt, cursor, HLC, draft hoặc recovery state đều tăng `local_state_revision` của owner trong cùng commit. Heartbeat lease thuần kỹ thuật không cần tăng revision nghiệp vụ nhưng phải kiểm tra fencing riêng.
- [ ] Thêm fixture operation, receipt và SyncPage theo JSON Schema T03, gồm batch thành công một phần và payload lỗi.
- [ ] Dựng harness chỉ trong môi trường test: gọi đúng mutation/storage API T08, owner gate T09 và reducer sản phẩm; không thêm endpoint CRUD hoặc đường bypass phục vụ test.
- [ ] Tạo runner tích hợp khởi động API + Next.js + MySQL cô lập, owner test đã xác minh và hai browser context có storage riêng. Mock transport chỉ dùng cho fault injection có chủ đích.

**Đạt khi:** test phân biệt được row đã commit local, đã ACK và đã vào shadow; môi trường tích hợp không chạm DB dev hoặc cần secrets production.

### Bước 2 — Transport, tương thích và clock

- [ ] Xây client API dùng credentials cùng origin, `cache: "no-store"`, header JSON/CSRF đúng T03; kiểm tra owner của kết quả session trước sync.
- [ ] Kiểm tra protocol/reducer/limits qua `/version`; version không hiểu thì dừng push/replay, giữ queue và báo cần cập nhật.
- [ ] Hiệu chỉnh clock bằng ba mẫu `/sync/clock`, chọn RTT nhỏ nhất không quá 10 giây; giữ anchor monotonic và evidence theo T03. HLC/sequence cấp cùng transaction mutation T08, không cấp khi retry.
- [ ] Khi ingest/publish bootstrap hoặc recovery, validate owner/version/envelope rồi merge HLC của recorded event vào mốc đã quan sát trong cùng commit. Khi tạo operation mới, physical lấy max của UTC ước lượng, local HLC và observed HLC; logical vượt mọi logical có physical trùng max, hoặc về 0 nếu UTC mới lớn hơn hết theo T03. Dùng state persisted qua reload/tab khác, không sửa timestamp operation đã commit và không dùng quarantined/diagnostic event để seed lane mới.
- [ ] Ghi rõ trạng thái khi offline/chưa có calibration tin cậy; giữ bản nhập/local operation và chặn phần không đủ điều kiện, không tự lấy giờ reconnect làm giờ sửa.
- [ ] Dùng fixture chuẩn T10 để kiểm tra reducer TypeScript cho toàn bộ action v1; port phần còn thiếu nếu T08 chưa cung cấp. JCS, UUID-byte ordering và semantic hash phải cùng kết quả server.

**Đạt khi:** serializer không sửa envelope đã lưu; unsupported version, sai hash/owner và clock lỗi không biến thành ACK giả.

### Bước 3 — Điều phối lifecycle và nhiều tab

- [ ] Tự đánh thức khi mở/mở lại, local commit, online, quay lại tab hoặc đăng nhập đúng owner. Dùng polling có khoảng nghỉ khi app mở để nhận sửa từ thiết bị khác dù local không có outbox; không busy loop.
- [ ] Một leader theo owner bằng lease IndexedDB có thời hạn/heartbeat và fencing token; có thể dùng Web Locks cho critical section ngắn khi hỗ trợ, không giữ khóa vô hạn quanh fetch. BroadcastChannel chỉ báo có thay đổi, không truyền payload lịch/key. Lease hết hạn cho phép tiếp quản cả khi tab cũ đang suspend.
- [ ] Khôi phục row `sending` bị bỏ dở khi leader chết bằng envelope cũ. Leader cũ mất lease không được cập nhật trạng thái bằng response trễ.
- [ ] Recheck owner/lock epoch khi resume/bfcache; hợp nhất trigger trùng. Background tab bị suspend không làm tab còn hoạt động kẹt vĩnh viễn.
- [ ] Trước login/sync mới, để T09 xử lý pending logout ticket. Lock hook chặn request mới, hủy request đang chờ và loại callback cũ; hết phiên chỉ chuyển auth-paused.

**Đạt khi:** hai tab cùng thao tác không cấp trùng sequence hoặc mất queue; đóng tab leader vẫn tiếp tục được, và đúng đắn vẫn giữ khi có request chồng lấn.

### Bước 4 — Push theo dependency và xử lý ACK

- [ ] Chọn operation chỉ từ active outbox theo DAG dependency; predecessor phải đã recorded hoặc đứng trước trong batch có thứ tự. Originals trong diagnostics không được trở lại hàng gửi hoặc được dùng thay dependency đã remap. Nhánh bị lỗi giữ blocked cùng hậu duệ; nhánh độc lập tiếp tục gửi.
- [ ] Đo đúng kích thước UTF-8/JCS và JSON body: tối đa 100 operation, 8 MiB/request, 2 MiB/operation, 1.000 command/operation. Không cắt operation hoặc payload để vừa batch.
- [ ] Ánh xạ từng result về đúng operation ID/hash; chỉ `recorded`/`duplicate` có receipt hợp lệ mới ACK. HTTP 200 hoặc `head_cursor` không đủ để xác nhận thành công.
- [ ] Commit receipt + trạng thái `ack_waiting_pull` qua owner gate; nếu pull đã nhận event trước ACK thì xử lý idempotent, không tái tạo row đã hoàn tất.
- [ ] Timeout/mất response sau commit: retry nguyên envelope; `dependency_missing` gửi dependency trước. `operation_id_reused` là lỗi integrity, không đổi ID để che lỗi.
- [ ] Backoff exponential có jitter, phần tính lùi tối đa năm phút, tôn trọng thời điểm `Retry-After` nếu dài hơn. Trigger online không được vượt hạn chờ server; lỗi validation/quyền không retry liên tục.

**Đạt khi:** commit rồi mất response chỉ có một tác dụng server; ACK cũ không làm mất operation vừa tạo sau đó.

### Bước 5 — Pull, bootstrap và transaction local

- [ ] Bootstrap stage vào generation mới từ prefix bất biến tới H; chỉ swap shadow/epoch/cursor sau đủ trang, validation và hash thành công. Giữ nguyên outbox/overlay đang dùng trong lúc tải.
- [ ] Pull dùng epoch + cursor đã commit local; continuation chỉ dùng page token của cùng phiên phân trang, giữ highwater H. Kiểm tra cursor tiến, thứ tự group, owner và version.
- [ ] Đọc snapshot nhất quán của shadow, active outbox, projection, HLC/cursor và `local_state_revision` trong transaction ngắn; đóng transaction rồi decrypt/replay/hash/encrypt write set bằng Web Crypto. Không giữ transaction IDB bằng cách `await` network/Web Crypto hoặc chia việc ghi cursor sang transaction khác.
- [ ] Mở transaction readwrite ngắn để so revision cùng owner/lock/generation/cursor/fencing/build gate của snapshot; chỉ enqueue thao tác IDB khi guard còn khớp. Ghi event + projection + observed HLC + cursor, receipt/outbox cần đổi và tăng revision nguyên tử. Guard lệch thì abort và prepare lại từ snapshot mới; lỗi quota, hash hoặc lock rollback toàn bộ trang. Chỉ báo hoàn tất sau transaction complete.
- [ ] Dùng cùng primitive prepare/compare-and-swap cho local mutation, ACK, publish bootstrap và các swap recovery T12. Khi người dùng lưu B hoặc một trang pull khác commit giữa prepare/commit, write set cũ không được xuất bản; bootstrap phải merge active outbox mới nhất, không dùng danh sách pending chụp lúc bắt đầu tải.
- [ ] Tái replay union theo K khi event cũ tới muộn; không append theo arrival hoặc chỉ thay projection một root khi chưa chứng minh tương đương.
- [ ] `page_token_expired`: pull tiếp từ cursor local đã commit; bootstrap bỏ staging chưa hoàn chỉnh và bắt đầu prefix mới an toàn. Response generation cũ không được swap.
- [ ] Epoch mismatch chuyển sang recovery của T12 và giữ journal chứa cả event từng ACK cùng pending. T11 chưa có recovery hoàn chỉnh phải dừng an toàn, không tự reset IDB.

**Đạt khi:** pull đang có ghi mới không bỏ event; crash giữa nhận trang và commit không tiến cursor một phần; remote cũ không đè local mới.

### Bước 6 — Kiểm chứng tích hợp và bàn giao

- [ ] Chạy đủ ca bên dưới với transport điều khiển được; chạy luồng hai thiết bị với API/MySQL thật, không chỉ stub response.
- [ ] Kiểm tra trạng thái lưu/sync qua hook/provider: chưa lưu, local đã lưu, pending, ack-waiting, offline, auth-paused, blocked và storage error; không sửa form đang gõ khi event tới.
- [ ] Chạy quality gates phù hợp; ghi lệnh, commit, số test và giới hạn vào báo cáo T11. Chỉ đánh dấu T11 sau khi có bằng chứng đạt phạm vi T11.
- [ ] Bàn giao T12 journal/clock/reducer interfaces; T13 hook pause/update và owner gate; T25 trạng thái/Problem tiếng Việt; T23/T28 các fixture tích hợp.

## 5. Ma trận kiểm chứng bắt buộc

| Ca | Kết quả phải quan sát |
| --- | --- |
| Mở app không có pending; thiết bị khác sửa | Leader tự pull, local hội tụ mà không cần thao tác lưu. |
| Tạo kế hoạch rồi task tham chiếu; lỗi một nhánh | Dependency đúng thứ tự, task không gửi sớm; nhánh độc lập không bị kẹt. |
| Mất response push; retry sau reload | Cùng ID/hash/time, một receipt/cursor server, không nhân bản. |
| Sửa B khi push A đang chờ; ACK A về sau | B còn trong union; ACK A không đẩy cursor hoặc ghi đè B. |
| Local save B xen giữa decrypt/replay/encrypt và commit pull/bootstrap | Revision mismatch buộc tính lại; B còn trong outbox và projection cuối, cursor không tiến từ write set lỗi. |
| Web Crypto bị trì hoãn; transaction commit bị abort | Không có `TransactionInactiveError` do chờ crypto trong transaction; mọi trường dữ liệu/cursor/HLC/receipt cùng commit hoặc rollback. |
| Đã pull event có HLC đi trước UTC local rồi sửa tiếp ở tab khác/sau reload | Observed HLC được giữ bền; HLC/K của operation mới lớn hơn event đã thấy mà không sửa envelope cũ. |
| A lỗi clock đã được thay bằng B; sau đó lưu C và restore server | A chỉ còn diagnostics, không replay/push/tính pending/gửi lại; C không bị timestamp lỗi A đè. |
| Pull A trước ACK A; ACK/pull trùng | Dedup idempotent, không hồi sinh row outbox đã hoàn tất. |
| Hai tab; kill/freeze leader; response leader cũ | Leader mới tiếp tục, response cũ bị fence, không mất row `sending`. |
| Trang pull có event cũ theo K và ghi server mới đồng thời | Replay lại đúng, continuation giữ H và phiên sau nhận phần còn lại. |
| Quota/crash/lock lúc commit trang | Event, projection và cursor cùng rollback; pending còn nguyên. |
| Bootstrap nhiều trang hết token; response generation cũ | Local đang dùng còn nguyên; chỉ generation đủ trang được swap. |
| 401/403, pending logout, đổi owner/lock ở tab khác | Dừng request đúng lúc, không lẫn dữ liệu; expiry không tự khóa vault. |
| 429/503/mạng chập chờn/batch partial failure | Tôn trọng retry; không ACK phần rejected hoặc spam server. |
| Unicode, uint64 lớn, operation sát giới hạn | Hash/byte count đúng; không cắt note/nhóm hoặc mất chính xác. |

Liên quan chính: **AC-21–AC-23, AC-26–AC-27**, cùng phần nền AC-29–AC-35. AC-19/AC-20 cần T13 và UI mutation; AC-24/AC-25 cần nghiệm thu T12. Không tuyên bố toàn bộ AC sản phẩm đạt từ harness.

## 6. Lệnh nghiệm thu và điều kiện hoàn thành

Sau khi thêm specs/runner, dùng các entrypoint T07: `pnpm lint`, `pnpm typecheck`, `pnpm test:api`, `pnpm test:api:mysql`, `pnpm test:web`, `pnpm build:web`, `pnpm test:web:prod`. Bộ tích hợp sync phải được gắn vào runner/CI với môi trường cô lập; các lệnh hiện có chưa tự chứng minh sync thật.

T11 hoàn thành khi sync thật hai context đạt ma trận thuộc phạm vi T11, replay v1 không dùng stub, ACK/pull an toàn và có báo cáo tái lập. Epoch/clock recovery đầy đủ được chốt tại T12; offline cold-start tại T13. Lập plan không đánh dấu task triển khai hoàn thành.

Tham khảo API điều phối cùng origin và thời gian giữ khóa: [MDN — Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API). Lease/fencing là lựa chọn triển khai của plan để phục hồi tab bị suspend, vẫn phải được kiểm chứng bằng ca nhiều tab ở trên.

Ranh giới prepare/commit phải tuân thủ [lifecycle transaction IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction); kiểm tra revision bảo vệ snapshot khi Web Crypto chạy ngoài transaction, không thay cho owner/lock gate.
