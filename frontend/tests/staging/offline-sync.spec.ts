import { expect, test } from "@playwright/test";
import {
  capturePendingMetadata,
  createTaskThroughUi,
  expectVerifiedSession,
  loginOwner,
  nextStagingDate,
  readOwnerCredentials,
  stagingUrl,
} from "./fixtures";

test("offlineReloadRetainsPending", async ({ browser }) => {
  const owner = readOwnerCredentials();
  const contextA = await browser.newContext({ serviceWorkers: "allow" });
  const contextB = await browser.newContext({ serviceWorkers: "allow" });
  try {
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await Promise.all([loginOwner(pageA, owner), loginOwner(pageB, owner)]);
    const [ownerA, ownerB] = await Promise.all([
      expectVerifiedSession(pageA.request),
      expectVerifiedSession(pageB.request),
    ]);
    if (ownerA !== ownerB) throw new Error("staging_owner_mismatch");

    const date = nextStagingDate();
    const title = `T32 offline task ${crypto.randomUUID()}`;
    await pageA.goto(stagingUrl(`/work?date=${date}&scale=week`));
    await pageA.evaluate(async () => { await navigator.serviceWorker.ready; });
    await contextA.setOffline(true);
    await pageA.reload({ waitUntil: "domcontentloaded" });
    await expect(pageA.getByRole("heading", { name: "Lịch công việc" })).toBeVisible();
    const pendingBefore = await capturePendingMetadata(pageA, ownerA);
    await createTaskThroughUi(pageA, date, title);
    const pendingAfterSave = await capturePendingMetadata(pageA, ownerA);
    expect(pendingAfterSave.operationIds.length).toBe(pendingBefore.operationIds.length + 1);
    expect(pendingAfterSave.ciphertextHashes.length).toBe(pendingAfterSave.operationIds.length);

    await pageA.reload({ waitUntil: "domcontentloaded" });
    await expect(pageA.locator(".work-task-card").filter({ hasText: title })).toBeVisible();
    expect(await capturePendingMetadata(pageA, ownerA)).toEqual(pendingAfterSave);

    await contextA.setOffline(false);
    const cardB = pageB.locator(".work-task-card").filter({ hasText: title });
    await pageB.goto(stagingUrl(`/work?date=${date}&scale=week`));
    await expect(cardB).toBeVisible({ timeout: 60_000 });
    await expect(cardB).toHaveCount(1);
  } finally {
    await Promise.all([contextA.close(), contextB.close()]);
  }
});

test("lostResponseRetryDoesNotDuplicate", async ({ browser }) => {
  const owner = readOwnerCredentials();
  const contextA = await browser.newContext({ serviceWorkers: "allow" });
  const contextB = await browser.newContext({ serviceWorkers: "allow" });
  let responseDropped = false;
  let firstPushObserved = false;
  try {
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await Promise.all([loginOwner(pageA, owner), loginOwner(pageB, owner)]);
    const [ownerA, ownerB] = await Promise.all([
      expectVerifiedSession(pageA.request),
      expectVerifiedSession(pageB.request),
    ]);
    if (ownerA !== ownerB) throw new Error("staging_owner_mismatch");

    await contextA.route("**/api/v1/sync/push*", async (route) => {
      if (firstPushObserved) {
        await route.continue();
        return;
      }
      firstPushObserved = true;
      const actualResponse = await route.fetch();
      if (actualResponse.ok()) responseDropped = true;
      await route.abort("failed");
    });

    const date = nextStagingDate();
    const title = `T32 retry task ${crypto.randomUUID()}`;
    await createTaskThroughUi(pageA, date, title);
    const cardB = pageB.locator(".work-task-card").filter({ hasText: title });
    await pageB.goto(stagingUrl(`/work?date=${date}&scale=week`));
    await expect(cardB).toBeVisible({ timeout: 60_000 });
    if (!responseDropped) throw new Error("staging_committed_response_was_not_dropped");
    await expect(cardB).toHaveCount(1);
  } finally {
    await Promise.all([contextA.close(), contextB.close()]);
  }
});
