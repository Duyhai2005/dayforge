import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  beginCaseAttempt,
  capturePendingMetadata,
  currentApprovedBuild,
  createTaskThroughUi,
  holdNextPushResponse,
  launchReleaseProfile,
  loginOwner,
  originBindingSha256,
  profileBindingSha256,
  readOwnerRecoveryState,
  readRestoreSession,
  readServerOperationIds,
  recordCaseEvidence,
  releaseFor,
  releaseUrl,
  writeRestoreSession,
} from "./fixtures";

const phase = process.env.DAYFORGE_RELEASE_RESTORE_PHASE;
const snapshotId = process.env.DAYFORGE_RELEASE_SNAPSHOT_ID ?? "";

function sorted(values: string[]): string[] {
  return [...values].sort();
}

function onlyNew(before: string[], after: string[]): string {
  const added = after.filter((item) => !before.includes(item));
  expect(added).toHaveLength(1);
  return added[0];
}

async function waitForServerIds(page: Page, expected: string[]): Promise<void> {
  await expect.poll(() => readServerOperationIds(page), { timeout: 90_000, intervals: [250, 500, 1_000, 2_000] })
    .toEqual(sorted(expected));
}

async function openUnsavedDraft(page: Page, title: string): Promise<void> {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + 86_400_000));
  await page.goto(releaseUrl(`/work?date=${date}&scale=week`));
  const bucket = page.locator(`.work-week-bucket[data-work-date="${date}"][data-period="afternoon"]`);
  await expect(bucket).toBeVisible();
  await bucket.locator(".work-week-add").click();
  const dialog = page.getByRole("dialog", { name: "Thêm công việc" });
  await dialog.getByLabel("Tên công việc").fill(title);
  await expect(dialog).toBeVisible();
}

async function closeProfiles(contexts: BrowserContext[]): Promise<void> {
  await Promise.all(contexts.map((context) => context.close()));
}

test("seedSnapshotBaselineWithTwoPersistentDevices", async () => {
  test.skip(phase !== "seed", "The guarded runner selects the restore seed or recover phase.");
  expect(snapshotId).toMatch(/^[a-f0-9]{64}$/);
  const releaseB = releaseFor("B");
  const contextA = await launchReleaseProfile("A");
  const contextB = await launchReleaseProfile("B");
  const contexts = [contextA, contextB];
  try {
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const ownerA = await loginOwner(pageA);
    const ownerB = await loginOwner(pageB);
    expect(ownerB).toBe(ownerA);
    expect(await currentApprovedBuild(pageA)).toBe(releaseB.build_id);
    expect(await currentApprovedBuild(pageB)).toBe(releaseB.build_id);

    const baselineIds = await readServerOperationIds(pageA);
    expect(baselineIds.length).toBeGreaterThan(0);
    await pageA.goto(releaseUrl("/work"));
    await pageB.goto(releaseUrl("/work"));
    await expect(pageA.locator("main")).toBeVisible();
    await expect(pageB.locator("main")).toBeVisible();

    const titleE1 = `T33 E1 A ${crypto.randomUUID()}`;
    await createTaskThroughUi(pageA, titleE1);
    await expect.poll(() => readServerOperationIds(pageA), { timeout: 90_000 }).toHaveLength(baselineIds.length + 1);
    const afterE1 = await readServerOperationIds(pageA);
    const e1 = onlyNew(baselineIds, afterE1);
    await expect.poll(async () => (await capturePendingMetadata(pageA, ownerA)).shadowOperationIds.includes(e1), { timeout: 90_000 }).toBe(true);

    const titleE2 = `T33 E2 B ${crypto.randomUUID()}`;
    await createTaskThroughUi(pageB, titleE2);
    await expect.poll(() => readServerOperationIds(pageB), { timeout: 90_000 }).toHaveLength(baselineIds.length + 2);
    const afterE2 = await readServerOperationIds(pageB);
    const e2 = onlyNew(afterE1, afterE2);
    await expect.poll(async () => (await capturePendingMetadata(pageB, ownerB)).shadowOperationIds.includes(e2), { timeout: 90_000 }).toBe(true);

    const beforeP0 = await capturePendingMetadata(pageA, ownerA);
    expect(beforeP0.operationIds).toHaveLength(0);
    await contextA.setOffline(true);
    const titleP0 = `T33 P0 pending A ${crypto.randomUUID()}`;
    await createTaskThroughUi(pageA, titleP0);
    const afterP0 = await capturePendingMetadata(pageA, ownerA);
    expect(afterP0.operationIds).toHaveLength(1);
    const p0 = onlyNew(beforeP0.operationIds, afterP0.operationIds);
    expect(afterP0.ciphertextHashes).toHaveLength(1);
    expect(await readServerOperationIds(pageA)).toEqual(sorted(afterE2));

    const beforeDraft = await capturePendingMetadata(pageA, ownerA);
    const titleDraft = `T33 nháp chưa lưu ${crypto.randomUUID()}`;
    await openUnsavedDraft(pageA, titleDraft);
    await expect.poll(async () => (await capturePendingMetadata(pageA, ownerA)).draftIds, { timeout: 30_000 })
      .toHaveLength(beforeDraft.draftIds.length + 1);
    const afterDraft = await capturePendingMetadata(pageA, ownerA);
    const draftId = onlyNew(beforeDraft.draftIds, afterDraft.draftIds);
    const draftIndex = afterDraft.draftIds.indexOf(draftId);
    const draftCiphertextSha256 = afterDraft.draftCiphertextHashes[draftIndex];
    expect(draftCiphertextSha256).toMatch(/^[a-f0-9]{64}$/);

    const [recoveryA, recoveryB] = await Promise.all([
      readOwnerRecoveryState(pageA, ownerA),
      readOwnerRecoveryState(pageB, ownerB),
    ]);
    expect(recoveryA.serverEpoch).toBeTruthy();
    expect(recoveryB.serverEpoch).toBe(recoveryA.serverEpoch);
    const session = readRestoreSession();
    expect(session.status).toBe("seed_target_ready");
    expect(session.snapshot_id).toBe(snapshotId);
    writeRestoreSession({
      status: "seeded",
      baseline_operation_ids: sorted(baselineIds),
      acknowledged_operation_ids: [e1, e2],
      pending_operation_id: p0,
      draft_id: draftId,
      draft_ciphertext_sha256: draftCiphertextSha256,
      title_e1: titleE1,
      title_e2: titleE2,
      title_p0: titleP0,
      title_draft: titleDraft,
      owner_id: ownerA,
      epoch_a: recoveryA.serverEpoch,
      epoch_b: recoveryB.serverEpoch,
      origin_sha256: originBindingSha256(),
      profile_a_sha256: profileBindingSha256("A"),
      profile_b_sha256: profileBindingSha256("B"),
    });
  } finally {
    await closeProfiles(contexts);
  }
});

test("restoredSnapshotReuploadsAckShadowAndPendingUnion", async () => {
  test.skip(phase !== "recover", "The guarded runner selects the restore seed or recover phase.");
  expect(snapshotId).toMatch(/^[a-f0-9]{64}$/);
  beginCaseAttempt("DR-01", "restore snapshot S, reupload E1/E2 ACK shadows and P0, retain the unsaved encrypted draft", {
    caseVariant: "restore-union",
    snapshotId,
    originBindingSha256: originBindingSha256(),
    profileABindingSha256: profileBindingSha256("A"),
    profileBBindingSha256: profileBindingSha256("B"),
  });
  const session = readRestoreSession();
  expect(session.status).toBe("seeded");
  expect(session.snapshot_id).toBe(snapshotId);
  expect(session.origin_sha256).toBe(originBindingSha256());
  expect(session.profile_a_sha256).toBe(profileBindingSha256("A"));
  expect(session.profile_b_sha256).toBe(profileBindingSha256("B"));
  const baselineIds = session.baseline_operation_ids as string[];
  const acknowledgedIds = session.acknowledged_operation_ids as string[];
  const pendingId = String(session.pending_operation_id);
  const expectedIds = sorted([...baselineIds, ...acknowledgedIds, pendingId]);
  const contextA = await launchReleaseProfile("A");
  const contextB = await launchReleaseProfile("B");
  const contexts = [contextA, contextB];
  try {
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const ownerA = await loginOwner(pageA);
    const ownerB = await loginOwner(pageB);
    expect(ownerA).toBe(session.owner_id);
    expect(ownerB).toBe(ownerA);
    const releaseB = releaseFor("B");
    expect(await currentApprovedBuild(pageA)).toBe(releaseB.build_id);
    expect(await currentApprovedBuild(pageB)).toBe(releaseB.build_id);

    await contextA.setOffline(true);
    await contextB.setOffline(true);
    expect(await readServerOperationIds(pageA)).toEqual(sorted(baselineIds));

    const pendingA = await capturePendingMetadata(pageA, ownerA);
    const pendingB = await capturePendingMetadata(pageB, ownerB);
    expect(pendingA.operationIds).toContain(pendingId);
    expect(pendingA.shadowOperationIds).toContain(acknowledgedIds[0]);
    expect(pendingB.shadowOperationIds).toContain(acknowledgedIds[1]);
    const draftIndex = pendingA.draftIds.indexOf(String(session.draft_id));
    expect(draftIndex).toBeGreaterThanOrEqual(0);
    expect(pendingA.draftCiphertextHashes[draftIndex]).toBe(session.draft_ciphertext_sha256);
    const epochABefore = (await readOwnerRecoveryState(pageA, ownerA)).serverEpoch;
    const epochBBefore = (await readOwnerRecoveryState(pageB, ownerB)).serverEpoch;
    expect(epochABefore).toBe(session.epoch_a);
    expect(epochBBefore).toBe(session.epoch_b);

    await pageA.goto(releaseUrl("/work"));
    await pageB.goto(releaseUrl("/work"));
    await expect(pageA.locator("main")).toBeVisible();
    await expect(pageB.locator("main")).toBeVisible();
    const held = await holdNextPushResponse(contextA);
    await contextA.setOffline(false);
    await pageA.reload();
    const originalBytes = await held.requestBytes;
    await held.committed;
    held.release();
    const retriedBytes = await held.retryBytes;
    expect(retriedBytes).toEqual(originalBytes);
    await waitForServerIds(pageA, sorted([...baselineIds, acknowledgedIds[0], pendingId]));

    await contextB.setOffline(false);
    await pageB.reload();
    await waitForServerIds(pageB, expectedIds);
    const titleE1 = String(session.title_e1);
    const titleE2 = String(session.title_e2);
    const titleP0 = String(session.title_p0);
    for (const page of [pageA, pageB]) {
      await expect(page.locator(".work-task-card").filter({ hasText: titleE1 })).toHaveCount(1, { timeout: 60_000 });
      await expect(page.locator(".work-task-card").filter({ hasText: titleE2 })).toHaveCount(1, { timeout: 60_000 });
      await expect(page.locator(".work-task-card").filter({ hasText: titleP0 })).toHaveCount(1, { timeout: 60_000 });
    }
    expect(await readServerOperationIds(pageA)).toEqual(expectedIds);

    const [finalA, finalB] = await Promise.all([
      capturePendingMetadata(pageA, ownerA),
      capturePendingMetadata(pageB, ownerB),
    ]);
    expect(finalA.operationIds).toHaveLength(0);
    expect(finalA.draftIds).toEqual([session.draft_id]);
    expect(finalA.draftCiphertextHashes).toEqual([session.draft_ciphertext_sha256]);
    const [recoveryA, recoveryB] = await Promise.all([
      readOwnerRecoveryState(pageA, ownerA),
      readOwnerRecoveryState(pageB, ownerB),
    ]);
    expect(recoveryA.serverEpoch).toBeTruthy();
    expect(recoveryA.serverEpoch).not.toBe(epochABefore);
    expect(recoveryB.serverEpoch).toBe(recoveryA.serverEpoch);
    expect(recoveryB.serverEpoch).not.toBe(epochBBefore);
    expect(recoveryA.journalCount).toBe(0);
    expect(recoveryB.journalCount).toBe(0);
    expect(finalB.operationIds).toHaveLength(0);

    recordCaseEvidence(
      "DR-01",
      "restore snapshot S, reupload E1/E2 ACK shadows and P0, retain the unsaved encrypted draft",
      "the clean restored DB began at E0; both same-origin persistent profiles converged to E0+E1+E2+P0 with one lost ACK retry, a new epoch, an empty recovery journal, and the original encrypted draft",
      {
        caseVariant: "restore-union",
        snapshotId,
        originBindingSha256: originBindingSha256(),
        profileABindingSha256: profileBindingSha256("A"),
        profileBBindingSha256: profileBindingSha256("B"),
      },
    );
    writeRestoreSession({
      status: "recovered",
      recovered_operation_ids: expectedIds,
      recovered_epoch: recoveryA.serverEpoch,
    });
  } finally {
    await closeProfiles(contexts);
  }
});
