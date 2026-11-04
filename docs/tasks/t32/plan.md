# T32 — Staging Candidate Acceptance Implementation Plan

> **Implementation:** Follow the task steps below and track completed work with checkboxes.

**Goal:** Deploy thử đúng candidate image lên staging cô lập, nghiệm thu đường HTTPS/API/MySQL/SMTP thật trên hai thiết bị và cập nhật đối chiếu AC-01–AC-38 bằng evidence đúng phiên bản.

**Architecture:** T30 deploy script activate candidate T29 sau backup T31; Playwright staging suite riêng gọi UI/API sản phẩm qua public HTTPS, không intercept auth/sync và không bật test route. Những case cần inbox, hai thiết bị vật lý và tắt PC có procedure thủ công kèm evidence; kết quả tự động không thay thế chúng. Matrix staging riêng giữ provenance T28 và phân biệt kết quả rehearsal với sign-off production T36.

**Tech Stack:** Immutable Next/FastAPI images + MySQL thật, HTTPS Caddy, SMTP/inbox thật, Playwright1.64.1/Windows Chromium và browser thứ hai; existing backend/sync/offline suites để regression.

**Spec:** [T32](../README.md), [38 AC](../../project-definition/06-delivery-and-acceptance.md), [matrix T28](../t28/acceptance-results.md), [T03 auth/sync](../t03/design.md), [T29](../t29/plan.md), [T30](../t30/plan.md), [T31](../t31/plan.md), [plan tổng](../../superpowers/plans/2026-11-04-group7-deployment-rehearsal.md).

## Global Constraints

- Kế thừa Global Constraints/metadata/evidence trong plan tổng; staging khác production về origin/DB/secrets/project/networks.
- “Email xác minh/reset phải tới inbox thực tế, không chỉ có log hoặc email giả lập.”
- “Không yêu cầu chạy nền khi đóng hẳn”; offline queue sync khi mở/mở lại và session đúng owner còn hiệu lực.
- AC-31/32/36 đang TARGET_PENDING ở T28; chỉ có evidence thực mới nâng trạng thái staging. AC-36 trong spec yêu cầu production nên vẫn phải tái xác nhận ở T36.
- Không đưa private password/token/cookie/key/note vào snapshot/trace/log upload. Staging auth tests trace/video off; dùng data kiểm thử và screenshots sau khi đã bỏ token URL.
- Desktop đích ghi OS/browser/version, ít nhất 1024×768 và1920×1080; không thay pin runtime của build bằng runtime local cũ trong báo cáo T28.

## Review Focus

- CI mock API xanh không chứng minh proxy/API/DB thật hoạt động — staging suite cấm route.fulfill auth/sync và kiểm tra backend state bằng thiết bị thứ hai.
- Link scanner GET không được tiêu thụ verify/reset; callback fragment phải được xóa mà không lọt log/cache — inbox callback test.
- Owner B không được mở dữ liệu A còn trong cùng browser — hai installation kiểm thử độc lập được thay lần lượt dưới cùng staging origin, giữ profile local.
- Tắt PC dev làm mất test runner không phải server fail — PC-off kiểm chứng từ thiết bị/mạng khác và ghi evidence ở đó.
- Acceptance record dùng nhiều SHA không được gọi là cùng candidate — validator từ chối row PASS thiếu đúng release/digest, hoặc ghi rõ inherited evidence chưa re-run.

---

## Bản đồ file

| File | Trách nhiệm |
| --- | --- |
| frontend/playwright.staging.config.ts | Tạo testDir staging, baseURL HTTPS thực, serviceWorkers allow, không webServer |
| frontend/tests/staging/fixtures.ts | Tạo private credentials/profile setup, actual auth helper, two-context fixtures; không product harness |
| frontend/tests/staging/routes.spec.ts | Tạo HTTPS/routes/header/build/real API checks |
| frontend/tests/staging/auth.spec.ts | Tạo login/session/CSRF/callback checks sau bước inbox thật |
| frontend/tests/staging/calendar.spec.ts | Tạo UI công việc/màu/lặp/dấu mốc tiếng Việt |
| frontend/tests/staging/offline-sync.spec.ts | Tạo hai context, offline→reload→reconnect, SW/cache và no false success |
| frontend/tests/staging/owner-isolation.spec.ts | Tạo test profile A→B cùng origin qua hai installation cô lập |
| frontend/playwright.config.ts, playwright.production.config.ts, playwright.offline.config.ts | Sửa exclude staging/release specs khỏi runner cũ |
| scripts/check-playwright-discovery.cjs | Sửa discovery gate cho ba suite mới/cũ không lẫn |
| scripts/run_staging_acceptance.cjs, scripts/validate_acceptance.py | Tạo guard runner và matrix validator |
| scripts/tests/test_acceptance_results.py, test_staging_runner.py | Tạo test schema/status/provenance evidence và CLI guards |
| frontend/package.json, package.json | Thêm test:web:staging; không gộp vào local verify mặc định |
| docs/tasks/t32/acceptance-results.md, acceptance-results.json, manual-scenarios.md | Ma trận38AC, checklist thiết bị/inbox/PC-off và evidence index |
| docs/tasks/t28/acceptance-results.md, docs/tasks/README.md | Chỉ thêm liên kết evidence mới, giữ lịch sử T28 và production pending |

## Task T32.1: Deploy candidate và kiểm tra public HTTPS không mock

**Files:** Create staging config/routes spec/runner, package scripts; Modify discovery/base configs.

**Interfaces:**

- CLI **node scripts/run_staging_acceptance.cjs --config <staging.json> --release <release.json> --output <dir> [-- <Playwright args>]**. Chỉ environment=staging, HTTPS origin trùng config; exit2 nếu production/localhost/origin mismatch/harness flag. Không tự migrate, xóa DB hoặc gửi email trong runner smoke; deployment là bước riêng có backup. pnpm test:web:staging chuyển nguyên arguments sau -- tới runner; config/release/output có thể lấy từ biến môi trường chỉ chứa đường dẫn private, thiếu thì exit2, không fallback.
- Private fixture input đường dẫn **DAYFORGE_STAGING_CREDENTIALS_FILE**: JSON owner_email, owner_password; không track trong git. Hai-device physical procedure dùng password manager, không sao chép vào report.
- Playwright config testDir='./tests/staging', webServer=undefined, serviceWorkers='allow', trace='off', video='off'; chỉ retain screenshot đã che khi an toàn. Command **pnpm test:web:staging** gọi runner, không mặc định fallback tới local mock.

- [ ] **Step 1: Viết failing smoke/runner guard tests.** Guard unit test trong scripts/tests/test_staging_runner.py; fake config valid fixtures cùng test. Routes spec assertions:

~~~typescript
test('publicCandidateMatchesImmutableRelease', async ({ page, request }) => {
  const health = await request.get('/api/v1/health');
  expect(health.status()).toBe(200);
  expect(health.headers()['cache-control']).toContain('no-store');
  const manifest = await request.get('/dayforge-build.json');
  expect((await manifest.json()).build_id).toBe(expectedRelease.build_id);
  await page.goto('/work');
  expect((await page.request.get('/milestones')).status()).toBe(200);
  expect((await request.get('/sync-browser')).status()).toBe(404);
  expect((await request.get('/offline-update')).status()).toBe(404);
});
~~~

expectedRelease fixture đọc release.json đã validate trong fixtures.ts. Thêm tests HTTPS certificate trusted, redirect HTTP→HTTPS không có token query; callback private/no-store/no-referrer; /sw.js+manifest no-store; API version1; malformed Origin/CSRF POST bị403 và state không đổi.

- [ ] **Step 2: Run đỏ.** `pnpm --filter @dayforge/frontend exec playwright test --config=playwright.staging.config.ts --list`; expected FAIL thiếu config/spec. Sau khi scaffold test, run routes tới staging prerequisite; nếu chưa có host ghi BLOCKED, không thay bằng mock để lấy xanh.
- [ ] **Step 3: Implement config/fixtures/guards.** Load release/config bằng đúng schema T29; runner không print environment/credentials. Exclude tests/staging và tests/release khỏi dev/prod/offline discovery; guard xác nhận mỗi suite chỉ chứa spec của mình. Không set DAYFORGE_SYNC_TEST_HARNESS, DAYFORGE_PLAYWRIGHT_MOCK_API hoặc dùng fixture auth mocked của suite cũ.
- [ ] **Step 4: Deploy candidate vào staging.** Kiểm tra T29/T30/T31 pass, required CI đúng SHA; lấy prechange snapshot nếu DB có data; deploy_release theo digest. Nếu cần installation mới cho first-owner verify, dùng **DB/volume staging mới** và archive installation cũ, chỉ sau khi record backup/IDs; không chạy downgrade base hoặc xóa volume nguồn. Giữ production dừng/chưa deploy.
- [ ] **Step 5: Run xanh.** Run runner chỉ routes spec bằng --grep/tag smoke hỗ trợ trong runner; `pnpm verify:web-discovery`; manifest/header/platform/image digest thực trùng release. Probe trực tiếp public origin từ thiết bị ngoài host; failure certificate không bật ignoreHTTPSErrors để coi PASS.
- [ ] **Step 6: Commit.** Stage staging config/fixtures/routes/runner/discovery/scripts; `git commit -m "test(staging): verify the immutable release over real https"`.

## Task T32.2: Inbox thật, callback, session và hai thiết bị

**Files:** Create auth.spec.ts/manual-scenarios.md; Extend fixtures/runner and evidence JSON.

**Interfaces:**

- fixtures.ts exports **loginOwner(page: Page, credentials: OwnerCredentials) -> Promise<void>**, **expectVerifiedSession(request: APIRequestContext) -> Promise<string>** trả owner_id; OwnerCredentials fields email/password, chỉ giữ memory từ file private.
- Manual evidence case IDs **MAIL-VERIFY, MAIL-RESET, DEVICE-LOGIN, PC-OFF**. Event record chỉ message/probe reference đã che, nhận lúc nào, kết quả callback, SHA/digest; không raw token.
- Kịch bản owner kiểm thử B cần inbox riêng được kiểm soát trong installation cô lập, không mở multi-user signup trong sản phẩm.

- [ ] **Step 1: Viết test đỏ auth kỳ vọng.** auth.spec tests callback GET doesNotConsumeEmailToken, resetRevokesBothDevices, wrongOriginOrCsrfDoesNotMutate, rememberedSessionSurvivesRestart và pendingSurvivesExpiredSession. Test assertion:

~~~typescript
expect(ownerOnDeviceA).toBe(ownerOnDeviceB);
expect(await loginWithOldPasswordAfterReset()).toBe(false);
expect(await oldSessionStillAuthenticated()).toBe(false);
expect(outboxAfterSessionExpiry).toEqual(outboxBeforeSessionExpiry);
expect(callbackHeaders['cache-control']).toContain('no-store');
expect(callbackHeaders['referrer-policy']).toBe('no-referrer');
~~~

Các helpers loginWithOldPasswordAfterReset/oldSessionStillAuthenticated thuộc fixtures.ts và dùng actual auth API qua CSRF session; local snapshot outbox chỉ đọc metadata/hash qua DevTools/IDB test helper, không bypass writer. Token cần nhập từ mailbox qua memory của procedure và không ghi fixture tracked. Hết phiên được kiểm tra bằng revoke/reset hoặc fixture thời hạn test riêng trong môi trường cô lập, không thêm endpoint time travel production.

- [ ] **Step 2: Run đỏ.** Chạy staging auth spec với prerequisites mail/owner; nếu chưa hoàn tất verify, assertion verified owner fail như dự kiến. Unit runner cấm dùng mock để bỏ qua gate. Không gửi register/resend liên tục vượt resend60s/rate limits.
- [ ] **Step 3: MAIL-VERIFY end-to-end.** Trên staging installation mới, gọi register qua UI với allowlist email; trước verify, sync/private API không truy cập được. Nhận email từ provider vào inbox thật, mở link trên browser khác; GET/link preview không consume. URL đúng HTTPS origin, fragment được history.replaceState xóa; nhập mật khẩu15–128codepoint theo T03, confirm tạo owner; callback không auto-login, đăng nhập rõ ràng. Thử link đã dùng và sai purpose không tạo owner thứ hai.
- [ ] **Step 4: MAIL-RESET và DEVICE-LOGIN.** Login cùng owner trên hai thiết bị vật lý, tạo data từ A và thấy B. Forgot gửi email tới inbox, link reset mở browser khác, TTL30phút và one-time semantics kiểm tra bằng API tests hiện hành cộng real-link used-case. Đổi mật khẩu: cũ không login, session A/B bị thu hồi; đăng nhập lại đúng owner, owner_id/key_id/data không đổi, pending vẫn còn. Verification TTL24giờ được chứng minh backend tests, không chờ24giờ trong manual inbox case.
- [ ] **Step 5: PC-OFF.** Đã login B, tắt hẳn PC chạy dev/runner A. Từ B qua mạng độc lập: tải cả hai route trực tuyến, tạo/sửa và thấy sync server, gửi forgot và nhận thư; host web/API/MySQL/SMTP tiếp tục chạy. Ghi evidence từ B/host, thời gian PC tắt/bật; sau bật A xác nhận nhận data B. Không yêu cầu A đang tắt vẫn background sync; không coi browser offline cache đơn lẻ là host còn sống.
- [ ] **Step 6: Run xanh và record.** Auth automatic PASS cùng manual cases có evidence; AC-31/32 staging PASS khi đủ inbox+link+hai thiết bị. AC-36 ghi “independent-host scenario verified on staging” ở evidence, status staging PASS nhưng production verification vẫn pending T36, không đổi status lịch sử T28 thành production PASS.
- [ ] **Step 7: Commit.** Stage auth specs/helpers/manual procedure/report metadata đã che; `git commit -m "test(staging): verify inbox callbacks and independent-device auth"`.

## Task T32.3: UI/offline/sync/cache owner qua đường thật

**Files:** Create calendar.spec.ts, offline-sync.spec.ts, owner-isolation.spec.ts; Extend fixtures/manual-scenarios.md.

**Interfaces:**

- Fixture **createCalendarDataset(page: Page, options: {prefix: string}): Promise<CalendarDataset>**; CalendarDataset fields planName/taskTitle/milestoneTitle/recurringTitle: string. Dùng UI sản phẩm, ngày tương đối theo UTC+07:00; seed “Ôn ABC”, “Ngày thi”, notes “Dòng một\nDòng hai tiếng Việt”.
- **capturePendingMetadata(page: Page): Promise<{operationIds: string[]; ciphertextHashes: string[]}>** đọc key/metadata IndexedDB dayforge-local của owner và SHA256 ciphertext read-only; không trả key mã hóa/plaintext draft và không đòi decrypt payload để lấy request_hash. So canonical request bytes/hash khi push xuất hiện qua network observer; không bundle route harness vào image candidate.
- Owner isolation procedure thay lần lượt **hai installation kiểm thử** A/B dưới cùng staging origin với browser profile giữ nguyên, không đổi OWNER_EMAIL trên DB đã bind. A/B có DB, secrets và verified owner khác; chỉ một installation phục vụ origin tại một thời điểm, production không đổi. Runner không tự thực hiện swap hạ tầng trong suite thường; ghi bước stop-A/backup/activate-B thủ công hoặc helper ops được guard staging.

- [ ] **Step 1: Viết failing UI/offline tests.** Thêm assertion có tên rõ: weekRendersSevenDaysAndThreePeriods; planColorPropagatesWithoutLosingDraft; movedRecurringExceptionAndStopKeepHistory; milestoneSessionAndVietnameseNotesConverge; offlineReloadRetainsPending; lostResponseRetryDoesNotDuplicate; sequentialOwnersCannotReadPriorVault.

~~~typescript
expect(await capturePendingMetadata(deviceA)).toEqual(beforeReload);
await deviceA.context().setOffline(false);
await expect(deviceB.getByText(dataset.milestoneTitle, {exact: true})).toBeVisible();
expect(await privateCacheSentinels(deviceB)).toEqual([]);
expect(await dataVisibleToOwnerB()).not.toContain(ownerATaskSentinel);
~~~

privateCacheSentinels/dataVisibleToOwnerB thuộc fixture test, scan Cache Storage/DOM/API của ownerB; không xuất key/ciphertext vào report. Lost-response fault ở network layer hold/drop response sau server commit, không route.fulfill một mock receipt.

- [ ] **Step 2: Run đỏ cho coverage mới.** `pnpm test:web:staging -- --grep "offlineReloadRetainsPending|milestoneSessionAndVietnameseNotesConverge"` sau khi runner hỗ trợ pass-through args. Expected test fail ở behavior chưa tích hợp hoặc prerequisite; mọi lỗi phát hiện phải triage/fix bằng task nhỏ, không đổi expected cho qua.
- [ ] **Step 3: Nối UI dataset và offline thật.** Tạo plan/task/milestone/recurrence qua UI, sửa tiếng Việt nhiều dòng, dời exception qua tuần, detach/stop/Undo theo contract. Offline A tạo/sửa/xóa/complete, reload/cold-start cả hai route sau SW ready, kiểm tra pending; B tạo edit thời điểm khác; reconnect theo thứ tự ngược, cả hai hội tụ LWW, không duplicate hoặc false synced trước ACK/pull. Cố ý lost response với operation ID/hash đã lưu, retry byte-identical.
- [ ] **Step 4: Owner/cache scenario.** Logout A khi draft/pending có cảnh báo và dữ liệu encrypted giữ; archive stackA, activate stackB trống cùng origin bằng config+DB+keys riêng và emailB allowlist đã verify. Giữ browser profile, login B: không thấy data/draft/outbox A, không decrypt ciphertext A; shell cache chỉ public assets. DừngB và đưa installationA nguyên trạng lại origin, loginA: pending/draft còn và sync đúng owner. Assert active-config isolation với production và stack đang phục vụ, không khai báo A/B cùng origin đồng thời. Restore policy không xóa browser data để làm test pass.
- [ ] **Step 5: Desktop interaction.** Chạy calendar spec ở1024×768/1920×1080, keyboard add/edit/move/complete/navigation, reduced motion; ngày đông/cuối tháng/chuyển năm/midnightUTC+07 theo fixtures đã có. Reuse test ý định từ T24–T28 nhưng thay mocked transport bằng actual product auth; không copy toàn suite cũ vào staging rồi để intercept vô tình còn chạy.
- [ ] **Step 6: Run xanh và regression.** Staging suites PASS, `pnpm test:sync:browser`, `pnpm test:web:offline`, `pnpm test:web:offline:update` PASS đúng source candidate. Bug fix làm image digest/SHA đổi thì rebuild/manifest mới và re-run case chịu ảnh hưởng; smoke/build/auth/isolation/offline gate chạy lại toàn bộ cho candidate cuối.
- [ ] **Step 7: Commit.** Stage specs/helpers/evidence; `git commit -m "test(staging): exercise calendar offline sync and owner boundaries"`.

## Task T32.4: Ma trận 38 AC và chốt candidate

**Files:** Create validate_acceptance.py, test_acceptance_results.py, acceptance-results.json/.md; Modify T28 matrix links/task index.

**Interfaces:**

- **validate_acceptance_results(path: Path, release: ReleaseManifest) -> list[str]** trả danh sách issue strings; CLI exit0 khi đủ38ID duy nhất, không FAIL/BLOCKED/TARGET_PENDING ở scope staging bắt buộc, mọi PASS có evidence/release ID/digest; production_pending có trường riêng.
- JSON schema mỗi row: ac_id, status: PASS|FAIL|BLOCKED|TARGET_PENDING, scope: staging, release_id, web_digest, api_digest, scenario, evidence_paths, tested_at, production_recheck: bool, limitations. Enum status giữ bốn giá trị; scope/evidence của AC36 ghi rõ đây là independent-host scenario trên staging.

- [ ] **Step 1: Viết test đỏ matrix.** missing AC-38/duplicate AC-31/PASS không evidence/wrong digest/historical-only evidence phải trả issues; đủ38rows đúng candidate trả[]. AC36 stagingPASS bắt buộc production_recheck=true, AC31/32 cũng true để T36 kiểm tra inbox production.
- [ ] **Step 2: Run đỏ.** `uv run --directory backend --locked python -m unittest discover -s ../scripts/tests -p test_acceptance_results.py -v`; expected FAIL thiếu validator.
- [ ] **Step 3: Implement validator và mapping.** AC01–12 calendar/interaction; AC13–18 recurrence/time; AC19–30 offline/sync/update/error; AC31–34 auth/manual+automation; AC35 owner-isolation; AC36 PC-OFF; AC37–38 milestone session/note. Matrix không suy PASS từ file test tồn tại hoặc T28 count; link evidence lần run đúng digest, code-level exhaustive permutations có thể là CI evidence đúng source cùng smoke staging bổ trợ.
- [ ] **Step 4: Ghi report candidate cuối.** SHA/digests/build ID, host/revision/schema/protocol, OS/browser/viewports, test commands, PC-off/inbox refs, defects/fixes/retests và snapshot ID. Liên kết T28→T32 như kết quả bổ sung; giữ nguyên provenance lịch sử và ghi production pending T35/T36.
- [ ] **Step 5: Run xanh gate.** `python3 scripts/validate_acceptance.py --results docs/tasks/t32/acceptance-results.json --release <release.json>` expected “38 staging criteria verified”, exit0. Nếu manual/inbox/PC-off thiếu thì BLOCKED/TARGET_PENDING và exit1; không hoàn tất T32. Required CI/package workflow đúngSHA xanh, T33 lấy đúng candidate manifest và backup.
- [ ] **Step 6: Commit.** Stage validator/tests/matrix/docs links; `git commit -m "docs(acceptance): record staging evidence for all phase-one criteria"`.

## Cổng hoàn tất T32

- [ ] Candidate immutable chạy real HTTPS/API/MySQL/SMTP, không mock/harness và có bằng chứng hai thiết bị.
- [ ] AC-01–38 đủ evidence staging; inboxverify/reset và PC-off được quan sát thực.
- [ ] Owner isolation đúng installation/profile thực, dirty/pending/offline và sync hội tụ không mất data.
- [ ] Báo cáo nêu rõ production verification còn T35/T36, không đánh dấu production đã deploy.
- [ ] Cùng candidate được đóng băng để T33 diễn tập; sửa code sau đó phải phát hành candidate/evidence mới.
