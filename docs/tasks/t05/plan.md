# T05 — FastAPI and MySQL Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dựng nền FastAPI kết nối MySQL thật, có migration ban đầu, validation nghiêm ngặt, lỗi HTTP thống nhất, health/version và log không lộ dữ liệu riêng.

**Architecture:** Mở rộng ASGI bootstrap và cấu hình `DB_*` của T04 bằng SQLAlchemy async/aiomysql; Alembic là đường tạo và nâng schema duy nhất. Migration đầu tạo nơi lưu owner đã xác minh và cấu hình workspace cố định; auth/session và event store được thêm bằng migration ở T09/T10. FastAPI dùng app factory/lifespan, session riêng cho từng request, transaction do service sở hữu; readiness kiểm tra DB/schema nhưng không tự migration hoặc tạo owner.

**Tech Stack:** Runtime Python/FastAPI/Uvicorn, uv và MySQL 8.4 theo pin/lockfile của T04; SQLAlchemy asyncio, aiomysql, Alembic, Pydantic v2; pytest, HTTPX và jsonschema cho kiểm chứng hẹp của T05; Docker Compose cho MySQL kiểm thử cô lập.

**Spec:** [T05 và phụ thuộc trong kế hoạch tổng thể](../README.md), [đầu vào T04](../t04/plan.md), [hợp đồng T03](../t03/design.md), [dữ liệu](../t03/data-contract.md), [tài khoản](../t03/auth-contract.md), [HTTP](../t03/api-contract.md), [đồng bộ](../t03/sync-contract.md), [JSON Schema](../t03/contract.schema.json), [convention](../../CONVENTION.md), [Git Flow](../../GITFLOW.md).

## Global Constraints

- “Next.js chạy server/Node + FastAPI + MySQL”; giữ runtime/ports/HTTPS của T04, không thay DB bằng SQLite để kiểm thử migration hoặc transaction.
- “Follow Python 3.11+ best practices.”; “Use Pydantic models for request and response validation.”; “Prefer `async def` for I/O-bound operations.”
- “Prefix `/api/v1`; cùng origin HTTPS với Next.js.” Tất cả path HTTP trong plan bên dưới đã bao gồm prefix này.
- “JSON UTF-8, khóa `snake_case`, UUID chữ thường, số nguyên lớn như cursor/device sequence/rank truyền bằng chuỗi thập phân.”
- “Trường không có trong schema hoặc enum sai bị từ chối; không bỏ âm thầm.”
- “`LocalDate` là ngày Gregorian hợp lệ `YYYY-MM-DD`, từ `0001-01-01` đến `9999-12-31`; MySQL lưu `CHAR(10) CHARACTER SET ascii COLLATE ascii_bin`, không dùng `DATE` vốn không phủ năm trước 1000.”
- “`WorkspaceSettings` có `time_zone: "Asia/Bangkok"`, `utc_offset_minutes: 420`, `week_start: 1`; cố định trong phase 1, không có form đổi múi giờ.”
- “Không log password, token email, cookie, CSRF, logout ticket, local key, note hoặc toàn bộ operation chứa dữ liệu cá nhân.”
- “Không có `/tasks`/`milestones` CRUD riêng, Google login, chia sẻ, quản trị nhiều owner hoặc endpoint đổi múi giờ trong đợt đầu.”
- “Không dọn event log, receipt hoặc tombstone ở giai đoạn đầu.” Không thêm cascade hoặc cơ chế dọn dữ liệu làm các migration T09/T10 phải phá hợp đồng này.
- “Direct pushes to `main` and `develop` are prohibited.” Khi triển khai dùng `feature/fastapi-mysql-foundation` từ `develop` theo Git Flow; giữ các thay đổi đang có, dùng checkout/worktree phù hợp và chỉ tích hợp qua PR.
- **Quy ước người dùng yêu cầu:** tên branch và message commit mô tả chức năng/thay đổi, không thêm mã task như `t05`, `T05` hoặc số task. Branch theo Git Flow của repo (`feature/`, `release/`, `fixbug/`, `hotfix/` đúng mục đích); commit theo dạng `feat: ...`, `fix: ...`, `docs: ...`, `chore: ...` đang dùng, không thêm tiền tố/scope theo mã task. Ví dụ: `feature/fastapi-mysql-foundation`, `feat: add async MySQL connection and transaction foundation`.

## Review Focus

1. **DB mất kết nối rồi hoạt động lại:** health trả 503 có thời hạn chờ, sau phục hồi trả 200 mà không restart API; transaction dở không được commit — Task 1/5.
2. **Schema trống, cũ hoặc mất bảng:** API không tự sửa DB và không báo ready giả; migration từ DB sạch có thể chạy lại, downgrade chỉ thử trên DB kiểm thử — Task 2/5.
3. **Ngày năm 0001, UUID/decimal không canonical, boolean giả số nguyên:** lưu/đọc ngày không đổi; từ chối dữ liệu sai kiểu hoặc vượt miền, không âm thầm coercion — Task 2/4.
4. **JSON trùng key, surrogate đơn, number không hữu hạn hoặc body chunked quá lớn:** trả đúng 400/413 trước handler, không ghi DB và không sửa payload — Task 4.
5. **Lỗi chứa password, cookie, token, note hoặc URL/query do người gửi đặt:** Problem/log chỉ chứa mã và request ID do server sinh, kể cả 500; không echo dữ liệu đầu vào — Task 3/4.

---

## 1. Trạng thái, phạm vi và quyết định triển khai

Ngày lập: **29/10/2026**. Lúc lập, T04 và T05 chưa triển khai. T04 đã hoàn thành và được merge vào `develop`; T05 đang được triển khai theo kế hoạch này. Các đường dẫn code trong plan là đầu ra dự kiến trước Task 1, không phải bảo đảm rằng chúng tồn tại trong base branch.

Quy ước dự án đặt hồ sơ theo task trong `docs/tasks/tXX/`, nên plan này lưu ở `docs/tasks/t05/plan.md` thay cho đường dẫn mặc định của skill.

### 1.1. Đầu vào bắt buộc từ T04

Trước Task 1 khi thực thi, xác nhận có `backend/app/main.py` với `app: FastAPI`, title `DAYFORGE API`, OpenAPI development `/api/v1/openapi.json`; `backend/pyproject.toml`, `.python-version`, `uv.lock`; `.env.example` và cấu hình local đã sinh; Compose service `mysql` có image digest và app user. Các lệnh `pnpm db:up`, `pnpm dev:api`, `pnpm dev:web`, `pnpm verify:env`, `pnpm smoke:local` phải dùng được theo báo cáo T04.

`backend/.env` cung cấp `APP_ENV`, `PUBLIC_ORIGIN`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`; development vẫn là `https://localhost:3000` và MySQL `127.0.0.1:3307`. Thiếu T04 thì hoàn thành T04 trước; không âm thầm dựng lại T04 trong T05. Không coi việc viết được plan T05 là đã đáp ứng điều kiện này.

### 1.2. Ranh giới với các task sau

| T05 sở hữu | Bàn giao, chưa làm trong T05 |
| --- | --- |
| Settings, engine/pool, dependency session và transaction rollback/close | T09: xác thực, mật khẩu, email, session/CSRF/Origin và binding `OWNER_EMAIL` |
| Migration `users`, `workspace_settings`, các kiểu DB dùng chung | T09: migration session/token/local-key/rate-limit; tạo owner + settings nguyên tử |
| Parser JSON, scalar DTO, Problem và log dùng chung | T10: schema Operation/Command đầy đủ, validation nghiệp vụ, JCS/hash và reducer |
| `/health`, `/version`, readiness schema | T10: `OwnerSyncState`, event/receipt/change log/projection, cursor/push/pull/bootstrap; calibration storage nếu cần |
| Bộ test hẹp đủ chứng minh T05 trên MySQL thật | T07: chuẩn hóa lint/typecheck/test runner toàn dự án, CI và môi trường test dùng chung |
| Hướng dẫn migration/chẩn đoán local và bằng chứng T05 | T29–T33: quyền DB production, deploy, backup/restore và rollback release |

T03 quy định schema tối thiểu khi các tính năng được triển khai, không yêu cầu tạo mọi bảng ngay T05. Chọn hai bảng đầu là quyết định chia migration của plan này; không thay hợp đồng dữ liệu. `WorkspaceSettings` là cấu hình của owner, **không** là root/operation sync mới. Không seed owner, password, email thật, session hoặc dữ liệu lịch.

### 1.3. Dependency và cấu hình vận hành

Chọn SQLAlchemy async + aiomysql để giữ I/O async theo convention; không thêm repository CRUD chung, Redis hoặc background worker. Alembic chạy qua async engine với `NullPool` và `connection.run_sync`; không gọi `metadata.create_all()` khi startup. Đây là cách tích hợp được mô tả trong [SQLAlchemy MySQL dialect](https://docs.sqlalchemy.org/en/21/dialects/mysql.html) và [Alembic asyncio cookbook](https://alembic.sqlalchemy.org/en/latest/cookbook.html#using-asyncio-with-alembic).

Pin bổ sung đã rà soát: `sqlalchemy[asyncio]==2.1.6`, `alembic==1.19.2`, `aiomysql[rsa]==0.3.2`, theo metadata [SQLAlchemy](https://pypi.org/project/SQLAlchemy/2.1.6/), [Alembic](https://pypi.org/project/alembic/1.19.2/), [aiomysql](https://pypi.org/project/aiomysql/0.3.2/). Không dùng Alembic 1.20.0/1.20.1 vì PyPI đã yank hai bản này do lỗi `alembic init`; 1.19.2 công bố hỗ trợ Python 3.14. Khả năng cài và chạy chung với Python/FastAPI của T04 vẫn phải được kiểm chứng thật; metadata aiomysql không đủ để kết luận đã hỗ trợ cấu hình Windows/Python này. Không tự hạ Python hoặc đổi major để làm bài kiểm tra xanh.

Pydantic trở thành dependency trực tiếp vì source T05 import nó; dùng Pydantic v2 trong giới hạn FastAPI đã khóa. `uv add --bounds exact` chọn và ghi pin chính xác cho Pydantic và các dev tools; ghi số phiên bản thực vào báo cáo. Không viết lockfile tay, không đổi pin frontend, không dùng extras `aiomysql.sa` hoặc cài thêm `python-dotenv`/`pydantic-settings`: uv của T04 đã nạp env file.

Các giá trị nội bộ được chọn cho T05: pool `pool_size=5`, `max_overflow=0`, `pool_timeout=3` giây, `pool_recycle=1800` giây; `pool_pre_ping=True`, driver `connect_timeout=3` giây, `echo=False`, `hide_parameters=True`. Mỗi connection đặt session timezone `+00:00`; kiểm tra strict SQL mode hiện có, không ghi đè mode khác. Readiness có timeout tổng **2 giây**, không cache kết quả qua request. Đây là mặc định local của plan, chưa phải thông số sizing production.

Lệnh root bổ sung: `pnpm db:migrate` → Alembic `upgrade head`; `pnpm db:current` → Alembic `current`; `pnpm test:api` → tests không cần MySQL; `pnpm test:api:mysql` → tests có marker `mysql` trên container riêng. Command migration dùng `uv run --directory backend --locked --env-file .env alembic ...`; command test không nạp `.env` development. Không thêm migration/reset vào `dev:api`, `db:up` hoặc startup HTTP.

## 2. Bản đồ file và thứ tự

| File tạo/sửa | Trách nhiệm | Task |
| --- | --- | --- |
| Modify `backend/pyproject.toml`, `backend/uv.lock`, `package.json` | Dependency exact, cấu hình pytest hẹp và command root | 1, command migration ở 2 |
| Create `backend/app/core/config.py` | Đọc/kiểm tra env, che secret, dựng DB URL bằng `URL.create` | 1 |
| Create `backend/app/core/database.py` | Bundle engine/sessionmaker, dependency session và dispose | 1 |
| Modify `backend/app/main.py` | `create_app`, lifespan, lắp middleware/router; giữ `app` cho Uvicorn | 1, 3–5 |
| Create `scripts/test_backend.py`, `backend/tests/compose.mysql.yaml` | Chạy pytest và cấp MySQL cô lập cho test T05 | 1 |
| Create `backend/tests/conftest.py` | Settings/factory và fixture an toàn, không đọc DB development | 1–2, 5 |
| Create `backend/tests/unit/test_config.py`, `backend/tests/integration/test_database.py` | Config, URL, transaction/connection lifecycle | 1 |
| Create `backend/app/core/values.py`, `backend/app/models/types.py` | Validator scalar, UUID binary, UTC timestamp, LocalDate SQL | 2 |
| Create `backend/app/models/base.py`, `backend/app/models/owner.py`, `backend/app/models/__init__.py` | Declarative metadata và hai model ban đầu | 2 |
| Create `backend/alembic.ini`, `backend/migrations/env.py`, `backend/migrations/script.py.mako`, `backend/migrations/versions/0001_owner_workspace.py` | Migration không chứa URL/password; online/offline và revision đầu | 2 |
| Create `backend/tests/integration/test_initial_migration.py`, `backend/tests/integration/test_sql_types.py` | DDL/constraint, vòng migration và round-trip kiểu dữ liệu | 2 |
| Create `backend/app/schemas/common.py`, `backend/app/schemas/problem.py` | Base DTO strict, FieldError và Problem | 3, scalar aliases ở 4 |
| Create `backend/app/core/errors.py`, `backend/app/core/request_logging.py` | Problem factory/handlers và ASGI request context/log | 3 |
| Create `backend/tests/api/test_errors_and_logging.py` | HTTP errors, request IDs và không lộ dữ liệu | 3 |
| Create `backend/app/core/strict_json.py` | Decode JSON nghiêm ngặt, giới hạn streaming body, replay bytes gốc | 4 |
| Create `backend/tests/unit/test_wire_values.py`, `backend/tests/api/test_strict_json.py` | Scalar biên, body sai và giới hạn byte | 4 |
| Create `backend/app/services/readiness.py`, `backend/app/schemas/system.py`, `backend/app/api/system.py` | DB/schema readiness và hai endpoint public | 5 |
| Create `backend/tests/api/test_system.py`, `backend/tests/integration/test_readiness.py` | DTO/version/health và mất–phục hồi DB/schema | 5 |
| Modify `scripts/smoke_local.py`, `docs/development.md`, `docs/README.md`, `docs/tasks/README.md` | Smoke HTTPS và hướng dẫn/trạng thái | 6 |
| Create `docs/tasks/t05/review-and-verification.md` | Bằng chứng, giới hạn và giao diện bàn giao | 6 |

Mọi package Python mới có `__init__.py` cần thiết, cùng task tạo module tương ứng; không tạo thư mục rỗng. Thứ tự chuẩn: **1 → 2 → 3 → 4 → 5 → 6**. Không đổi cấu trúc frontend hoặc refactor các tài liệu T01–T04.

## 3. Các task triển khai

### Task 1: Settings, kết nối async và session có rollback

**Files:** Các file Task 1 trong bảng mục 2; tests `backend/tests/unit/test_config.py`, `backend/tests/integration/test_database.py`.

**Interfaces:**
- Consumes: các biến env T04 tại mục 1.1; không nhận root DB password.
- Produces `Settings` trong `core/config.py`: `app_env: Literal["development","test","production"]`, `public_origin: str`, `db_host: str`, `db_port: int`, `db_name: str`, `db_user: str`, `db_password: SecretStr`; `load_settings(environ: Mapping[str, str] | None = None) -> Settings`; `build_database_url(settings: Settings) -> sqlalchemy.engine.URL`; `SettingsError(ValueError)` chỉ mang tên trường lỗi.
- Produces `Database` trong `core/database.py` với `engine: AsyncEngine`, `sessions: async_sessionmaker[AsyncSession]`; `create_database(settings: Settings) -> Database`; `async close_database(database: Database) -> None`; `async get_session(request: Request) -> AsyncIterator[AsyncSession]`.
- Produces `create_app(settings: Settings | None = None) -> FastAPI` và `app = create_app()` tại `app.main`. Load env/create engine trong lifespan, không ở import; runtime truy cập `request.app.state.database`.
- Test interfaces tại `conftest.py`: fixture `settings_factory: Callable[..., Settings]` tạo config test hợp lệ rồi áp dụng override; `t05_mysql_settings: Settings` chỉ nhận env có test-run ID do runner sinh. Test async dùng `asyncio.run()` và tạo/dispose engine trong cùng event loop, không thêm plugin async.

- [ ] **Step 1: Bổ sung dependency và khóa lại bằng uv.**

Run riêng từ root:

```powershell
uv add --directory backend --bounds exact "sqlalchemy[asyncio]==2.1.6" "alembic==1.19.2" "aiomysql[rsa]==0.3.2" "pydantic>=2,<3"
uv add --directory backend --dev --bounds exact pytest httpx jsonschema
```

Với Pydantic có constraint, lấy phiên bản v2 uv vừa resolve trong `uv.lock`, rồi chạy `uv add --directory backend "pydantic==<phiên bản vừa resolve>"` để manifest chỉ giữ pin exact. Không để placeholder trong file được commit. Giữ nguyên các pin T04; nếu resolver không giữ được chúng, xác minh nguyên nhân/compatibility trước khi thay. Expected: resolver thành công và không thay FastAPI/Uvicorn/Python ngoài chủ đích.

- [ ] **Step 2: Viết tests settings/transaction và fixture kiểm thử hẹp.**

Test config có tên/assertion:

```python
def test_database_url_preserves_reserved_password(settings_factory):
    settings = settings_factory(db_password="test-only:@/#%? mật khẩu")
    url = build_database_url(settings)
    assert url.drivername == "mysql+aiomysql"
    assert url.password == "test-only:@/#%? mật khẩu"
    assert url.query["charset"] == "utf8mb4"
    assert settings.db_password.get_secret_value() not in repr(settings)

@pytest.mark.parametrize("port", ["0", "65536", "3.5", "true"])
def test_invalid_port_is_rejected_without_echo(port):
    env = {"APP_ENV": "test", "DB_PORT": port, "DB_PASSWORD": "test-only-private"}
    with pytest.raises(SettingsError) as caught:
        load_settings(env)
    assert "test-only-private" not in str(caught.value)
```

Thêm `test_missing_required_env_is_not_defaulted`: mapping rỗng phải lỗi, không tự dùng DB development; `test_environment_does_not_override_explicit_settings`: factory truyền settings không bị `.env` ghi đè. Integration `test_explicit_transaction_commits`, `test_exception_rolls_back`, `test_close_without_commit_rolls_back` dùng bảng probe riêng, assert số dòng lần lượt `1`, `0`, `0` sau khi đọc bằng connection/session mới. `test_database_round_trip_uses_utf8mb4_utc_and_strict_mode` assert `SELECT 1 == 1`, charset `utf8mb4`, timezone `+00:00`, có `STRICT_TRANS_TABLES` hoặc `STRICT_ALL_TABLES`.

Đặt pytest `pythonpath=["."]`, `testpaths=["tests"]`, khai báo marker `mysql`. Unit/API tests tự tạo settings giả; fixture MySQL phải fail nếu thiếu run ID hoặc DB name khác `dayforge_t05_test`, không skip xanh hoặc dùng `backend/.env`. Fixture bảng probe chỉ tạo/drop trong database kiểm thử đã xác nhận, ngoài transaction đang được kiểm tra.

- [ ] **Step 3: Chạy tests mới để thấy thiếu implementation.**

Run: `uv run --directory backend --locked pytest tests/unit/test_config.py -v`.

Expected: FAIL do chưa có `app.core.config` hoặc các interface; không chấp nhận lỗi thiếu pytest/dependency làm bằng chứng RED của tính năng.

- [ ] **Step 4: Implement `Settings`, `load_settings`, `build_database_url` theo Interfaces.**

Chỉ chọn các biến được khai báo từ môi trường; validate port nguyên 1–65535, required string không rỗng, không nhận marker `__GENERATE_*__`. `PUBLIC_ORIGIN` là HTTPS origin không credentials/path/query/fragment; development phải khớp `https://localhost:3000`. Settings giữ secret bằng `SecretStr`, bất biến và không echo input trong lỗi. Dùng `URL.create("mysql+aiomysql", ...)`, không ghép DSN bằng f-string hoặc in DSN. CLI/application chỉ báo tên env lỗi, không in `ValidationError` chứa input.

- [ ] **Step 5: Implement `Database`, dependency session và lifespan theo Interfaces.**

Áp dụng pool/timeout mục 1.3, `expire_on_commit=False`, `autoflush=False`; không chia sẻ một `AsyncSession` giữa request/task song song. `get_session` rollback phần transaction chưa kết thúc và close trong `finally`, không tự commit khi response thành công. Service tương lai phải dùng `async with session.begin():`; không rollback thay cho một commit mà service đã hoàn tất. Shutdown dispose engine. DB unavailable không ngăn process lên để `/health` chẩn đoán; config sai làm startup fail với lỗi đã làm sạch. Import `app.main` không đọc/ghi DB, tạo schema hoặc mở kết nối.

- [ ] **Step 6: Implement runner MySQL kiểm thử cô lập và command root.**

`scripts/test_backend.py::main(argv: Sequence[str] | None = None) -> int`: mặc định gọi `python -m pytest -m "not mysql"`; `--mysql` gọi `-m mysql` và nhận các pytest args còn lại (bỏ separator `--` nếu có). Dùng `sys.executable`, cwd tuyệt đối `backend/`, truyền argv list, không shell string.

Nhánh MySQL lấy **chỉ image** từ `docker compose --env-file .env config --images` của T04, phải là một image MySQL có digest. Sinh project `dayforge-t05-<uuid4hex>`, password app/root độc lập trong memory và test-run ID. `backend/tests/compose.mysql.yaml` dùng image đó qua env, DB `dayforge_t05_test`, user `dayforge_test`, mapping `127.0.0.1::3306`, anonymous volume riêng tại `/var/lib/mysql`, không named volume hoặc bind mount; healthcheck SELECT 1 như T04. Anonymous volume giữ schema qua stop/start trong bài thử outage và bị gỡ khi cleanup project test. Compose dùng env file rỗng tạm thời và env test riêng, không dùng credentials development để mở DB test.

Runner `up -d --wait --wait-timeout 120`, lấy mapped port qua `compose port` và container ID qua `compose ps -q mysql`; đặt `APP_ENV=test`/`DB_*`, `DAYFORGE_T05_TEST_RUN_ID`, `DAYFORGE_T05_TEST_PROJECT`, `DAYFORGE_T05_TEST_CONTAINER_ID` cho pytest. Mọi SQL test dùng app user; không root. `finally` gọi `down --volumes --remove-orphans` **chỉ** với file/project UUID vừa tạo đã kiểm tra prefix, kể cả pytest/startup lỗi. Không đổi/dừng project `dayforge-dev`. Không in config, env, raw container inspect hoặc output có secret; lỗi Docker/timeout/test phải exit khác 0, không giả thành skip. Runner chỉ là scaffold cho các test T05; T07 có thể hợp nhất sau.

Thêm root scripts `test:api = uv run --directory backend --locked python ../scripts/test_backend.py`, `test:api:mysql` là cùng command thêm `--mysql`.

- [ ] **Step 7: Kiểm chứng deliverable và commit.**

Run riêng: `uv sync --directory backend --locked`, `pnpm test:api -- tests/unit/test_config.py -v`, `pnpm test:api:mysql -- tests/integration/test_database.py -v`.

Expected: tests PASS, không skip case MySQL; runner cleanup đúng project và service dev còn nguyên. Chạy runner khi Docker không khả dụng phải exit khác 0, không PASS; không dừng daemon dùng chung để tạo lỗi, có thể kiểm tra bằng executable Docker không khả dụng trong môi trường process thử riêng.

```bash
git add backend/pyproject.toml backend/uv.lock backend/app/core/__init__.py backend/app/core/config.py backend/app/core/database.py backend/app/main.py backend/tests/conftest.py backend/tests/compose.mysql.yaml backend/tests/unit/test_config.py backend/tests/integration/test_database.py scripts/test_backend.py package.json
git commit -m "feat: add async MySQL connection and transaction foundation"
```

### Task 2: Kiểu dữ liệu và migration owner/workspace ban đầu

**Files:** Các file Task 2 trong bảng mục 2; Modify test fixtures và `package.json`; Test `test_initial_migration.py`, `test_sql_types.py`.

**Interfaces:**
- Consumes: `Settings`, `build_database_url`, `Database`, runner/fixture Task 1.
- Produces `Base(DeclarativeBase)` với metadata naming convention; `User`, `WorkspaceSettings` trong `models/owner.py`; `UUIDBytes(TypeDecorator[UUID])`, `UTCMilliseconds(TypeDecorator[datetime])`, `LocalDateSQL(TypeDecorator[str])` trong `models/types.py`.
- Produces `validate_local_date(value: str) -> str`, `parse_wire_uuid(value: str) -> UUID`, `parse_wire_timestamp(value: str) -> datetime`, `format_utc_timestamp(value: datetime) -> str`, `validate_decimal(value: str, *, minimum: int, maximum: int) -> str` tại `core/values.py`. Hàm parse/validate lỗi bằng `ValueError` với mã cố định, không kèm giá trị; trả nguyên chuỗi canonical khi đúng.
- Migration revision `0001_owner_workspace`, `down_revision=None`; `upgrade() -> None`, `downgrade() -> None`. Test fixture bổ sung `user_factory: Callable[..., User]` tạo row chưa persist, dùng UUID test, email `.test`, PHC placeholder chỉ cho storage test và timestamp UTC cố định; không seed vào DB development.

- [ ] **Step 1: Viết tests migration và round-trip theo schema quyết định dưới đây.**

`test_upgrade_from_empty_and_repeat_upgrade`: sau `upgrade head`, schema có đúng `alembic_version`, `users`, `workspace_settings`, current revision `0001_owner_workspace`; hai bảng business rỗng; chạy lại upgrade không đổi schema/dữ liệu. Không assert đây là toàn bộ schema sau khi T09/T10 thêm migration; cập nhật test danh sách revision/bảng khi task sau mở rộng.

`test_owner_slot_is_singleton`, `test_workspace_requires_existing_owner`, `test_workspace_constants_are_enforced` chạy DML cố ý vi phạm qua SQL để chứng minh constraint nằm trong MySQL, assert `IntegrityError` và đọc mới không thấy row lỗi. `test_email_has_its_own_binary_unique_constraint` inspect MySQL metadata, assert unique index `uq_users_email_canonical` chỉ gồm `email_canonical` và kiểu `VARBINARY(254)`. Vì singleton không cho tồn tại hai owner, không giả định một insert trùng email sẽ cô lập được constraint email khỏi constraint slot; không nới singleton để test.

```python
@pytest.mark.parametrize("value", ["0001-01-01", "0999-12-31", "2000-02-29", "9999-12-31"])
def test_local_date_round_trip_has_no_year_1000_floor(t05_mysql_settings, value):
    assert asyncio.run(round_trip_local_date(t05_mysql_settings, value)) == value
```

Định nghĩa helper test `async round_trip_local_date(settings: Settings, value: str) -> str` trong `test_sql_types.py`: tạo bảng probe bằng `LocalDateSQL` trong DB test, insert/select rồi drop/dispose ở `finally`; không tạo bảng đó trong migration. `test_uuid_bytes_use_network_order` assert UUID round-trip và `HEX(id)` bằng `uuid.bytes.hex().upper()`. `test_utc_milliseconds_round_trip` assert aware UTC cùng millisecond; `test_naive_or_submillisecond_datetime_is_rejected` phải lỗi, không truncate. `test_binary_email_comparison_preserves_local_part_case` assert query `Owner@example.test` không match `owner@example.test`.

Thêm `test_alembic_check_has_no_metadata_drift`, `test_downgrade_upgrade_on_disposable_db`: downgrade base chỉ trên DB test, mất đúng hai bảng, nâng lại tạo đúng schema/rỗng. Mỗi case migration cần DB test rỗng hoặc teardown/reset đúng các bảng của nó trong project test, không dựa thứ tự pytest.

- [ ] **Step 2: Chạy tests để thấy thiếu migration/model.**

Run: `pnpm test:api:mysql -- tests/integration/test_initial_migration.py tests/integration/test_sql_types.py -v`.

Expected: FAIL do chưa có migration/type/model hoặc chưa có revision; fixture không được tự `create_all()` làm test pass.

- [ ] **Step 3: Implement scalar helpers và SQL types theo Interfaces.**

`LocalDateSQL` là `CHAR(10, charset="ascii", collation="ascii_bin")`, validate regex đúng padding và Gregorian bằng `datetime.date` cả bind/result. UUID storage `BINARY(16)` theo `UUID.bytes`, chỉ nhận UUID object ở bind; timestamp storage `DATETIME(3)`, bind cần aware datetime có precision millisecond, convert UTC trước khi bỏ tzinfo, read gắn UTC. Không dùng MySQL `TIMESTAMP` với miền hẹp hơn hoặc ngày nghiệp vụ kiểu UTC datetime. Wire UUID chỉ nhận lowercase v4/v5 đúng schema; wire timestamp đúng `YYYY-MM-DDTHH:mm:ss.mmmZ`, parse semantic, không nhận offset thay `Z`. `format_utc_timestamp` dùng padding 4 chữ số năm, không dựa `%Y` cho năm trước 1000. Decimal canonical không `+`, leading zero hoặc `-0`, kiểm tra numeric bounds theo tham số.

- [ ] **Step 4: Implement metadata, model và revision đầu.**

Mọi bảng InnoDB, mặc định `utf8mb4` (hỗ trợ đầy đủ Unicode theo [MySQL utf8mb4](https://dev.mysql.com/doc/refman/8.4/en/charset-unicode-utf8mb4.html)); cột định danh/canonical override binary như dưới. Đặt tên constraint rõ ràng; không FK cascade xóa owner hoặc dữ liệu con.

| Bảng | Cột, nullability và constraint phải có |
| --- | --- |
| `users` | `id BINARY(16) PRIMARY KEY` không auto increment; `owner_slot TINYINT UNSIGNED NOT NULL DEFAULT 1`, `UNIQUE uq_users_owner_slot`, `CHECK ck_users_owner_slot_one: owner_slot = 1`; `email_canonical VARBINARY(254) NOT NULL UNIQUE uq_users_email_canonical`; `email_delivery VARCHAR(254) NOT NULL`; `password_hash VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`; `email_verified_at DATETIME(3) NOT NULL`; `auth_version BIGINT UNSIGNED NOT NULL DEFAULT 1 CHECK >= 1`; `created_at`, `updated_at DATETIME(3) NOT NULL`. |
| `workspace_settings` | `owner_id BINARY(16) PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT`; `time_zone VARCHAR(64) ascii/ascii_bin NOT NULL DEFAULT 'Asia/Bangkok' CHECK = 'Asia/Bangkok'`; `utc_offset_minutes SMALLINT NOT NULL DEFAULT 420 CHECK = 420`; `week_start TINYINT UNSIGNED NOT NULL DEFAULT 1 CHECK = 1`. |

`User.email_canonical` là bytes UTF-8 để so sánh binary; T09 canonical hóa email rồi encode, không lower toàn bộ email. PHC/created/updated/verified do service T09 cung cấp; DB không tự kích hoạt tài khoản, không lưu password plaintext. Hai bảng được tạo rỗng. Mặc định SQL phải khớp ORM để `alembic check` không sinh drift; không thêm field nghiệp vụ chưa có trong hợp đồng.

- [ ] **Step 5: Nối Alembic với settings và thêm command migration.**

`alembic.ini` không chứa `sqlalchemy.url` có credential; `env.py` load settings qua Task 1, tạo engine `NullPool`, dùng `run_sync` cho context migration, dispose trong `finally`. `target_metadata=Base.metadata` sau import models; bật compare type/server default. Offline `--sql` dùng dialect MySQL, không literalize dữ liệu riêng. Không đưa DSN có `%` vào `ConfigParser` bằng chuỗi chưa escape; ưu tiên truyền URL/connection trực tiếp cho context/engine.

Thêm `db:migrate`, `db:current` đúng mục 1.3. Test subprocess Alembic truyền env test và cwd `backend/`, không có `--env-file .env`. MySQL DDL có implicit commit: lỗi giữa migration không được coi là đã rollback nguyên khối; ghi cách kiểm tra revision/tables và sửa có chủ đích, không tự drop DB dev để retry. Không stamp head để che thiếu schema.

- [ ] **Step 6: Kiểm chứng migration thật và commit.**

Run: `pnpm test:api:mysql -- tests/integration/test_initial_migration.py tests/integration/test_sql_types.py -v`; sau đó trên DB dev của T04 chạy riêng `pnpm db:migrate`, `pnpm db:current`, `pnpm db:migrate`.

Expected: test PASS, `alembic check` exit 0 trong test, revision đúng và upgrade lần hai không thay đổi. Không chạy downgrade/reset trên DB dev. Kiểm tra `upgrade head --sql` sinh SQL không có credential và không kết nối DB.

```bash
git add backend/app/core/values.py backend/app/models backend/alembic.ini backend/migrations backend/tests/conftest.py backend/tests/integration/test_initial_migration.py backend/tests/integration/test_sql_types.py package.json
git commit -m "feat: add owner workspace schema and Alembic migrations"
```

### Task 3: Problem HTTP và request log an toàn

**Files:** Task 3 trong bảng mục 2; Modify `main.py`; Test `backend/tests/api/test_errors_and_logging.py`.

**Interfaces:**
- Consumes: `create_app`, `format_utc_timestamp` và settings/database lifecycle từ Tasks 1–2.
- Produces `ContractModel(BaseModel)` tại `schemas/common.py` với `ConfigDict(strict=True, extra="forbid", hide_input_in_errors=True)`; `FieldError(path: str, code: str)` và `Problem` đúng `$defs.Problem` T03 tại `schemas/problem.py`.
- Produces `ProblemHTTPException(HTTPException)` tại `core/errors.py`, constructor `(*, status_code: int, code: str, field_errors: list[FieldError] | None = None, retry_after_seconds: int | None = None)`; `make_problem(request: Request, *, status_code: int, code: str, field_errors: list[FieldError] | None = None, retry_after_seconds: int | None = None) -> JSONResponse`; `register_exception_handlers(app: FastAPI) -> None`.
- Produces pure-ASGI `RequestLoggingMiddleware(app: ASGIApp)` và `configure_logging() -> None` tại `core/request_logging.py`. Request ID ở `scope["state"]["request_id"]`/`request.state.request_id`; tạo mới UUID v4 tại server và gửi `X-Request-ID` ở mọi HTTP response, gồm 500.

- [ ] **Step 1: Viết tests lỗi/log qua test-only routes.**

Routes `/api/v1/_test/*` chỉ tạo trong test, không mount vào app production. Dùng `TestClient` context manager để thực sự chạy lifespan. Tạo route validation với `ContractModel`, route raise `ProblemHTTPException(503, ...)` bằng keyword args và route raise `RuntimeError("test-only-secret")`.

```python
def test_unexpected_error_returns_sanitized_problem(error_client, caplog):
    response = error_client.get("/api/v1/_test/crash?token=test-only-query")
    body = response.json()
    assert response.status_code == 500
    assert response.headers["content-type"].startswith("application/problem+json")
    assert body["code"] == "internal_error"
    assert body["retryable"] is False
    assert response.headers["x-request-id"] == body["request_id"]
    assert body["instance"] == f"/api/v1/requests/{body['request_id']}"
    assert "test-only-secret" not in response.text + caplog.text
    assert "test-only-query" not in response.text + caplog.text
```

Định nghĩa fixture `error_client: TestClient` trong file test tạo app/config giả, thêm probe routes; không gọi DB để setup. `test_validation_problem_matches_t03_schema` validate response qua Draft202012Validator + FormatChecker và `$defs.Problem`, assert 422/`validation_failed`, JSON Pointer đúng và không có `input`, `ctx`, raw body. `test_404_and_405_are_problem_json` assert 404/405 và giữ header `Allow` đúng. `test_unavailable_is_retryable` assert 503/`service_unavailable`/true. `test_request_id_cannot_be_injected` gửi `X-Request-ID` tùy ý, assert response là UUID v4 mới.

`test_sensitive_request_never_enters_logs` gửi body/password/note, Cookie, Authorization, CSRF và query token với sentinel riêng; assert không sentinel nào xuất hiện trong response lỗi/log. `test_request_completion_is_logged_once_even_on_500` assert đúng một event hoàn thành và cùng request ID trên response/log. Lấy response 500 bằng cả `raise_server_exceptions=False` lẫn mặc định để phát hiện exception vô tình thoát khỏi middleware.

- [ ] **Step 2: Chạy tests mới và xác nhận RED.**

Run: `pnpm test:api -- tests/api/test_errors_and_logging.py -v`.

Expected: FAIL do thiếu Problem/handlers/middleware hoặc FastAPI còn trả lỗi mặc định; lỗi test fixture/dependency phải được sửa trước khi coi RED hợp lệ.

- [ ] **Step 3: Implement `ContractModel`, `FieldError`, `Problem` và error handlers.**

Giữ chính xác field/required/additionalProperties theo T03; optional fields không có thì loại khỏi JSON, không thêm `operation_id` vào Problem. `make_problem` dùng text tĩnh theo code, `type=/api/v1/problems/{code}`, `instance=/api/v1/requests/{request_id}`, UTC `.mmmZ`, media type chuẩn và `Cache-Control: no-store`. `retryable=true` cho 429/503, false cho lỗi khác. `retry_after_seconds` chỉ tạo cho 429 và phải khớp `Retry-After`; mặc định 503 không thêm hai field/header này.

Map `RequestValidationError` sang 422/`validation_failed` (JSON syntax sang 400/`malformed_request` khi parser Task 4 lắp vào), dùng error location/code đã lọc, JSON Pointer escape `~` → `~0`, `/` → `~1`. Body field dùng `/field`, query/path dùng `/query/field`, `/path/field`; root dùng chuỗi rỗng. Chỉ đưa tên field/alias đã khai báo trong schema và array index vào path; lỗi extra key dùng pointer của parent đã biết, không echo tên key tùy ý. Không copy `input`, `ctx`, message tùy ý vào lỗi. Handler Starlette `HTTPException` giữ header protocol cần thiết như `Allow`, map 404 `not_found`, 405 `method_not_allowed`, không echo `detail` lạ. Unexpected exception/response validation lỗi trả 500 `internal_error`; không map mọi `IntegrityError` thành 503 hoặc 409. Service T09/T10 sau này phân loại lỗi DB theo nghiệp vụ.

- [ ] **Step 4: Implement request context/log và lắp vào `create_app`.**

Dùng middleware ASGI thuần, không `BaseHTTPMiddleware`; logger JSON stdout theo allowlist `event`, `request_id`, `method`, `route`, `status_code`, `duration_ms`, `error_code`. `route` lấy template đã match, route lạ dùng `unmatched`, không dùng raw path/query. Không log headers, body, DSN, SQL parameters, exception message/traceback có dữ liệu; SQLAlchemy echo/debug tắt. Owner ID chưa auth nên chưa ghi. Mỗi request chỉ một completion event; startup/shutdown/error event dùng mã tĩnh.

Middleware context nằm ngoài middleware parser Task 4, giữ request ID tới lúc gửi response và reset ContextVar trong `finally`. Bắt exception chưa bắt đầu response, gửi Problem 500 qua cùng factory và không rethrow làm TestClient/Uvicorn ghi lại exception nhạy cảm. Nếu response đã bắt đầu thì không gửi response thứ hai; log code tĩnh `response_interrupted`. Uvicorn vẫn `--no-access-log` như T04. Không tự gắn CORS, cookie hoặc auth placeholder.

- [ ] **Step 5: Kiểm chứng và commit.**

Run: `pnpm test:api -- tests/api/test_errors_and_logging.py -v`.

Expected: PASS, mọi Problem hợp schema, sentinel không xuất hiện, exception route không làm request ID/log bị mất hoặc bị ghi hai lần.

```bash
git add backend/app/schemas/__init__.py backend/app/schemas/common.py backend/app/schemas/problem.py backend/app/core/errors.py backend/app/core/request_logging.py backend/app/main.py backend/tests/api/test_errors_and_logging.py
git commit -m "feat: add consistent API problems and private request logging"
```

### Task 4: Parser JSON nghiêm ngặt và scalar DTO dùng chung

**Files:** Create `core/strict_json.py`, `tests/unit/test_wire_values.py`, `tests/api/test_strict_json.py`; Modify `schemas/common.py`, `main.py`.

**Interfaces:**
- Consumes: validators `core/values.py` Task 2, `ContractModel` và `make_problem` Task 3.
- Produces `parse_json_bytes(data: bytes) -> Any` (chỉ JSON-compatible Python values; invalid raises `ProblemHTTPException` 400); pure-ASGI `StrictJSONMiddleware(app: ASGIApp)` giới hạn body và validate syntax trước routing/handler.
- Produces scalar aliases trong `schemas/common.py`: `WireUUID` giữ chuỗi lowercase v4/v5; `LocalDate` giữ chuỗi Gregorian; `WireTimestamp` giữ chuỗi UTC millisecond; `Cursor` chuỗi canonical trong `[0,18446744073709551615]`; `DeviceSequence` trong `[1,18446744073709551615]`; `OrderKey` trong `[-9223372036854775808,9223372036854775807]`. Dùng `Annotated[str, ...]` và helpers Task 2, không đổi chuỗi wire thành JSON number.

- [ ] **Step 1: Viết tests scalar biên và JSON trước implementation.**

```python
@pytest.mark.parametrize("value", ["0001-01-01", "2000-02-29", "9999-12-31"])
def test_local_date_accepts_full_contract_range(value):
    assert TypeAdapter(LocalDate).validate_python(value) == value

@pytest.mark.parametrize("value", ["0000-01-01", "1900-02-29", "2026-2-01"])
def test_local_date_rejects_invalid_gregorian_or_padding(value):
    with pytest.raises(ValidationError):
        TypeAdapter(LocalDate).validate_python(value)
```

`test_decimal_bounds_and_canonical_spelling` assert Cursor max accepted, max+1 rejected, DeviceSequence `"0"` rejected, OrderKey min/max accepted; `"01"`, `"+1"`, `"-0"`, int/float/bool đều bị từ chối. `test_uuid_and_timestamp_are_not_reformatted` assert uppercase UUID, UUID v1, offset `+00:00`, timestamp thiếu `.mmm`/ngày sai đều bị từ chối; payload hợp lệ trả nguyên chuỗi. `test_strict_model_rejects_coercion_and_extra_fields` dùng model test `duration_minutes: StrictInt | None`, `enabled: StrictBool`, assert `True`, `"1"`, `1.0` không hợp duration, `"true"` không hợp boolean; không nhận field lạ.

API probe test-only dùng model này và spy đếm số lần handler chạy. `test_invalid_json_never_reaches_handler` parameterize duplicate key lồng nhau, `NaN`, `Infinity`, `1e999`, lone surrogate escape, UTF-8 sai, số nguyên ngoài miền safe integer `±9007199254740991`; assert 400/`malformed_request`, spy 0. `test_wrong_content_type_is_rejected` assert 415/`unsupported_media_type`. JSON media type cho phép `application/json` và tham số charset UTF-8, từ chối charset khác.

`test_streaming_body_limit_counts_actual_bytes` gửi không Content-Length và có Content-Length sai, assert giới hạn dựa byte thực: auth **16.384**, các JSON mutation còn lại **8.388.608** byte. Body JSON hợp lệ có kích thước đúng giới hạn đi qua; thêm một byte trả 413/`payload_too_large`, spy 0, không đọc toàn bộ stream vô hạn. Có case Unicode nhiều byte để không nhầm code point với byte. `test_parser_preserves_original_body_bytes` assert handler đọc lại đúng raw bytes ban đầu, khoảng trắng/key order không đổi. `test_field_error_pointer_escapes_known_alias_only` dùng schema probe có alias `known/~field`, assert path `/known~1~0field`; với extra key `test-only-private-key` assert pointer parent `""`, không có tên key đó trong response/log.

- [ ] **Step 2: Chạy tests mới và xác nhận RED.**

Run: `pnpm test:api -- tests/unit/test_wire_values.py tests/api/test_strict_json.py -v`.

Expected: FAIL do thiếu aliases/parser hoặc JSON mặc định chấp nhận dữ liệu bị cấm; không coi 404 do quên probe route là RED hợp lệ.

- [ ] **Step 3: Implement aliases strict theo Interfaces.**

Validators kiểm tra cú pháp và miền số thật, không chỉ length/regex. Không tự lowercase UUID, sửa số decimal, cắt text hoặc thêm default vào DTO đã gửi. Number trong JSON chỉ nhận giá trị hữu hạn; numeric integer vượt safe integer bị từ chối vì mọi số lớn trong contract v1 phải là chuỗi. Field có miền nhỏ hơn vẫn do Pydantic/DTO task sở hữu kiểm tra.

T05 chưa tạo `TaskData`/`Command`/auth request DTO: normalization NFC/trim, password policy, enum/limits nghiệp vụ được làm ở task sở hữu. Các operation đã ký/hash ở T10 chỉ được validate canonical, không normalize/rewrite lúc retry hoặc lưu.

- [ ] **Step 4: Implement decoder và middleware streaming rồi lắp sau request context.**

Decoder dùng UTF-8 strict, `json.loads` có `object_pairs_hook` kiểm tra duplicate mọi mức, `parse_constant` từ chối NaN/Infinity, kiểm tra float hữu hạn/int bounds và recursive kiểm tra surrogate cả key/value. Từ chối BOM/JSON lỗi, không sửa payload. Middleware áp dụng POST/PUT/PATCH thuộc `/api/v1/`; auth prefix `/api/v1/auth/` dùng 16 KiB, còn lại 8 MiB. Từ chối Content-Length rõ ràng vượt giới hạn sớm, nhưng vẫn đếm từng chunk dù header vắng/sai. Khi hợp lệ, replay nguyên body cho downstream, không chèn parsed object vào request bằng private attribute.

Lỗi body dùng `make_problem` và request ID Task 3, không echo parser exception. Không xử lý body cho GET/HEAD, không gọi DB và không thay kiểm tra Origin/CSRF mà T09 phải bổ sung trước mọi mutation thật. Middleware xử lý `http.disconnect` kết thúc an toàn, không coi body dang dở là request hợp lệ.

- [ ] **Step 5: Kiểm chứng toàn bộ pipeline HTTP và commit.**

Run: `pnpm test:api -- tests/unit/test_wire_values.py tests/api/test_strict_json.py tests/api/test_errors_and_logging.py -v`.

Expected: PASS; các sentinel JSON/validation không lọt response/log, Error/Problem/header không bị middleware mới đổi định dạng.

```bash
git add backend/app/core/strict_json.py backend/app/schemas/common.py backend/app/main.py backend/tests/unit/test_wire_values.py backend/tests/api/test_strict_json.py
git commit -m "feat: enforce strict JSON and canonical wire scalar validation"
```

### Task 5: Health/version có kiểm tra DB và schema thật

**Files:** Task 5 trong bảng mục 2; Modify `main.py`, test fixtures.

**Interfaces:**
- Consumes: `Database`, Alembic metadata/revisions, `ContractModel`, `ProblemHTTPException`, `WireTimestamp`.
- Produces `required_schema_revision() -> str`, `async check_readiness(database: Database, *, required_revision: str) -> bool` tại `services/readiness.py`; `HealthResponse`, `VersionLimits`, `VersionInfo` tại `schemas/system.py`; `router: APIRouter` tại `api/system.py` có prefix `/api/v1`.
- `required_schema_revision()` đọc single head từ Alembic scripts được đóng gói cùng backend, không hardcode `0001` khiến T09 nâng migration rồi health báo sai. Nhiều head hoặc thiếu scripts là lỗi cấu hình startup đã làm sạch.
- `async health(request: Request) -> HealthResponse`: 200 `{"status":"ok"}` khi ready, ngược lại raise 503 `service_unavailable`. `async version() -> VersionInfo`: 200 thông tin tương thích, không phụ thuộc DB. Hai GET không tạo dữ liệu/cookie/owner.
- Test fixture `mysql_control: Callable[[Literal["stop", "start"]], None]` trong `conftest.py` chỉ điều khiển container ID do runner Task 1 cung cấp sau khi xác nhận run ID/project UUID khớp. `stop` gọi Docker stop đúng ID; `start` gọi Docker start đúng ID rồi chờ health qua `docker inspect --format` chỉ lấy `.State.Health.Status`, timeout 120 giây; không đọc/in full inspect hoặc thao tác project dev.

- [ ] **Step 1: Viết tests endpoint và readiness thật.**

```python
def test_version_matches_contract_without_database(system_client, contract_validator):
    response = system_client.get("/api/v1/version")
    body = response.json()
    assert response.status_code == 200
    contract_validator("VersionInfo").validate(body)
    assert body["api_major"] == 1
    assert body["protocol_versions"] == [1]
    assert body["reducer_versions"] == [1]
    assert body["limits"] == {
        "push_operations": 100, "push_request_bytes": 8388608,
        "operation_bytes": 2097152, "commands_per_operation": 1000,
        "page_operations": 200, "page_bytes": 8388608,
        "page_token_ttl_seconds": 1800,
    }
    assert "set-cookie" not in response.headers
```

Định nghĩa `system_client` tạo app với settings test và DB không liên lạc được; `contract_validator(definition: str) -> Draft202012Validator` fixture resolve `$defs` từ file T03 trong repo, không tải mạng. Unit/API test `test_health_success_dto_is_exact` override readiness bằng mock async true, assert body chính xác/status 200/no-store/no cookie. `test_health_unavailable_is_problem` mock false, assert 503/`service_unavailable`/true/hợp Problem.

Integration `test_empty_database_is_not_ready` assert 503 và không sinh bảng. `test_behind_revision_or_missing_table_is_not_ready` tạo revision cũ và case drop bảng `workspace_settings` trên DB test, assert 503, giữ revision/data còn lại. `test_migrated_database_is_ready` assert 200 sau migration, số owner vẫn 0. `test_database_outage_recovers_without_api_restart` giữ cùng TestClient/lifespan, stop/start **chỉ container MySQL test**, request lúc dừng trả 503 trong tối đa 3 giây (timeout logic 2 giây + tolerance), request sau Compose healthy trả 200; không dispose/recreate app để làm test xanh. Dùng pool đã từng hoạt động để kiểm tra stale connection/pre-ping.

- [ ] **Step 2: Chạy tests mới và xác nhận RED.**

Run riêng `pnpm test:api -- tests/api/test_system.py -v`, `pnpm test:api:mysql -- tests/integration/test_readiness.py -v`.

Expected: FAIL vì thiếu route/readiness, không pass bằng stub luôn true.

- [ ] **Step 3: Implement readiness service theo Interfaces.**

Trong `asyncio.timeout(2)`, mở connection mới từ pool, `SELECT 1`, kiểm tra `alembic_version` có đúng revision single-head, và đọc zero rows từ cột tối thiểu `users.id`/`workspace_settings.owner_id` để phát hiện stamp có nhưng thiếu bảng. Xác nhận session timezone `+00:00`, charset `utf8mb4`, strict SQL mode. Timeout/lỗi kết nối/schema không sẵn sàng trả false và log mã tĩnh, không raw SQL/exception/DSN. Hủy probe giải phóng/invalidates connection đúng theo driver; không để probe treo giữ pool. Không mutate DB hoặc dùng cache ready cũ. Owner chưa được tạo không phải lỗi readiness.

- [ ] **Step 4: Implement schema/router và lắp app factory.**

`VersionInfo`/limits đúng test/schema T03, `server_time` là UTC millisecond tại mỗi response, không lộ runtime patch/config/email/DSN. Health/version đều `Cache-Control: no-store`, không auth; chỉ mount hai endpoint này. App giữ title và OpenAPI path development T04; production tắt docs/OpenAPI public. Startup config sai fail rõ, DB down vẫn lên process để health trả 503, startup không tự chạy Alembic/seed. Probe Next.js T04 tiếp tục đọc OpenAPI JSON hợp lệ, không yêu cầu `paths == {}` sau T05.

- [ ] **Step 5: Chạy tests và commit.**

Run: `pnpm test:api -- tests/api/test_system.py -v`, `pnpm test:api:mysql -- tests/integration/test_readiness.py -v`.

Expected: PASS; outage→recovery không restart API, không skip, không tác động DB dev. `/version` không phải bằng chứng auth/sync hoặc reducer nghiệp vụ đã được triển khai.

```bash
git add backend/app/services/__init__.py backend/app/services/readiness.py backend/app/schemas/system.py backend/app/api/__init__.py backend/app/api/system.py backend/app/main.py backend/tests/conftest.py backend/tests/api/test_system.py backend/tests/integration/test_readiness.py
git commit -m "feat: expose database readiness and API compatibility version"
```

### Task 6: Kiểm chứng xuyên HTTPS, runbook và bàn giao T05

**Files:** Modify `scripts/smoke_local.py`, `docs/development.md`, `docs/README.md`, `docs/tasks/README.md`; Create `docs/tasks/t05/review-and-verification.md`.

**Interfaces:**
- Consumes: toàn bộ command/endpoint/interface Tasks 1–5, smoke TLS có kiểm tra CA của T04.
- Produces: smoke `/`, `/api/v1/openapi.json`, `/api/v1/health`, `/api/v1/version` qua HTTPS cùng origin; hướng dẫn migrate/start/test/chẩn đoán và báo cáo kết quả trung thực.

- [ ] **Step 1: Mở rộng smoke đã có và ghi kỳ vọng trước khi chạy.**

Giữ `--ca-file`, hostname/origin validation và TLS verification của T04. Probe health phải 200 và body đúng `{"status":"ok"}`; version đúng major/arrays/limits mục Task 5 và timestamp UTC. Sau khi cả bốn probe pass mới in `PASS: local HTTPS web, API and MySQL readiness`. Health 503, version sai hoặc proxy trả HTML đều exit 1, không PASS. Không theo redirect sang origin khác, không thêm credentials vào CLI.

Chạy smoke lúc MySQL **dev** chưa migrate (môi trường local chưa có dữ liệu sản phẩm), phải FAIL vì health 503; không drop/downgrade DB đang có chỉ để tạo RED. Nếu DB đã migrate, dùng kết quả RED từ test readiness Task 5 và không đảo schema thật.

- [ ] **Step 2: Cập nhật runbook local theo đường chạy cụ thể.**

Sau `setup:local`/TLS/`db:up`, chạy `pnpm db:migrate`, `pnpm db:current`, rồi `dev:api`, `dev:web`, smoke với CA T04. Ghi thêm commands unit/API tests và MySQL tests cô lập; migration không tự chạy khi API khởi động. Ghi các tình huống: env thiếu/sai, port/credential của volume cũ lệch cấu hình, DB unavailable, revision lệch, migration DDL thất bại một phần. Hướng xử lý là kiểm tra cấu hình/revision và áp dụng migration đúng; không `down -v`, `stamp head` hoặc restore backup cũ tự động.

Ghi ranh giới transaction: request dependency không auto-commit, service dùng `session.begin()`, background/concurrent task cần session riêng. T09 tạo verified `User` + fixed `WorkspaceSettings` trong cùng transaction; T10 thêm owner lock/event store và dữ liệu domain qua Alembic, không tái sử dụng User ID hoặc thêm đường CRUD bypass sync. Backend có quyền schema dev để migrate; phân quyền migration/runtime production xử lý tại T29.

- [ ] **Step 3: Chạy bộ kiểm chứng cuối từ môi trường T04.**

Chạy riêng từ root:

```powershell
uv sync --directory backend --locked
pnpm verify:env
pnpm test:api
pnpm test:api:mysql
pnpm db:migrate
pnpm db:current
pnpm smoke:local --ca-file "$dayforgeCaFile"
git diff --check
git status --short
```

`$dayforgeCaFile` là đường dẫn `rootCA.pem` đã dùng ở T04. Expected: install locked không đổi lockfile, tests không có MySQL case bị skip, revision head, HTTPS smoke PASS và diff sạch whitespace. Kiểm tra Cốc Cốc desktop đọc được health/version qua `https://localhost:3000`, ghi phiên bản thực; không coi đây là AC auth/offline/sync đã đạt. Sau khi API đóng bằng Ctrl+C, không còn connection do engine T05 giữ.

- [ ] **Step 4: Ghi báo cáo và cập nhật trạng thái có điều kiện.**

Báo cáo ghi ngày/OS/runtime/dependency versions, MySQL image+digest, từng lệnh/exit code, tests count, kết quả năm Review Focus, migration từ DB sạch, rollback/upgrade DB test, outage/recovery, log sentinels và HTTPS. Nếu thiếu Docker/runtime/CA hoặc tests fail thì ghi FAIL/BLOCKED/chưa chạy đúng case, không ghi PASS suy đoán; không đính kèm env/raw log có secrets.

Link báo cáo/runbook vào mục lục; chỉ đánh dấu T05 hoàn thành sau khi đủ điều kiện mục 4. T06–T36 giữ trạng thái thực tế; T04 không tự đổi thành hoàn thành dựa trên T05. Báo cáo phân biệt rõ các phần chưa có: auth/email/owner initialization, lịch, event log/reducer/sync, offline, CI và production.

- [ ] **Step 5: Commit tài liệu và bàn giao để review.**

```bash
git add scripts/smoke_local.py docs/development.md docs/README.md docs/tasks/README.md docs/tasks/t05/review-and-verification.md
git commit -m "docs: verify and document FastAPI MySQL foundation"
```

Các lệnh commit trong plan là bước của lần **triển khai sau**, chưa thực hiện khi viết plan. Theo Git Flow, nhánh được review qua PR trước tích hợp; không push/merge protected branch để kết thúc task.

## 4. Điều kiện hoàn thành T05

- [ ] App khởi động theo T04, import không kết nối/ghi DB; settings bắt buộc và secret không rò qua repr/error/log.
- [ ] Driver/async pool/session chạy trên Python/MySQL đã khóa; explicit commit/rollback, charset, timezone và strict mode được kiểm chứng thật.
- [ ] Alembic tạo hai bảng rỗng đúng constraints, upgrade lặp không đổi dữ liệu, metadata không drift; vòng downgrade/upgrade chỉ thử trên DB cô lập.
- [ ] UUID/UTC millisecond/LocalDate round-trip đúng; parser/scalar từ chối các dữ liệu biên liệt kê trong Review Focus.
- [ ] Problem đúng T03, 404/405/validation/503/500 có mã/request ID nhất quán; log không chứa sentinel nhạy cảm.
- [ ] Health không ready khi DB/schema lỗi, phục hồi không restart API; version đúng DTO và giới hạn, không lộ cấu hình.
- [ ] Test runner không dùng DB dev, cleanup đúng project riêng kể cả failure; smoke HTTPS và runbook có kết quả, báo cáo ghi đủ giới hạn.

## 5. Tự rà soát kế hoạch

- **Spec coverage:** kết nối/config/transaction → Task 1; schema/migration → Task 2; xử lý lỗi/log → Task 3; validation → Task 4; health/version → Task 5; local verification/tài liệu → Task 6. Auth/event store có task sở hữu T09/T10, không bỏ mất hoặc tuyên bố đã làm.
- **Step scan:** bước code chốt interface/file/giá trị; bước test có tên và assertion; bước kiểm chứng có command/kết quả; commit gắn deliverable. Không viết sẵn thân implementation, không dùng “TBD” làm quyết định.
- **Type consistency:** Settings/Database, owner `UUIDBytes`, UTC `UTCMilliseconds`, date string `LocalDateSQL` và wire aliases dùng cùng helpers; `create_app`, request state, prefixes và command root nhất quán giữa các task.
- **Review Focus:** DB/lifecycle → Tasks 1/5; migration/schema → Tasks 2/5; types/miền ngày → Tasks 2/4; JSON/byte limits → Task 4; bí mật/error/log → Tasks 3/4. Từng mục có test cụ thể ở task sở hữu.
- **Proportion:** sáu deliverable nền có vòng kiểm chứng riêng; không chia mỗi file cấu hình thành một task và không lập trình trước auth/reducer/domain model của các task sau.

Một điểm hợp đồng cần giữ nguyên khi mở rộng: sync contract nhắc operation ID trong lỗi nhưng `$defs.Problem` cấm trường ngoài và không có field đó. T05 giữ Problem đúng JSON Schema; operation ID nằm ở push result của T10. Nếu T10 cần thay đổi DTO thì sửa đồng bộ bộ hợp đồng trước, không tự thêm field trong middleware T05.

## 6. Handoff sau khi người dùng review

**Phương thức triển khai: subagent-driven-development**, theo yêu cầu của người dùng. Sáu task sẽ chạy tuần tự; mỗi task có implementer mới và reviewer độc lập về tuân thủ đặc tả/chất lượng trước khi tiếp tục. Nhánh Git Flow `feature/fastapi-mysql-foundation` được giữ để người dùng review; không push hoặc merge nếu chưa được yêu cầu.
