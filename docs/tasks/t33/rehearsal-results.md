# T33 rehearsal status

Ngày cập nhật: **04/11/2026** (Asia/Bangkok).

**Trạng thái:** harness và result validator đã được chuẩn bị; acceptance trên môi trường thật vẫn `TARGET_PENDING`. Người dùng xác nhận hiện chưa có staging target được phê duyệt, nên chưa chạy deploy, email thật, backup/restore trên host, A/B browser rehearsal hoặc edge cutover. Không có candidate staging SHA/digest để ghi PASS.

## Kiểm tra harness cục bộ

- Python unit tests cho rehearsal runner, result validator, deploy/rollback: chạy sau khi hoàn tất code; xem lệnh/kết quả trong CI hoặc session report đi kèm PR T33.
- Frontend TypeScript typecheck và Playwright `--list`: xác nhận code biên dịch và release config cô lập đúng 11 test; đây không phải browser acceptance trên target.
- Ruff lint: phải pass trước merge.
- Disposable MySQL interruption/roll-forward fixture: **chưa chạy**. Docker CLI hiện không thể mở Docker Desktop engine (`permission denied` với pipe `dockerDesktopLinuxEngine`). Không đổi quyền Docker/khởi động hạ tầng trong lần chạy này.

Kết quả cục bộ của lần hoàn thiện harness: 31 Python unit tests PASS, 1 Windows symlink test SKIP vì symlink creation không khả dụng; Ruff check/format PASS; TypeScript typecheck PASS; ESLint các release spec/fixture PASS; Playwright discovery PASS với 11 release tests. Không có Playwright browser test hoặc MySQL integration test được chạy.

## Ma trận acceptance

Candidate binding và kết quả từng case được ghi trong [compatibility matrix](../../deployment/compatibility-matrix.json). Các trường release A/B vẫn để trống cho đến khi có target và digest đã duyệt.

Mỗi dòng bắt đầu `TARGET_PENDING`. Local typecheck, Playwright discovery, validator unit tests hoặc MySQL giả lập không được chuyển các case cần origin thật sang PASS. RF-01 chỉ được validator chấp nhận sau khi disposable MySQL fixture chứng minh partial DDL vẫn fail readiness rồi roll-forward tới `0004_sync` thành công.

| Case | Kết quả yêu cầu | Trạng thái |
| --- | --- | --- |
| UP-01 | Draft chưa lưu hoãn service worker switch; A vẫn được duyệt | `TARGET_PENDING` |
| UP-02 | Pending ciphertext giữ nguyên qua A→B | `TARGET_PENDING` |
| UP-03 | Lost ACK retry gửi lại envelope byte-identical và chỉ có một hiệu ứng | `TARGET_PENDING` |
| UP-04 | Tab frozen không bị tính là đồng ý cập nhật | `TARGET_PENDING` |
| UP-05 | Asset/install lỗi giữ build A hoạt động | `TARGET_PENDING` |
| UP-06 | Flight response gắn build A; asset A-only còn phục vụ từ previous web (`late-flight`, `previous-static`) | `TARGET_PENDING` |
| RB-01 | Rollback tương thích giữ write B và DB revision hiện tại | `TARGET_PENDING` |
| RB-02 | Revision không tương thích chặn rollback trước activation | `TARGET_PENDING` |
| RF-01 | Interrupted MySQL DDL giữ readiness fail; repair fixture đã xác minh rồi roll-forward thành công | `TARGET_PENDING` |
| DR-01 | Snapshot S vào target thứ hai; cùng origin/profile giữ E1/E2 ACK-shadow, P0 và draft rồi hội tụ epoch mới | `TARGET_PENDING` |

Khi có staging target, chạy theo [upgrade/rollback runbook](../../deployment/upgrade-rollback.md), giữ output root ngoài repo và lưu evidence kín. Chỉ báo PASS sau khi `scripts/validate_rehearsal_results.py` exit 0 với đúng release manifests A/B cuối cùng.
