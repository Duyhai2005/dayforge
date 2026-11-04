# Group 7 — Deployment and Recovery Rehearsal Implementation Plan

> **Implementation:** Follow the task steps below and track completed work with checkboxes.

**Goal:** Hoàn thành T29–T33 để DAYFORGE có artifact production tái lập được, host độc lập, email tới inbox thật, backup phục hồi được và quy trình nâng cấp/rollback đã diễn tập trên staging.

**Architecture:** Đề xuất một host Linux trên AWS hoặc Oracle, chạy Next.js standalone, FastAPI và MySQL bằng Docker Compose; một Caddy edge dùng HTTPS và định tuyến cùng origin. Mỗi môi trường có project, network nội bộ, database, volume, secrets và origin riêng; chỉ edge dùng chung nếu cùng host. Build ở CI/máy build, vận chuyển image theo digest, migrate bằng job riêng, rồi nghiệm thu và diễn tập trên staging trước khi bàn giao T34–T36.

**Tech Stack:** Node 24.22.1, pnpm 12.16.1, Next.js 16.4.3, React 19.3.1; Python 3.14.10, uv 0.13.6, FastAPI 0.162.0, SQLAlchemy 2.1.6, Alembic 1.19.2; MySQL 8.4.13; Docker Engine/Compose v2, Caddy, restic, Playwright 1.64.1. Caddy/restic/base-image digest được phân giải và khóa trong T29, không tự đoán digest.

**Spec:** [Định nghĩa nhóm 7/T29–T33](../../tasks/README.md#nhóm-7--chuẩn-bị-và-diễn-tập-deploy--t29t33), [thiết kế T01](../../tasks/t01/design.md), [kiến trúc](../../project-definition/04-technical-architecture.md), [T03 auth](../../tasks/t03/auth-contract.md), [T03 sync](../../tasks/t03/sync-contract.md), [AC-01–AC-38](../../project-definition/06-delivery-and-acceptance.md), [kết quả T28](../../tasks/t28/acceptance-results.md), [offline update T13](../../tasks/t13/offline-update-runbook.md).

## Global Constraints

Các câu dưới đây giữ nguyên từ đặc tả; quyết định bổ sung của plan được tách ở phần sau.

- “Đã chốt **phương án B: Next.js chạy server/Node + FastAPI + MySQL**, dữ liệu làm việc offline trong IndexedDB.”
- “Server phải chạy độc lập với PC cá nhân. AWS hoặc Oracle, tài nguyên sẵn có và hệ thống gửi email được chọn tại T29/T30; không tự mua hạ tầng. Email xác minh/reset phải tới inbox thực tế, không chỉ có log hoặc email giả lập.”
- “Staging có thể cùng host với production để giảm vận hành, nhưng phải tách dữ liệu/quyền và dùng origin riêng để không đụng cache hay IndexedDB của bản dùng thật.”
- “Cookie tên `__Host-dayforge-session`, `Secure; HttpOnly; SameSite=Lax; Path=/`, không `Domain`.”
- “Origin phải bằng chính xác `PUBLIC_ORIGIN` được cấu hình, gồm scheme/host/port; không kiểm tra kiểu suffix.”
- “Link tạo từ `PUBLIC_ORIGIN` cố định: `/verify-email#token=...` hoặc `/reset-password#token=...`; không lấy host/return URL từ request.”
- “Khi epoch đổi do restore, giữ toàn bộ union event cũ cùng outbox trong journal phục hồi; rebootstrap không được xóa các event từng được ACK.”
- “Migration IndexedDB giữ journal/outbox nguyên tử; triển khai server phải tiếp nhận authored v1 trong phạm vi hỗ trợ đã công bố.”
- “Bản sao lưu server chỉ có dữ liệu đã đồng bộ.”
- “Các bước production trong tài liệu là công việc cần làm khi triển khai, không phải tuyên bố đã deploy trong lần lập kế hoạch này.”

## Review Focus

1. Backup có SQL nhưng thiếu LOCAL_KEY_KEK_B64/version sẽ không mở được vault trên thiết bị mới — test T31.2 phải phục hồi key và đăng nhập bằng profile sạch.
2. Restore ảnh cũ với epoch cũ có thể khiến client bỏ sót event đã ACK sau backup — T31.3 đổi epoch mà giữ event/receipt/hash; T33.4 kiểm tra recovery cùng origin, cả ACK và pending.
3. Rollback binary sau migration không có nghĩa binary cũ đọc được schema mới — T33.1/T33.3 kiểm tra readiness hiện đang đòi đúng Alembic head và từ chối cặp không tương thích trước khi switch.
4. Cùng host nhưng origin/secret/volume/edge alias bị dùng chung có thể làm staging tác động production — T30.1 và T32.3 có test cấu hình âm, kiểm tra runtime và profile browser riêng.
5. Build mới nhưng manifest/SW/static asset thuộc build khác hoặc bật test harness có thể mất offline/update gate — T29.2/T29.4 kiểm tra image cuối; T33.2 kiểm tra dirty draft, tab cũ, lost ACK và asset cũ.

---

## 1. Phạm vi và trạng thái lập kế hoạch

Ngày lập: **04/11/2026**, Asia/Bangkok. Checkout khảo sát: **develop @ 319a12e**. Kế hoạch được dùng làm checklist triển khai cho T29–T33. PR #29 hoàn tất package code và CI smoke; T29 còn cổng target/sizing cần đầu vào thật. Các checkbox chỉ được đánh dấu khi có kiểm chứng; hạ tầng/inbox/staging/backup/rehearsal phải chờ tài nguyên thật.

Repo đang có Compose MySQL **development**, SMTP không TLS/auth để dùng Mailpit, build/offline/sync runners và migration đến **0004_sync**. Chưa có thư mục deploy, Dockerfile production, SMTP credentials/TLS, timer backup hay deployment workflow. Next config hiện chỉ nhận API_INTERNAL_ORIGIN=http://127.0.0.1:8000; scripts/build-frontend.cjs sinh public/dayforge-build.json **sau** next build. Hai chi tiết này phải được xử lý khi đóng gói, không copy nguyên dev stack lên host.

T28 ghi 35 PASS và 3 TARGET_PENDING: **AC-31, AC-32, AC-36**. Các kết quả cũ dùng nhiều SHA và runtime local khác pin; T32 phải ghi bằng chứng đúng candidate/digest, không coi 35 PASS cũ là đã kiểm chứng image mới. T10–T13 trong task index vẫn còn giới hạn nghiệm thu tích hợp; T32 kiểm tra lại đường thật chịu ảnh hưởng.

Chưa có cloud account/inventory, budget/domain/SMTP inbox hoặc Docker Engine trong workspace. Vì vậy chưa tạo cloud resource, mua dịch vụ, gửi thư thật, deploy, thay secret production hay chạy migration trên host. Những giới hạn này không chặn package code và kiểm chứng CI độc lập.

## 2. Chia plan theo đầu ra

| Task | Plan chi tiết | Đầu ra có thể nghiệm thu độc lập | Phụ thuộc |
| --- | --- | --- | --- |
| T29 | [Đóng gói và chốt phương án](../../tasks/t29/plan.md) | Quyết định host/mail/backup có căn cứ; image khóa digest; runtime config/secrets; SMTP production; smoke package | T07/T09/T13, contracts T03 |
| T30 | [Hạ tầng độc lập](../../tasks/t30/plan.md) | Host, DNS/TLS, môi trường tách biệt, DB grants, restart/health/log, inbox probe thực | T29 |
| T31 | [Backup và restore](../../tasks/t31/plan.md) | Backup tự động ngoài host, retention, restore DB sạch + khóa, reset epoch có kiểm chứng | T05/T30 |
| T32 | [Candidate trên staging](../../tasks/t32/plan.md) | Cùng image ứng viên chạy HTTPS với MySQL/SMTP thật, hai thiết bị và ma trận 38 AC có evidence | T28/T29/T30; dùng backup T31 trước khi ghi dữ liệu staging quan trọng |
| T33 | [Upgrade và rollback](../../tasks/t33/plan.md) | Ma trận tương thích, A→B→A hoặc roll-forward, migration, pending/draft, disaster recovery | T31/T32 |

Thứ tự triển khai khuyến nghị: **T29 → T30 → T31 → T32 → T33**. T31/T32 có vài bước đọc/chuẩn bị độc lập, nhưng không chạy đồng thời trên cùng DB/profile. Mỗi task một nhánh feature từ develop mới nhất và một PR theo docs/GITFLOW.md; không dùng một PR khổng lồ cho cả nhóm. Việc tạo nhánh, commit, PR diễn ra lúc triển khai, không trong lần viết plan này.

## 3. Các lựa chọn kỹ thuật đề xuất

| Lựa chọn | Quyết định trong plan | Lý do/giới hạn |
| --- | --- | --- |
| Đơn vị vận hành | Một Linux VM, Compose, một edge HTTPS | Phù hợp app dùng riêng; không thêm Kubernetes/load balancer/Redis |
| AWS hoặc Oracle | Chốt tại T29.1 sau inventory read-only và đo artifact | Chưa có bằng chứng account, credit, quota, budget hoặc host; không hứa free tier |
| Runtime web | Next standalone, copy public và .next/static sau build | Không export tĩnh, không next dev; xác minh tracing root của pnpm workspace |
| Image | Một cặp web/api theo SHA+digest, build một lần cho platform đã chọn | Staging và production dùng cùng digest; config origin/DB/SMTP chỉ lúc chạy |
| Email | SMTP với starttls hoặc implicit TLS, xác thực, verify certificate | Tận dụng adapter hiện tại; giữ SMTP plain chỉ cho dev/test |
| Backup | mysqldump InnoDB + restic tới nơi ngoài host | Backup chứa DB/config/khóa cần phục hồi; password restic giữ riêng ngoài host |
| Nâng cấp | Maintenance ngắn, dừng writer trong lúc migrate/switch | Không hứa zero downtime; offline client tiếp tục giữ pending |
| Rollback | Đổi về image tương thích với **DB hiện tại**, giữ dữ liệu mới | Restore là quy trình disaster recovery riêng, không là rollback mặc định |
| OS/scripts | Linux LTS được kiểm chứng; ops Python stdlib 3.11+ | Backend trong image vẫn Python 3.14.10; không yêu cầu host cài Node/uv để chạy app |

Đã cân nhắc native systemd cho từng runtime: ít container nhưng khó tái lập pin/rollback. Managed web/API/DB nhiều dịch vụ: giảm quản trị DB nhưng tăng tài nguyên/quyền/cấu hình; chỉ xem lại nếu tài nguyên sẵn có làm nó rõ ràng thuận lợi hơn. Compose là đề xuất của người lập plan, chưa được diễn giải thành lựa chọn cloud đã được người dùng duyệt.

## 4. Điểm chốt thông tin trước hành động hạ tầng

T29.1 phải tạo docs/tasks/t29/deployment-decision.md với các giá trị cụ thể sau; không vượt qua bước này bằng chuỗi rỗng hoặc nhãn TBD:

1. Provider aws/oci, account/project tham chiếu đã che, region, VM sẵn có hoặc phương án cấp mới, platform linux/amd64 hoặc linux/arm64.
2. Ngân sách trần và nguồn tài nguyên đã được phép sử dụng; chi phí ước tính theo cấu hình/region thực, ngày lấy giá và headroom đo được.
3. Hai HTTPS origin staging/production khác nhau và một origin restore/rehearsal cô lập do người dùng kiểm soát; DNS, người có quyền sửa và email ACME. Có thể dùng hostname/subdomain sẵn có, nhưng certificate phải được browser thiết bị đích tin cậy. Origin rehearsal được giữ nguyên qua các lần thay DB trong T33, không trùng môi trường đang phục vụ khác.
4. Owner inbox và sender identity, SMTP endpoint/port/TLS, sender verification, hạn mức và quyền gửi tới inbox đích.
5. Registry private hoặc cơ chế docker save/load nếu không có registry; digest và quyền pull phải kiểm chứng từ host, không phụ thuộc máy cá nhân.
6. Đích restic ngoài VM/volume ứng dụng, quyền truy cập, nơi cất password khôi phục bên ngoài host.

Thiếu quyền/account/ngân sách/domain/inbox thực thì ghi blocker cụ thể, vẫn hoàn thành code/package/test local độc lập. Không tự mua tài nguyên hoặc gán một dịch vụ trả phí làm mặc định.

**Mặc định vận hành do plan đề xuất, được ghi rõ trong decision trước khi dùng:** backup mỗi ngày **02:15 Asia/Bangkok** (=19:15 UTC ngày trước), giữ 7 daily/4 weekly/3 monthly; mục tiêu RPO ≤24 giờ và RTO ≤120 phút trên bộ dữ liệu nghiệm thu; cảnh báo backup cuối thành công quá 26 giờ. Đây là mục tiêu phải đo, không phải kết quả hoặc yêu cầu có sẵn trong spec.

## 5. Bản đồ file và quyền sở hữu

| Nhóm file | Owner | Trách nhiệm |
| --- | --- | --- |
| deploy/frontend.Dockerfile, deploy/backend.Dockerfile, .dockerignore, deploy/images.lock.json | T29 | Build/runtime và pin tool/image |
| deploy/compose.app.yaml, deploy/compose.edge.yaml, deploy/Caddyfile, deploy/.env.example | T29; T30 cấu hình thật | Topology và hợp đồng môi trường, không chứa secret |
| scripts/deploy_config.py, scripts/release_manifest.py, deploy/release.schema.json | T29 | Validate config private và metadata release public |
| backend/app/core/config.py, backend/app/services/email_delivery.py; tests tương ứng | T29 | File secrets và SMTP production |
| scripts/deploy_release.py, scripts/smoke_deploy.py | T30; mở rộng T32/T33 | Migrate/start/smoke có kiểm tra môi trường |
| deploy/host/bootstrap.sh, deploy/mysql/*.sql, deploy/systemd/* | T30/T31 | Host, grants, timer, health và backup |
| scripts/backup_database.py, scripts/restore_database.py, scripts/verify_restore.py | T31 | Snapshot, restore cô lập, manifest và integrity |
| backend/app/services/restore_recovery.py, backend/app/cli/prepare_restored_database.py | T31 | Chuẩn bị DB restore trước khi mở mạng; không API quản trị công khai |
| frontend/playwright.staging.config.ts, frontend/tests/staging/*.spec.ts, scripts/run_staging_acceptance.cjs | T32 | HTTPS smoke/acceptance không mock và giữ SW thật |
| scripts/check_release_compatibility.py, scripts/rehearse_release.py, frontend/tests/release/*.spec.ts | T33 | Kiểm tra cặp phiên bản và diễn tập cùng origin/profile |
| docs/deployment/*, docs/tasks/t29–t33/*-results.md | Task tạo đầu ra | Runbook cùng bằng chứng đã che dữ liệu riêng |

Không sửa đồng thời runner T13 đang chạy hoặc ghi đè .next của checkout trong smoke deployment. T29 container build dùng context sạch; T33 dùng image A/B riêng.

## 6. Hợp đồng dùng xuyên năm task

### DeployConfig — file private trên host

scripts/deploy_config.py định nghĩa frozen dataclass **DeployConfig** và hàm **load_deploy_config(path: Path) -> DeployConfig**. Trường bắt buộc: environment: Literal['staging','production','restore']; provider: Literal['aws','oci']; region: str; platform: Literal['linux/amd64','linux/arm64']; public_origin: str; compose_project: str; db_name: str; secrets_dir: Path; state_dir: Path; edge_alias: str; app_subnet: str (IPv4 CIDR private, strict network address). Không chứa password/token; secrets_dir tham chiếu file quyền hạn chế.

Quy ước staging/production lần lượt dayforge-staging/dayforge-production, DB dayforge_staging/dayforge_production và alias staging-web/production-web; restore có project/DB/alias duy nhất bắt đầu dayforge-restore-/dayforge_restore_/restore-. **assert_environment_isolation(configs: Sequence[DeployConfig]) -> None** từ chối trùng origin/project/db/secrets_dir/state_dir/alias sau khi resolve path, hoặc app_subnet overlap. Danh sách configs là các installation sẽ phục vụ đồng thời; T32/T33 thay installation cùng origin phải dừng nguồn trước và giữ source volume để khôi phục, không bypass isolation khi cả hai đang hoạt động. Edge chỉ kết nối web; API/MySQL ở network riêng project, web proxy /api/v1 tới api:8000.

### ReleaseManifest — đi cùng artifact

scripts/release_manifest.py định nghĩa **ReleaseManifest** và **load_release_manifest(path: Path) -> ReleaseManifest**. Schema version 1; trường: release_id, git_sha (40 hex), build_id, platform, web_image và api_image (registry@sha256:64hex), mysql_image, required_db_revision, supported_db_revisions, indexeddb_schema_version, supported_indexeddb_schema_versions, protocol_versions, reducer_versions, created_at (UTC), test_harness=false. Current baseline: revision 0004_sync, schema local 2 với upgrade source versions [1,2], protocol/reducer [1]. Schema này là **DATABASE_VERSION của frontend/lib/storage/vault.ts (dayforge-local)** mà SW/build gate đang dùng; không nhầm với adapter thấp hơn trong schema.ts (dayforge). Các giá trị phải lấy từ source/build khi đóng gói; không hardcode mãi baseline nếu source đổi.

Dataclass types: release_id/git_sha/build_id/web_image/api_image/mysql_image/required_db_revision/created_at: str; platform cùng Literal với DeployConfig; supported_db_revisions: tuple[str,...]; indexeddb_schema_version: int; supported_indexeddb_schema_versions/protocol_versions/reducer_versions: tuple[int,...]; test_harness: bool=False; format_version: Literal[1]=1. JSON serialize tuple thành array; không nhận bool như int hoặc trường ngoài schema. Build/package đơn vị Linux đã khóa platform, không thêm matrix architecture chưa sử dụng.

Release metadata, X-Dayforge-Build và dayforge-build.json dùng cùng build_id. Không tự bật Next deploymentId hard reload: T13 có gate giữ dirty draft; bất kỳ cơ chế reload mới phải đi qua test T33 trước khi đưa vào runtime.

### CLI/exit code

Mỗi Python CLI có **main(argv: Sequence[str] | None = None) -> int**, dùng argv list/subprocess không shell=True; command lỗi trả thông báo cố định, không echo credentials. Exit 0=đạt; 1=runtime/test thất bại; 2=config/target/compatibility không hợp lệ. CLI nhận đường dẫn config/manifest, không password trên command line.

Deploy/backup/restore/rehearsal khóa chung theo **state_dir/operation.lock**; không được migrate hoặc đổi secret trong khi snapshot; timer bỏ lượt và báo rõ nếu đang bị khóa. Script chỉ quản lý đường dẫn dưới root cấu hình đã resolve và chỉ tác động project/database đã xác minh. DB password/khóa/SMTP ở /etc/dayforge/<environment>/secrets, dữ liệu vận hành ở /srv/dayforge/<environment>; đây là layout đề xuất, không thư mục cần tạo trong lần lập plan.

### Evidence

Mỗi kết quả có task/case_id, timestamp UTC và Asia/Bangkok, git SHA, release_id, image digest, origin đã che nếu cần, OS/browser/version/viewport, command/scenario, expected/actual, status và evidence path. Dùng PASS/FAIL/BLOCKED/TARGET_PENDING; PASS phải có evidence, không gắn PASS cho case chưa chạy. Screenshot/log/trace phải được kiểm tra không chứa cookie, email token, key hoặc lịch riêng; raw auth trace không upload công khai.

## 7. Cổng hoàn tất nhóm

- [ ] T29: cặp image cuối chạy được cả hai route/API, manifest/static/SW đồng nhất; không harness/secret; SMTP TLS/auth được kiểm chứng bằng test.
- [ ] T30: host có DNS/TLS, quyền DB riêng, restart/reboot/log/health đã thử; xác minh và reset tới inbox thật.
- [ ] T31: timer tạo snapshot ngoài host; restore DB sạch bằng app/profile sạch; key và sync epoch phục hồi đúng; số đo RPO/RTO được ghi.
- [ ] T32: candidate digest cố định, AC-01–AC-38 có evidence staging; hai thiết bị thật; AC-31/32 và independent-host scenario đạt trên staging, vẫn giữ production verification ở T36.
- [ ] T33: rollout, rollback tương thích, rollback bị chặn khi không tương thích, migration interrupted, dirty draft/pending/lost response và restore epoch cùng origin đã diễn tập.
- [ ] Các CI bắt buộc ở đúng SHA xanh; runbook không còn bước giả định máy cá nhân phải chạy.
- [ ] Bàn giao T34: artifact/config contract, checklist, kết quả backup/restore/upgrade và giới hạn còn lại; T35/T36 mới thực hiện và xác nhận production.

Nhóm 7 chỉ hoàn tất khi cả năm cổng có bằng chứng. Không đánh dấu T29–T33 xong chỉ vì đã viết plan hoặc build thành công.

## 8. Tự rà soát plan

- Coverage: năm định nghĩa task trong task index được ánh xạ một-một tới năm plan con; AC-28/29/31–36 và backup/key/recovery đều có owner.
- Steps: từng plan con ghi file, interface, test/assertion, command, expected output, bước triển khai và commit; không bắt executor tự đặt hợp đồng giữa task.
- Types: DeployConfig/ReleaseManifest/exit codes và tên file thống nhất theo mục 6; plan con không tạo schema trùng khác tên.
- Review Focus: năm rủi ro đầu tài liệu có test ở đúng task; phân biệt rollback binary với disaster restore và staging PASS với production PASS.
- Proportion: mô tả cách thực hiện và tiêu chí; không chép reducer/auth/storage code, không mở thêm feature người dùng ngoài nhóm 7.

Kết quả kiểm tra tài liệu khi lập plan: **6 tài liệu, 21 đầu việc triển khai, 139 bước có checkbox**; mọi local Markdown link trỏ tới file hiện có, header/fence/chuỗi số bước hợp lệ, 9 snippet Python parse được và không có trailing whitespace. Đây là kiểm tra **plan**, chưa chạy các test/deploy/recovery được mô tả trong các bước.

## 9. Handoff

Triển khai từng task trên một nhánh feature Gitflow riêng; chỉ bắt đầu task kế tiếp sau khi PR task trước được merge vào develop. Mỗi PR có title/description tiếng Anh, CI phải xanh, review findings phải được xử lý trước khi merge.

Nguồn kỹ thuật đã đối chiếu ngày 04/11/2026: [Next standalone](https://nextjs.org/docs/app/api-reference/config/next-config-js/output), [self-hosting](https://nextjs.org/docs/app/guides/self-hosting), [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/), [uv Docker](https://docs.astral.sh/uv/guides/integration/docker/), [MySQL 8.4 mysqldump](https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html), [Python smtplib](https://docs.python.org/3.14/library/smtplib.html), [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [restic repository](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html), [restic restore](https://restic.readthedocs.io/en/stable/050_restore.html).
