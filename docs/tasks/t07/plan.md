# DAYFORGE — T07 Detailed Implementation Plan
## Thiết lập kiểm tra tự động, quality gates và CI

> Repo: `Duyhai2005/dayforge`  
> Base branch: `develop`  
> Base commit: `a49b1780ab05134108814f684d15210cc157572f`  
> Feature branch: `feature/automated-quality-gates`  
> Task nguồn: `docs/tasks/README.md` — **T07 — Thiết lập kiểm tra tự động**  
> Phạm vi: lint, format check cần thiết, type check, test runners, MySQL test cô lập, CI test/build và tài liệu bàn giao.
> Trạng thái: **Hoàn thành** theo [báo cáo kiểm chứng](review-and-verification.md).

---

## 1. Mục tiêu và phạm vi

### 1.1. Mục tiêu
Thiết lập quality pipeline thống nhất, có thể chạy giống nhau giữa local (Windows/Linux) và GitHub CI:
1. Frontend lint đạt (`eslint --max-warnings=0`).
2. Backend lint đạt (`ruff check`).
3. Backend formatting check đạt (`black --check`).
4. Frontend TypeScript type check đạt (`tsc --noEmit`).
5. Backend Python type check đạt (`mypy app`).
6. Regression môi trường (`verify:env`) đạt.
7. Backend non-MySQL tests (`test:api`) đạt.
8. Backend MySQL integration tests chạy trên database cô lập (`test:api:mysql`) đạt.
9. Frontend Playwright development suite (`test:web`) đạt.
10. Next.js production build (`build:web`) đạt cross-platform không cần cấu hình thủ công.
11. Frontend Playwright production suite (`test:web:prod`) đạt, kiểm tra nghiêm ngặt callback headers.
12. Clean checkout không cần `.env` để chạy CI và tests.
13. CI không dùng development database và không cần repository secrets.
14. Failure ở bất kỳ gate nào làm fail workflow.
15. Local và CI dùng chung interface root `package.json`.

### 1.2. Ngoài phạm vi
- Không đưa tính năng người dùng hay business logic mới vào T07.
- Không đưa IndexedDB (T08), auth/session thực (T09), Sync API (T10).
- Không thêm SaaS bên thứ ba (SonarCloud, Sentry, CodeQL,...).

---

## 2. Kết quả baseline trước triển khai

Baseline ghi nhận tại commit `a49b1780ab05134108814f684d15210cc157572f` trên Windows 11 Home (Node 24.22.1, pnpm 12.16.1, uv 0.13.6, CPython 3.14.10):

| Check | Lệnh | Kết quả baseline |
|---|---|---|
| Environment suite | `pnpm verify:env` | **PASS**, 17 tests in 1.427s |
| Backend non-MySQL tests | `pnpm test:api` | **PASS**, 200 passed, 38 deselected in 17.11s |
| Frontend Playwright dev | `pnpm --filter @dayforge/frontend exec playwright test` | **PASS**, 32 passed in 59.4s |
| Frontend production build | `$env:API_INTERNAL_ORIGIN = "http://127.0.0.1:8000"; pnpm build:web` | **PASS**, compilation & static page generation (6/6) |
| Git diff hygiene | `git diff --check` | **PASS**, clean working tree |
| MySQL test runner | `pnpm test:api:mysql` | **FAIL CLOSED** an toàn khi Docker daemon không hoạt động, không lộ credentials |

---

## 3. Public Command Contract sau T07

### 3.1. Frontend package scripts (`frontend/package.json`)
- `lint`: `eslint app components lib tests playwright.config.ts next.config.ts --max-warnings=0`
- `typecheck`: `tsc --noEmit`
- `test:e2e`: `playwright test`
- `test:e2e:prod`: `cross-env PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 playwright test --config=playwright.production.config.ts`

### 3.2. Root scripts (`package.json`)
- `lint:web`: `pnpm --filter @dayforge/frontend lint`
- `lint:api`: `uv run --directory backend --locked ruff check app tests migrations ../scripts`
- `format:check:api`: `uv run --directory backend --locked black --check app tests migrations ../scripts`
- `lint`: `pnpm lint:web && pnpm lint:api && pnpm format:check:api`
- `typecheck:web`: `pnpm --filter @dayforge/frontend typecheck`
- `typecheck:api`: `uv run --directory backend --locked mypy app`
- `typecheck`: `pnpm typecheck:web && pnpm typecheck:api`
- `test:web`: `pnpm --filter @dayforge/frontend test:e2e`
- `test:web:prod`: `pnpm --filter @dayforge/frontend test:e2e:prod`
- `build:web`: `cross-env API_INTERNAL_ORIGIN=http://127.0.0.1:8000 pnpm --filter @dayforge/frontend build`
- `verify:fast`: `pnpm lint && pnpm typecheck && pnpm verify:env && pnpm test:api`
- `verify`: `pnpm verify:fast && pnpm test:web && pnpm build:web && pnpm test:web:prod`

---

## 4. Các giai đoạn triển khai (Phases)

- **Phase 0**: Plan và baseline guard (`docs/tasks/t07/plan.md`).
- **Phase 1**: Frontend ESLint config (`frontend/eslint.config.mjs`) và script `lint`.
- **Phase 2**: Frontend type check script `typecheck` (`tsc --noEmit`).
- **Phase 3**: Backend Ruff + Black (`backend/pyproject.toml`, pinned dependencies trong uv).
- **Phase 4**: Backend mypy (`backend/pyproject.toml`, pinned dependency mypy).
- **Phase 5**: Root quality orchestration (`package.json`, `cross-env` cho `build:web`).
- **Phase 6**: Tổng quát hóa MySQL test runner (`scripts/test_backend.py`, generic naming, loại bỏ `.env` dependency, regression tests `scripts/tests/test_backend_runner.py`).
- **Phase 7**: Production Playwright runner chuẩn hóa (`frontend/playwright.production.config.ts`).
- **Phase 8**: GitHub Actions CI workflow (`.github/workflows/ci.yml`).
- **Phase 9**: CI self-verification & deliberate failure checks.
- **Phase 10**: Documentation & handoff (`docs/tasks/t07/review-and-verification.md`, cập nhật `docs/development.md`, `docs/tasks/README.md`, `docs/README.md`).

---

## 5. Quy tắc cô lập MySQL Test Runner

1. Đổi toàn bộ định danh `DAYFORGE_T05_` thành `DAYFORGE_TEST_`.
2. Đổi tên container/project: `dayforge-test-<uuid>`, database `dayforge_test`.
3. Loại bỏ yêu cầu `.env` khi resolve MySQL image từ `compose.yaml`: sử dụng dummy non-secret env nội bộ trong memory để Compose parse image digest.
4. Port ngẫu nhiên chỉ bind `127.0.0.1`.
5. Anonymous volume tự hủy khi cleanup.
6. `root` password chỉ truyền vào container environment, không truyền vào pytest subprocess.
7. Cleanup trong khối `finally` luôn thực hiện dù tests pass hay fail; nếu cleanup lỗi thì overall exit code là 1.

---

## 6. GitHub Actions CI Architecture

3 jobs độc lập:
1. `quality`:
   - Ubuntu latest, checkout
   - Node 24.22.1, pnpm 12.16.1, uv 0.13.6, Python 3.14.10
   - `pnpm install --frozen-lockfile`, `uv sync --directory backend --locked`
   - `pnpm lint`, `pnpm typecheck`, `pnpm verify:env`, `pnpm test:api`
   - Lockfile mutation guard (`git diff --exit-code`)
2. `backend-mysql`:
   - Ubuntu latest, Docker daemon có sẵn
   - Locked dependencies
   - `pnpm test:api:mysql`
3. `frontend`:
   - Ubuntu latest, Node/pnpm
   - Locked dependencies, Playwright Chromium install
   - `pnpm test:web`, `pnpm build:web`, `pnpm test:web:prod`
   - Upload Playwright trace/artifact on failure

---

## 7. Rollback và Safe Edits

- Mọi thay đổi code tuân thủ direct file editing, tạo diff reviewable.
- Không force push, không rewrite git history ngoài ý muốn.
- Không push lên remote repository khi chưa có yêu cầu.

---

## 8. Commit Plan

- **Commit 1**: `docs: add T07 automated quality plan` (Phase 0)
- **Commit 2**: `chore: add frontend lint and typecheck` (Phase 1 & 2)
- **Commit 3**: `chore: add backend lint format and type checks` (Phase 3 & 4)
- **Commit 4**: `test: generalize isolated MySQL runner` (Phase 6)
- **Commit 5**: `test: automate production frontend suite` (Phase 5 & 7)
- **Commit 6**: `ci: add repository quality workflow` (Phase 8)
- **Commit 7**: `docs: record T07 verification and handoff` (Phase 10)
