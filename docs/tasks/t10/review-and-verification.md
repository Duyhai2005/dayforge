# T10 — rà soát và kiểm chứng

Ngày cập nhật: **02/11/2026** · Branch/worktree: `codex/t10-sync-api`.

## Kết quả

| Hạng mục | Kết quả |
| --- | --- |
| Clock, push, bootstrap, pull; DTO và Problem theo T03 | Đạt API acceptance. |
| Verified owner, owner assertion, Origin/CSRF, no-store, log không chứa payload | Đạt API tests. |
| Giới hạn `/version`, media type và OpenAPI route list | Đạt API tests. |
| Owner isolation, epoch/cursor, dependency, idempotency, fixed watermark H, page cap/progress | Đạt MySQL integration tests. |
| Event, receipt, change-log và head rollback nguyên tử; race duplicate và cursor liên tục | Đạt MySQL integration tests. |
| Migration `0004_sync` và schema FK/index | Đạt MySQL integration và Alembic offline SQL. |
| Ý nghĩa `effect_at_commit` | **Chưa đạt T03:** giá trị mới đang là placeholder `applied`; cần kết quả reducer T12. T10 chưa được đánh dấu hoàn tất. |

## Lệnh và kết quả

Các test HTTP chạy bằng Python 3.14 venv cộng user site-packages qua `PYTHONPATH`. Cần chạy ngoài sandbox vì tạo asyncio loop trên Windows gọi local socketpair và bị sandbox chặn.

```powershell
$env:PYTHONPATH = 'C:\Users\ADMIN\AppData\Roaming\Python\Python314\site-packages'
& 'C:\WorkSpace\dayforge\backend\.venv\Scripts\python.exe' -m pytest tests/api -q
```

Kết quả: **114 passed**, 2 cảnh báo tương thích từ AnyIO/httpx.

```powershell
$env:PYTHONPATH = 'C:\Users\ADMIN\AppData\Roaming\Python\Python314\site-packages'
& 'C:\WorkSpace\dayforge\backend\.venv\Scripts\python.exe' scripts/test_backend.py --mysql -q
```

Kết quả: **87 passed, 285 deselected**, 2 cảnh báo, 658.26 giây. Runner tạo project MySQL cô lập với credential ngẫu nhiên và tự teardown.

Các kiểm tra khác:

- Tập sync unit: **28 passed**.
- Ruff: pass trên code/service/test liên quan.
- Mypy: `app/services/sync.py` pass.
- `compileall -q app tests`: pass.
- Black `--check --workers 1` theo từng file: pass.
- `python -m alembic upgrade head --sql`: pass; SQL đi qua `0003_auth_lifecycle_hardening -> 0004_sync` và tạo đủ bốn bảng sync.
- `git diff --check`: pass.

Lệnh monorepo theo plan không khởi chạy được trong sandbox:

- `pnpm verify:fast` và `pnpm test:api:mysql` dừng trong bước cài workspace khi PNPM không thể tạo symlink project vào store (`EPERM`). `uv` cũng không có trên PATH. Frontend lint/typecheck vì vậy chưa chạy trong lượt này.
- Lệnh Python MySQL runner bên trên chạy trực tiếp và hoàn tất toàn bộ 87 MySQL tests.

## T11 handoff — client coordinator

- Gọi `GET /api/v1/sync/clock`, `POST /api/v1/sync/push`, `GET /api/v1/sync/bootstrap` và `GET /api/v1/sync/pull` theo DTO T03.
- Lưu nguyên operation ID và envelope trước khi push. Khi mất response, retry cùng ID và đúng nội dung/hash; không đổi payload dưới cùng ID.
- `recorded`/`duplicate` receipt xác nhận event đã bền vững trên server. Không dùng `head_cursor` hoặc `commit_cursor` làm local pull cursor; chỉ tiến cursor sau khi lưu các group từ pull/bootstrap.
- Gửi dependency trước hậu duệ. `dependency_missing` không ACK; giữ pending data qua auth, epoch, expiry và lỗi retryable.
- Continuation chỉ gửi `page_token`; token gắn owner/endpoint/epoch/H/position/version và hết hạn sau 30 phút.

## T12 handoff — reducer và receipt effect

T10 giữ immutable envelope, receipt, change log và tombstone; chưa xây projection lịch hay canonical LWW reducer. T12 cần tính trạng thái effect thật (`applied`, `superseded`, `no_op` cùng reason) và đưa kết quả đó vào receipt khi commit. Trước khi reducer được tích hợp hoặc T03 được sửa theo version mới, client không được xem placeholder `applied` là kết quả nghiệp vụ. Sau khi xử lý khoảng trống này, chạy lại receipt, retry/idempotency và MySQL acceptance rồi mới đánh dấu T10 hoàn tất.
