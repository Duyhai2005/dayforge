# T12 — Trạng thái triển khai

Cập nhật: **03/11/2026** · Trạng thái: **Reducer parity, clock repair, browser clock-skew nhiều vòng, quota thật ở local writer/recovery journal/bootstrap staging và epoch recovery đã kiểm chứng; còn quota generation publish và nghiệm thu clock trên thiết bị/OS đích**.

## Đã triển khai

- Python reducer v1 xử lý plan, milestone, single work item, recurrence family, occurrence/detached edits, series edit/stop, guarded `set_order` và undo; backend sync hiện tính receipt outcome từ reducer trong transaction của T10.
- Replay theo khóa K của T03; operation group rollback khi no-op, tombstone giữ addressability, precondition root/bucket được kiểm tra trước cả nhóm, dependency và reference integrity được xác thực.
- Undo yêu cầu dependency, root/hash đầy đủ và operation hiệu lực mới nhất; late edit làm undo thành no-op. Undo xóa root mới tạo giữ tombstone và provenance catalog.
- Clock calibration lấy ba mẫu, quarantine nhánh lỗi clock/dependency; recovery epoch journal giữ union local trước bootstrap. Journal cũ được thay nguyên tử khi tạo journal mới và chỉ xóa cùng transaction publish generation phục hồi. Luồng **“Lưu lại sau sửa giờ thiết bị”** trong tài khoản yêu cầu đăng nhập/vault mở, lấy calibration mới, chuẩn bị lane/ID mới, remap dependency/provenance và tính lại root/bucket guard. `commitClockReauthorBatch` kiểm tra fresh calibration, dependency closure, semantic equivalence, owner/fence/revision CAS; originals được chuyển sang diagnostics mã hóa cùng transaction. Operation có receipt hoặc kết quả không chắc chắn không được reauthor.
- Fixture JSON dùng chung cho **18 action v1**, gồm basic LWW, đầy đủ vòng đời milestone, recurrence/detached, UUID byte tie-break, undo hợp lệ/no-op muộn và `set_order` root/bucket guards cùng rank int64 lớn; mỗi scenario có expected projection tĩnh và chạy ở cả TypeScript lẫn Python.

## Kiểm chứng đã chạy

- `tests/unit/test_reducer.py`: **12 passed**; toàn bộ fixture kiểm tra **1.724 arrival permutations** so với expected projection độc lập. Thử rank `9223372036854775807` hợp lệ, vượt signed int64 bị từ chối; expected effects/no-op reasons vẫn được assert theo thứ tự fixture. MySQL integration: **45 passed**.
- `tests/reducer-parity.spec.ts`: **9 passed** trên cùng corpus và **1.724 permutation** ở TypeScript; wire test nhận uint64 tối đa cho device sequence/cursor như decimal string và từ chối giá trị vượt giới hạn. Clock reauthor preparation: **1 passed** với guard root, lane mới, trusted HLC và giữ nguyên semantic projection.
- Reducer checks gồm rollback nguyên operation nhiều root khi command tham chiếu lỗi, occurrence đã dời được detach ở series edit, `series.stop_future`, và `set_order` bị từ chối khi phantom insert làm đổi bucket hash.
- `pnpm test:sync:browser`: integration disposable MySQL/Chromium mô phỏng server restore, cấp epoch mới và reset cursor; trong khi bootstrap recovery đầu tiên chờ, server restore lần hai. Ở lượt chạy hiện tại, cả hai device giữ đúng **10 operation ID/hash** đã ACK, upload lại envelope gốc, hội tụ ở epoch cuối và kết thúc với outbox/journal rỗng. Recovery publication xóa journal trong cùng owner revision/CAS transaction. Fault hook abort transaction persist journal trước commit; revision, cursor, shadow và journal đều giữ nguyên.
- Cùng runner kiểm tra đầy đủ clock repair: operation future bị từ chối `time_invalid`, quarantine; endpoint push trả rejection đúng thay vì 500; client lấy ba mẫu clock gắn với device lane mới, đổi lane + calibration + replacement outbox trong một CAS, archive operation gốc trong diagnostics, rồi sync replacement tới client kia. Backend guard cũng xác nhận calibration ID thuộc lane mới.
- Test MySQL đã seed `head_cursor=UINT64_MAX-1`, cấp/pull cursor cuối dưới dạng decimal string, trả receipt `duplicate` ổn định khi retry, từ chối operation kế tiếp bằng 503 và xác nhận head/event không bị ghi nửa chừng.
- Bộ `tests/integration/test_sync_log.py` cũ dựa vào model/migration T10 trùng lặp đã được gỡ khi rebase. Các kiểm tra MySQL về push hiện ở `tests/integration/test_sync_push.py`; browser runner reset epoch bằng schema `develop` hiện hành và cần được chạy lại trước khi kết quả trước rebase được xem là xác nhận cho tích hợp mới.
- Bổ sung vào runner Chromium/MySQL: A và B lần lượt chạy sáu calibration thật qua endpoint `/sync/clock` với browser wall clock được skew +4, -3, -6, +2 phút rồi đưa về 0; mỗi cycle nhận calibration ID mới và offset được kiểm tra với server time. Sau đó mutation qua HLC đã hiệu chỉnh vẫn sync/replay được trên hai thiết bị. Đây là clock skew được điều khiển trong browser runtime, không phải thay đổi đồng hồ hệ điều hành của hai máy vật lý.
- Quota scenario production Chromium giới hạn origin để ép mutation local lớn nhận `QuotaExceededError`; revision/outbox/projection không đổi. Scenario recovery bổ sung ép lỗi quota thật khi journal copy draft mã hóa 600 KB và khi bootstrap staging ghi 200 event lớn; revision/journal/staging đều được kiểm tra không đổi và không còn dòng một phần. Generation publish hiện có fault-injection abort/reload, chưa có bằng chứng ép `QuotaExceededError` thật.
- Ruff, mypy, Black, TypeScript và ESLint pass.

## Còn thiếu để nghiệm thu T12 trên thiết bị đích

Ghi chú cập nhật: các mục fault injection/reload tại bootstrap staging và recovery publish trong snapshot ban đầu đã được thực hiện; phần cập nhật cuối tài liệu ghi rõ kết quả lượt mới.

- Chưa chạy diễn tập bằng đồng hồ hệ điều hành lệch trên hai máy vật lý. Bằng chứng hiện tại dùng hai Chromium/device lane, MySQL thật và wall-clock skew được điều khiển trong tab.
- Chưa ép quota thật trong transaction generation publish (bootstrap/recovery swap). Tại đây hiện có abort/reload coverage; quota thật đã kiểm tra rollback ở local writer, recovery journal và bootstrap staging.

**Kết luận:** reducer client/server có corpus parity; hai browser device lane phục hồi union **10 operation** đã ACK qua hai epoch restore MySQL và dọn journal nguyên tử. Clock repair/reauthor chạy đầu-cuối cho `time_invalid`; sáu calibration với wall-clock skew và quota thật ở local writer, journal, bootstrap staging đã có bằng chứng. Giới hạn còn lại là đồng hồ OS vật lý và quota ngay tại generation publish. Xem [runbook recovery](recovery-runbook.md).

## Cập nhật sau lượt kiểm chứng cuối · 03/11/2026

- Runner `pnpm test:sync:browser` hiện abort transaction thật tại bootstrap staging và epoch-recovery publish, reload sau từng abort, rồi xác nhận A khôi phục union và B giữ lại shadow khi bootstrap prefix chứa các operation ID đã có. Hai epoch restore được chạy trong cùng scenario.
- Ca này phát hiện transaction publish ghi shadow mới rồi xóa shadow cũ cùng khóa IndexedDB, khiến cursor tiến nhưng shadow biến mất. `publishEpochRecoveryStage` và `publishBootstrapStage` nay chỉ xóa shadow cũ không được prefix mới thay thế.
- Ở thời điểm cập nhật đó còn thiếu clock drift đa thiết bị, quota IndexedDB và crash trong recovery reupload; phần crash recovery reupload đã được kiểm chứng trong lượt bổ sung bên dưới.

## Cập nhật bổ sung · 03/11/2026

- Trong ca epoch recovery, runner giữ response của recovery reupload sau khi MySQL đã ghi event, đóng tab leader rồi mở tab mới trên cùng profile/IndexedDB. Tab mới lấy lease với fencing token cao hơn, gửi lại body byte-identical, nhận `duplicate`, phục hồi event và tiếp tục hoàn tất recovery cùng thiết bị thứ hai.
- Clock drift ở đây được mô phỏng bằng `Date.now` của browser runtime; chưa thay cho thay đổi clock ở OS/máy vật lý.
