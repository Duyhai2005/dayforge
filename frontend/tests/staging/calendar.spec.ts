import { expect, test } from "@playwright/test";
import {
  expectVerifiedSession,
  loginOwner,
  nextStagingDate,
  readOwnerCredentials,
  stagingUrl,
} from "./fixtures";

test("weekRendersSevenDaysAndThreePeriods", async ({ page }) => {
  await loginOwner(page, readOwnerCredentials());
  const date = nextStagingDate();
  await page.goto(stagingUrl(`/work?date=${date}&scale=week`));
  await expect(page.getByRole("heading", { name: "Lịch công việc" })).toBeVisible();
  await expect(page.locator(".work-week-day-heading")).toHaveCount(7);
  await expect(page.locator(".work-week-period")).toHaveCount(3);
});

test("planColorPropagatesWithoutLosingDraft", async ({ page }) => {
  await loginOwner(page, readOwnerCredentials());
  const date = nextStagingDate();
  await page.goto(stagingUrl(`/work?date=${date}&scale=week`));
  const bucket = page.locator(`.work-week-bucket[data-work-date="${date}"][data-period="afternoon"]`);
  await bucket.locator(".work-week-add").click();
  const taskDialog = page.getByRole("dialog", { name: "Thêm công việc" });
  await taskDialog.getByLabel("Tên công việc").fill(`T32 nested plan ${crypto.randomUUID()}`);
  await taskDialog.getByRole("button", { name: "Tạo kế hoạch", exact: true }).click();
  const planDialog = page.getByRole("dialog", { name: "Kế hoạch" });
  await planDialog.getByRole("button", { name: "Tạo kế hoạch", exact: true }).click();
  await planDialog.getByLabel("Tên kế hoạch").fill(`T32 green plan ${crypto.randomUUID()}`);
  await planDialog.getByRole("radio", { name: "Xanh lá" }).check();
  await planDialog.getByRole("button", { name: "Lưu kế hoạch", exact: true }).click();

  await expect(taskDialog).toBeVisible();
  await expect(taskDialog.getByLabel("Tên công việc")).toHaveValue(/T32 nested plan/);
  await expect(taskDialog.getByLabel("Ngày", { exact: true })).toHaveValue(date);
  await expect(taskDialog.getByLabel("Buổi")).toHaveValue("afternoon");
  await expect(taskDialog.getByLabel("Kế hoạch")).toHaveValue(/.+/);
  await taskDialog.getByRole("button", { name: "Lưu công việc", exact: true }).click();

  const card = bucket.locator(".work-task-card").filter({ hasText: "T32 nested plan" });
  await expect(card).toBeVisible();
  await expect.poll(() => card.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(43, 65, 56)");
  await page.reload();
  await expect(bucket.locator(".work-task-card").filter({ hasText: "T32 nested plan" })).toBeVisible();
});

test("milestoneSessionAndVietnameseNotesConverge", async ({ browser }) => {
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
    const title = `T32 milestone ${crypto.randomUUID()}`;
    await pageA.goto(stagingUrl(`/work?date=${date}&scale=week`));
    await pageA.getByRole("button", { name: "Mở hoặc đóng điều hướng lịch" }).click();
    await pageA.getByRole("button", { name: "Thêm dấu mốc", exact: true }).click();
    const createDialog = pageA.getByRole("dialog", { name: "Thêm dấu mốc" });
    await createDialog.getByLabel("Tên dấu mốc").fill(title);
    await createDialog.getByLabel("Buổi").selectOption("afternoon");
    await createDialog.getByLabel("Ghi chú liên quan (không bắt buộc)").fill("Dòng một\nDòng hai tiếng Việt");
    await createDialog.getByRole("button", { name: "Thêm dấu mốc", exact: true }).click();

    const cardB = pageB.locator(".work-milestone-card").filter({ hasText: title });
    await pageB.goto(stagingUrl(`/work?date=${date}&scale=week`));
    await expect(cardB).toBeVisible({ timeout: 60_000 });
    await cardB.click();
    const editDialogB = pageB.getByRole("dialog", { name: "Sửa dấu mốc" });
    await expect(editDialogB.getByLabel("Ghi chú liên quan (không bắt buộc)")).toHaveValue("Dòng một\nDòng hai tiếng Việt");
    await editDialogB.getByLabel("Ghi chú liên quan (không bắt buộc)").fill("Dòng một đã sửa\nDòng hai tiếng Việt");
    await editDialogB.getByRole("button", { name: "Lưu thay đổi", exact: true }).click();

    await pageA.reload();
    const cardA = pageA.locator(".work-milestone-card").filter({ hasText: title });
    await expect(cardA).toBeVisible({ timeout: 60_000 });
    await cardA.click();
    const editDialogA = pageA.getByRole("dialog", { name: "Sửa dấu mốc" });
    await expect(editDialogA.getByLabel("Ghi chú liên quan (không bắt buộc)")).toHaveValue("Dòng một đã sửa\nDòng hai tiếng Việt");
  } finally {
    await Promise.all([contextA.close(), contextB.close()]);
  }
});
