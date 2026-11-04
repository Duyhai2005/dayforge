# T30 — Independent Infrastructure Implementation Plan

> **Implementation:** Follow the task steps below and track completed work with checkboxes.

**Goal:** Chuẩn bị host AWS/Oracle độc lập với PC, TLS/DNS, dữ liệu bền và các quyền vận hành để release T29 chạy được và gửi thư tới inbox thật.

**Architecture:** Bootstrap một Linux host theo decision T29, tạo môi trường staging tách production và triển khai image đã build. Edge Caddy sở hữu 80/443; mỗi app stack có ingress/app/data network riêng, MySQL không publish host port, migration chạy bằng principal riêng. Health/restart/log/timer được kiểm chứng bằng fault injection có giới hạn, không chỉ xem file cấu hình.

**Tech Stack:** Linux LTS đã chốt tại T29; Docker Engine/Compose v2/Caddy pin; systemd, MySQL 8.4.13; Python ops 3.11+; HTTPS/SMTP thật.

**Spec:** [T30](../README.md), [T29 plan](../t29/plan.md), [auth contract](../t03/auth-contract.md), [AC-31/32/35/36](../../project-definition/06-delivery-and-acceptance.md), [plan tổng/interfaces](../../superpowers/plans/2026-11-04-group7-deployment-rehearsal.md).

## Global Constraints

- Kế thừa Global Constraints/DeployConfig/ReleaseManifest/CLI/evidence trong plan tổng.
- “Server phải chạy độc lập với PC cá nhân”; host không dùng tunnel/SMTP/storage trên PC làm dependency.
- “Staging có thể cùng host với production để giảm vận hành, nhưng phải tách dữ liệu/quyền và dùng origin riêng”.
- Không tự mua host/domain/email/backup; chỉ dùng tài nguyên đã chốt và được phép tại T29.
- Không mở public 3000/8000/3306, Caddy admin API, Docker socket hoặc MySQL root remote; secret thật chỉ ở private config/file trên host.
- Production user data và deploy production thuộc T35; T30 khởi động staging và chuẩn bị template production.

## Review Focus

- Chạy bootstrap lần hai không sinh lại khóa, reset DB hoặc thay quyền SSH gây mất truy cập — idempotence test và diff trạng thái host.
- MySQL volume đã có không tự áp init SQL mới; grants phải có bước áp dụng rõ và kiểm tra bằng từng principal — privilege integration test.
- process đang chạy không đồng nghĩa healthy, và restart policy không tự restart container chỉ vì unhealthy — fault/recovery test.
- Origin/header giả từ Internet không được vượt gate auth hoặc làm nhận IP tùy ý — HTTPS proxy test với X-Forwarded-* giả.
- SMTP accept không đồng nghĩa inbox delivery; probe phải quan sát mailbox ngoài host — delivery evidence, luồng token đầy đủ ở T32.

---

## Bản đồ file

| File | Trách nhiệm |
| --- | --- |
| deploy/host/bootstrap.sh | Tạo: --check/--apply host prerequisites, dirs, service enablement; không tạo cloud resource |
| deploy/mysql/initialize.sql, deploy/mysql/grants.sql | Tạo: DB charset/timezone/DDL template và principal grants |
| deploy/systemd/dayforge-app@.service | Tạo: khởi động lại stack hiện tại, không build/migrate lúc boot |
| deploy/systemd/dayforge-health@.service, dayforge-health@.timer | Tạo: kiểm tra định kỳ và trạng thái lỗi |
| scripts/deploy_release.py | Tạo: validate→lock→pull→migrate→start→smoke; T33 bổ sung compatibility switch |
| scripts/smoke_deploy.py, scripts/check_host_health.py | Tạo: probe HTTP/runtime/health không cần import backend trên host |
| backend/app/cli/__init__.py, backend/app/cli/send_mail_probe.py; backend/tests/unit/test_email_probe.py | Tạo: mail probe chạy trong API image và unit test |
| scripts/tests/test_deploy_release.py, test_host_health.py | Tạo: unit command planning, guard/error redaction |
| scripts/deploy_tests/test_host_stack.py | Tạo: Docker/runtime/DB privilege integration; không thuộc verify:env |
| docs/deployment/infrastructure.md, docs/deployment/runtime-config.md | Tạo runbook Linux và secret custody |
| docs/tasks/t30/infrastructure-results.md | Tạo evidence host/DNS/TLS/grants/reboot/inbox |
| deploy/compose.app.yaml, compose.edge.yaml, Caddyfile | Sửa template T29 khi host test phát hiện lỗi; không hardcode secrets |

## Task T30.1: Bootstrap host và cách ly môi trường

**Files:** Create bootstrap.sh, infrastructure.md, runtime-config.md; Modify config validator/tests từ T29 nếu cần cho subnet và paths; Test scripts/deploy_tests/test_host_stack.py.

**Interfaces:**

- Consumes DeployConfig và deployment-decision đã đủ provider/region/platform/budget/origin; image/tool pins T29.
- Produces CLI **bash deploy/host/bootstrap.sh --check --config <path>** và **--apply --config <path>**. --check chỉ đọc, exit 2 nếu thiếu prerequisite; --apply chỉ cài/cấu hình host đã chọn, không gọi API mua VM.
- Host paths /etc/dayforge/<environment>/secrets, /srv/dayforge/<environment> và /srv/dayforge/releases/<release_id>; private dirs 0700, file secret 0400/0600 theo UID đọc container. File Compose bind secret không bảo đảm chown theo secret uid/mode; phải kiểm tra quyền file thực dưới UID runtime.

- [ ] **Step 1: Viết failing guard/idempotence test.** Định nghĩa command planner fixture và host sandbox trong test module; test không dùng /etc thật của máy dev.

~~~python
def test_second_bootstrap_preserves_secret_and_volume_identity(self):
    first = self.bootstrap_sandbox()
    second = self.bootstrap_sandbox()
    self.assertEqual(first.secret_sha256, second.secret_sha256)
    self.assertEqual(first.volume_names, second.volume_names)
    self.assertFalse(second.pending_mutations)

def test_staging_cannot_reference_production_paths(self):
    self.assertEqual(self.run_check(self.colliding_config).returncode, 2)
    self.assertEqual(self.executed_mutations, [])
~~~

Các helper ở cùng fixture, dùng file giả không credentials thật; integration host thật xác nhận lại sau. Thêm test path traversal/symlink ngoài root; config staging/prod cùng app subnet; prod DB trỏ localhost dev; Docker platform không khớp manifest.

- [ ] **Step 2: Run đỏ.** `uv run --directory backend --locked python -m unittest discover -s ../scripts/deploy_tests -p test_host_stack.py -v`; expected FAIL thiếu bootstrap contract. Thử --check trước --apply trên host thật sau implementation, không skip prerequisite thành PASS.
- [ ] **Step 3: Implement bootstrap.** Kiểm tra host identity/platform/disk/RAM/time sync và package checksum; enable Docker, tạo dirs/network và service account vận hành. Có outbound DNS/HTTPS/SMTP đã chọn; cloud security rules và firewall host chỉ allow SSH từ nguồn quản trị được chốt và 80/443 public. Không đổi SSH policy trước khi thử một SSH session thứ hai; không mở Docker TCP socket.
- [ ] **Step 4: Chuẩn bị secrets riêng từng env.** Sinh CSPRNG một lần, đủ format T03; lưu file chứ không echo. Không tái dùng KEK/logout/rate/outbox/sync key, DB password hoặc SMTP credentials giữa stage/prod. Mount tối thiểu theo service; migrate dùng credential DDL riêng. Không regenerate key khi restart/upgrade. Kiểm tra đọc file bằng đúng UID/GID trong image, không chmod world-readable để sửa lỗi.
- [ ] **Step 5: Chuẩn bị DNS/TLS và networks.** Chỉ đổi zone/record đã được phép; xác nhận A/AAAA trỏ đúng host, cả IPv4/IPv6 nếu có. Mỗi env có ingress network riêng; edge nối cả hai. app subnet lấy từ DeployConfig.app_subnet, xác nhận không overlap host/VPC/stack khác; API chỉ trust forwarded client của network web này, Caddy sanitize header đầu vào. Không tạo tên miền mua mới để vượt blocker.
- [ ] **Step 6: Run xanh/idempotence thật.** Chạy --check, --apply rồi --check và --apply lần hai; expected cùng secret checksum/volume/network identity, không mutation lần hai. Run `bash -n deploy/host/bootstrap.sh`; Docker info/Compose version đúng pin; từ máy ngoài host xác nhận chỉ port public dự kiến mở. Log report chỉ có version/ID đã che, không nội dung secret.
- [ ] **Step 7: Commit.** Stage bootstrap, tests và infrastructure/runtime-config docs; `git commit -m "feat(ops): provision isolated host runtime prerequisites"`.

## Task T30.2: Quyền DB và deploy job tách migration

**Files:** Create mysql SQL templates, scripts/deploy_release.py, scripts/tests/test_deploy_release.py, scripts/smoke_deploy.py; Modify Compose app.

**Interfaces:**

- **deploy_release(config: DeployConfig, release: ReleaseManifest, *, initialize: bool=False) -> DeploymentResult** trong scripts/deploy_release.py. DeploymentResult gồm release_id: str, migrated_revision: str, healthy: bool; lỗi runtime qua **DeploymentError** đã redact.
- CLI **python3 scripts/deploy_release.py --config <path> --release <release.json> [--initialize]**; initialize chỉ staging/restore trống đã kiểm tra, không DROP/overwrite.
- **smoke_deployment(origin: str, expected_build_id: str, *, timeout_seconds: int=60) -> dict[str,bool]** trong smoke_deploy.py; GET /work,/milestones,/dayforge-build.json,/sw.js,/api/v1/health,/api/v1/version, verify headers; không tạo account/data.
- Principals trong đúng DB môi trường: runtime SELECT/INSERT/UPDATE/DELETE; migrator SELECT/INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/INDEX/REFERENCES; backup SELECT/SHOW VIEW/TRIGGER với flags T31 không cần global PROCESS/RELOAD hoặc LOCK TABLES. Test trên MySQL8.4.13 phải xác nhận từng grant đủ cho code thực. Root chỉ bootstrap/privilege administration và không mount vào API/web; không GRANT ALL ON *.* cho bất kỳ principal app nào.

- [ ] **Step 1: Viết test đỏ cho sequencing và grants.** Unit fake subprocess ghi argv; assert invalid release/config không pull/migrate; concurrent lock không chạy; migrate exit≠0 không start candidate; health fail không báo deployment success. Integration test dùng actual MySQL:

~~~python
def test_runtime_cannot_change_schema_or_read_other_environment(self):
    self.assertTrue(self.runtime_can_select_own_workspace())
    self.assertFalse(self.runtime_can_create_table())
    self.assertFalse(self.runtime_can_select_production_users())

def test_migration_failure_stops_activation(self):
    result = self.deploy_with_migration_exit(1)
    self.assertFalse(result.activated)
    self.assertNotIn('start-candidate', self.runner.events)
~~~

Helpers thuộc scripts/tests/test_deploy_release.py hoặc deploy_tests/test_host_stack.py; fixture disposable DB xác minh đúng schema/project trước khi chạy SQL âm.

- [ ] **Step 2: Run đỏ.** `uv run --directory backend --locked python -m unittest discover -s ../scripts/tests -p test_deploy_release.py -v`; integration bằng lệnh T30.1 Step 2. Expected FAIL vì CLI/grants chưa có.
- [ ] **Step 3: Implement grants/bootstrap DB.** Dùng parameters/SQL quoting an toàn; không interpolate password vào log/command history. Charset utf8mb4, collation như dev, server UTC, strict SQL mode. CREATE USER/GRANT trên volume mới **và** runbook áp grants trên volume đã tồn tại; không giả định /docker-entrypoint-initdb.d sẽ chạy lại. Health DB dùng SELECT/readiness chứ không chỉ mysqladmin ping root.
- [ ] **Step 4: Implement deploy_release.** Validate target+manifest/platform→acquire operation.lock→pull digest→check volume/DB identity→maintenance edge nếu đã có app→dừng API writer/mail worker→migrate one-shot credential riêng→start API/web runtime→smoke→mở edge→ghi current-release.json atomic. Trước thay đổi DB có dữ liệu, bắt buộc pre-change backup T31; trước khi T31 có, chỉ --initialize staging trống. Migrate failure giữ maintenance và app cũ dừng nếu schema có thể đã đổi; không tự downgrade hoặc báo rollback thành công.
- [ ] **Step 5: Tránh downtime giả và secret leak.** Không chạy migration trong API startup hoặc mỗi container restart; không pass --env-file chứa plaintext secret vào report/config render public. Caddy maintenance trả 503/Retry-After cho API và tài khoản, không chặn cached local offline hoạt động; service worker script/manifest phục vụ phiên bản nhất quán. Process argv chỉ có paths/IDs.
- [ ] **Step 6: Run xanh tại disposable host/staging.** Chạy unit+privilege tests rồi initialize staging đúng digest; run smoke_deploy CLI. Expected DB revision=release.required_db_revision, health200, /version có protocol1/reducer1, build ID headers và manifest bằng nhau; API không khởi động được khi dùng DB/schema sai. `pnpm test:api:mysql` không hồi quy.
- [ ] **Step 7: Commit.** Stage SQL templates, scripts/tests và Compose; `git commit -m "feat(deploy): separate database migration from runtime activation"`.

## Task T30.3: Restart, readiness và log có giới hạn

**Files:** Create systemd app/health units, scripts/check_host_health.py, scripts/tests/test_host_health.py; Modify infrastructure.md; Test deploy_tests/test_host_stack.py.

**Interfaces:**

- **check_host_health(config: DeployConfig, *, now: datetime) -> HealthReport**; HealthReport fields healthy: bool, codes: tuple[str,...], checked_at: str. Codes cố định: api_unhealthy, web_unhealthy, disk_pressure, backup_stale, clock_unsynchronized.
- Timer health mỗi **5 phút**; disk warning khi usage≥85%; backup_stale chỉ bật sau T31 enable backup và khi snapshot success quá26h. Kênh thông báo do người dùng chọn tại execution; nếu chưa có kênh thì systemd failed/journal + file state có bằng chứng, không nhận là đã notify người dùng.
- Docker restart unless-stopped cho app/edge/MySQL; log local driver hoặc json-file max-size=10m/max-file=3; application log không chứa query/body/cookie/token/key. Unhealthy được report, không tự xóa/recreate DB.

- [ ] **Step 1: Viết test đỏ probe.** Assert health503 không healthy, timeout bounded, disk84% không warning/85% warning, clock unsync warning, backup age26h+1s stale, exception không echo secret sentinel. Assert repeated unchanged failure không gửi alert lặp mỗi5 phút nếu đã cấu hình notifier.
- [ ] **Step 2: Run đỏ.** `uv run --directory backend --locked python -m unittest discover -s ../scripts/tests -p test_host_health.py -v`; expected FAIL chưa có module.
- [ ] **Step 3: Implement probes/units.** App boot unit chỉ up image đang là current-release, không pull mutable tag/build/migrate. Health unit có timeout, lock tránh chồng; journal chỉ codes/request IDs. Ghi runbook phân biệt process exit→restart policy và health503→triage, không thêm watchdog gây restart storm MySQL.
- [ ] **Step 4: Fault/recovery trên staging.** Kill API process trong container; xác nhận restart và two-route/API recovery. Stop MySQL có chủ ý: API health503/no-store, app báo sync pending, không false success; start lại DB và kiểm tra sync resume. Reboot host trong cửa sổ được phép: Docker/edge/app tự lên, DB volume/secrets/owner ID không đổi. Không chạy ca này trên production trong T30.
- [ ] **Step 5: Run xanh.** Unit PASS; `systemd-analyze verify` cho units trên Linux; `systemctl list-timers` thấy health; probe HTTPS ngoài host đạt sau reboot. Ghi thời gian hồi phục thật và log rotation configuration, không cam kết SLA mới từ một lần đo.
- [ ] **Step 6: Commit.** Stage health/systemd/docs/tests; `git commit -m "feat(ops): verify service recovery and bounded health logging"`.

## Task T30.4: SMTP/DNS thực và bằng chứng host độc lập

**Files:** Create backend/app/cli/__init__.py, backend/app/cli/send_mail_probe.py, backend/tests/unit/test_email_probe.py, docs/tasks/t30/infrastructure-results.md; Modify runtime-config.md/deployment-decision.md.

**Interfaces:**

- **send_mail_probe(settings: Settings, *, recipient: str, probe_id: str) -> None** trong backend/app/cli/send_mail_probe.py gọi smtp_send_message cấu hình T29.3, subject chứa probe_id, body ghi rõ delivery probe; không tạo verify/reset token giả và không consume token.
- CLI **python -m app.cli.send_mail_probe --probe-id <safe-id>** chạy trong API image bằng secret file runtime; recipient lấy từ OWNER_EMAIL private, không ghi email thật vào report public. CLI không khởi động FastAPI lifespan/mail worker và không cần host cài backend dependencies.

- [ ] **Step 1: Viết test đỏ probe.** pytest monkeypatch SMTP; assert TLS/auth settings được truyền; subject có probe ID; message không chứa token/key/password; mismatch recipient ngoài owner reject, probe ID chứa newline/header injection reject. Fixtures ở backend/tests/unit/test_email_probe.py, không gọi mạng.
- [ ] **Step 2: Run đỏ.** `uv run --directory backend --locked python ../scripts/test_backend.py tests/unit/test_email_probe.py -q`; expected FAIL thiếu probe implementation.
- [ ] **Step 3: Cấu hình provider thực.** Xác minh sender identity và DNS records do SMTP provider yêu cầu; SMTP TLS host/port/auth và egress đúng. Với SES kiểm tra sandbox theo region, verified recipient/production access phù hợp inbox owner; không yêu cầu nâng quyền gửi public nếu verified-recipient use case đủ. Với OCI kiểm tra approved sender/SMTP credential theo region. Không ghi secret vào docs.
- [ ] **Step 4: Gửi và quan sát inbox thật.** Chạy probe từ host, kiểm tra inbox/spam, header sender/authentication và thời điểm nhận; lưu probe ID, timestamp, provider result đã redact. API accepted hoặc SMTP250 đơn lẻ chưa đạt delivery. Kiểm tra callback origin trong cấu hình bằng URL mẫu không token; luồng verify/reset với token thật sẽ chạy T32.
- [ ] **Step 5: Kiểm chứng không phụ thuộc PC.** Từ thiết bị/mạng khác chạy smoke_deploy đến host; tắt các process dev/tunnel/SMTP trên PC và kiểm tra host tiếp tục web/API/SMTP. Tắt hẳn PC theo bài diễn tập hai thiết bị thật ở T32; T30 report phân biệt rõ mức bằng chứng hiện có.
- [ ] **Step 6: Run xanh và ghi report.** Unit probe PASS; infrastructure-results liệt kê cloud host reference, OS/platform/digest, DNS/cert, network/grants, reboot/restart/log/probe evidence; không gán AC-31/32 PASS chỉ bằng mail probe.
- [ ] **Step 7: Commit.** Stage probe/unit/report/docs; `git commit -m "test(ops): verify external smtp delivery and host prerequisites"`.

## Cổng hoàn tất T30

- [ ] Host hoạt động độc lập; staging được khởi động theo immutable release, HTTPS trusted từ thiết bị ngoài.
- [ ] DB/secrets/networks/origins tách biệt, quyền runtime/migrator đã test và secrets còn nguyên qua reboot.
- [ ] DNS/SMTP thật có probe tới inbox; callback origin đúng; full auth delivery acceptance giữ tại T32.
- [ ] Health/restart/log đã thử bằng fault, không chỉ đọc cấu hình; limitation/thiếu kênh alert được ghi rõ.
- [ ] CI/unit/package và integration chịu ảnh hưởng PASS ở SHA cuối; T31 có thể lấy backup staging.

Tham khảo: [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/), [Compose secrets và quyền file](https://docs.docker.com/compose/how-tos/use-secrets/), [Caddy reverse proxy và forwarded headers](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
