import { expect, test } from "@playwright/test";

const toggleName = "Mở hoặc đóng điều hướng lịch";
const panelName = "Điều khiển lịch";

test("widgetOpensAndClosesByToggleEscapeAndOutsideClick", async ({ page }) => {
  await page.goto("/work?date=2026-01-31");
  const toggle = page.getByRole("button", { name: toggleName });
  const panel = page.getByRole("region", { name: panelName });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toBeVisible();
  await toggle.click();
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();
  await toggle.press("Enter");
  await page.getByRole("button", { name: "Hôm nay", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();
  await toggle.press("Space");
  await page.getByRole("heading", { name: "Lịch công việc", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(page).toHaveURL(/\/work\?date=2026-01-31$/);
  await toggle.click();
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("widgetTabOrderIncludesExpandedPanel", async ({ page }) => {
  await page.goto("/work?date=2026-01-31");
  const toggle = page.getByRole("button", { name: toggleName });
  const panel = page.getByRole("region", { name: panelName });
  const currentCalendar = panel.getByRole("link", { name: "Lịch công việc", exact: true });
  const otherCalendar = panel.getByRole("link", { name: "Lịch dấu mốc", exact: true });

  // Complete one real state change first so the keyboard assertions run after production hydration.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(currentCalendar).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(otherCalendar).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(currentCalendar).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(toggle).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();

  await toggle.press("Enter");
  await page.getByRole("heading", { name: "Lịch công việc", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();
});

test("calendarSwitchClosesAndFocusesMain", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("dayforge:view:v1:milestones", JSON.stringify({ anchor: "2026-02-28", scale: "year", scrollY: 0 }));
  });
  await page.goto("/work?date=2026-01-31");
  await page.getByRole("button", { name: toggleName }).click();
  await expect(page.getByLabel("Quy mô")).toHaveCount(0);
  await page.getByRole("link", { name: "Lịch dấu mốc", exact: true }).click();
  await expect(page).toHaveURL(/\/milestones\?date=2026-02-28&scale=year$/);
  await expect(page.getByRole("region", { name: panelName })).toBeHidden();
  await expect(page.locator("main#calendar-main")).toBeFocused();
  await page.getByRole("button", { name: toggleName }).click();
  await expect(page.getByLabel("Ngày đang xem")).toHaveValue("2026-02-28");
  await expect(page.getByLabel("Quy mô")).toHaveValue("year");
  await page.getByRole("link", { name: "Lịch công việc", exact: true }).click();
  await expect(page).toHaveURL(/\/work\?date=2026-01-31$/);
  await expect(page.locator("main#calendar-main")).toBeFocused();
});

test("viewControlsKeepWidgetOpen", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-29T17:30:00.000Z"));
  await page.goto("/milestones?date=2026-01-31&scale=month");
  await page.getByRole("button", { name: toggleName }).click();
  const panel = page.getByRole("region", { name: panelName });
  await page.getByRole("button", { name: "Tiến", exact: true }).click();
  await expect(page).toHaveURL(/\/milestones\?date=2026-02-28&scale=month$/);
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "Lùi", exact: true }).click();
  await expect(page).toHaveURL(/\/milestones\?date=2026-01-28&scale=month$/);
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "Hôm nay", exact: true }).click();
  await expect(page).toHaveURL(/\/milestones\?date=2026-10-30&scale=month$/);
  await expect(panel).toBeVisible();
  await page.getByLabel("Ngày đang xem").fill("2026-02-28");
  await expect(page).toHaveURL(/\/milestones\?date=2026-02-28&scale=month$/);
  await expect(panel).toBeVisible();
  await page.getByLabel("Quy mô").selectOption("year");
  await expect(page).toHaveURL(/\/milestones\?date=2026-02-28&scale=year$/);
  await expect(panel).toBeVisible();
  await expect(page.getByRole("link", { name: "Tài khoản", exact: true })).toHaveAttribute("href", "/account");
  await expect(page.getByLabel("Khoảng đang xem").first()).toHaveText("Năm 2026");
});

test("viewControlsEnforceT03DomainBounds", async ({ page }) => {
  for (const route of ["/work", "/milestones?scale=week", "/milestones?scale=month", "/milestones?scale=year"]) {
    const separator = route.includes("?") ? "&" : "?";
    for (const anchor of ["0001-01-01", "9999-12-31"]) {
      await page.goto(`${route}${separator}date=${anchor}`);
      await page.getByRole("button", { name: toggleName }).click();
      const date = page.getByLabel("Ngày đang xem");
      await expect(date).toHaveValue(anchor);
      await expect(date).toHaveAttribute("min", "0001-01-01");
      await expect(date).toHaveAttribute("max", "9999-12-31");
      const previous = page.getByRole("button", { name: "Lùi", exact: true });
      const next = page.getByRole("button", { name: "Tiến", exact: true });
      if (anchor === "0001-01-01") {
        await expect(previous).toBeDisabled();
        await expect(next).toBeEnabled();
      } else {
        await expect(previous).toBeEnabled();
        await expect(next).toBeDisabled();
      }
    }
  }
});

test("calendarMutationsRequireAnUnlockedLocalVault", async ({ page }) => {
  await page.goto("/work?date=2026-01-31");
  await expect(page.getByRole("button", { name: "Thêm nhanh", exact: true })).toBeDisabled();
  await expect(page.locator(".widget-summary [role='status']")).toHaveText("Chưa kết nối dữ liệu");
  await page.getByRole("button", { name: toggleName }).click();
  for (const name of ["Thêm công việc", "Thêm dấu mốc", "Quản lý kế hoạch"]) {
    const action = page.getByRole("button", { name, exact: true });
    await expect(action).toBeDisabled();
    await expect(action).toHaveAccessibleDescription("Mở khóa kho local để thêm công việc, dấu mốc hoặc quản lý kế hoạch.");
  }
  await expect(page.getByText("Mở khóa kho local để thêm công việc, dấu mốc hoặc quản lý kế hoạch.")).toBeVisible();
  await expect(page.locator(".work-week-bucket .work-week-add")).toHaveCount(21);
  await expect(page.locator(".work-week-all-day-bucket .work-week-add")).toHaveCount(7);
  await expect(page.locator(".work-week-add:not(:disabled)")).toHaveCount(0);
});

test("workWeekShowsSevenDaysAndThreeAlignedPeriodsAcrossNewYear", async ({ page }) => {
  await page.goto("/work?date=2026-01-01");
  const headers = page.locator(".work-week-day-heading");
  await expect(headers).toHaveCount(7);
  await expect(headers.first()).toContainText("29 tháng 12, 2025");
  await expect(headers.last()).toContainText("4 tháng 1, 2026");
  const periods = page.locator(".work-week-period");
  await expect(periods).toHaveCount(3);
  await expect(page.locator(".work-week-buckets")).toHaveCount(3);
  for (const row of await page.locator(".work-week-buckets").all()) {
    await expect(row.locator(".work-week-bucket")).toHaveCount(7);
  }
  await expect(page.locator(".work-week-bucket .work-week-add")).toHaveCount(21);
  await expect(page.locator(".work-week-all-day-bucket .work-week-add")).toHaveCount(7);
});

test("widgetHonorsReducedMotion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/milestones?date=2026-01-31&scale=month");
  await page.getByRole("button", { name: toggleName }).click();
  const panel = page.getByRole("region", { name: panelName });
  await expect(panel).toBeVisible();
  const motion = await panel.evaluate(element => {
    const style = getComputedStyle(element);
    const animations = element.getAnimations().map(animation => ({
      duration: Number(animation.effect?.getTiming().duration ?? 0),
      frames: (animation.effect as KeyframeEffect).getKeyframes().map(frame => frame.transform),
    }));
    return { transform: style.transform, translate: style.translate, scale: style.scale, transitions: style.transitionDuration.split(",").map(value => parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000)), animations };
  });
  expect(["none", "matrix(1,0,0,1,0,0)"]).toContain(motion.transform.replace(/\s+/g, ""));
  expect(motion.translate).toBe("none");
  expect(motion.scale).toBe("none");
  expect(motion.transitions.every(duration => duration <= 80)).toBe(true);
  expect(motion.animations.every(animation => animation.duration <= 80 && animation.frames.every(transform => transform === undefined || transform === "none"))).toBe(true);
});

test("relatedDayHighlightExpiresAndDoesNotReplayAfterReload", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("dayforge:related-work-day:v1", "2026-11-03");
  });
  await page.goto("/work?date=2026-11-03");
  const heading = page.locator('.work-week-day-heading[data-related-day="true"]');
  await expect(heading).toContainText("3 tháng 11, 2026");
  await expect(heading).toHaveCSS("animation-name", "related-day-arrival");
  await expect(heading).toHaveCount(0, { timeout: 1_000 });
  await page.reload();
  await expect(page.locator('.work-week-day-heading[data-related-day="true"]')).toHaveCount(0);
});
