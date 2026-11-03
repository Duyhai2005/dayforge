# T13 — Cache offline cho Next.js server

Ngày lập: **02/11/2026** · Cập nhật **03/11/2026**: **Production offline suite, IndexedDB quota, A/B guarded reload, ACK-waiting preservation, writer-drain guard, Flight-in-flight, lost push response qua defer và A→B switch, và hoãn update khi tab không phản hồi handshake (mô phỏng suspended client) đã kiểm chứng trên Chromium; còn UI lịch thuộc T14–T23 và nghiệm thu browser/OS đích**. Xem [trạng thái triển khai](implementation-status.md).

Bản chỉnh sau review **02/11/2026**: pin build đang được phép chạy, thêm build/storage gate trước migration, hỗ trợ `/` offline và cách ly suite Playwright; dùng revision guard T11 khi lưu draft/chuyển phiên bản.

**Mục tiêu:** Sau một lần chuẩn bị online hợp lệ, mở lại trực tiếp cả hai lịch khi mất mạng vẫn tải được app, đọc/sửa dữ liệu local; cập nhật cache/schema không mất pending hoặc bản nháp.

**Căn cứ:** [Kiến trúc đã chốt](../../project-definition/04-technical-architecture.md), [auth/vault contract T03](../t03/auth-contract.md), [HTTP contract](../t03/api-contract.md), [sync contract](../t03/sync-contract.md), [bàn giao T06](../t06/review-and-verification.md), [plan T11](../t11/plan.md), [plan T12](../t12/plan.md).

## 1. Hiện trạng và phụ thuộc

Ở checkout khảo sát lúc lập kế hoạch (`65480f2`), Next.js server đã có `/work`, `/milestones`, view-state `date`/`scale`, client navigation và shell không chứa dữ liệu riêng. Khi đó chưa có service worker, precache, storage/vault hoặc auth thật. Các phần này đã được triển khai một phần sau đó; xem [trạng thái hiện tại](implementation-status.md). Callback `/verify-email`, `/reset-password` đã có no-store/no-referrer và phải giữ regression.

T13 cần T06/T08/T09 để có shell, dữ liệu bền và owner gate. Chuẩn bị cache có thể bắt đầu khi các phần đó đủ; nghiệm thu reconnect phải chạy cùng T11, và test upgrade có pending/recovery dùng T12. Không chờ T14–T23 mới xây offline shell; thao tác dữ liệu trong giai đoạn nền dùng harness gọi đúng mutation API sản phẩm.

## 2. Thiết kế cache được thực hiện

Giữ Next.js server/Node + FastAPI; bổ sung service worker cùng origin, scope `/`, ưu tiên API trình duyệt và build tooling hiện có. Next.js có hướng dẫn [phục vụ worker từ `public` và cấu hình headers](https://nextjs.org/docs/app/guides/progressive-web-apps); plan này bổ sung cache offline riêng theo yêu cầu DAYFORGE. Không đổi sang static export. Cache Storage chỉ chứa shell/tài nguyên công khai; dữ liệu lịch, outbox, shadow, cursor, bản nháp và undo tiếp tục mã hóa trong IndexedDB theo T08/T09.

| Loại request | Chính sách |
| --- | --- |
| HTML navigation `/work`, `/milestones` | Khi đã chuẩn bị, phục vụ shell công khai của build được chấp thuận từ cache riêng build đó. Chỉ nhận shell mạng khi có build marker khớp build được phép chạy; response build mới chỉ phục vụ staging/update, không tự hydrate. Không runtime-cache HTML tùy ý có cookie/owner. |
| HTML navigation `/` | Worker chuyển hướng cục bộ tới `/work`, rồi dùng shell build được chấp thuận; không cần server trả redirect khi offline. Đây là redirect do worker tạo cho đúng `/`, không phải cho phép cache redirect tùy ý từ mạng. |
| Query `date`, `scale` | Dùng shell route trung tính, đọc URL trên client; không nhân cache theo ngày/tháng/năm. Chỉ bỏ query khi lookup navigation đã allowlist, không dùng `ignoreSearch` cho mọi request. |
| JS/CSS/font/tài nguyên build hai lịch | Precache allowlist cùng build, cache-first theo URL có fingerprint/revision; bảo đảm đủ chunk của cả hai lịch trước khi báo offline-ready. |
| RSC/Flight/router prefetch | Không cache; chỉ chuyển response mạng cho router khi build marker khớp build được phép chạy và client tương ứng. Thiếu/sai marker hoặc mất mạng thì bỏ response Flight và chuyển document navigation tới shell build đang được phép; không trả HTML trong request Flight hoặc trộn response theo header/query/Vary. |
| `/api/**`, auth/session/local-key/logout/sync | Network-only với no-store; không cache GET lỗi, POST hoặc giả response thành công khi offline. |
| `/account`, `/verify-email`, `/reset-password` | Network-only, không precache, không dùng lịch làm fallback; email callback không được lấy từ cache cũ. |
| Cross-origin, redirect, opaque, request ngoài allowlist | Không cache hoặc fallback rộng. |

Shell precache phải được lấy không có credential và được kiểm chứng chỉ chứa markup/code chung, không có owner, key, dữ liệu local, CSRF hoặc token. Chỉ chấp nhận status/content-type/route/build đúng; private/no-store response bị loại. Calendar SSR/RSC không được fetch hoặc nhúng dữ liệu riêng vào shared cache; nếu cần dữ liệu riêng thì đọc local phía client.

**Build/storage gate:** HTML shell, RSC và manifest có cùng build marker công khai, dự kiến header `X-Dayforge-Build` đối chiếu với ID do pipeline sinh; không dựa vào worker còn waiting để kết luận app cũ vẫn đang chạy. Metadata kỹ thuật ổn định lưu `approved_build`, `target_build` khi cập nhật, `update_epoch` và pha `running|preparing|switching`, đọc được trước khi mở versioned owner vault, không chứa owner/key/dữ liệu lịch. Mọi entrypoint mở vault, migration, render dữ liệu local hoặc ghi/sync phải qua gate này; áp dụng cả khi HTML account/callback được tải network-only hoặc trang chưa được worker kiểm soát. Build không khớp chỉ được hiện shell/thông báo cập nhật; chỉ updater có quyền switching tường minh cho đúng `target_build`/epoch mới được chạy migration, chưa được mở writer nghiệp vụ trước khi hoàn tất. Không cache callback riêng tư để giải quyết lệch build.

Lần đầu thiết lập gate chưa có `approved_build`, một initializer duy nhất kiểm tra manifest/schema được hỗ trợ rồi tạo metadata bằng compare-and-swap; không có coordinator cập nhật hoặc initializer khác đang giữ quyền. Đây là nhánh khởi tạo, không được dùng để tự nhận build mới khi metadata đã tồn tại. Các ca upgrade A/B dùng hai build đã tích hợp gate; schema/vault hiện có vẫn được giữ qua migration T08.

Store metadata gate phải ổn định qua các schema được hỗ trợ và cùng IndexedDB với owner data để writer kiểm tra update epoch trong chính transaction ghi dữ liệu. Bootstrap đọc metadata bằng cách mở version hiện hành, không yêu cầu nâng version trước khi biết quyền migration; T08 storage facade phải cung cấp hoặc bổ sung khả năng này trước khi bật luồng update. Không đặt gate ở một DB riêng rồi coi hai transaction là một commit nguyên tử.

Đổi `approved_build` chỉ qua giao thức cập nhật ở bước 4, sau khi các writer cũ đã bị chặn và draft đã lưu bền. Tab mới, reload trực tiếp hoặc RSC mới không được tự đổi metadata sang build của mình. Khi chuyển build/migration thất bại trước khi hoàn tất, giữ hoặc khôi phục gate của build cũ tương thích; không bật writer cũ trên schema đã nâng cấp thành công.

`offline-ready` cần đủ shell/assets của **hai** lịch; khả năng đọc dữ liệu còn tùy vault đã chuẩn bị/unlocked. Khi shell tải được nhưng local chưa chuẩn bị, báo đúng cần online chuẩn bị, không hiện lịch trống như thể dữ liệu đã mất. Nếu chưa từng tải/cache shell, trình duyệt có thể chỉ hiện lỗi mất mạng; không hứa app tự chạy lần đầu khi offline.

## 3. Bản đồ thay đổi dự kiến

| Vùng/file | Trách nhiệm |
| --- | --- |
| `frontend/service-worker/sw.ts` | Allowlist fetch/cache, lifecycle và message protocol có version; worker không giữ owner key hoặc gửi outbox. |
| `scripts/build-offline-assets.cjs`, `frontend/public/sw.js`, manifest sinh từ build | Tạo worker và danh mục assets đúng production build. Output sinh tự động, không sửa tay/chốt danh sách chunk cố định. |
| `frontend/lib/offline/register.ts`, `cache-state.ts`, `navigation.ts`, `build-gate.ts` | Registration, offline-ready, pin build, root redirect, RSC-safe document fallback và update gate dùng chung trước khi mở vault. |
| `frontend/components/offline/offline-provider.tsx`, update notice | Tích hợp lifecycle ở layout phù hợp, giao tiếp với draft/storage/sync; không đưa chi tiết kỹ thuật vào UI. |
| `frontend/next.config.ts`, root/account/calendar layouts và storage/auth bootstrap thực tế | Headers worker/build marker, gate trước vault/migration, shell công khai và điều hướng giữ URL/history/focus. |
| Storage facade/metadata/migration thực tế từ T08/T11 | Metadata build/update ổn định trước versioned vault; kiểm tra update epoch trong mọi writer và prepare/compare-and-swap khi flush draft/swap. |
| `frontend/playwright.config.ts`, `frontend/playwright.production.config.ts`, `frontend/playwright.offline.config.ts` | Tách test discovery dev/production thường/offline, chính sách worker, output và profile theo suite. |
| `frontend/tests/offline-*.spec.ts`, helpers | Production browser suite dùng service worker thật, build A/B, root cold-start, quota/install failure và owner lock. |
| Root/frontend scripts, `.gitignore`, `.github/workflows/ci.yml`, runbook/báo cáo T13 | Build reproducible, runner/artefact/profile riêng và kết quả nghiệm thu; không commit dữ liệu test. |

Tên provider/storage adapter thực tế phải đối chiếu T08/T09/T11. Nếu cần schema mới, lấy version kế tiếp từ code bàn giao; worker không tự chạy migration dữ liệu.

## 4. Các bước triển khai

### Bước 1 — Chứng minh shell offline với production build

- [ ] Audit HTML/RSC, fetch/headers và asset graph thực của hai route trên build production; xác nhận không có server auth gate khiến shell chung bị redirect hoặc nhúng dữ liệu riêng.
- [ ] Chuẩn bị shell trung tính cho từng route và manifest revision/build ID tự động. Precache cả hai route cùng toàn bộ chunk phụ thuộc cần hydrate/điều hướng; không chỉ cache trang đang mở.
- [ ] Chốt pipeline sinh worker/manifest: khai báo đường dẫn public trước build, hoàn tất danh mục từ output build trước start/đóng gói; kiểm tra `/sw.js` và manifest được server production phục vụ đúng build ID/byte thực. Không phụ thuộc vào ghi file mới sau khi server đã chạy.
- [ ] Sinh build marker chung cho shell/RSC/manifest; kiểm tra response production có marker trước khi cho hydrate hoặc dùng cho router. Build mới tải được từ mạng chưa đồng nghĩa được phép mở vault/migrate.
- [ ] Tạo prototype cold navigation `/`, `/work?date=...`, `/milestones?date=...&scale=year` sau chuẩn bị online, ngắt mạng, đóng trang rồi mở trang mới cùng browser profile. `/` phải chuyển tới `/work` mà không cần SSR/redirect từ server.
- [ ] Đặt kiểm chứng bắt buộc: hydration không cần SSR/Flight mới để hiện dữ liệu local. Nếu asset discovery thiếu chunk thì sửa build manifest trước khi mở rộng caching.

**Đạt khi:** cả hai lịch cold-start được offline trên production build; không chỉ là fallback có tiêu đề hoặc tab giữ sẵn DOM.

### Bước 2 — Worker fetch rules và navigation App Router

- [ ] Đăng ký worker cùng origin/scope ở production hoặc chế độ test rõ ràng; dev mặc định không đăng ký để tránh HMR/stale cache. Worker script có header bắt buộc kiểm tra cập nhật, không cache dài chính nó.
- [ ] Fetch handler chỉ `respondWith` cho request được phân loại; private/auth/callback đi network-only và không được catch-all fallback sang calendar HTML.
- [ ] Pin calendar navigation vào `approved_build`, lookup đúng cache namespace của build đó, không `caches.match` xuyên mọi generation. Chỉ bổ sung từ mạng khi marker khớp; cache cũ thiếu mà server chỉ trả build mới thì báo cần chuẩn bị/cập nhật, không tự chạy build mới. Không cache response `Set-Cookie`/private/no-store, redirect/login page hoặc lỗi làm shell hợp lệ; không chỉ dựa một header JS không đọc được để phân loại an toàn.
- [ ] Xử lý RSC/prefetch theo header, content-type và query thực tế Next.js: fetch network-only có guard build; marker thiếu/sai thì không giao payload cho router, chuyển document navigation dùng shell đã pin. Giữ nguyên quy tắc không xóa `_rsc` để dùng cache HTML; kiểm tra cả request đang chờ khi server đổi build.
- [ ] Thêm đúng route navigation `/` vào allowlist và tạo local redirect tới `/work`, chạy được khi server đã dừng. Query calendar tiếp tục xử lý ở route lịch theo T06; không mở rộng fallback sang account/callback hoặc mọi redirect.
- [ ] Tích hợp điều hướng offline cho đổi lịch, đổi ngày/scale và Back/Forward; khi Flight không dùng được thì document navigation tới đúng URL. Hỗ trợ mất mạng trong lúc router request đang chạy; không dựa riêng `navigator.onLine` làm bằng chứng mạng tốt.
- [ ] Giữ regression T06 về URL/preferences/focus/scroll; không nới response cache cho account/callback chỉ để điều hướng thành công.

**Đạt khi:** đổi tuần/tháng/năm và qua lại hai lịch offline không trắng trang, sai type response hoặc mất ngữ cảnh.

### Bước 3 — Owner gate, vault và trạng thái sẵn sàng

- [ ] Shell hydrate qua owner gate T08/T09, kiểm tra persisted lock epoch trước đọc/render. Reload offline unlocked đọc CryptoKey đã chuẩn bị theo contract; cookie tự nó không được mở vault.
- [ ] Khởi tạo build/storage gate trước provider mở owner vault hoặc migration. Metadata gate phải đọc được mà không tự nâng schema vault; tab có build không khớp hoặc đến giữa lúc chuyển phiên bản chỉ được chạy shell chờ, không hydrate dữ liệu, unlock, ghi hoặc sync. Gate phiên bản không thay thế kiểm tra owner/lock epoch.
- [ ] Logout ở tab khác khóa mọi tab, bỏ plaintext/key/query cache trong memory; cache chung vẫn chỉ là shell. Worker không giữ key, payload lịch hoặc state phiên riêng.
- [ ] Giữ local edits khi hết phiên; reconnect để T11 xác thực đúng owner rồi sync. Pending logout được xử lý trước login/sync theo T09.
- [ ] Phân biệt cache-ready, local-ready/unlocked, pending/offline và auth-paused; không báo đã lưu/sync chỉ vì worker nhận request hoặc tài nguyên đã cache.
- [ ] Xử lý Cache Storage/quota/private-mode lỗi độc lập với lỗi IndexedDB. Đề nghị persistent storage nếu phù hợp và kiểm tra kết quả; không hứa trình duyệt không thể xóa site data.

**Đạt khi:** hai owner fixture dùng lần lượt cùng profile không thấy dữ liệu nhau; owner locked không bị mở lại từ cached HTML/RSC hoặc cookie cũ.

### Bước 4 — Cập nhật worker và migration an toàn

- [ ] Cache có namespace/build version; install generation mới chỉ hoàn tất khi đủ mọi asset bắt buộc. Install lỗi không đụng cache đang hoạt động hoặc báo ready giả.
- [ ] Không tự `skipWaiting`, `clientsClaim` hoặc reload giữa lúc người dùng nhập. Thông báo có bản mới; người dùng chọn cập nhật sau khi draft được lưu bền hoặc quyết định xử lý bản nhập rõ ràng.
- [ ] Khi người dùng chọn cập nhật, tạo `update_epoch` mới và pha preparing bền vững; mọi tab dừng nhận edit mới, pause coordinator và drain writer đang chạy. Chỉ cho phép luồng flush draft đã cấp quyền cho epoch này dùng primitive prepare/compare-and-swap T11. Mọi writer đều kiểm tra update gate trong transaction commit, không chỉ kiểm tra dirty form một lần trong memory.
- [ ] Update handshake với mọi tab/entrypoint: xác nhận draft đã lưu, revision cuối, không còn transaction và có thể hydrate lại. Tab mới mở phải gia nhập gate, không được tiếp tục viết ở build cũ hoặc mở vault bằng build mới. Tab suspend/không phản hồi thì hoãn/hủy preparation và dùng tiếp build cũ an toàn; không coi timeout là đồng ý hoặc ép reload làm mất nhập liệu.
- [ ] Pending không bắt buộc phải gửi hết trước cập nhật: snapshot/journal/active outbox và draft phải đã commit bền. Chuyển pha switching chỉ sau khi xác nhận writer cũ bị fence; giữ envelope và khởi động coordinator sau hydrate build được chấp thuận. Nếu còn request không rõ đã commit server, retry nguyên envelope sau update, không để response cũ ghi qua update epoch.
- [ ] Cấp quyền migration riêng cho updater đúng `target_build`/update epoch ở pha switching, sau đó chạy migration IndexedDB qua T08, xử lý `versionchange`/blocked đa tab và atomic rollback. Mở quyền ghi cho build mới/chuyển `approved_build` chỉ khi migration thành công; lỗi trước hoàn tất giữ gate/schema cũ tương thích và không mất draft/pending. Ghi checkpoint để crash sau commit schema nhưng trước đổi `approved_build` vẫn resume switching sang build mới, không bật lại writer cũ trên schema mới. Worker không xóa DB/outbox hoặc dùng `Clear-Site-Data`.
- [ ] Không xóa cache/chunk cũ khi còn tab đang dùng build đó. Cleanup theo build đang được clients sử dụng và giữ generation cũ khi chưa chứng minh an toàn; không xóa mọi cache khác của origin.
- [ ] Protocol/reducer mới không được replay event cũ bằng nghĩa khác; client không tương thích giữ pending và yêu cầu update. Chạy một cặp build A/B có schema migration tương thích, thêm fixture migration thất bại.

**Đạt khi:** cập nhật khi còn draft/pending/ack-waiting, tab cũ và lost response vẫn giữ dữ liệu; install/migration lỗi dùng tiếp trạng thái cũ an toàn.

### Bước 5 — Suite offline thật và build A/B

- [ ] Tạo runner production riêng, profile sạch mỗi test, service worker enabled; giữ bộ mock/API route test hiện có tách khỏi bằng chứng SW thật.
- [ ] Sửa **cả** `playwright.config.ts` và `playwright.production.config.ts` để `testIgnore: ["**/offline-*.spec.ts"]`; cấu hình offline chỉ `testMatch: ["**/offline-*.spec.ts"]`. Suite dev/production thường đặt `serviceWorkers: "block"` để không ảnh hưởng mock/HTTP tests; suite offline đặt `serviceWorkers: "allow"`. Không chỉ thêm config mới mà giữ discovery mặc định cho tất cả specs.
- [ ] Tách `outputDir`, trace/report và profile theo suite/run; dự kiến `frontend/.test-artifacts/web-dev`, `web-prod`, `web-offline`, nằm ngoài `.next`/build A/B và được ignore. Offline runner sở hữu persistent profile riêng từng test/run, giữ profile chỉ trong ca restart cùng test; không tái sử dụng profile của dev hoặc production suite thường.
- [ ] Kiểm tra discovery bằng `playwright test --list` với từng config: dev/production thường không liệt kê offline spec; offline chỉ liệt kê offline spec; các test nền hiện có vẫn được chạy. CI kiểm tra điều này trước browser run để phát hiện test bị bỏ sót hoặc chạy nhầm suite.
- [ ] Test lạnh bằng page mới trong cùng persistent browser profile, thêm ca khởi động lại browser cùng profile để xác nhận cache/key/lock là persisted; không coi `reload` trên tab sống là đủ.
- [ ] Chuẩn bị online với API/owner thật trong DB cô lập, ngắt mạng, lưu mutation qua sản phẩm, đóng/mở rồi online; hai context nhận đúng qua T11/T12.
- [ ] Với SW tests, dùng network control thật hoặc proxy test có thể ngắt/kéo trễ server; không dùng route interception bỏ qua worker để kết luận precache hoạt động.
- [ ] Duyệt Cache Storage keys/bodies và HTML/RSC bằng dữ liệu sentinel test: không có title/note/owner/token/key trong shared cache; kiểm tra auth/callback no-store ở production.
- [ ] Chạy build A online rồi đổi server sang B trên **cùng origin** trong khi worker B còn waiting và tab A còn draft. Thử mở tab mới, reload và request Flight đang chờ: B không được hydrate/migrate vault trước handshake. Sau chấp thuận, kiểm tra một lần chuyển build/schema và resume sync; ghi build ID/protocol/schema của cả hai. Tách thư mục/process build A/B nhưng giữ nguyên browser profile, local DB/outbox và backend test DB trong cùng ca; chỉ tách profile/DB/artefact giữa các suite/test/run.
- [ ] Thử local save hoặc gõ thêm đúng giữa lúc kiểm tra dirty và chuyển build, tab mới tham gia preparing, tab suspend, install thiếu asset, migration blocked/rollback. Update epoch/revision guard phải giữ draft/pending hoặc hoãn chuyển; không chỉ dựa việc pause bộ sync.

**Đạt khi:** test quan sát request/cache/IDB và dữ liệu cuối, không chỉ assert offline banner.

### Bước 6 — Runbook, CI và nghiệm thu

- [ ] Gắn offline suite production vào CI sau build, với artifact/profile/process tách biệt; không chạy build A/B cùng thư mục `.next` đang phục vụ hoặc dùng DB dev.
- [ ] Gắn cả discovery checks và ba runner đã cách ly vào quality workflow, giữ regression dev/production thường. Ghi chính xác entrypoint/config/output/profile để tái lập, không tính một offline spec chạy nhầm trong runner thường là bằng chứng SW.
- [ ] Ghi cách chuẩn bị offline, nhận cập nhật, chẩn đoán cache/storage/auth lỗi và khôi phục mà không xóa pending; ghi browser/OS/HTTPS thực đã kiểm tra.
- [ ] Tạo báo cáo T13 gồm lệnh, kết quả ma trận, giới hạn và bàn giao T25/T28/T33. Luồng nghiệp vụ chưa có UI chỉ ghi đạt ở mức nền/harness.
- [ ] Chỉ cập nhật trạng thái hoàn thành sau kết quả; bài diễn tập production rollout/rollback đầy đủ tiếp tục ở T33.

## 5. Ma trận kiểm chứng bắt buộc

| Ca | Kết quả phải quan sát |
| --- | --- |
| Online chuẩn bị một lịch; offline mở trực tiếp lịch còn lại | Cả hai shell/assets đã sẵn, hydrate được; không cần thăm trước từng route thủ công. |
| Cold-start bằng `/` khi server đã dừng | Worker redirect cục bộ tới `/work`, shell của approved build và vault đã chuẩn bị vẫn dùng được; không cần server redirect. |
| Cold-start offline với date/scale và qua lại hai lịch | Đúng URL/ngày/scale, không lỗi Flight, không trắng trang. |
| Offline tạo/sửa/xóa bằng mutation API, đóng/mở browser | Dữ liệu và outbox tồn tại; reconnect tự sync cùng ID/hash. |
| Chưa từng chuẩn bị hoặc cache bị thiếu | Thông báo cần online đúng trạng thái; không giả dữ liệu rỗng/sync thành công. |
| API GET/POST lỗi; verify/reset/account offline | Không có response riêng từ cache hoặc calendar fallback; callback không bị consume/replay. |
| Logout liên tab, hết phiên, owner A rồi B | Lock/expiry đúng chính sách; shared cache không có plaintext riêng của A. |
| Update A→B còn draft/pending/ack-waiting | Draft được giữ hoặc update hoãn; outbox byte/hash giữ nguyên; không ép reload. |
| Server đã chạy B, worker B waiting; tab A dirty; tab mới/reload/Flight | Shell/RSC mới không vượt build gate; B chưa mở/migrate vault, A không mất draft; chỉ chuyển khi đủ điều kiện. |
| Local save/gõ thêm/tab mới xen giữa readiness check và switching | Update epoch + revision guard chặn writer/prepare cũ; flush bền hoặc hoãn update, không mất bản nhập. |
| Crash sau commit schema mới nhưng chưa đổi approved build | Giữ pha switching, resume updater đúng target/epoch; build cũ không reopen writer trên schema mới. |
| Hai tab khác build, tab suspend, `versionchange` | Không xóa chunk còn dùng, không mất transaction, chờ/resume đúng. |
| Install thiếu asset, quota, migration lỗi | Bản cũ hoạt động, không xóa IDB/cache cũ để cứu install; báo lỗi phù hợp. |
| Mất response sync đúng lúc update | Retry envelope cũ, một tác dụng server, cuối cùng pull đủ shadow. |
| Kiểm tra production headers/cache bodies | No-store auth/API/callback; không owner/key/token/title/note trong shared cache. |
| Discovery ba config và chạy các suite độc lập | Offline spec chỉ xuất hiện trong offline runner; worker block/allow đúng suite; output/profile/build không dùng chung. |

Liên quan chính: **AC-19, AC-20, AC-28, AC-35**, cùng phần nền AC-21/AC-30/AC-33/AC-34. Nghiệm thu mọi thao tác UI của AC-20 cần T14–T23/T28, không suy từ shell/harness.

## 6. Lệnh nghiệm thu và điều kiện hoàn thành

Giữ `pnpm lint`, `pnpm typecheck`, `pnpm test:web`, `pnpm build:web`, `pnpm test:web:prod`; entrypoint `pnpm test:web:offline` và runner `pnpm test:web:offline:update` đã được tạo và gắn CI. Chạy backend/integration gates khi test reconnect hoặc thay đổi runner liên quan. Bằng chứng hiện tại phủ install lỗi, quota hai storage, Flight qua switching, ACK-waiting preservation, writer drain, timeout khi tab không phản hồi, lost push response trong cả defer/switch, migration blocked/rollback/resume và cold start. Các giới hạn còn lại được liệt kê theo phạm vi ở [trạng thái triển khai](implementation-status.md); luồng UI lịch và nghiệm thu môi trường đích chưa được suy ra từ harness.

Trước khi chạy browser suites, kiểm tra discovery bằng `pnpm verify:web-discovery` (dev, production và offline configs); các lệnh Playwright `--list` tương ứng được runner gọi để phát hiện spec bị chạy nhầm hoặc bỏ sót. Đối chiếu [Playwright testMatch/testIgnore](https://playwright.dev/docs/api/class-testconfig#test-config-test-match) khi sửa cấu hình.

T13 phần nền hoàn thành khi `/` và cả hai route lịch cold-start/sửa local/reconnect thật được qua mutation API, cache riêng tư bị loại, build gate chặn app mới trước handshake, upgrade giữ draft/pending và ba suite được cách ly đúng cấu hình với báo cáo tái lập. Nghiệm thu UX nhập liệu lịch và browser/OS đích được theo dõi riêng ở T14–T23 và môi trường phát hành; không suy từ harness. Đối chiếu từng kết quả với [báo cáo triển khai hiện tại](implementation-status.md).

Tham khảo lifecycle install/wait/activate và ảnh hưởng của việc kích hoạt sớm: [web.dev — The service worker lifecycle](https://web.dev/articles/service-worker-lifecycle). Quy tắc hoãn update khi còn draft và giữ cache build cũ ở trên là chính sách của DAYFORGE, cần chứng minh bằng test A/B.
