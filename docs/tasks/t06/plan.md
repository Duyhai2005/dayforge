# T06 — Dựng khung Next.js server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dựng hai route lịch, route tài khoản và callback email, nền giao diện cùng widget điều hướng có quản lý trạng thái/focus; tạo shell công khai để T13 bổ sung cache offline.

**Architecture:** Giữ Next.js App Router chạy trên Node theo T04. Hai route lịch dùng chung layout và widget phía client; trạng thái khoảng xem mã hóa trong URL để Back/Forward hoạt động, sở thích riêng từng lịch lưu trong sessionStorage. Route tài khoản/callback tách khỏi layout lịch, callback xóa token fragment ngay khi khởi tạo và không tự xác minh/reset.

**Tech Stack:** Node.js 24.22.1, pnpm 12.16.1, Next.js 16.4.3, React 19.3.1, TypeScript 6.0.3, `@playwright/test` 1.64.1 (dev dependency); CSS thuần và API trình duyệt hiện có.

**Spec:** `docs/tasks/t02/design.md`, `docs/tasks/t03/auth-contract.md`, `docs/tasks/t04/plan.md`, `docs/tasks/README.md`.

## Global Constraints

- Runtime: Node.js `24.22.1`; pnpm `12.16.1`; Next.js `16.4.3`; React `19.3.1`; TypeScript `6.0.3`.
- Kiến trúc: Next.js chạy server/Node; giữ rewrite `/api/v1/*` của T04.
- Múi giờ làm việc: `UTC+07:00`; tuần bắt đầu thứ hai và kết thúc chủ nhật.
- Token UI theo T02: nền `#141C22`, lớp ngoài `#10171C`, panel `#202C30`, chữ chính `#E6ECE7`; font `Segoe UI, Arial, sans-serif`; max content khoảng `1540px`.
- Không header/sidebar cố định; bố cục desktop 1024–1920px; vùng lịch hẹp được cuộn ngang, widget không che cuối trang.
- Shell chung chỉ có code/tài nguyên và trạng thái UI công khai; không cache/render dữ liệu owner, session, token hoặc nội dung lịch riêng.
- T06 không triển khai auth/API nghiệp vụ, IndexedDB, sync hay service worker; không hiển thị trạng thái lưu/sync thành công giả. Các phần đó thuộc T08/T09/T13.
- Kiểm thử tương tác trình duyệt dùng `@playwright/test` `1.64.1` như dev dependency, không thêm dependency runtime.
- Callback email dùng `/verify-email#token=...` và `/reset-password#token=...`; GET không tiêu thụ token, callback dùng `Cache-Control: private, no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer`, không có analytics bên thứ ba.

## Review Focus

- Ngày UTC+07:00 đổi ngày khi máy ở timezone khác — kiểm thử trong Task 2 với thời điểm hai phía nửa đêm UTC.
- Query ngày/scale sai hoặc storage bị chặn/hỏng — kiểm thử trong Task 2; dùng mặc định hợp lệ.
- Điều hướng Back/Forward hoặc đổi lịch nhiều lần — kiểm thử trong Task 2/3; phục hồi đúng view, scale, vị trí cuộn và focus.
- Token callback lộ qua URL, DOM, storage hay request tự động — kiểm thử trong Task 4; xóa fragment và không POST trước thao tác xác nhận (callback T06 chưa có thao tác consume).
- API tắt nhưng shell báo thành công hoặc trắng trang — kiểm thử route/build trong Task 1/5; shell mở độc lập và không khẳng định auth/sync.

---

### Task 1: Route, shell và token giao diện

**Files:**
- Modify: `frontend/app/layout.tsx`, `frontend/app/page.tsx`, `frontend/package.json`, `pnpm-lock.yaml`
- Create: `frontend/playwright.config.ts`, `frontend/app/(calendar)/layout.tsx`, `frontend/app/(calendar)/work/page.tsx`, `frontend/app/(calendar)/milestones/page.tsx`, `frontend/app/globals.css`
- Test: `frontend/tests/routes.spec.ts` (Playwright browser test)

**Interfaces:**
- Produces: `/` redirect tới `/work`; route `/work`, `/milestones`; layout lịch với vùng nội dung chính có `id="calendar-main"`, `tabIndex={-1}` và tiêu đề trang.

- [ ] Thêm dev dependency `@playwright/test@1.64.1`; cấu hình webServer Next dev trên port `3010`, `API_INTERNAL_ORIGIN=http://127.0.0.1:8000`, baseURL `http://127.0.0.1:3010`; nếu đặt `PLAYWRIGHT_BASE_URL`, dùng server production đã chạy.
- [ ] Viết test Playwright cho `/`, `/work`, `/milestones`: root redirect tới `/work`; hai trang lịch 200, có tiêu đề tiếng Việt và không chứa dữ liệu lịch giả.
- [ ] Chạy `pnpm --filter @dayforge/frontend exec playwright test tests/routes.spec.ts` trước triển khai; xác nhận root/route assertion thất bại.
- [ ] Tạo shell và route khung, không thêm nội dung lịch giả; route lịch dùng chung layout và metadata tiếng Việt.
- [ ] Tạo token/layout desktop theo Global Constraints; không có header/sidebar cố định, vùng lịch cuộn ngang khi cần, có đệm cuối trang cho widget.
- [ ] Chạy `pnpm --filter @dayforge/frontend exec playwright test tests/routes.spec.ts` và `pnpm build:web`; cả hai phải đạt. Commit deliverable với subject `feat: add calendar route shell`.

### Task 2: Ngày, URL và lịch sử điều hướng

**Files:**
- Create: `frontend/lib/calendar/view-state.ts`, `frontend/tests/view-state.spec.ts`
- Modify: `frontend/app/(calendar)/work/page.tsx`, `frontend/app/(calendar)/milestones/page.tsx`

**Interfaces:**
```ts
export type CalendarKind = "work" | "milestones";
export type MilestoneScale = "week" | "month" | "year";
export type ViewState = { calendar: CalendarKind; anchor: string; scale: MilestoneScale };
export function todayInUtc7(now: Date): string;
export type ViewPreference = { anchor: string; scale: MilestoneScale; scrollY: number };
export function parseViewState(pathname: string, search: URLSearchParams, now: Date, preference: ViewPreference | null): ViewState;
export function readPreference(calendar: CalendarKind, storage: Storage): ViewPreference | null;
export function writePreference(calendar: CalendarKind, preference: ViewPreference, storage: Storage): void;
export function serializeViewState(view: ViewState): string;
export function moveAnchor(view: ViewState, direction: -1 | 1): ViewState;
```
- Ngày dùng định dạng `YYYY-MM-DD`; lịch công việc luôn scale `week`; lịch dấu mốc nhận `week|month|year`. `serializeViewState` trả pathname kèm query đã sắp theo thứ tự `date`, rồi `scale` (chỉ lịch dấu mốc).
- Ngày query phải hợp lệ theo lịch thực; query field hiện diện nhưng sai dùng mặc định hôm nay UTC+07:00 hoặc scale `month` cho field đó.
- Với query field bị thiếu, `parseViewState` dùng field tương ứng từ preference hợp lệ; nếu không có preference thì ngày hôm nay/scale `month`. Query field hiện diện nhưng không hợp lệ dùng mặc định kể cả khi preference có giá trị.
- Query dùng `date=YYYY-MM-DD` và, ở lịch dấu mốc, `scale=week|month|year`. Giá trị hợp lệ trong URL ưu tiên trường tương ứng; thiếu giá trị khôi phục từ sở thích nếu hợp lệ, nếu không dùng hôm nay/`month`; giá trị hiện diện nhưng sai dùng mặc định cho trường đó.
- Query thay đổi tạo history entry và Back/Forward phục hồi route/ngày/scale.
- Sở thích lưu riêng từng lịch bằng `sessionStorage`, không lưu nội dung nghiệp vụ; khóa chính xác `dayforge:view:v1:work` và `dayforge:view:v1:milestones`, JSON shape `{anchor,scale,scrollY}`; work luôn scale `week`. Storage lỗi/hỏng thì bỏ qua và dùng mặc định.

- [ ] Viết test với các assertion cụ thể: `todayInUtc7RollsAtBangkokMidnight` (`2026-10-29T16:59:59.999Z` → `2026-10-29`; `2026-10-29T17:00:00.000Z` → `2026-10-30`); `parseViewStateUsesPreferenceOnlyForMissingFields` (`/milestones?scale=year` + preference `{anchor:"2026-01-31",scale:"month",scrollY:80}` → anchor `2026-01-31`, scale `year`); `parseViewStateDefaultsInvalidFields` (`/milestones?date=2026-02-30&scale=decade`, now `2026-10-29T00:00:00.000Z` → anchor `2026-10-29`, scale `month`, bỏ preference); `moveAnchorPreservesEndOfMonth` (`2026-01-31` + month → `2026-02-28`); `moveAnchorClampsLeapDay` (`2024-02-29` + year → `2025-02-28`); `readPreferenceRejectsMalformedOrUnavailableStorage` (JSON hỏng hoặc `getItem` throw → `null`); `writePreferenceUsesCalendarSpecificKey` (work writes `dayforge:view:v1:work`, milestones writes `dayforge:view:v1:milestones`, scroll `80.8` writes `81`). Playwright `calendarHistoryRestoresRouteDateAndScale`: navigate work `?date=2026-01-31`, then milestones `?date=2026-02-28&scale=year`, browser back restores first URL and forward restores second.
- [ ] Chạy `pnpm --filter @dayforge/frontend exec playwright test tests/view-state.spec.ts` trước triển khai; xác nhận các test hàm/route thất bại vì module hoặc route wiring chưa có.
- [ ] Cài đặt sáu hàm trong `view-state.ts`; phép tính dùng UTC calendar date, `week` cộng/trừ 7 ngày, `month` cộng/trừ một tháng và giữ ngày trong tháng (clamp tới ngày cuối nếu thiếu), `year` giữ tháng/ngày và clamp 29/2 sang 28/2 ở năm không nhuận.
- [ ] Nối trạng thái vào hai route và URL; lùi/tiến thay đổi khoảng phù hợp scale chỉ áp dụng dấu mốc.
- [ ] Đọc preference all-or-nothing; validate `anchor` là ngày lịch thực, `scale` thuộc enum (work phải `week`), `scrollY` là số hữu hạn không âm. Khi ghi, làm tròn/clamp `scrollY` thành số nguyên không âm; JSON lỗi và mọi exception từ storage đều không được throw ra UI.
- [ ] Chạy `pnpm --filter @dayforge/frontend exec playwright test tests/view-state.spec.ts` và `pnpm build:web`; xác nhận ngày, scale, storage, Back/Forward và TypeScript/build đạt. Commit `feat: add calendar view state navigation`.

### Task 3: Widget, tương tác và focus

**Files:**
- Create: `frontend/components/calendar/calendar-widget.tsx`, `frontend/components/calendar/calendar-view.tsx`
- Modify: `frontend/app/(calendar)/layout.tsx`, `frontend/app/(calendar)/work/page.tsx`, `frontend/app/(calendar)/milestones/page.tsx`, `frontend/app/globals.css`
- Test: `frontend/tests/calendar-widget.spec.ts` (Playwright browser test; Playwright là dev dependency từ Task 1)

**Interfaces:**
- Consumes: `ViewState`, `serializeViewState`, `moveAnchor` từ Task 2.
- Produces: widget thu gọn/mở, điều hướng lịch/khoảng/scale, focus theo route; link `/account`.

- [ ] Viết kiểm thử cho mở/thu widget, Escape, click ngoài, chuyển lịch, lùi/tiến, hôm nay, scale dấu mốc, focus đích và focus trả về.
- [ ] Chạy `pnpm --filter @dayforge/frontend exec playwright test tests/calendar-widget.spec.ts` trước triển khai; xác nhận test thất bại.
- [ ] Tạo widget giữa cạnh dưới theo T02; panel mở chứa chuyển lịch, điều hướng, scale dấu mốc, mục thêm và tài khoản.
- [ ] Chỉ bật tương tác đã có: chuyển route, thời gian, scale, mở `/account`; thao tác tạo chưa triển khai phải disabled và giải thích ngắn, không tạo kết quả giả.
- [ ] Chuyển lịch thu panel và focus vùng nội dung đích; Escape/click ngoài trả focus nút mở; đổi khoảng/scale giữ panel mở.
- [ ] Dùng button native, accessible name, `aria-expanded`, focus ring 2px offset 3px; reduced-motion vẫn giữ chức năng.
- [ ] Chạy `pnpm --filter @dayforge/frontend exec playwright test tests/calendar-widget.spec.ts`; xác nhận bàn phím/chuột, focus và trạng thái reduced-motion. Commit `feat: add calendar navigation widget`.

### Task 4: Route tài khoản và callback email an toàn

**Files:**
- Create: `frontend/app/(account)/account/page.tsx`, `frontend/app/(account)/verify-email/page.tsx`, `frontend/app/(account)/reset-password/page.tsx`
- Modify: `frontend/next.config.ts`; `headers()` áp callback headers chính xác cho `/verify-email` và `/reset-password`.
- Test: `frontend/tests/auth-routes.spec.ts` (Playwright route/header/browser test)

**Interfaces:**
- Produces: `/account`, `/verify-email`, `/reset-password`; callback loại token khỏi URL ngay khi khởi tạo, chưa gọi API hoặc consume token.

- [ ] Viết HTTP test cho ba route trả 200; callback trả `Cache-Control: private, no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer`.
- [ ] Viết browser test mở URL có `#token=...`; sau hydrate fragment bị xóa, token không có trong DOM/storage/network request; GET không gọi API.
- [ ] Chạy `pnpm --filter @dayforge/frontend exec playwright test tests/auth-routes.spec.ts` trước triển khai; xác nhận route/header/callback chưa đạt.
- [ ] Tạo trang tài khoản và callback nền, copy tiếng Việt báo luồng đang được hoàn thiện; callback đọc token chỉ trong memory nếu cần và xóa fragment bằng `history.replaceState` ngay khi mount, không lưu token.
- [ ] Đặt header no-store/no-referrer chính xác cho callback; giữ nguyên rewrite `/api/v1/*`; không thêm analytics/script bên thứ ba.
- [ ] Chạy kiểm thử HTTP/trình duyệt và xác nhận trên production build. Commit `feat: add account and email callback shells`.

### Task 5: Kiểm chứng tích hợp và bàn giao T06

**Files:**
- Create: `docs/tasks/t06/review-and-verification.md`
- Modify: `docs/development.md`, `docs/tasks/README.md`

**Interfaces:**
- Consumes: route, view-state, widget và callback deliverables từ Tasks 1–4.
- Produces: báo cáo kết quả T06 và mô tả phạm vi bàn giao cho T07–T13.

- [ ] Chạy `pnpm verify:env`, `pnpm build:web`, `pnpm --filter @dayforge/frontend exec playwright test`; ghi lệnh và kết quả thực tế.
- [ ] Khởi chạy production server ở port `3001`, đặt `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001` để chạy route/callback tests với production build; chạy lại smoke HTTPS same-origin T04 với API hoạt động.
- [ ] Kiểm tra bàn phím, focus, Escape, Back/Forward, reduced motion, layout laptop/desktop và Cốc Cốc nếu môi trường có; ghi rõ mục chưa chạy.
- [ ] Cập nhật development guide và trạng thái T06; chỉ đánh dấu hoàn thành khi checks bắt buộc đạt hoặc ngoại lệ được ghi rõ.
- [ ] Ghi bàn giao: T08/T09 chuyển trạng thái xem tạm sang lưu theo thiết bị/owner và làm auth thật; T13 làm cache shell offline; T07 tích hợp runner/CI.
- [ ] Commit `docs: record T06 verification and handoff`.