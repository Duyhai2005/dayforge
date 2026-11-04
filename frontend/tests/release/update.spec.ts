import { expect, test } from "@playwright/test";
import {
  announceBuildUpdate,
  beginCaseAttempt,
  capturePendingMetadata,
  currentApprovedBuild,
  holdNextPushResponse,
  loginOwner,
  recordCaseEvidence,
  readGatePhase,
  releaseFor,
  releaseUrl,
  switchRelease,
  waitForApprovedBuild,
} from "./fixtures";

test.beforeEach(async ({}, testInfo) => {
  const cases: Record<string, { id: "UP-01" | "UP-02" | "UP-03" | "UP-04" | "UP-05" | "UP-06"; action: string; variant?: string }> = {
    dirtyDraftDefersBuildSwitch: { id: "UP-01", action: "defer while a form contains unsaved edits" },
    pendingCiphertextSurvivesBuildSwitch: { id: "UP-02", action: "preserve pending encrypted rows through the approved A to B switch" },
    lostPushAckRetriesOriginalEnvelope: { id: "UP-03", action: "retry the byte-identical envelope after losing the committed ACK" },
    suspendedTabDoesNotConsentToUpdate: { id: "UP-04", action: "treat a frozen tab as non-consenting" },
    incompleteAssetsKeepApprovedBuild: { id: "UP-05", action: "keep build A approved when the candidate worker cannot fetch its required assets" },
    lateFlightDoesNotMixBuilds: { id: "UP-06", action: "keep release-bound Flight responses and prior static assets usable across A to B", variant: "late-flight" },
    previousStaticAssetsRemainReachable: { id: "UP-06", action: "keep release-bound Flight responses and prior static assets usable across A to B", variant: "previous-static" },
  };
  const current = cases[testInfo.title];
  if (!current) throw new Error("release_test_case_mapping_missing");
  beginCaseAttempt(current.id, current.action, current.variant ? { caseVariant: current.variant } : {});
  await switchRelease("A");
});

test("dirtyDraftDefersBuildSwitch", async ({ page }) => {
  await loginOwner(page);
  const releaseA = releaseFor("A");
  await page.goto(releaseUrl("/work"));
  expect(await currentApprovedBuild(page)).toBe(releaseA.build_id);
  await page.getByRole("button", { name: "Thêm công việc", exact: true }).first().click();
  const editor = page.getByRole("dialog", { name: "Thêm công việc" });
  await editor.getByLabel("Tên công việc").fill(`T33 draft ${crypto.randomUUID()}`);

  await switchRelease("B");
  await announceBuildUpdate(page, "B");
  const banner = page.locator(".offline-update-banner");
  await expect(banner).toBeVisible({ timeout: 90_000 });
  await banner.getByRole("button", { name: "Cập nhật" }).click();
  await expect(page.getByText(/unsaved input|did not respond|hoãn/i)).toBeVisible({ timeout: 30_000 });
  expect(await readGatePhase(page)).toBe("running");
  expect(await currentApprovedBuild(page)).toBe(releaseA.build_id);
  recordCaseEvidence("UP-01", "defer while a form contains unsaved edits", "build A remains approved and the update gate returns to running");
});

test("pendingCiphertextSurvivesBuildSwitch", async ({ page, context }) => {
  const ownerId = await loginOwner(page);
  await page.goto(releaseUrl("/work"));
  await context.setOffline(true);
  const before = await capturePendingMetadata(page, ownerId);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Date.now() + 86_400_000));
  const title = `T33 offline ${crypto.randomUUID()}`;
  const bucket = page.locator(`.work-week-bucket[data-work-date="${date}"][data-period="afternoon"]`);
  await expect(bucket).toBeVisible();
  await bucket.locator(".work-week-add").click();
  const editor = page.getByRole("dialog", { name: "Thêm công việc" });
  await editor.getByLabel("Tên công việc").fill(title);
  await editor.getByLabel("Buổi").selectOption("afternoon");
  await editor.getByRole("button", { name: "Lưu công việc", exact: true }).click();
  await expect(editor).toBeHidden();
  const pending = await capturePendingMetadata(page, ownerId);
  expect(pending.operationIds.length).toBe(before.operationIds.length + 1);

  await switchRelease("B");
  await context.route("**/api/v1/sync/push**", (route) => route.abort("failed"));
  await context.setOffline(false);
  await announceBuildUpdate(page, "B");
  const banner = page.locator(".offline-update-banner");
  await expect(banner).toBeVisible({ timeout: 90_000 });
  await context.setOffline(true);
  await banner.getByRole("button", { name: "Cập nhật" }).click();
  const releaseB = releaseFor("B");
  await waitForApprovedBuild(page, releaseB.build_id);
  expect(await capturePendingMetadata(page, ownerId)).toEqual(pending);
  recordCaseEvidence("UP-02", "preserve pending encrypted rows through the approved A to B switch", "operation IDs and ciphertext hashes are unchanged after build B is approved");
});

test("lostPushAckRetriesOriginalEnvelope", async ({ page, browser }) => {
  await loginOwner(page);
  const secondContext = await browser.newContext({ serviceWorkers: "allow" });
  const secondPage = await secondContext.newPage();
  try {
    await loginOwner(secondPage);
    const held = await holdNextPushResponse(page.context());
    await page.goto(releaseUrl("/work"));
    const title = `T33 lost response ${crypto.randomUUID()}`;
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(Date.now() + 86_400_000));
    const bucket = page.locator(`.work-week-bucket[data-work-date="${date}"][data-period="afternoon"]`);
    await expect(bucket).toBeVisible();
    await bucket.locator(".work-week-add").click();
    const editor = page.getByRole("dialog", { name: "Thêm công việc" });
    await editor.getByLabel("Tên công việc").fill(title);
    await editor.getByLabel("Buổi").selectOption("afternoon");
    await editor.getByRole("button", { name: "Lưu công việc", exact: true }).click();
    const originalBytes = await held.requestBytes;
    await held.committed;
    held.release();
    const retryBytes = await held.retryBytes;
    expect(retryBytes).toEqual(originalBytes);

    await secondPage.goto(releaseUrl(`/work?date=${date}&scale=week`));
    const task = secondPage.locator(".work-task-card").filter({ hasText: title });
    await expect(task).toHaveCount(1, { timeout: 60_000 });
    recordCaseEvidence("UP-03", "retry the byte-identical envelope after losing the committed ACK", "second device observes exactly one task effect");
  } finally {
    await secondContext.close();
  }
});

test("suspendedTabDoesNotConsentToUpdate", async ({ page, context }) => {
  await loginOwner(page);
  const otherTab = await context.newPage();
  await otherTab.goto(releaseUrl("/work"));
  await otherTab.locator("main").waitFor({ state: "visible" });
  const cdp = await context.newCDPSession(otherTab);
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });

  await switchRelease("B");
  await announceBuildUpdate(page, "B");
  const banner = page.locator(".offline-update-banner");
  await expect(banner).toBeVisible({ timeout: 90_000 });
  await banner.getByRole("button", { name: "Cập nhật" }).click();
  await expect(page.getByText(/did not respond|hoãn/i)).toBeVisible({ timeout: 30_000 });
  expect(await currentApprovedBuild(page)).toBe(releaseFor("A").build_id);
  recordCaseEvidence("UP-04", "treat a frozen tab as non-consenting", "update preparation is deferred and build A remains approved");
  await cdp.send("Page.setWebLifecycleState", { state: "active" }).catch(() => undefined);
  await cdp.detach();
});

test("incompleteAssetsKeepApprovedBuild", async ({ page, context }) => {
  await loginOwner(page);
  await page.goto(releaseUrl("/work"));
  const releaseA = releaseFor("A");
  expect(await currentApprovedBuild(page)).toBe(releaseA.build_id);
  await context.setOffline(true);
  await switchRelease("B");
  await expect(announceBuildUpdate(page, "B")).rejects.toThrow();
  expect(await currentApprovedBuild(page)).toBe(releaseA.build_id);
  expect(await readGatePhase(page)).toBe("running");
  recordCaseEvidence("UP-05", "keep build A approved when the candidate worker cannot fetch its required assets", "offline installation failure leaves the approved gate on build A");
  await context.setOffline(false);
});

test("lateFlightDoesNotMixBuilds", async ({ page }) => {
  await loginOwner(page);
  await page.goto(releaseUrl("/work"));
  const releaseA = releaseFor("A");
  let resolveResponse!: (value: { buildMarker: string | undefined }) => void;
  let releaseHeld!: () => void;
  const responseReady = new Promise<{ buildMarker: string | undefined }>((resolve) => { resolveResponse = resolve; });
  const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
  let intercepted = false;
  await page.route("**/milestones**", async (route) => {
    if (intercepted || !route.request().url().includes("_rsc=")) return route.continue();
    intercepted = true;
    const response = await route.fetch();
    resolveResponse({ buildMarker: response.headers()["x-dayforge-build"] });
    await held;
    await route.fulfill({ response });
  });
  const navigation = page.locator('a[href="/milestones"]').click();
  const response = await responseReady;
  await switchRelease("B");
  releaseHeld();
  await navigation;
  expect(response.buildMarker).toBe(releaseA.build_id);
  expect(await currentApprovedBuild(page)).toBe(releaseA.build_id);
  await expect(page.locator("main")).toBeVisible();
  recordCaseEvidence("UP-06", "keep release-bound Flight responses and prior static assets usable across A to B", "the delayed response carries build A marker while gate A is still approved", { caseVariant: "late-flight" });
});

test("previousStaticAssetsRemainReachable", async ({ page }) => {
  await loginOwner(page);
  const releaseA = releaseFor("A");
  const oldAssets: string[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/_next/static/") && response.ok()) oldAssets.push(url.pathname);
  });
  await page.goto(releaseUrl("/work"));
  await expect(page.locator("main")).toBeVisible();
  const initialAssets = [...new Set(oldAssets)];
  expect(initialAssets.length).toBeGreaterThan(0);

  await switchRelease("B");
  const releaseB = releaseFor("B");
  await page.goto(releaseUrl("/work"));
  const checked = await Promise.all(initialAssets.map(async (asset) => {
    const response = await page.request.get(releaseUrl(asset), { failOnStatusCode: false });
    return { status: response.status(), marker: response.headers()["x-dayforge-build"] };
  }));
  expect(checked.some((item) => item.status === 200 && item.marker === releaseA.build_id)).toBe(true);
  expect(await currentApprovedBuild(page)).toBe(releaseA.build_id);
  recordCaseEvidence("UP-06", "keep release-bound Flight responses and prior static assets usable across A to B", `old asset served with build A marker while B web is current (${releaseB.build_id})`, { caseVariant: "previous-static" });
});
