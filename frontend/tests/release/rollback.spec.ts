import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  beginCaseAttempt,
  createTaskThroughUi,
  currentApprovedBuild,
  invokeReleaseSwitch,
  loginOwner,
  readCurrentReleaseRecord,
  recordCaseEvidence,
  releaseFor,
  releaseUrl,
  switchRelease,
} from "./fixtures";

test.beforeEach(async ({}, testInfo) => {
  const cases: Record<string, { id: "RB-01" | "RB-02"; action: string }> = {
    rollbackKeepsBWrittenDataAndDatabaseRevision: {
      id: "RB-01",
      action: "roll back A after writing data on B without restoring a pre-deploy backup",
    },
    incompatibleRollbackIsRefusedBeforeActivation: {
      id: "RB-02",
      action: "refuse rollback when the runtime revision is outside release A support",
    },
  };
  const current = cases[testInfo.title];
  if (!current) throw new Error("release_test_case_mapping_missing");
  beginCaseAttempt(current.id, current.action);
  await switchRelease("B");
});

test("rollbackKeepsBWrittenDataAndDatabaseRevision", async ({ page, browser }) => {
  await loginOwner(page);
  const releaseB = releaseFor("B");
  expect(await currentApprovedBuild(page)).toBe(releaseB.build_id);
  const before = readCurrentReleaseRecord();
  const taskName = `T33 rollback retained ${randomUUID()}`;
  await createTaskThroughUi(page, taskName);

  await switchRelease("A");
  const after = readCurrentReleaseRecord();
  expect(after.release_id).toBe(releaseFor("A").release_id);
  expect(after.database_revision).toBe(before.database_revision);
  expect(after.database_revision).toBe(releaseB.required_db_revision);

  const freshContext = await browser.newContext({ serviceWorkers: "allow" });
  try {
    const freshPage = await freshContext.newPage();
    await loginOwner(freshPage);
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(Date.now() + 86_400_000));
    await freshPage.goto(releaseUrl(`/work?date=${date}&scale=week`));
    const card = freshPage.locator(".work-task-card").filter({ hasText: taskName });
    await expect(card).toHaveCount(1, { timeout: 60_000 });
  } finally {
    await freshContext.close();
  }
  recordCaseEvidence("RB-01", "roll back A after writing data on B without restoring a pre-deploy backup", "fresh A profile reads the B-written task and the database revision is unchanged");
});

test("incompatibleRollbackIsRefusedBeforeActivation", async ({ page }) => {
  await loginOwner(page);
  const releaseB = releaseFor("B");
  expect(await currentApprovedBuild(page)).toBe(releaseB.build_id);
  const before = readCurrentReleaseRecord();
  const runtimePath = resolve(process.env.DAYFORGE_RELEASE_OUTPUT_ROOT!, `runtime-incompatible-${randomUUID()}.json`);
  writeFileSync(runtimePath, JSON.stringify({
    db_revision: "0005_rehearsal",
    indexeddb_schema_version: 2,
    protocol_version: 1,
    reducer_version: 1,
  }), { mode: 0o600 });

  const exitCode = invokeReleaseSwitch("A", runtimePath);
  expect(exitCode).toBe(2);
  expect(readCurrentReleaseRecord()).toEqual(before);
  expect(await currentApprovedBuild(page)).toBe(releaseB.build_id);
  recordCaseEvidence("RB-02", "refuse rollback when the runtime revision is outside release A support", "admission exits before activation and current release B remains selected");
});
