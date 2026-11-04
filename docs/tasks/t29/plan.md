# T29 — Production Packaging Implementation Plan

> **Implementation:** Follow the task steps below and track completed work with checkboxes.

**Current status:** Package code and the disposable Docker/MySQL/API/web smoke passed on candidate SHA `907772c5df493ea23881e7e7572549637d7386fd` (see [review and verification](review-and-verification.md)). T29 remains open until the deployment target, budget, email/backup destination, and host sizing evidence are supplied.

**Goal:** Chốt target AWS/Oracle và email dựa trên tài nguyên thật, rồi tạo cặp image Next.js/FastAPI, config/secrets và package production có thể mang sang host mà không build lại.

**Architecture:** Dùng Compose app theo từng environment và một edge Caddy cho host. Web standalone proxy API qua tên service api:8000; API tự load file secret và SMTP TLS/auth; migration là job riêng dùng cùng image API nhưng credential khác. Metadata release ràng buộc SHA/build ID/platform/digest/schema để các task sau triển khai đúng artifact.

**Tech Stack:** Các pin runtime/library tại [plan tổng](../../superpowers/plans/2026-11-04-group7-deployment-rehearsal.md); Docker multi-stage, Compose v2, Caddy, stdlib unittest/pytest và container smoke.

**Spec:** [T29 và ràng buộc nhóm 7](../README.md), [T01](../t01/design.md), [kiến trúc §8](../../project-definition/04-technical-architecture.md), [auth contract](../t03/auth-contract.md), [plan tổng và interfaces](../../superpowers/plans/2026-11-04-group7-deployment-rehearsal.md).

## Global Constraints

- Kế thừa nguyên văn Global Constraints trong plan tổng; giữ Node 24.22.1, pnpm 12.16.1, Python 3.14.10, uv 0.13.6 và lockfiles hiện có.
- “Không tự mua hạ tầng”; chưa biết cloud/budget/domain không được biến thành lựa chọn đã được duyệt.
- “Production chỉ HTTPS cùng origin; không có token bearer trong localStorage hoặc payload sync.”
- Dữ liệu private, OWNER_EMAIL và mọi key/password không được đưa vào NEXT_PUBLIC_*, Docker build arg, image layer, build log hoặc release manifest.
- Chỉ thêm dependency vận hành có mục đích: Docker/Compose, Caddy và restic; không thêm SMTP SDK/Redis/Kubernetes khi SMTP hiện tại đủ.

## Review Focus

- Docker build phải loại .env, .local, .aws, .git, host venv/node_modules và report chứa dữ liệu riêng — package sentinel test.
- Manifest tạo sau next build phải được copy vào standalone/public sau khi sinh — image manifest/static/SW smoke.
- STARTTLS không được fallback plaintext khi server thiếu extension hoặc certificate sai — SMTP transport unit test.
- Config biến môi trường và file cùng tồn tại phải fail, lỗi không lộ nội dung — file-secret unit test.
- Production image không có route harness khả dụng hoặc mock rewrite — runtime /sync-browser, /offline-update phải 404; request API phải tới backend thật.

---

## Bản đồ file

| File | Thao tác/trách nhiệm |
| --- | --- |
| docs/tasks/t29/deployment-decision.md | Tạo: quyết định provider/region/host/SMTP/DNS/registry/backup, ngân sách tham chiếu và căn cứ đo |
| deploy/target.example.json, scripts/deploy_config.py | Tạo: config private có validation/isolation; public example chỉ dùng example.test |
| scripts/tests/test_deploy_config.py | Tạo: config âm và tách môi trường |
| backend/app/core/config.py | Sửa load_settings/Settings/ENV_FIELDS, thêm file-secret và SMTP options |
| backend/app/services/email_delivery.py | Sửa transport TLS/auth, giữ outbox/lease/retry hiện có |
| backend/tests/unit/test_config.py, test_email_transport.py | Sửa/tạo: cấu hình và trình tự SMTP |
| backend/tests/conftest.py; .env.example; backend/.env.example | Sửa fixture/default mẫu nếu cần để dev/Mailpit tiếp tục chạy |
| frontend/next.config.ts | Sửa có điều kiện container build + standalone; giữ dev guard |
| deploy/frontend.Dockerfile, deploy/backend.Dockerfile, .dockerignore | Tạo image build/runtime và context allowlist |
| deploy/compose.app.yaml, deploy/compose.edge.yaml, deploy/Caddyfile, deploy/.env.example | Tạo topology/runtime template không secret |
| deploy/images.lock.json | Tạo: image/tool version, digest/checksum và platform đã phân giải |
| deploy/release.schema.json, scripts/release_manifest.py | Tạo metadata parser/validator |
| scripts/tests/test_release_manifest.py; scripts/deploy_tests/test_production_package.py | Tạo unit hợp đồng artifact và container smoke riêng, không làm verify:env phụ thuộc Docker |
| .github/workflows/package-production.yml | Tạo build/smoke; publish chỉ khi đã cấu hình registry, không tự deploy |
| docs/deployment/packaging.md, docs/tasks/t29/review-and-verification.md | Tạo hướng dẫn và bằng chứng |

## Task T29.1: Khóa deployment decision và config contract

**Files:** Create docs/tasks/t29/deployment-decision.md, deploy/target.example.json, scripts/deploy_config.py, scripts/tests/test_deploy_config.py.

**Interfaces:**

- Consumes: T01 kiến trúc B; pin trong package.json/backend/pyproject.toml; quyền/tài nguyên thực người dùng đã có.
- Produces: DeployConfig, load_deploy_config(path: Path) -> DeployConfig và assert_environment_isolation(configs: Sequence[DeployConfig]) -> None theo §6 plan tổng; lỗi **DeployConfigError(ValueError)** chỉ chứa tên field/code.
- Example config là staging với HTTPS example.test; không dùng domain đó để nhận cert hoặc gửi email thật.

- [ ] **Step 1: Viết failing test config.** Dùng tempfile và json.dumps trong unittest; định nghĩa fixture valid_config(environment) ngay trong test module, tạo các field đúng §6. Các assertion bắt buộc:

~~~python
def test_staging_and_production_are_isolated(self):
    staging = self.load_fixture('staging')
    production = self.load_fixture('production')
    self.assertIsNone(assert_environment_isolation([staging, production]))

def test_rejects_duplicate_origin_and_resolved_secret_directory(self):
    for field in ('public_origin', 'secrets_dir', 'state_dir', 'db_name',
                  'compose_project', 'edge_alias'):
        with self.subTest(field=field), self.assertRaises(DeployConfigError):
            assert_environment_isolation(self.configs_with_collision(field))
~~~

Thêm test public_origin HTTP/path/query/fragment/userinfo; environment/compose_project/DB prefix không khớp; platform lạ; secret path có symlink trỏ cùng thư mục; field lạ hoặc thiếu. Fixture helper load_fixture/configs_with_collision được định nghĩa trong cùng test file, không dùng helper chưa tồn tại.

- [ ] **Step 2: Chạy test đỏ.** Run: `uv run --directory backend --locked python -m unittest discover -s ../scripts/tests -p test_deploy_config.py -v`. Expected: FAIL do chưa có scripts/deploy_config.py; không phải lỗi tìm runtime.
- [ ] **Step 3: Cài dataclass/validator.** Implement đúng interface; parse JSON strict, resolve path, origin HTTPS không trailing slash, kiểm tra uniqueness theo giá trị normalized. Không mở secrets hoặc kết nối cloud trong parser.
- [ ] **Step 4: Khảo sát tài nguyên và ghi quyết định.** Read-only inventory account/host/quota/billing permission đã được cung cấp; so AWS và OCI theo cấu hình thực, quyền DNS/email/backup. Ghi đầy đủ sáu đầu vào ở §4 plan tổng; giá và free allowance phải tra nguồn chính thức đúng region vào ngày thực hiện. Thiếu đầu vào thì ghi người cần cung cấp và phần thực thi bị chặn; vẫn làm package/test độc lập. Việc tạo resource mới hoặc mua domain chỉ thực hiện khi nằm trong ủy quyền/ngân sách thực tế.
- [ ] **Step 5: Kiểm tra xanh và decision gate.** Run lại lệnh Step 2; expected toàn bộ test PASS. Review document có provider, platform, hostname/origin và nguồn budget cụ thể trước khi bắt đầu T30. Cấu hình máy chỉ chốt sau số đo image ở T29.4, không cam kết 512 MB/1 GB.
- [ ] **Step 6: Commit.** `git add docs/tasks/t29/deployment-decision.md deploy/target.example.json scripts/deploy_config.py scripts/tests/test_deploy_config.py`; `git commit -m "feat(deploy): define isolated deployment targets"`.

## Task T29.2: Image Next.js/FastAPI và topology production

**Files:** Create Dockerfiles/.dockerignore/Compose/Caddyfile/images.lock.json; Modify frontend/next.config.ts; Test scripts/deploy_tests/test_production_package.py.

**Interfaces:**

- Consumes: DeployConfig platform; scripts/build-frontend.cjs nhận DAYFORGE_BUILD_ID và sinh public/dayforge-build.json; cùng lockfiles hiện tại.
- Produces: web image chạy **node frontend/server.js** tại /app; API image chạy **uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1 --no-access-log --proxy-headers --forwarded-allow-ips=<config.app_subnet>**. APP_SUBNET trong Compose được render từ DeployConfig.app_subnet; không tin header từ Internet. Migrate service cùng API image nhưng entrypoint **python -m alembic upgrade head**.
- Web build bật DAYFORGE_CONTAINER_BUILD=1; chỉ mode này cho API_INTERNAL_ORIGIN=http://api:8000 và output='standalone'. Dev mode vẫn chỉ nhận http://127.0.0.1:8000. Tracing root là repo root; cây runtime /app/frontend/server.js được xác nhận bằng build smoke, không giả định output root là server.js.

- [ ] **Step 1: Viết test failing package contract.** Tạo unittest test cho resolved Compose model và Docker container smoke fixture dùng project dayforge-package-test-<uuid>; fixture tự tạo secret giả, MySQL test và cleanup đúng project. Tests named:

~~~python
def test_final_image_contains_matching_manifest_and_static_assets(self):
    manifest = self.fetch_json('/dayforge-build.json')
    self.assertEqual(manifest['build_id'], self.expected_build_id)
    self.assertEqual(self.header('/work', 'X-Dayforge-Build'), self.expected_build_id)
    self.assertTrue(manifest['assets'])
    for asset in manifest['assets']:
        self.assertEqual(self.status(asset), 200)

def test_runtime_does_not_expose_test_routes(self):
    self.assertEqual(self.status('/sync-browser'), 404)
    self.assertEqual(self.status('/offline-update'), 404)
~~~

fetch_json/header/status là helpers cục bộ gọi HTTP vào port test loopback, không mock response. Thêm test /work, /milestones, /sw.js, /api/v1/health; non-root UID; không publish API/MySQL; migrate không có restart loop; volume DB không anonymous; API không dùng DB root. Unit test config build reject origin lạ và cấm DAYFORGE_*_TEST_HARNESS/DAYFORGE_PLAYWRIGHT_MOCK_API trong production build.

- [ ] **Step 2: Chạy test đỏ.** Run: `uv run --directory backend --locked python -m unittest discover -s ../scripts/deploy_tests -p test_production_package.py -v`. Expected FAIL thiếu production package; Docker không khả dụng phải báo prerequisite, không skip thành PASS.
- [ ] **Step 3: Viết image nhiều stage.** Frontend cài pnpm frozen lockfile và build không secret; copy toàn bộ standalone, **sau đó** public đã có manifest và .next/static vào /app/frontend. Backend dùng uv locked --no-dev trong build stage, copy venv/runtime Python cùng đường dẫn và app/migrations/alembic.ini; không để compiler/dev dependencies trong runtime. Runtime non-root; API giữ working directory /app/backend để required_schema_revision đọc đúng file migration.
- [ ] **Step 4: Khóa image/tool và giới hạn build context.** Giữ MySQL đúng image/digest trong compose.yaml; phân giải Node/Python/uv/Caddy/restic theo version thực hỗ trợ platform mục tiêu rồi lưu digest/checksum vào deploy/images.lock.json. Không dùng latest hoặc fake sha. .dockerignore theo allowlist source/lockfile cần build, loại mọi env/secrets/cache/test artifacts/git/cloud config; test đặt secret sentinel vào những đường bị loại rồi kiểm tra không có trong layer/bundle/log. Không copy credential thật để thử.
- [ ] **Step 5: Viết topology.** app có web/api/mysql/migrate; web+api ở network app riêng từng project có outbound SMTP, api+mysql ở network data internal=true. Web tham gia external ingress network **riêng môi trường**; edge Caddy tham gia ingress staging và production, chỉ edge publish 80/443. Web proxy /api/v1 qua api:8000 nên không cần edge truy cập DB/API. Environment alias staging-web/production-web là duy nhất. Hai stack không cùng network app/data hoặc volume/secrets.
- [ ] **Step 6: Cấu hình edge không phá HTTP contract.** Giữ nguyên path /api/v1; chuyển Host/Origin/Cookie/Set-Cookie; không cache auth/API/callback; giữ no-store/no-referrer của callback và header X-Dayforge-Build. /sw.js và /dayforge-build.json không cache qua proxy; không cache RSC HTML đại trà. Dùng cert được thiết bị tin cậy cho staging thật; local package smoke được dùng CA test riêng. Không bật deploymentId tự reload khi chưa có test gate.
- [ ] **Step 7: Run xanh và regression dev guard.** Chạy lại Step 2; `pnpm verify:env`; `pnpm typecheck:web`; `pnpm build:web`. Expected package smoke PASS, guard local vẫn reject http://api:8000 khi không có DAYFORGE_CONTAINER_BUILD=1. Build artifact không có test harness dù CI cũ vẫn có job mock riêng.
- [ ] **Step 8: Commit.** Stage Dockerfiles, compose/Caddy/lock/.dockerignore, next.config và test vừa thay; `git commit -m "feat(deploy): package reproducible web and api containers"`.

## Task T29.3: File secret và SMTP TLS/auth thực

**Files:** Modify backend/app/core/config.py, backend/app/services/email_delivery.py, backend/tests/unit/test_config.py, backend/tests/conftest.py và env examples; Create backend/tests/unit/test_email_transport.py.

**Interfaces:**

- Giữ **load_settings(environ: Mapping[str,str] | None = None) -> Settings**. Bổ sung biến EMAIL_SMTP_TLS='none'|'starttls'|'implicit', EMAIL_SMTP_USERNAME, EMAIL_SMTP_PASSWORD, EMAIL_SMTP_TIMEOUT_SECONDS (mặc định 10, hợp lệ 1–60). username/password là SecretStr | None; tls mặc định none cho dev/test; production bắt buộc TLS và cặp credentials không rỗng.
- Chỉ hỗ trợ *_FILE cho DB_PASSWORD, LOCAL_KEY_KEK_B64, LOGOUT_TICKET_KEY_B64, LOGOUT_TICKET_PREVIOUS_KEYS_B64, AUTH_RATE_LIMIT_KEY_B64, AUTH_EMAIL_OUTBOX_KEY_B64, SYNC_PAGE_TOKEN_KEY_B64, EMAIL_SMTP_USERNAME, EMAIL_SMTP_PASSWORD. env và *_FILE cùng khai báo là lỗi; strip tối đa một newline cuối file; không strip password khoảng trắng. Fail chỉ nêu tên field, không path/nội dung secret.
- **smtp_send_message(host: str, port: int, message: EmailMessage, *, tls: Literal['none','starttls','implicit']='none', username: str | None=None, password: str | None=None, timeout_seconds: int=10) -> None**.
- **deliver_pending_jobs(..., send_message: Callable[[str,int,EmailMessage],None] | None=None, limit: int=20) -> int**: khi None tạo callable bind SMTP settings; injected fake 3 tham số hiện tại vẫn hoạt động. Lease, outbox encryption và retry semantics không đổi.

- [ ] **Step 1: Viết failing test config/secrets/transport.** Thêm các assertion:

~~~python
def test_production_rejects_plaintext_smtp(settings_factory):
    with pytest.raises(SettingsError, match='EMAIL_SMTP_TLS'):
        settings_factory(app_env='production', email_smtp_tls='none')

def test_starttls_precedes_auth_and_send(smtp_fake, message):
    smtp_send_message('smtp.example.test', 587, message,
                      tls='starttls', username='user', password='sentinel')
    assert smtp_fake.actions == ['connect', 'ehlo', 'starttls', 'ehlo', 'login', 'send', 'quit']
~~~

smtp_fake/message là fixture định nghĩa trong test_email_transport.py, monkeypatch smtplib/ssl không gọi mạng. Test thêm implicit TLS; default context verify certificate; thiếu STARTTLS/SSL cert lỗi/timeout/auth fail thì không send; exception secret không bị log. File-secret test unreadable/missing/conflicting env+file, newline semantics, repr redaction; load cả cấu hình dev cũ không cần field mới. MySQL outbox test chứng minh failure giữ job/retry và success xóa job như hiện tại.

- [ ] **Step 2: Chạy đỏ.** Run: `uv run --directory backend --locked python ../scripts/test_backend.py tests/unit/test_config.py tests/unit/test_email_transport.py -q`. Expected FAIL vì option/function behavior chưa có.
- [ ] **Step 3: Cài file secrets.** Mở rộng ENV_FIELDS và default handling trong Settings.__init__ để optional mới không vô tình thành required ở test/dev. Đọc file trước validation; production Compose dùng *_FILE mount read-only, không interpolate giá trị secret vào model/log. Giá trị file đã đọc chỉ giữ trong SecretStr.
- [ ] **Step 4: Cài SMTP transport.** starttls: connect→ehlo→starttls với ssl.create_default_context()→ehlo→login→send. implicit: SMTP_SSL với default verified context→login→send. Chỉ none dùng SMTP plain trong dev/test. Không bắt TLS failure để gửi lại plain; worker tiếp tục dùng error code cố định smtp_delivery_failed.
- [ ] **Step 5: Chạy xanh và hồi quy auth.** Chạy lại Step 2; `pnpm test:api`; `pnpm test:api:mysql`. Expected PASS, Mailpit adapter vẫn được dùng test/dev, outbox encrypted lease không thay hành vi. Run package smoke sau đổi settings vì production fixture giờ cần TLS SMTP giả hoặc local relay test có CA được cấu hình trong fixture, không nới validator production.
- [ ] **Step 6: Cập nhật env mẫu và Commit.** Ví dụ không chứa credentials; ghi rõ EMAIL_SMTP_TLS=none là dev. `git add backend/app/core/config.py backend/app/services/email_delivery.py backend/tests .env.example backend/.env.example`; `git commit -m "feat(mail): support verified tls smtp and runtime file secrets"`.

## Task T29.4: Manifest release, build gate và bằng chứng package

**Files:** Create deploy/release.schema.json, scripts/release_manifest.py, scripts/tests/test_release_manifest.py, .github/workflows/package-production.yml, docs/deployment/packaging.md, docs/tasks/t29/review-and-verification.md; Modify test_production_package.py.

**Interfaces:**

- Produces ReleaseManifest, **load_release_manifest(path: Path) -> ReleaseManifest**, **write_release_manifest(path: Path, manifest: ReleaseManifest) -> None**; schema và fields chính xác §6 plan tổng. Invalid manifest raises **ReleaseManifestError(ValueError)**.
- Container test entrypoint `python -m unittest discover -s scripts/deploy_tests -p test_production_package.py -v` nhận DAYFORGE_PACKAGE_TEST_MANIFEST=<path>; parser không cần registry credentials. Unit parser/config ở scripts/tests chạy trong verify:env; mọi test cần Docker/host ở scripts/deploy_tests chỉ chạy bằng job/lệnh integration riêng.
- Output release directory: release.json, checksums.sha256, images.lock.json, compose templates; không có config private hoặc secret. Registry pull dùng digest; docker save/load fallback ghi repo digest/image ID và kiểm chứng tương đương, không gán archive checksum là registry digest.

- [ ] **Step 1: Viết failing manifest test.** test_manifest_rejects_mutable_tag, test_manifest_rejects_short_sha, test_manifest_requires_matching_platform, test_manifest_rejects_harness, test_manifest_requires_required_revision_in_supported_set; assert load invalid raise ReleaseManifestError; valid round-trip giữ chính xác build_id/schema/protocol/reducer.
- [ ] **Step 2: Run đỏ.** `uv run --directory backend --locked python -m unittest discover -s ../scripts/tests -p test_release_manifest.py -v`; expected FAIL thiếu parser.
- [ ] **Step 3: Implement schema/parser/writer.** Kiểm tra digest regex, required revision nằm trong supported set, supported revisions không wildcard; dùng values lấy từ packaged source và manifest web. Validate schema JSON bằng jsonschema sẵn trong backend test, không thêm thư viện host cho CLI.
- [ ] **Step 4: Thêm workflow build/smoke.** Chạy PR/manual, pin actions SHA theo repo; default permissions contents:read. Build linux platform đã chọn, chạy MySQL+API+Next thật và unit SMTP; production build không thừa hưởng flag mock/harness từ workflow cũ. Publish cần quyền packages:write chỉ ở job publish và registry đã chọn; không deploy qua pull_request. Upload report đã redact và release.json; secrets qua runtime file trên runner, xóa khi kết thúc.
- [ ] **Step 5: Xác minh build cuối và đo.** Run các test manifest/package, `pnpm verify:fast`, `pnpm test:api:mysql`, `pnpm test:sync:browser`, các suite production/offline hiện hành trên source. Container smoke là kiểm chứng bổ sung bắt buộc, không thay bằng Playwright mock. Đo image size, RSS web/API/MySQL, Argon2 login, disk growth/backup workspace và concurrent two-device sync; ghi cấu hình host đề xuất có headroom, sau đó hoàn tất sizing decision T29.1. Pin auth contract Argon2id 65536 KiB/t=3/p=1; mục tiêu verify <1 giây là số đo, không tự hạ policy.
- [ ] **Step 6: Tạo report và bàn giao.** Ghi SHA/digest/build_id/platform/test commands/evidence; xác nhận hai route, API real, SW/asset, callbacks headers và absence of harness/secrets. Nếu host/registry/inbox chưa có thì ghi blocker đúng phần; không đánh dấu T29 đủ đầu vào T30 khi deployment decision còn thiếu.
- [ ] **Step 7: Commit.** Stage schema/parser/tests/workflow/docs và metadata không secret; `git commit -m "ci(deploy): validate immutable production release artifacts"`.

## Cổng hoàn tất T29

- [ ] T29.1–T29.4 có evidence; image tái build từ checkout sạch; lockfiles không đổi ngoài thay đổi đã giải thích.
- [ ] Đã chốt provider/platform/host sizing/nguồn ngân sách/origin/mail/backup hoặc ghi rõ T29 chưa hoàn tất vì đầu vào thiếu.
- [ ] Runtime package dùng same-origin HTTPS khi đặt sau edge; mọi API callback/header/cache test đạt.
- [ ] Không khẳng định inbox delivery hoặc host độc lập từ package local; chuyển kiểm chứng thực cho T30/T32.
- [ ] PR vào develop, required CI + package workflow ở SHA cuối xanh; cập nhật status sau khi đã chạy, chưa ở giai đoạn plan.

Nguồn hỗ trợ các lựa chọn đóng gói: [Next standalone và public/static](https://nextjs.org/docs/app/api-reference/config/next-config-js/output), [uv multi-stage/locked dependencies](https://docs.astral.sh/uv/guides/integration/docker/), [Compose secret files](https://docs.docker.com/compose/how-tos/use-secrets/), [smtplib TLS/auth](https://docs.python.org/3.14/library/smtplib.html). Nguồn vendor chỉ dùng để kiểm tra điều kiện nếu chọn dịch vụ tương ứng: [SES sandbox](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html), [OCI Email Delivery](https://docs.oracle.com/en-us/iaas/Content/Email/Concepts/overview.htm).
