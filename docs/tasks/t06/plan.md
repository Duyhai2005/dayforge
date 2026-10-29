# T06 — Dựng khung Next.js server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]` for incomplete and `- [x]` for complete) syntax for tracking.

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
- Motion theo T02: hover/press `120ms`, widget/modal `180ms`, route/scale `260ms`, focus outline `2px` offset `3px`; reduced motion dùng trạng thái tức thì hoặc fade tối đa `80ms` và bỏ translate/scale.
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

- [x] Thêm dev dependency `@playwright/test@1.64.1`; cấu hình webServer Next dev trên port `3010`, `API_INTERNAL_ORIGIN=http://127.0.0.1:8000`, baseURL `http://127.0.0.1:3010`; nếu đặt `PLAYWRIGHT_BASE_URL`, dùng server production đã chạy.
- [x] Viết test Playwright cho `/`, `/work`, `/milestones`: root redirect tới `/work`; hai trang lịch 200, có tiêu đề tiếng Việt và không chứa dữ liệu lịch giả.
- [x] Chạy `pnpm --filter @dayforge/frontend exec playwright test tests/routes.spec.ts` trước triển khai; xác nhận root/route assertion thất bại.
- [x] Tạo shell và route khung, không thêm nội dung lịch giả; route lịch dùng chung layout và metadata tiếng Việt.
- [x] Tạo token/layout desktop theo Global Constraints; không có header/sidebar cố định, vùng lịch cuộn ngang khi cần, có đệm cuối trang cho widget.
- [x] Chạy `pnpm --filter @dayforge/frontend exec playwright test tests/routes.spec.ts` và `pnpm build:web`; cả hai phải đạt. Commit deliverable với subject `feat: add calendar route shell`.

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

- [x] Viết test với các assertion cụ thể: `todayInUtc7RollsAtBangkokMidnight` (`2026-10-29T16:59:59.999Z` → `2026-10-29`; `2026-10-29T17:00:00.000Z` → `2026-10-30`); `parseViewStateUsesPreferenceOnlyForMissingFields` (`/milestones?scale=year` + preference `{anchor:"2026-01-31",scale:"month",scrollY:80}` → anchor `2026-01-31`, scale `year`); `parseViewStateDefaultsInvalidFields` (`/milestones?date=2026-02-30&scale=decade`, now `2026-10-29T00:00:00.000Z` → anchor `2026-10-29`, scale `month`, bỏ preference); `moveAnchorPreservesEndOfMonth` (`2026-01-31` + month → `2026-02-28`); `moveAnchorClampsLeapDay` (`2024-02-29` + year → `2025-02-28`); `readPreferenceRejectsMalformedOrUnavailableStorage` (JSON hỏng hoặc `getItem` throw → `null`); `writePreferenceUsesCalendarSpecificKey` (work writes `dayforge:view:v1:work`, milestones writes `dayforge:view:v1:milestones`, scroll `80.8` writes `81`). Playwright `calendarHistoryRestoresRouteDateAndScale`: navigate work `?date=2026-01-31`, then milestones `?date=2026-02-28&scale=year`, browser back restores first URL and forward restores second.
- [x] Chạy `pnpm --filter @dayforge/frontend exec playwright test tests/view-state.spec.ts` trước triển khai; xác nhận các test hàm/route thất bại vì module hoặc route wiring chưa có.
- [x] Cài đặt sáu hàm trong `view-state.ts`; phép tính dùng UTC calendar date, `week` cộng/trừ 7 ngày, `month` cộng/trừ một tháng và giữ ngày trong tháng (clamp tới ngày cuối nếu thiếu), `year` giữ tháng/ngày và clamp 29/2 sang 28/2 ở năm không nhuận.
- [x] Nối trạng thái vào hai route và URL; lùi/tiến thay đổi khoảng phù hợp scale chỉ áp dụng dấu mốc.
- [x] Đọc preference all-or-nothing; validate `anchor` là ngày lịch thực, `scale` thuộc enum (work phải `week`), `scrollY` là số hữu hạn không âm. Khi ghi, làm tròn/clamp `scrollY` thành số nguyên không âm; JSON lỗi và mọi exception từ storage đều không được throw ra UI.
- [x] Chạy `pnpm --filter @dayforge/frontend exec playwright test tests/view-state.spec.ts` và `pnpm build:web`; xác nhận ngày, scale, storage, Back/Forward và TypeScript/build đạt. Commit `feat: add calendar view state navigation`.

### Task 3: Widget, tương tác và focus

**Files:**
- Create: `frontend/components/calendar/calendar-widget.tsx`, `frontend/components/calendar/calendar-view.tsx`, `frontend/tests/calendar-widget.spec.ts`
- Modify: `frontend/app/(calendar)/layout.tsx`, `frontend/app/(calendar)/work/page.tsx`, `frontend/app/(calendar)/milestones/page.tsx`, `frontend/app/globals.css`, `frontend/tests/routes.spec.ts`, `frontend/tests/view-state.spec.ts`
- Delete after migration: `frontend/components/calendar/view-navigation.tsx`

**Interfaces:**
- Consumes: exported `CalendarKind`, `ViewState`, `serializeViewState`, `moveAnchor`, `todayInUtc7`, `parseViewState`, `readPreference`, `writePreference` from Task 2.
- Produces:
```ts
type CalendarViewProps = { calendar: CalendarKind };
export function CalendarView(props: CalendarViewProps): React.JSX.Element;
type CalendarWidgetProps = {
  calendar: CalendarKind;
  view: ViewState;
  onNavigate(next: ViewState): void;
  onSwitch(nextCalendar: CalendarKind): void;
};
export function CalendarWidget(props: CalendarWidgetProps): React.JSX.Element;
```
`CalendarView` owns the existing route/query/preference lifecycle and renders the route heading, current-period label and `CalendarWidget`; the two page routes wrap it in `Suspense`. `CalendarWidget` renders controls and calls its callbacks; it does not own or persist calendar state.

- [x] Write Playwright tests with exact outcomes: `widgetOpensAndClosesByToggleEscapeAndOutsideClick` (toggle sets `aria-expanded`, Escape/outside click hides panel and restores focus to toggle); `calendarSwitchClosesAndFocusesMain` (with saved milestones preference `{anchor:"2026-02-28",scale:"year"}`, switch to milestones navigates to that view, closes panel, focuses `main#calendar-main`); `viewControlsKeepWidgetOpen` (next/today/date/scale update the expected URL while panel stays open); `quickAddActionsAreDisabledWithExplanation` (all three add actions are disabled and their visible explanation says saving is not available yet); `widgetHonorsReducedMotion` (with reduced motion, no translate/scale and transition duration is at most `80ms`).
- [x] Run `pnpm --filter @dayforge/frontend exec playwright test tests/calendar-widget.spec.ts` before implementation; confirm the widget assertions fail.
- [x] Move the Task 2 route-state lifecycle from `view-navigation.tsx` into `CalendarView`; render its state through a presentational `CalendarWidget`; remove `view-navigation.tsx` after both calendar pages use the replacement.
- [x] Place the widget centered on the bottom edge. Start collapsed on each page load and do not persist its open state. Collapsed state shows a disabled quick-add control, current calendar name, an accessible `Chưa kết nối dữ liệu` status, and the open toggle. Expanded panel includes add-work/add-milestone/add-plan controls, route switches, milestone-only week/month/year scale, today/previous/next/current-range controls, and `/account`.
- [x] Keep add controls disabled with visible explanatory text; implement route, date, scale and today controls using the Task 2 callbacks. Switching calendar loads the saved date/scale for that destination (never carries the current calendar view), closes the widget and focuses the destination main region; Escape/outside click closes without changing view and returns focus to the toggle; range/scale changes keep the widget open.
- [x] Apply T02 motion: hover/press `120ms`, widget open/close `180ms`, route/scale transition `260ms`, opacity/transform with `6–10px` movement; reduced motion removes movement/scale and uses immediate change or fade of at most `80ms`. Keep the visible `2px` focus outline with `3px` offset and retain keyboard operation.
- [x] Run `pnpm --filter @dayforge/frontend exec playwright test tests/calendar-widget.spec.ts`, the full Playwright suite, and `pnpm build:web`; all must pass. Commit `feat: add calendar navigation widget`.
### Task 4: Route tài khoản và callback email an toàn

**Files:**
- Create: `frontend/app/(account)/layout.tsx`, `frontend/app/(account)/account/page.tsx`, `frontend/app/(account)/verify-email/page.tsx`, `frontend/app/(account)/reset-password/page.tsx`, `frontend/components/account/email-callback.tsx`, `frontend/tests/auth-routes.spec.ts`
- Modify: `frontend/next.config.ts`, `frontend/app/globals.css`

**Interfaces:**
- Produces: `/account`, `/verify-email`, `/reset-password`; callback reads `token` from the URL fragment into component memory, removes the full fragment using `history.replaceState` while preserving pathname/query, then renders only a neutral incomplete status. It does not POST, consume, display, or persist the token.

- [x] Write Playwright tests with exact outcomes: `accountRouteIsAnExplicitPlaceholder` (`/account` is 200, heading `Tài khoản`, text `Chức năng tài khoản chưa được kết nối.`, no login/password form); `callbackRoutesCarryNoStoreHeaders` (both callback routes return `Cache-Control` with `no-store` in development; when `PLAYWRIGHT_BASE_URL` points to the built production server, require both `private` and `no-store`; in both modes require `Pragma: no-cache` and `Referrer-Policy: no-referrer`. Task 5 runs the full suite against production to enforce the strict header requirement.); `callbackScrubsTokenWithoutPersistingOrPosting` (open `/verify-email#token=dayforge-test-token`, wait until hash is empty, then assert token is absent from DOM, localStorage, sessionStorage, and all requests; no POST to `/api/**`); `resetCallbackScrubsTokenToo` (same assertions for `/reset-password#token=dayforge-test-token`); `callbackWithoutTokenRemainsNeutral` (missing token keeps incomplete status and creates no request); `callbacksLoadNoThirdPartyScripts` (every external script URL is same-origin).
- [x] Run `pnpm --filter @dayforge/frontend exec playwright test tests/auth-routes.spec.ts` before implementation; confirm missing routes or callback/header assertions fail.
- [x] Create a separate account route-group layout using the established dark tokens. `/account` and callback pages are explicit placeholders with the exact status text above; add no login, password, reset or verification form controls.
- [x] Implement `EmailCallback({ purpose: "verify-email" | "reset-password" })` in `frontend/components/account/email-callback.tsx`: on mount, parse only the fragment `token`, keep its value only in a ref, replace the current URL with pathname plus search and no fragment, and never include the token in rendered text, storage, analytics, API requests or error output.
- [x] Add Next.js `headers()` rules for exact paths `/verify-email` and `/reset-password`: `Cache-Control: private, no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer`. Preserve `/api/v1/*` rewrite; add no third-party scripts or analytics.
- [x] Run `pnpm --filter @dayforge/frontend exec playwright test tests/auth-routes.spec.ts`, the full Playwright suite, and `pnpm build:web`; all must pass. Verify the same callback headers against the production server in Task 5. Commit `feat: add account and email callback shells`.
### Task 5: Kiểm chứng tích hợp và bàn giao T06

**Files:**
- Create: `docs/tasks/t06/review-and-verification.md`, `scripts/tests/test_smoke_local.py`
- Modify: `docs/development.md`, `docs/tasks/README.md`, `docs/README.md`, `docs/tasks/t06/plan.md`, `scripts/smoke_local.py`

**Interfaces:**
- Consumes: route, view-state, widget và callback deliverables từ Tasks 1–4.
- Produces: báo cáo kết quả T06 và mô tả phạm vi bàn giao cho T07–T13.

- [x] Add a failing regression for the HTTPS smoke web probe using direct `/work` after the root redirect and preserve the no-redirect policy. Change only the web probe path from `/` to `/work`, retain TLS validation and `/api/v1/openapi.json`, and close an HTTP error response before raising its safe error. Run the focused smoke tests and `pnpm verify:env`; commit `fix: align local smoke probe with T06 routes`.
- [x] Chạy `pnpm verify:env`, `pnpm build:web`, `pnpm --filter @dayforge/frontend exec playwright test`; ghi lệnh và kết quả thực tế.
- [x] Khởi chạy production server ở port `3001`, đặt `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001` và chạy toàn bộ suite production: 26/26 đạt, gồm callback headers chặt.
- [x] Ghi nhận HTTPS same-origin smoke T04 chưa chạy trong checkout T06: không có bộ `.env`, TLS leaf/key hoặc API listener; CA công khai mkcert có sẵn. Không bỏ qua TLS; chạy lại sau khi chuẩn bị local đúng runbook. Ngoại lệ được ghi trong báo cáo bàn giao.
- [x] Đã kiểm tra focus/Escape, Back/Forward, reduced motion bằng browser suite; probe layout laptop/desktop trong Chromium. Cốc Cốc gốc không chạy theo yêu cầu người dùng; không tuyên bố nghiệm thu browser đó. Điểm thứ tự Tab còn mở được ghi cho final review.
- [x] Cập nhật development guide và trạng thái T06; chỉ đánh dấu hoàn thành khi checks bắt buộc đạt hoặc ngoại lệ được ghi rõ.
- [x] Ghi bàn giao: T08/T09 chuyển trạng thái xem tạm sang lưu theo thiết bị/owner và làm auth thật; T13 làm cache shell offline; T07 tích hợp runner/CI.
- [x] Commit `docs: record T06 verification and handoff`.
