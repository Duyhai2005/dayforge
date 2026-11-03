import { expect, test } from "@playwright/test";
import { milestoneMonthAnchor, milestoneMonthDates } from "../lib/calendar/milestone-calendar";

test("milestoneMonthGridStartsOnMondayAndRespectsCalendarYearBounds", async () => {
  const november = milestoneMonthDates(2026, 10, true);
  expect(november).toHaveLength(42);
  expect(november[0]).toBe("2026-10-26");
  expect(november[6]).toBe("2026-11-01");
  expect(milestoneMonthAnchor(2024, 1, 29)).toBe("2024-02-29");
  expect(milestoneMonthAnchor(2026, 1, 29)).toBeNull();
  expect(milestoneMonthDates(1, 0, true)[0]).toBe("0001-01-01");
  expect(milestoneMonthDates(9999, 11, true).some((date) => date === null)).toBe(true);
});

test("milestoneCalendarSupportsWeekMonthYearAndReturnsToItsSavedContext", async ({ page }) => {
  await page.goto("/milestones?date=2026-11-03&scale=week");
  await expect(page.locator(".milestone-week-day")).toHaveCount(7);

  await page.getByRole("button", { name: "Mở hoặc đóng điều hướng lịch" }).click();
  const scale = page.getByLabel("Quy mô");
  await scale.selectOption("month");
  await expect(page).toHaveURL(/\/milestones\?date=2026-11-03&scale=month$/);
  await expect(page.locator(".milestone-month-day")).toHaveCount(42);

  await page.getByLabel("Quy mô").selectOption("year");
  await expect(page).toHaveURL(/\/milestones\?date=2026-11-03&scale=year$/);
  const months = page.locator(".milestone-year-month");
  await expect(months).toHaveCount(12);
  await months.nth(10).getByRole("button").first().click();
  await expect(page).toHaveURL(/\/milestones\?date=2026-11-01&scale=month$/);

  const selectedDate = page.locator('.milestone-month-day[data-milestone-date="2026-11-03"]');
  await selectedDate.getByRole("button").click();
  await expect(page.locator(".milestone-day-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Mở tuần công việc", exact: true }).click();
  await expect(page).toHaveURL(/\/work\?date=2026-11-03$/);

  await page.getByRole("button", { name: "Mở hoặc đóng điều hướng lịch" }).click();
  await page.getByRole("link", { name: "Lịch dấu mốc", exact: true }).click();
  await expect(page).toHaveURL(/\/milestones\?date=2026-11-01&scale=month$/);
  await expect(page.locator(".milestone-month-day")).toHaveCount(42);
});

test("milestoneDayDialogUsesThePanelMotionToken", async ({ page }) => {
  await page.goto("/milestones?date=2026-11-03&scale=month");
  await page.locator(".milestone-month-date").nth(8).click();
  const dialog = page.locator(".milestone-day-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("animation-name", "panel-arrival");
  const duration = await dialog.evaluate((element) => getComputedStyle(element).animationDuration);
  expect(Number.parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000)).toBe(180);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(dialog).toHaveCSS("animation-name", "none");
});
