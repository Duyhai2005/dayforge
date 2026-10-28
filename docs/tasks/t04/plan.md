# T04 — Project Structure and Local Development Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Từ repo hiện chỉ có tài liệu, tạo bộ khung frontend/backend, khóa phiên bản, cấu hình mẫu không chứa secrets và quy trình chạy local có thể dựng lại trên Windows.

**Architecture:** Node.js/Next.js và Python/FastAPI chạy trực tiếp trên máy phát triển; MySQL chạy bằng Docker Compose với volume riêng. Browser truy cập `https://localhost:3000`; Next.js chuyển tiếp nguyên đường dẫn `/api/v1/*` đến FastAPI ở loopback, giữ một origin để các task tài khoản sau dùng đúng hợp đồng T03. T04 chỉ tạo bootstrap tối thiểu và kiểm chứng môi trường; nghiệp vụ, kết nối DB của ứng dụng, giao diện lịch và CI được bàn giao cho T05–T07.

**Tech Stack:** Node.js 24 LTS, pnpm workspace, Next.js App Router/React, TypeScript strict, Python 3.14, uv, FastAPI/Uvicorn, MySQL 8.4 LTS, Docker Compose và mkcert; `unittest`/`urllib` có sẵn trong Python cho kiểm chứng hẹp của T04.

**Spec:** [Task tổng thể — T04 và ranh giới T05–T07](../README.md), [thiết kế T01](../t01/design.md), [thiết kế T02](../t02/design.md), [hợp đồng T03](../t03/design.md), [HTTP API](../t03/api-contract.md), [tài khoản](../t03/auth-contract.md), [kiến trúc](../../project-definition/04-technical-architecture.md), [convention](../../CONVENTION.md), [Git Flow](../../GITFLOW.md).

## Global Constraints

- “Tạo cấu trúc frontend/backend, khóa phiên bản, cấu hình mẫu không chứa secrets và các lệnh chạy local tái lập được.”
- “Next.js chạy server/Node + FastAPI + MySQL”; không đổi sang static export hoặc thay MySQL bằng SQLite.
- “Use TypeScript in strict mode.”; “Prefer the Next.js App Router.”; “Follow Python 3.11+ best practices.”
- “Prefix `/api/v1`; cùng origin HTTPS với Next.js.”
- “Cookie tên `__Host-dayforge-session`, `Secure; HttpOnly; SameSite=Lax; Path=/`, không `Domain`.” T04 chưa cấp cookie; cấu hình local không tạo ngoại lệ làm suy yếu hợp đồng này.
- “`OWNER_EMAIL` chỉ ở cấu hình server; không đưa allowlist vào bundle hoặc response công khai.”
- “Không log password, token email, cookie, CSRF, logout ticket, local key, note hoặc toàn bộ operation chứa dữ liệu cá nhân.”
- “Không tự mua hạ tầng”; AWS/Oracle, domain và nhà cung cấp email giữ ở T29/T30.
- “Cốc Cốc desktop” là browser nghiệm thu. Chạy bootstrap không có nghĩa đã đạt các AC của sản phẩm.
- “Direct pushes to `main` and `develop` are prohibited.” Lúc triển khai dùng nhánh `feature/t04-development-environment` từ `develop` theo Git Flow; tái sử dụng checkout/worktree phù hợp, không tự chuyển hoặc bỏ thay đổi đang có.

## Review Focus

1. **Chạy lại hoặc chỉ còn một phần file cấu hình:** giữ nguyên credentials/cấu hình đã có, báo rõ file thiếu và không ghi đè — test ở Task 2, gồm đường dẫn Windows có dấu cách.
2. **Manifest lệch lockfile hoặc runtime lệch phiên bản:** lệnh cài đặt chuẩn phải báo lỗi, không âm thầm chọn dependency khác — kiểm chứng ở Task 1 và Task 5.
3. **Chứng chỉ chưa tin cậy, sai hostname hoặc cổng 3000 bị chiếm:** thất bại rõ ràng, không tắt TLS verification hoặc tự đổi origin — kiểm chứng ở Task 4.
4. **Restart MySQL hoặc cổng DB vô tình mở ra LAN:** dữ liệu dev còn nguyên, DB chỉ publish ở `127.0.0.1:3307` — kiểm chứng ở Task 3.
5. **Backend dừng trong khi Next.js vẫn chạy:** probe API phải thất bại, không trả trang HTML/placeholder rồi báo môi trường hoạt động — kiểm chứng ở Task 4.

---

## 1. Phạm vi và lựa chọn kỹ thuật

Ngày lập plan: **28/10/2026**. Trạng thái: **chỉ có kế hoạch, chưa triển khai; T04 vẫn chưa hoàn thành**. Các phiên bản dưới đây là lựa chọn kỹ thuật của người lập plan dựa trên nguồn chính thức, chưa phải kết quả cài/build tương thích trên máy này.

| T04 tạo ra | Giữ ở task sau |
| --- | --- |
| Workspace, manifest/lockfile, bootstrap Next.js/FastAPI tối thiểu | T05: ORM/driver, DB connection, schema/Alembic, validation/error/log/health/version |
| Trang `/` chỉ hiển thị tên ứng dụng và dòng xác nhận bootstrap | T06: hai route lịch, route tài khoản/callback, theme, widget và focus |
| MySQL dev có volume, user riêng, probe SQL hẹp | T07: DB kiểm thử riêng, lint/typecheck/test runner toàn dự án và CI |
| HTTPS local, rewrite cùng origin, config generator và smoke command | T08–T13: IndexedDB, auth/email, vault, sync và service worker |
| Hướng dẫn dựng lại môi trường từ checkout sạch | T29–T33: đóng gói production, reverse proxy production, host/email và rollback |

**Phương án chọn:** runtime web/API trên host, container hóa riêng MySQL. Cách này dùng trực tiếp Fast Refresh/reload trên Windows và không cần thêm lớp điều phối container cho source code. Compose toàn bộ web/API có thể xem lại ở T29; chạy MySQL native làm tăng khác biệt cài đặt giữa máy nên không dùng làm đường chạy chuẩn.

Không dựng sẵn Redis, worker, monorepo framework hoặc package dùng chung. Chỉ tạo thư mục khi có file thật; các vùng `components/`, `services/`, `models/`, `repositories/` được bổ sung theo convention khi task sở hữu cần đến.

**Trước Task 1 khi triển khai:** kiểm tra `node --version`, `pnpm --version`, `uv --version`, `docker compose version` với bảng dưới; chuẩn bị đúng tool còn thiếu và chạy `uv python install 3.14.10`. Repo không tự nâng tool toàn cục hoặc thay trust store qua lệnh cài dependency. Đảm bảo nhánh triển khai có đủ tài liệu T01–T03 trước khi bắt đầu; không chuyển nhánh đang có thay đổi chưa xử lý.

### 1.1. Phiên bản và nơi khóa

| Thành phần | Giá trị chọn | Nơi khóa / nguồn |
| --- | --- | --- |
| Node.js | `24.22.1` LTS | `.node-version`, `package.json#engines.node`; [Node.js](https://nodejs.org/en/download) |
| pnpm | `12.16.1` | `package.json#packageManager = pnpm@12.16.1`; [release](https://github.com/pnpm/pnpm/releases/tag/v12.16.1) |
| Next.js | `16.4.3` | `frontend/package.json`; [manifest đúng tag](https://raw.githubusercontent.com/vercel/next.js/v16.4.3/packages/next/package.json) |
| React / React DOM | `19.3.1` / `19.3.1` | `frontend/package.json`; [React release](https://github.com/react/react/releases/tag/v19.3.1) |
| TypeScript | `6.0.3` | `frontend/package.json`; [release](https://github.com/microsoft/TypeScript/releases/tag/v6.0.3); chọn nhánh tương thích với Next 16.4, không tự nâng major |
| Types | `@types/node=24.19.2`, `@types/react=19.3.0`, `@types/react-dom=19.3.0` | Dev dependencies; [Node types](https://www.npmjs.com/package/@types/node?activeTab=versions), [React types](https://www.npmjs.com/package/@types/react?activeTab=versions), [DOM types](https://www.npmjs.com/package/@types/react-dom?activeTab=versions) |
| CPython | `3.14.10` | `backend/.python-version`, `requires-python = ==3.14.10`; [release](https://www.python.org/downloads/release/python-31410/) |
| uv | `0.13.6` | `[tool.uv] required-version = ==0.13.6` và hướng dẫn cài; [release](https://github.com/astral-sh/uv/releases/tag/0.13.6) |
| FastAPI / Uvicorn | `0.162.0` / `0.54.0` | `backend/pyproject.toml`, không extras; [FastAPI manifest](https://raw.githubusercontent.com/fastapi/fastapi/0.162.0/pyproject.toml), [Uvicorn manifest](https://raw.githubusercontent.com/Kludex/uvicorn/0.54.0/pyproject.toml) |
| MySQL | `mysql:8.4.13` + manifest digest | `compose.yaml`; [official image manifest](https://raw.githubusercontent.com/docker-library/official-images/master/library/mysql) |
| Docker Compose | `>=2.20.0`, plugin `docker compose` | Floor cho `up --wait --wait-timeout`; [source 2.20.0](https://raw.githubusercontent.com/docker/compose/v2.20.0/cmd/compose/up.go). Ghi phiên bản Docker Engine/Desktop/Compose thực chạy vào báo cáo |
| mkcert | `1.4.4` | Hướng dẫn local; [release](https://github.com/FiloSottile/mkcert/releases/tag/v1.4.4) |

Dependency trực tiếp dùng số chính xác, không `^`, `~`, `*` hoặc `latest`; dependency gián tiếp khóa bằng `pnpm-lock.yaml` và `backend/uv.lock`. Không viết lockfile bằng tay. MySQL digest lấy thực tế bằng `docker buildx imagetools inspect mysql:8.4.13`, rồi commit `mysql:8.4.13@sha256:<digest vừa xác minh>`; chuỗi placeholder không được còn trong kết quả T04. [Docker giải thích digest](https://docs.docker.com/dhi/explore/security-concepts/digests/).

Trước cài lần đầu, kiểm tra lại advisory/release chính thức cho các pin; nếu cần bản vá, cập nhật bảng này, manifest và lockfile cùng một thay đổi rồi kiểm chứng lại. Không đổi major hoặc hợp đồng để xử lý lỗi cài đặt. Không thêm Dexie/Workbox/Motion/dnd-kit/SQLAlchemy/Alembic/auth libraries trước khi task dùng chúng bắt đầu.

### 1.2. Cấu hình và lệnh công khai

| File local được ignore | Nội dung chuẩn | Template được commit |
| --- | --- | --- |
| `.env` | `MYSQL_DATABASE=dayforge_dev`, `MYSQL_USER=dayforge_app`, `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`; hai password được sinh độc lập | `.env.example` |
| `backend/.env` | `APP_ENV=development`, `PUBLIC_ORIGIN=https://localhost:3000`, `DB_HOST=127.0.0.1`, `DB_PORT=3307`, `DB_NAME=dayforge_dev`, `DB_USER=dayforge_app`, `DB_PASSWORD` giống app password của Compose | `backend/.env.example` |
| `frontend/.env.local` | Chỉ `API_INTERNAL_ORIGIN=http://127.0.0.1:8000` | `frontend/.env.example` |
| `.local/tls/localhost.pem`, `.local/tls/localhost-key.pem` | Chứng chỉ localhost và private key riêng trên từng máy | Không commit certificate/key |

Templates dùng `__GENERATE_MYSQL_PASSWORD__` và `__GENERATE_MYSQL_ROOT_PASSWORD__`, không có credential dùng lại được. T09 mới bổ sung `OWNER_EMAIL`, KEK/logout/rate-limit keys theo hợp đồng; không tạo auth giả ở T04. `API_INTERNAL_ORIGIN` chỉ dùng trong Next config phía server; browser sau này gọi `/api/v1/...` tương đối. Không dùng `NEXT_PUBLIC_*` hoặc `next.config.env` để chuyển cấu hình backend sang client.

Các lệnh sau chạy từ repo root, dùng được trong PowerShell 5.1+, không cần activate virtualenv:

| Lệnh | Hành vi |
| --- | --- |
| `pnpm install --frozen-lockfile` | Cài workspace theo lockfile, lỗi nếu manifest lệch |
| `uv sync --directory backend --locked` | Cài Python/dependency đã khóa, lỗi nếu metadata lệch |
| `pnpm setup:local` | Sinh ba file env từ templates, không ghi đè; không cài tool hoặc thay trust store |
| `pnpm db:up` | `docker compose --env-file .env up -d --wait --wait-timeout 120 mysql` |
| `pnpm db:down` | `docker compose --env-file .env down`, giữ volume |
| `pnpm dev:api` | `uv run --directory backend --locked --env-file .env uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload --no-access-log` |
| `pnpm dev:web` | `pnpm --filter @dayforge/frontend dev`, HTTPS port 3000 cố định |
| `pnpm build:web` | `pnpm --filter @dayforge/frontend build` |
| `pnpm start:web` | `pnpm --filter @dayforge/frontend start`, HTTP loopback 3001 để probe Node production build công khai |
| `pnpm verify:env` | `uv run --directory backend --locked python -m unittest discover -s ../scripts/tests -v` |
| `pnpm smoke:local --ca-file <đường-dẫn-rootCA.pem>` | Probe HTTPS `/` và `/api/v1/openapi.json`; không nhận DB/auth secrets trong đối số |

`uv --directory backend` đổi thư mục trước khi chạy; `.env` của `dev:api` vì vậy là `backend/.env`. [uv hỗ trợ env file](https://docs.astral.sh/uv/reference/cli/#uv-run--env-file); dùng khả năng này thay cho cài thêm `python-dotenv`. `--locked` kiểm tra lockfile khớp metadata, khác với bỏ kiểm tra bằng `--frozen`. [uv locking](https://docs.astral.sh/uv/concepts/projects/sync/).

## 2. Bản đồ file và phụ thuộc

| File | Trách nhiệm | Task |
| --- | --- | --- |
| `.node-version`, `.npmrc`, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` | Runtime Node, pnpm, một workspace frontend và các command root | 1, bổ sung command ở 2–4 |
| `frontend/package.json`, `tsconfig.json`, `next-env.d.ts`, `next.config.ts` | Dependency, TS strict, Next server và rewrite | 1, 4 |
| `frontend/app/layout.tsx`, `frontend/app/page.tsx` | Bootstrap route `/`, chưa phải UI T06 | 1 |
| `backend/.python-version`, `backend/pyproject.toml`, `backend/uv.lock` | Runtime Python, dependency tối thiểu, uv version | 1 |
| `backend/app/__init__.py`, `backend/app/main.py` | ASGI app không có business endpoint | 1 |
| `.gitignore`, `.gitattributes`, `.editorconfig` | Ignore artifacts trước lần cài đầu; bổ sung bảo vệ env và UTF-8/LF/indentation | 1, 2 |
| `.env.example`, `backend/.env.example`, `frontend/.env.example` | Các template ở mục 1.2 | 2 |
| `scripts/init_local.py`, `scripts/tests/test_init_local.py` | Sinh env an toàn và regression tests cho thao tác có thể ghi đè credentials | 2 |
| `compose.yaml` | MySQL local, digest, loopback port, healthcheck, named volume | 3 |
| `scripts/smoke_local.py` | Probe HTTPS web/API, exit code có ý nghĩa khi service lỗi | 4 |
| `README.md`, `docs/development.md` | Điểm vào dự án và hướng dẫn local đầy đủ | 5 |
| `docs/tasks/t04/review-and-verification.md` | Bằng chứng chạy thật T04, giới hạn và bàn giao | 5 |
| `docs/tasks/README.md`, `docs/README.md` | Link tài liệu, trạng thái đúng với bằng chứng | 5 |

Thứ tự: **1 → 2 → 3 → 4 → 5**. Sau Task 2 có thể nghiên cứu TLS và Compose song song, nhưng tránh hai người cùng sửa `package.json`; người tích hợp thêm command root. Các bước dưới đây là việc cần thực hiện khi triển khai, không phải kết quả đã chạy.

## 3. Các task triển khai

### Task 1: Workspace và bootstrap hai runtime có lockfile

**Files:** Create các file thuộc Task 1 trong bản đồ mục 2; Modify `.gitignore` trước khi cài dependency.

**Interfaces:**
- Consumes: các pin ở mục 1.1 và convention hiện có.
- Produces: frontend package tên `@dayforge/frontend`; `RootLayout(props: Readonly<{ children: React.ReactNode }>): React.JSX.Element`; `HomePage(): React.JSX.Element`; backend `app: FastAPI` tại `app.main`; scripts `build:web`, `start:web`.
- ASGI bootstrap: title `DAYFORGE API`, version `0.0.0`, `openapi_url="/api/v1/openapi.json"`, `docs_url=None`, `redoc_url=None`; chưa có `/health`, `/version`, auth hoặc mutation. OpenAPI này là probe dev, không thay API tương thích T03.

- [ ] **Step 1: Ghi và chạy probe trước khi có bootstrap.**

Run: `pnpm --filter @dayforge/frontend build`.

Expected: FAIL vì workspace/package chưa tồn tại. Probe backend sẽ dùng đúng các assertion sau sau khi có uv project:

```python
from app.main import app
assert app.title == "DAYFORGE API"
assert app.openapi_url == "/api/v1/openapi.json"
assert app.openapi()["paths"] == {}
```

- [ ] **Step 2: Tạo manifest và cấu hình runtime theo mục 1.1.**

Root `package.json` đặt `name=dayforge`, `version=0.0.0`, `private=true`, exact `engines.node`, `packageManager`; `.npmrc` có `engine-strict=true`, `save-exact=true`; workspace chỉ gồm `frontend`. Backend đặt project `name=dayforge-backend`, `version=0.0.0`, `[tool.uv] package=false` và `required-version`, chưa thêm build backend/package phát hành. Tạo manifest frontend với runtime/dev dependency đúng bảng; `build=next build`, `start=next start --hostname 127.0.0.1 --port 3001`. Bổ sung `.gitignore` cho `node_modules/`, `.next/`, `.venv/`, `__pycache__/` và `*.pyc` ngay ở bước này; giữ `.superpowers/` hiện có.

- [ ] **Step 3: Tạo bootstrap `RootLayout`, `HomePage` và `app` theo Interfaces.**

Layout dùng `<html lang="vi">`; `/` có heading `DAYFORGE` và câu `Môi trường phát triển đã sẵn sàng.`. Không dùng remote font/ảnh, không thêm CSS framework; `tsconfig.json` bật `strict`, `noEmit`, cấu hình Next App Router. Next config không có `output: "export"`; không thêm DB connection, route lịch hoặc auth.

- [ ] **Step 4: Sinh lockfile bằng đúng package manager rồi cài lại ở chế độ locked.**

Run lần đầu: `pnpm install`, tiếp theo `uv lock --directory backend`. Sau đó chạy riêng `pnpm install --frozen-lockfile` và `uv sync --directory backend --locked`.

Expected: bốn lệnh exit 0; chỉ có một pnpm lockfile tại root và một uv lockfile trong backend; không có `package-lock.json`/`yarn.lock`/requirements được tạo song song.

- [ ] **Step 5: Chạy probe bootstrap và production build.**

Run: `uv run --directory backend --locked python -c "from app.main import app; assert app.title == 'DAYFORGE API'; assert app.openapi_url == '/api/v1/openapi.json'; assert app.openapi()['paths'] == {}"`, rồi `pnpm build:web`.

Expected: exit 0; build có route `/`. Chạy `pnpm start:web` ở terminal riêng; `Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3001` trả 200 và có `DAYFORGE`. Dừng bằng Ctrl+C. Probe HTTP này chỉ xác nhận Next Node runtime, không dùng cho luồng tài khoản.

- [ ] **Step 6: Kiểm chứng lockfile từ chối metadata bị đổi trong thư mục tạm.**

Sao chép các manifest/lockfile vào thư mục tạm ngoài checkout làm việc. Đổi React trực tiếp thành một phiên bản khác mà không sinh lại lock; `pnpm install --frozen-lockfile` phải exit khác 0 vì lockfile không khớp. Trong bản sao backend, đổi pin FastAPI nhưng giữ `uv.lock`; `uv sync --locked` cũng phải exit khác 0. Chạy pnpm với Node không khớp `engines.node` phải bị `engine-strict` chặn; uv có version khác bị `required-version` chặn. Giữ log đã bỏ đường dẫn cá nhân; không sửa manifest/lockfile thật cho bài thử này.

- [ ] **Step 7: Commit deliverable đã kiểm chứng.**

Run: `git add .gitignore .node-version .npmrc package.json pnpm-workspace.yaml pnpm-lock.yaml frontend/package.json frontend/tsconfig.json frontend/next-env.d.ts frontend/next.config.ts frontend/app/layout.tsx frontend/app/page.tsx backend/.python-version backend/pyproject.toml backend/uv.lock backend/app/__init__.py backend/app/main.py`.

Run: `git commit -m "chore: bootstrap pinned frontend and backend workspaces"`.

### Task 2: Template cấu hình và khởi tạo không ghi đè

**Files:** Create `.env.example`, `backend/.env.example`, `frontend/.env.example`, `.gitattributes`, `.editorconfig`, `scripts/init_local.py`, `scripts/tests/test_init_local.py`; Modify `.gitignore`, `package.json`.

**Interfaces:**
- Consumes: backend Python đã khóa; danh sách file/giá trị mục 1.2.
- Produces: `initialize_local(repo_root: Path) -> tuple[Path, Path, Path]` trong `scripts/init_local.py`; `main() -> int` chạy từ bất kỳ cwd nào và xác định root theo vị trí script.
- Lần đầu trả ba path đã tạo. Nếu đủ ba file, trả lại các path mà không đổi byte nào; nếu chỉ tồn tại một phần, raise `FileExistsError` với tên file thiếu, không in nội dung. CLI exit 0 cho tạo mới/giữ nguyên, exit 1 cho lỗi và chỉ in path/trạng thái.

- [ ] **Step 1: Viết test thất bại cho dữ liệu local cần được bảo toàn.**

Dùng `unittest.TestCase` và `TemporaryDirectory`; fixtures chép ba templates vào cây tạm. Viết các test sau, với assertion tương ứng:

```python
# test_creates_matching_database_credentials
assert compose_env["MYSQL_PASSWORD"] == backend_env["DB_PASSWORD"]
assert len(compose_env["MYSQL_PASSWORD"]) >= 32
assert compose_env["MYSQL_PASSWORD"] != compose_env["MYSQL_ROOT_PASSWORD"]
assert "MYSQL_ROOT_PASSWORD" not in backend_env
assert frontend_env == {"API_INTERNAL_ORIGIN": "http://127.0.0.1:8000"}

# test_rerun_preserves_all_existing_bytes
assert after == before  # đọc bytes của cả ba file trước/sau lần gọi thứ hai

# test_partial_configuration_refuses_without_writing
with self.assertRaises(FileExistsError):
    initialize_local(partial_root)
assert existing.read_bytes() == original_bytes
assert not missing_backend.exists()
assert not missing_frontend.exists()

# test_path_with_spaces_and_unicode: root tạm có tên "Dayforge thử nghiệm"
assert all(path.is_file() for path in initialize_local(root_with_spaces))

# test_missing_template_creates_no_output
with self.assertRaises(FileNotFoundError):
    initialize_local(root_missing_template)
assert not any(path.exists() for path in output_paths)
```

Các biến fixture/dictionary trong ví dụ được định nghĩa trong test; parse env fixture bằng cách tách mỗi dòng tại dấu `=` đầu tiên. Đây là test cho nguy cơ mất credentials, không phải yêu cầu bổ sung test runner T07.

- [ ] **Step 2: Chạy test để xác nhận thất bại vì chưa có generator.**

Run: `uv run --directory backend --locked python -m unittest discover -s ../scripts/tests -v`.

Expected: FAIL/ImportError do `scripts/init_local.py` chưa có. Test thêm repo root vào import path bằng `Path(__file__).resolve().parents[2]`, không phụ thuộc cwd.

- [ ] **Step 3: Viết `initialize_local(repo_root: Path) -> tuple[Path, Path, Path]`.**

Đọc và kiểm tra đủ templates/đầu ra trước khi ghi; dùng `secrets.token_urlsafe(32)` độc lập cho app/root password. Render UTF-8, LF, từ templates ở mục 1.2; tạo file với chế độ exclusive `x`, không cung cấp cờ `--force`. Lỗi I/O giữa chừng báo rõ tập file còn thiếu để người dùng phục hồi; lần chạy sau không tự ghi đè phần đã tạo. Không gọi Docker, installer, mkcert hoặc thay trust store trong generator.

- [ ] **Step 4: Thêm command và quy tắc Git/editor.**

`setup:local = uv run --directory backend --locked python ../scripts/init_local.py`; `verify:env` theo mục 1.2. Ignore `node_modules/`, `.next/`, `.venv/`, Python caches, `.env`, `.env.*` nhưng allow `!.env.example` ở mọi cấp, `.local/`, certificates/private keys và log sinh ra. Giữ dòng `.superpowers/` hiện có. `.gitattributes` áp dụng `text=auto eol=lf`; `.editorconfig` dùng UTF-8/LF, final newline, TS/JSON/YAML 2 spaces và Python 4 spaces; không đổi line endings các tài liệu cũ hàng loạt.

- [ ] **Step 5: Kiểm chứng generator và ignore.**

Run `pnpm verify:env`, sau đó `pnpm setup:local` hai lần. Expected: tất cả 5 tests PASS; lần hai giữ nguyên các file.

Run: `git check-ignore .env backend/.env frontend/.env.local .local/tls/localhost-key.pem` — cả bốn path phải được ignore. Run: `git check-ignore .env.example backend/.env.example frontend/.env.example` — không in path, exit 1. `git status --short` không hiện file cấu hình local.

- [ ] **Step 6: Commit deliverable đã kiểm chứng.**

Run: `git add .gitignore .gitattributes .editorconfig .env.example backend/.env.example frontend/.env.example scripts/init_local.py scripts/tests/test_init_local.py package.json`.

Run: `git commit -m "chore: add safe local environment initialization"`.

### Task 3: MySQL local bền vững và có probe SQL

**Files:** Create `compose.yaml`; Modify `package.json`.

**Interfaces:**
- Consumes: `.env` đã sinh; image/version/digest mục 1.1.
- Produces: Compose service `mysql`; named volume key `mysql-data`; project name `dayforge-dev`; DB `dayforge_dev`, app user `dayforge_app`, host endpoint `127.0.0.1:3307`.
- Các task sau dùng các trường `DB_*` trong `backend/.env`; T04 chưa tạo SQLAlchemy engine hoặc migration.

- [ ] **Step 1: Ghi probe và xác nhận chưa có service.**

Run: `docker compose --env-file .env config --quiet`.

Expected: FAIL vì chưa có Compose file. Probe chấp nhận cuối task là SQL trả `VERSION()` thuộc `8.4.13`, `DATABASE() = dayforge_dev`, `CURRENT_USER()` là app user và một bản ghi còn sau `down`/`up`.

- [ ] **Step 2: Khóa image digest và viết service `mysql`.**

Lấy manifest digest thực như mục 1.1. Dùng `${VARIABLE:?missing VARIABLE}` cho bốn biến MySQL; `ports` chỉ `127.0.0.1:3307:3306`; mount `mysql-data:/var/lib/mysql`. Cấu hình `utf8mb4`, `utf8mb4_0900_ai_ci`, server timezone `+00:00`; ngày nghiệp vụ UTC+07:00 vẫn do hợp đồng dữ liệu xử lý. Không mount source code vào data directory, không thêm `container_name` hoặc secret trong YAML.

- [ ] **Step 3: Thêm healthcheck và commands chờ DB sẵn sàng.**

Healthcheck chạy `SELECT 1` bằng app user/DB trong container, dùng biến env qua `CMD-SHELL` và escape `$` của Compose bằng `$$`; password chỉ qua `MYSQL_PWD`, không nằm trong đối số `-p`. Chọn `interval=5s`, `timeout=5s`, `retries=20`, `start_period=20s`. Thêm `db:up`/`db:down` theo mục 1.2; không có lệnh reset/down `-v` trong luồng chuẩn.

- [ ] **Step 4: Xác nhận cấu hình và kết nối bằng app user.**

Run `docker compose --env-file .env config --quiet`, rồi `pnpm db:up`.

Run từ PowerShell:

```powershell
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u"$MYSQL_USER" "$MYSQL_DATABASE" -N -e "SELECT VERSION(), DATABASE(), CURRENT_USER();"'
docker compose port mysql 3306
```

Expected: exit 0, SQL đúng giá trị Interfaces, port đúng `127.0.0.1:3307`. Không dùng `docker compose config` không có `--quiet` trong báo cáo vì output có thể chứa secrets đã nội suy.

- [ ] **Step 5: Kiểm chứng giữ dữ liệu qua restart và giới hạn quyền user.**

Trong DB dev riêng, dùng cùng cách truyền credentials ở Step 4 để tạo bảng `_t04_volume_probe(id INT PRIMARY KEY)` và insert `id=4`. Chạy `pnpm db:down`, `pnpm db:up`, rồi `SELECT id FROM _t04_volume_probe` phải trả `4`. `SHOW GRANTS` của app user chỉ có quyền trên `dayforge_dev.*`, không có quyền quản trị toàn server. Xóa riêng bảng probe sau khi đã đọc lại; không xóa volume. Đây là probe môi trường, không phải schema ứng dụng T05.

- [ ] **Step 6: Commit deliverable đã kiểm chứng.**

Run: `git add compose.yaml package.json`.

Run: `git commit -m "chore: add persistent local MySQL service"`.

### Task 4: HTTPS local, proxy một origin và smoke có thể thất bại

**Files:** Create `scripts/smoke_local.py`; Modify `frontend/next.config.ts`, `frontend/package.json`, `package.json`.

**Interfaces:**
- Consumes: frontend `.env.local`, backend ASGI app và TLS files ở mục 1.2.
- Produces: browser origin `https://localhost:3000`; rewrite `/api/v1/:path*` → `http://127.0.0.1:8000/api/v1/:path*`; commands `dev:web`, `dev:api`, `smoke:local`.
- `smoke_local(base_url: str, ca_file: Path, timeout_seconds: float = 10.0) -> None` trong `scripts/smoke_local.py`; `main() -> int` nhận `--base-url` mặc định HTTPS origin ở trên và `--ca-file` bắt buộc, exit 0/1. Không in response body hoặc giá trị env khi lỗi.

- [ ] **Step 1: Viết probe smoke trước phần nối proxy/TLS.**

Probe thực hiện hai GET bằng `urllib.request` với `ssl.create_default_context(cafile=str(ca_file))`, không theo redirect sang origin khác; kiểm tra chính xác:

```python
assert web_status == 200
assert "text/html" in web_content_type
assert "DAYFORGE" in web_body
assert api_status == 200
assert "application/json" in api_content_type
assert api_json["info"]["title"] == "DAYFORGE API"
assert isinstance(api_json["paths"], dict)
```

Chỉ chấp nhận `base_url` là HTTPS với hostname `localhost`, không có credentials/path/query/fragment. Thiếu chứng chỉ, TLS/HTTP/JSON lỗi hoặc sai assertion đều exit 1. In `PASS: local HTTPS web and API bootstrap` sau khi cả hai probe thành công. Không dùng schema rỗng làm điều kiện smoke để T05 thêm endpoint không làm hỏng lệnh.

- [ ] **Step 2: Chạy probe để xác nhận thiếu TLS/proxy thì chưa pass.**

Run: `uv run --directory backend --locked python ../scripts/smoke_local.py --ca-file ../.local/tls/missing-ca.pem`.

Expected: exit 1, thông báo ngắn về file CA; không traceback chứa response/config, không có dòng PASS.

- [ ] **Step 3: Chuẩn bị chứng chỉ localhost riêng trên máy.**

Xác nhận `mkcert -version` là `v1.4.4`; chạy bước trust CA một lần, tách khỏi bootstrap tự động. Nếu môi trường cần quyền hệ thống, làm đúng luồng permission của máy thay vì tự nâng quyền. Các lệnh được ghi vào hướng dẫn:

```powershell
mkcert -install
New-Item -ItemType Directory -Force .local/tls
mkcert -cert-file .local/tls/localhost.pem -key-file .local/tls/localhost-key.pem localhost 127.0.0.1 ::1
```

`mkcert -CAROOT` chứa CA trên từng máy; chỉ lấy `rootCA.pem` cho probe, không sao chép `rootCA-key.pem` vào repo hoặc chia sẻ. [mkcert](https://github.com/FiloSottile/mkcert) mô tả việc cài CA vào Windows trust store. Chưa cần certificate production hoặc domain.

- [ ] **Step 4: Nối Next config và command chạy hai server.**

Frontend `dev` dùng `next dev --hostname localhost --port 3000 --experimental-https --experimental-https-key ../.local/tls/localhost-key.pem --experimental-https-cert ../.local/tls/localhost.pem`. Dùng `rewrites` của `NextConfig` để giữ nguyên prefix; đọc `API_INTERNAL_ORIGIN` phía server, thiếu/sai giá trị thì lỗi ngắn trước startup. Chỉ cho internal origin `http://127.0.0.1:8000`, không xây open proxy. Không thêm route handler auth/DB trong Next.js, CORS wildcard, response cache hoặc rewrite email callback. Thêm ba command root theo Interfaces; `smoke:local = uv run --directory backend --locked python ../scripts/smoke_local.py`.

[Next CLI](https://nextjs.org/docs/app/api-reference/cli/next) hỗ trợ các cờ HTTPS này cho development; [rewrites](https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites) là proxy URL. `next start` vẫn là probe HTTP công khai port 3001; TLS/reverse proxy production thuộc T29/T30.

- [ ] **Step 5: Chạy smoke thành công và kiểm tra browser thực.**

Mở hai terminal từ root: `pnpm dev:api` và `pnpm dev:web`. Terminal thứ ba:

```powershell
$dayforgeCaFile = Join-Path (mkcert -CAROOT) 'rootCA.pem'
pnpm smoke:local --ca-file "$dayforgeCaFile"
```

Expected: exit 0, đúng dòng PASS; trực tiếp Cốc Cốc mở `https://localhost:3000` không cảnh báo TLS và `/api/v1/openapi.json` trả JSON của FastAPI. Ghi browser version. T04 không cấp cookie, nên chưa tuyên bố kiểm chứng session/CSRF/no-store auth.

- [ ] **Step 6: Kiểm chứng ba trường hợp lỗi của môi trường.**

1. Dừng API, giữ web: chạy lại smoke phải exit 1 ở probe API, không PASS hoặc HTML 200 giả thành công; khởi động lại API và smoke phải PASS.
2. Dùng CA không ký certificate localhost hoặc hostname không hợp lệ: smoke phải exit 1; không thêm `-k`, `verify=False` hoặc `NODE_TLS_REJECT_UNAUTHORIZED=0`.
3. Khi web đầu tiên đang chiếm 3000, chạy thêm `pnpm dev:web`: phải exit khác 0 vì cổng cố định, không tự chuyển 3002 làm lệch `PUBLIC_ORIGIN`. Dừng tiến trình thử, giữ web đầu tiên.

- [ ] **Step 7: Commit deliverable đã kiểm chứng.**

Run: `git add scripts/smoke_local.py frontend/next.config.ts frontend/package.json package.json`.

Run: `git commit -m "chore: add same-origin HTTPS local development"`.

### Task 5: Hướng dẫn checkout sạch và bằng chứng bàn giao T04

**Files:** Create `README.md`, `docs/development.md`, `docs/tasks/t04/review-and-verification.md`; Modify `docs/README.md`, `docs/tasks/README.md`.

**Interfaces:**
- Consumes: các command, file và probe từ Tasks 1–4.
- Produces: một quy trình clone/checkout → cài đúng tool → cài locked → sinh config/TLS → MySQL → web/API → smoke/build → dừng mà giữ dữ liệu; báo cáo ghi rõ PASS/FAIL/BLOCKED/chưa chạy, phiên bản thực và giới hạn.

- [ ] **Step 1: Viết runbook `docs/development.md` theo đúng thứ tự dưới đây.**

Ghi prerequisite Windows/PowerShell, Docker Desktop Linux containers và engine đang chạy; lấy đúng Node/pnpm/uv/mkcert từ nguồn mục 1.1, dùng installer/version cụ thể, không giả định tool toàn cục hiện tại đúng pin. `uv python install 3.14.10` cài interpreter do uv quản lý, không cần thay Python hệ thống. Đưa từng command mục 1.2 và các bước mkcert vào hướng dẫn; mỗi command có cwd, kết quả mong đợi và cách dừng.

Runbook giải thích: lần đầu cần mạng tải dependency/image; chưa có offline app. Với port bị chiếm, xử lý tiến trình đang dùng thay vì tự đổi origin. Với MySQL volume cũ, đổi password env không tự đổi user trong volume; phục hồi config cũ/đổi credentials bằng quy trình có chủ đích, không tự `down -v`. Với lỗi TLS, kiểm tra CA, hostname và restart browser. Với thiếu một phần env, phục hồi file thiếu thủ công bằng template/cấu hình tương ứng, không ghi đè file còn lại.

- [ ] **Step 2: Chạy toàn bộ hướng dẫn trên một checkout sạch.**

Dùng thư mục kiểm chứng riêng có dấu cách, cài từ manifest/lockfile được commit, không sao chép `.env`, `.venv`, `node_modules`, certificates hoặc `.next` từ checkout gốc. Dừng dịch vụ dev gốc trước để tránh xung đột cổng; trong một terminal kiểm chứng mới đặt `$env:COMPOSE_PROJECT_NAME = 'dayforge-t04-verify'` trước mọi command của lần diễn tập. Biến này ghi đè project name trong YAML, nên các command `pnpm db:up`/`pnpm db:down` vẫn dùng được và volume DB gốc không bị tác động. Sinh env mới rồi thực hiện lần lượt install locked, `setup:local`, TLS, `db:up`, hai server và smoke; kết thúc bằng `db:down`, dừng server và đóng terminal kiểm chứng. Ghi việc dùng project override vào báo cáo; trở lại checkout chính, chạy lại services/probe trước bước tiếp theo.

Expected: mọi bước từ hướng dẫn chạy được; không phải sửa source hoặc lockfile. Nếu chưa có quyền cài tool/trust CA, ghi BLOCKED cho đúng bước và chưa đánh dấu T04 hoàn thành.

- [ ] **Step 3: Chạy lại kiểm chứng cuối trên checkout đang bàn giao.**

Chạy riêng `pnpm install --frozen-lockfile`, `uv sync --directory backend --locked`, `pnpm verify:env`, `pnpm build:web`, `pnpm smoke:local --ca-file "$dayforgeCaFile"`, `git diff --check` và `git status --short`. Chạy lại probe `start:web` sau build; xác nhận lockfiles không đổi khi cài lại. Kiểm tra `git ls-files` không chứa `.env` thật, private key hoặc output build; không stage bằng `git add .`.

Expected: commands exit 0; 5 tests generator PASS; smoke/build/Node start PASS; chỉ các file dự kiến thay đổi. Không cần thêm pytest/Vitest/Playwright/CI để hoàn thành T04; chúng thuộc T07.

- [ ] **Step 4: Ghi báo cáo và ranh giới bàn giao.**

`review-and-verification.md` ghi ngày/OS/tool/browser versions, MySQL tag + digest, từng command/kết quả, 5 mục Review Focus, checkout sạch và các giới hạn. Không đưa secrets hoặc log đầy đủ chứa env vào báo cáo. Ghi rõ chưa kiểm chứng kết nối DB từ app/migration (T05), UI lịch (T06), CI (T07), auth/email/offline/sync và AC-01–AC-38.

README root chỉ dẫn đến `docs/development.md`, task plan và hồ sơ thiết kế. Trong `docs/README.md` thêm link runbook/báo cáo. Chỉ đổi checkbox T04 và trạng thái tổng thể ở `docs/tasks/README.md` sau khi toàn bộ điều kiện hoàn thành dưới đây có bằng chứng; giữ T05–T36 chưa hoàn thành.

- [ ] **Step 5: Commit tài liệu và bàn giao nhánh để review.**

Run: `git add README.md docs/development.md docs/README.md docs/tasks/README.md docs/tasks/t04/review-and-verification.md`.

Run: `git commit -m "docs: verify and document T04 local development setup"`.

Tạo/tích hợp PR theo Git Flow khi được yêu cầu trong lượt triển khai; không merge hoặc push trực tiếp `develop`/`main`. Không coi việc có plan hiện tại là đã thực hiện các commit nêu trên.

## 4. Điều kiện hoàn thành và bàn giao

- [ ] Frontend Next.js chạy bằng Node server, backend import/chạy ASGI được; build/start của bootstrap đã được probe.
- [ ] Runtime/dependency/image được khóa; hai lần cài locked không đổi lockfiles; bài thử manifest/runtime lệch bị chặn.
- [ ] Templates không có secrets; khởi tạo đúng DB password ở hai nơi, không lộ root password cho backend/frontend, chạy lại không ghi đè, partial config có lỗi rõ ràng.
- [ ] MySQL healthy bằng app user, loopback port đúng, bản ghi dev còn qua down/up và không có quyền quản trị toàn server.
- [ ] HTTPS localhost được Cốc Cốc tin cậy; API proxy giữ prefix/cùng origin; mất backend, sai TLS và trùng cổng không bị báo thành công.
- [ ] Checkout sạch dựng lại được từ hướng dẫn, kết quả và các phần chưa chạy được ghi trung thực.
- [ ] T05 nhận ASGI app + DB/config và tự làm settings/connection/schema/health; T06 nhận Next server để dựng routes/UI; T07 nhận lockfiles và các probe hẹp để tổ chức kiểm tra tự động.

## 5. Tự rà soát kế hoạch

- **Spec coverage:** yêu cầu cấu trúc → Task 1; khóa phiên bản → Task 1/3; cấu hình mẫu không secrets → Task 2; local tái lập → Task 3/4/5. Không thiếu phần T04; chưa mở rộng thành T05–T07.
- **Step scan:** mỗi bước có file/interface hoặc command/kết quả cụ thể; ví dụ code chỉ giữ assertion và câu lệnh cần thiết, không viết sẵn toàn bộ implementation.
- **Type consistency:** `initialize_local`/`smoke_local`, package `@dayforge/frontend`, `/api/v1`, các env path, ports và tên service nhất quán giữa bảng, task và runbook dự kiến.
- **Review Focus:** mục 1 → Task 2; mục 2 → Task 1/5; mục 3 → Task 4; mục 4 → Task 3; mục 5 → Task 4. Mỗi mục có kiểm chứng tương ứng.
- **Proportion:** chỉ chia 5 deliverable có thể review độc lập; không tạo task riêng cho mỗi config file, không lên kế hoạch chi tiết tính năng của T05 trở đi.

## 6. Cách thực thi sau khi review

Khuyến nghị **Native** cho plan này: năm task đi liên tiếp qua cùng manifest/config/command, nên triển khai trong một ngữ cảnh giảm công phối hợp; có một lượt review độc lập toàn nhánh ở cuối. **Subagent-driven** phù hợp nếu muốn reviewer riêng cho từng deliverable và chấp nhận nhiều lượt context hơn. Chỉ triển khai khi người dùng đã review plan và chọn cách thực hiện theo skill `writing-plans`.
