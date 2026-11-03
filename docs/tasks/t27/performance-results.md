# T27 — Kết quả benchmark hiệu năng desktop

## Tóm tắt

Đo UI production trên Chromium với 1.200 dấu mốc và 168 mục lịch tuần. Các thay đổi grouping đem lại kết quả hỗn hợp nhưng cải thiện điều hướng tuần và lịch năm ở cả hai viewport; phép đo projection refresh giảm median nhẹ. Đặc tả không đặt ngưỡng latency, nên kết quả được ghi nhận để so sánh và không dùng làm tiêu chí đạt/trượt.

## Môi trường và phương pháp

| Thuộc tính | Giá trị |
| --- | --- |
| Hệ điều hành | Windows 11 Home 10.0.26300 x64 |
| CPU | 12th Gen Intel(R) Core(TM) i7-12700H |
| Logical CPU / RAM | 20 / 15.7 GB |
| Browser | Chromium 156.0.8078.4 |
| Viewport | 1024×768 và 1920×1080 |
| Dataset | 24 chuỗi lặp hàng ngày, 168 occurrence hiển thị tuần; 1.200 dấu mốc, 20 cùng ngày; 1.198 dấu mốc trong năm 2026 và hai dấu mốc ngoài năm ở hai phía ranh giới |
| Mỗi scenario / viewport | 3 lượt khởi động, sau đó 20 lượt đo |
| Long task | `PerformanceObserver`, entry từ 50 ms trở lên; ghi số lượng và tổng duration |
| Layout shift | `PerformanceObserver`; CLS cộng các entry không có `hadRecentInput` |

| Bản đo | Commit ứng dụng | Thời điểm ghi artifact (UTC) |
| --- | --- | --- |
| Baseline | `f412e69506b5d18844bcb9e60e6a3edc9fd4fcd3` | 2026-11-03 21:23:07.772Z |
| Optimized | `3077ef2711e723ccacb9de7c9e78b74bb40a8141` | 2026-11-03 21:41:11.499Z |

Artifact optimized được ghi sau baseline. Lượt baseline chạy với hai component lịch tại SHA `f412e69`; SHA đó được truyền riêng vào metadata trong lúc nhánh checkout giữ nguyên ở revision optimized. Harness Playwright dùng cùng một source test và workload cho cả hai lượt. Đây là một lượt đo tuần tự cho mỗi revision, không có lượt lặp độc lập hoặc A/B đan xen.

Lệnh đo production:

```powershell
$env:DAYFORGE_RUN_DENSITY_BENCHMARK = '1'
$env:DAYFORGE_DENSITY_BENCHMARK_PHASE = 'baseline' # đổi thành optimized cho lượt sau
$env:DAYFORGE_DENSITY_BENCHMARK_SHA = 'f412e69506b5d18844bcb9e60e6a3edc9fd4fcd3' # chỉ đặt cho baseline
pnpm --filter @dayforge/frontend exec playwright test --config=playwright.production.config.ts tests/calendar-density.spec.ts --grep productionDensityBenchmark
```

Mỗi artifact JSON ghi thêm viewport, scenario, thống kê median/p95, CPU profile và metadata máy. Lệnh tương đương được chạy với `DAYFORGE_DENSITY_BENCHMARK_PHASE=optimized`, source tại SHA `3077ef2`, và không đặt override SHA.

## Thời gian tương tác

Mỗi ô ghi `median/p95 ms`, theo thứ tự **baseline → optimized**.

### 1024×768

| Scenario | Duration median/p95 ms |
| --- | ---: |
| Mở tuần hiện hành | 51.3/69.5 → 49.7/59.9 |
| Điều hướng một tuần | 135.0/165.9 → 114.2/135.4 |
| Mở danh sách ngày dấu mốc | 50.4/60.0 → 56.5/68.3 |
| Mở danh sách ngày từ lịch tháng | 57.2/68.2 → 56.7/72.3 |
| Mở lịch dấu mốc năm | 70.2/77.9 → 69.4/78.8 |
| Refresh projection | 237.8/317.0 → 248.9/320.2 |

| Scenario | Long task count median/p95 | Long task total ms median/p95 | CLS median/p95 | Layout-shift count median/p95 |
| --- | ---: | ---: | ---: | ---: |
| Mở tuần hiện hành | 0/0 → 0/0 | 0/0 → 0/0 | 0/0.01 → 0.01/0.01 | 0/1 → 1/1 |
| Điều hướng một tuần | 0/0 → 0/0 | 0/0 → 0/0 | 0/0 → 0/0 | 0/0 → 0/0 |
| Mở danh sách ngày dấu mốc | 0/0 → 0/0 | 0/0 → 0/0 | 0/0 → 0/0 | 0/0 → 0/0 |
| Mở danh sách ngày từ lịch tháng | 0/0 → 0/0 | 0/0 → 0/0 | 0/0 → 0/0 | 0/0 → 0/0 |
| Mở lịch dấu mốc năm | 0/0 → 0/0 | 0/0 → 0/0 | 0.02/0.02 → 0.02/0.02 | 2/2 → 2/2 |
| Refresh projection | 1/1 → 1/1 | 74/88 → 75/88 | 0.12/0.12 → 0.12/0.12 | 2/2 → 2/2 |

### 1920×1080

| Scenario | Duration median/p95 ms |
| --- | ---: |
| Mở tuần hiện hành | 52.7/82.1 → 48.2/70.3 |
| Điều hướng một tuần | 115.2/152.0 → 109.4/132.0 |
| Mở danh sách ngày dấu mốc | 52.0/59.0 → 54.8/58.8 |
| Mở danh sách ngày từ lịch tháng | 57.1/70.7 → 63.5/71.5 |
| Mở lịch dấu mốc năm | 84.7/97.8 → 71.7/133.4 |
| Refresh projection | 236.3/324.4 → 232.2/288.8 |

| Scenario | Long task count median/p95 | Long task total ms median/p95 | CLS median/p95 | Layout-shift count median/p95 |
| --- | ---: | ---: | ---: | ---: |
| Mở tuần hiện hành | 0/0 → 0/0 | 0/0 → 0/0 | 0.02/0.35 → 0.02/0.35 | 1/1 → 1/2 |
| Điều hướng một tuần | 0/0 → 0/0 | 0/0 → 0/0 | 0/0 → 0/0 | 0/0 → 0/0 |
| Mở danh sách ngày dấu mốc | 0/0 → 0/0 | 0/0 → 0/0 | 0/0 → 0/0 | 0/0 → 0/0 |
| Mở danh sách ngày từ lịch tháng | 0/0 → 0/0 | 0/0 → 0/0 | 0/0 → 0/0 | 0/0 → 0/0 |
| Mở lịch dấu mốc năm | 0/0 → 0/0 | 0/0 → 0/0 | 0/0 → 0/0 | 2/2 → 2/2 |
| Refresh projection | 1/1 → 1/1 | 74/80 → 72/117 | 0.05/0.05 → 0.05/0.05 | 2/2 → 2/2 |

## Thay đổi đã đo

- Nhóm thẻ tuần và dấu mốc theo ngày bằng accumulator `Map`/array `push`, tránh sao chép lại toàn bộ mảng mỗi khi thêm phần tử.
- Nhóm dấu mốc năm theo tháng trong một lượt duyệt thay vì lọc toàn bộ dữ liệu 12 lần.
- Không sửa reducer hoặc hợp đồng đồng bộ; thứ tự render và identity nghiệp vụ được giữ nguyên.

Median điều hướng tuần giảm 20.8 ms ở 1024×768 và 5.8 ms ở 1920×1080; p95 cũng giảm ở cả hai viewport. Median mở lịch năm giảm 0.8 ms và 13.0 ms, nhưng p95 tại 1920×1080 tăng từ 97.8 lên 133.4 ms. Projection refresh chậm hơn 11.1 ms median ở 1024×768 và nhanh hơn 4.1 ms ở 1920×1080; long-task total p95 tại viewport lớn tăng từ 80 lên 117 ms dù duration p95 giảm. Các thao tác mở ngày có biến động hai chiều. Kết quả ủng hộ cải thiện điều hướng tuần, nhưng chưa chứng minh cải thiện ổn định cho mọi workload. Chỉ projection refresh phát sinh long task trong các lượt đo; CLS và số layout shift của scenario này không đổi.

## Kiểm chứng

| Lệnh | Kết quả |
| --- | --- |
| `pnpm lint:web` | PASS |
| `pnpm typecheck:web` | PASS |
| `pnpm build:web` | PASS |
| `pnpm --filter @dayforge/frontend exec playwright test tests/reducer-parity.spec.ts` | 13 passed |
| `pnpm --filter @dayforge/frontend exec playwright test --config=playwright.production.config.ts tests/calendar-density.spec.ts --grep-invert productionDensityBenchmark` | 4 passed |
| `pnpm --filter @dayforge/frontend exec playwright test --config=playwright.production.config.ts tests/calendar-density.spec.ts --grep productionDensityBenchmark` | 1 passed; 12 viewport/scenario combinations, 20 measured runs each |
| `git diff --check` | PASS |

CPU profile được thu trong production Chromium tại viewport 1024×768. Một số frame chiếm mẫu cao nhất là `(program)` hoặc tên hàm đã rút gọn như `B`; profile không ánh xạ đủ tốt về source function để kết luận một hàm reducer cụ thể là bottleneck. Không có thay đổi reducer dựa trên các profile này.

## Giới hạn diễn giải

- `open-work-week` đổi query ngày bằng History API trên component đã mount; số đo là thời gian cập nhật anchor/render tuần trong app đang mở, không phải cold route load, đăng nhập hay khởi động app.
- `projection-refresh` phát event owner-state để đọc lại projection local qua test harness. Test chặn `/api/v1/sync/**`; kết quả không đo latency mạng/server sync thật.
- Các phép đo chạy trên một máy và mỗi revision có một lượt benchmark; median/p95 mô tả lần chạy đó, không phải cam kết hiệu năng hoặc kiểm định thống kê.
- Mỗi revision chỉ có một lượt benchmark. Sai khác giữa các lượt có thể đến từ biến động máy/browser; xem kết quả theo từng scenario và không gán mọi chênh lệch cho code.
- Mọi test semantic density và reducer parity được chạy riêng với benchmark. Artifact JSON có metric đầy đủ và được giữ trong `frontend/.test-artifacts/t27/` của checkout; không đưa binary/trace vào commit.
