import { expect, test, type Locator, type Page } from "@playwright/test";
import { contrastRatio } from "./helpers/accessibility";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const CSRF_TOKEN = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const LOCAL_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

type SessionView = {
  authenticated: boolean;
  owner: { id: string; email: string; email_verified_at: string } | null;
  session: { id: string; remember_me: boolean; idle_expires_at: string; absolute_expires_at: string; password_authenticated_at: string | null } | null;
  csrf_token: string;
  server_time: string;
  logout_ticket: string | null;
};

async function unlockLocalOwner(page: Page): Promise<void> {
  let authenticated = false;
  const sessionView = (): SessionView => ({
    authenticated,
    owner: authenticated ? { id: OWNER_ID, email: "owner@example.test", email_verified_at: "2026-11-01T00:00:00.000Z" } : null,
    session: authenticated ? {
      id: SESSION_ID,
      remember_me: true,
      idle_expires_at: "2026-11-08T00:00:00.000Z",
      absolute_expires_at: "2026-12-01T00:00:00.000Z",
      password_authenticated_at: "2026-11-01T00:00:00.000Z",
    } : null,
    csrf_token: CSRF_TOKEN,
    server_time: "2026-11-01T00:00:00.000Z",
    logout_ticket: authenticated ? "A".repeat(64) : null,
  });

  await page.route("**/api/v1/sync/**", (route) => route.abort());
  await page.route("**/api/v1/version", (route) => route.abort());
  await page.route("**/api/v1/auth/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = { "cache-control": "no-store", "content-type": "application/json" };
    if (path === "/api/v1/auth/session" && request.method() === "GET") {
      await route.fulfill({ status: 200, headers, body: JSON.stringify(sessionView()) });
      return;
    }
    if (path === "/api/v1/auth/login" && request.method() === "POST") {
      authenticated = true;
      await route.fulfill({ status: 200, headers, body: JSON.stringify(sessionView()) });
      return;
    }
    if (path === "/api/v1/auth/local-key" && request.method() === "GET") {
      await route.fulfill({ status: 200, headers, body: JSON.stringify({
        owner_id: OWNER_ID,
        key_id: KEY_ID,
        algorithm: "A256GCM",
        key_base64url: LOCAL_KEY,
      }) });
      return;
    }
    if (path === "/api/v1/auth/logout" && request.method() === "POST") {
      authenticated = false;
      await route.fulfill({ status: 204, headers, body: "" });
      return;
    }
    await route.fulfill({ status: 404, headers, body: JSON.stringify({ code: "not_found" }) });
  });

  await page.goto("/account");
  await expectLabeledControls(page.locator("main"));
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Mật khẩu").fill("Sundial Maple Crane 7429");
  await page.getByRole("button", { name: "Đăng nhập và mở kho local", exact: true }).click();
  await expect(page.locator(".account-status").filter({ hasText: "Kho local đang mở" })).toHaveCount(1);
}

async function expectNamedButtons(scope: Locator): Promise<void> {
  const buttons = await scope.getByRole("button").all();
  for (const button of buttons) await expect(button).toHaveAccessibleName(/\S+/);
}

async function expectLabeledControls(scope: Locator): Promise<void> {
  const unlabeled = await scope.locator("input:visible, select:visible, textarea:visible").evaluateAll((controls) => controls.filter((control) => {
    const input = control as HTMLInputElement;
    return input.type !== "hidden" && !input.labels?.length && !input.getAttribute("aria-label") && !input.getAttribute("aria-labelledby");
  }).map((control) => `${control.tagName.toLowerCase()}#${control.id || "no-id"}`));
  expect(unlabeled, `Controls without a programmatic label: ${unlabeled.join(", ")}`).toEqual([]);
}

async function textPairs(page: Page, selector: string): Promise<Array<{ text: string; foreground: string; background: string; fontSize: string; fontWeight: string }>> {
  return page.locator(selector).evaluateAll((elements) => elements.filter((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }).map((element) => {
    const style = getComputedStyle(element);
    let backgroundElement: Element | null = element;
    let background = "rgba(0, 0, 0, 0)";
    while (backgroundElement) {
      background = getComputedStyle(backgroundElement).backgroundColor;
      const rgba = background.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([^)]+)\)$/i);
      if (background !== "transparent" && (!rgba || Number.parseFloat(rgba[1]) > 0)) break;
      backgroundElement = backgroundElement.parentElement;
    }
    if (!backgroundElement) background = getComputedStyle(document.body).backgroundColor;
    return {
      text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
      foreground: style.color,
      background,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
    };
  }));
}

async function expectInsideViewport(page: Page, locator: Locator, label: string): Promise<void> {
  const bounds = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds, `${label} must have a visible bounding box`).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bounds!.x, `${label} left edge`).toBeGreaterThanOrEqual(-1);
  expect(bounds!.y, `${label} top edge`).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width, `${label} right edge`).toBeLessThanOrEqual(viewport!.width + 1);
  expect(bounds!.y + bounds!.height, `${label} bottom edge`).toBeLessThanOrEqual(viewport!.height + 1);
}

async function expectNoDocumentHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(metrics.document, `document width ${metrics.document} must fit viewport ${metrics.viewport}`).toBeLessThanOrEqual(metrics.viewport + 1);
}

function expectNoVisualTransform(value: string): void {
  expect(["none", "matrix(1,0,0,1,0,0)"], `Unexpected non-identity transform: ${value}`).toContain(value.replace(/\s+/g, ""));
}

test("contrastRatioHandlesHexRgbAndAlpha", () => {
  expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 5);
  expect(contrastRatio("rgb(118, 118, 118)", "rgb(255, 255, 255)")).toBeGreaterThan(4.5);
  expect(contrastRatio("rgba(0, 0, 0, 0.5)", "#fff")).toBeCloseTo(3.98, 1);
});

test("calendarIconButtonsHaveAccessibleNamesAndStatesHaveTextLabels", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-04T12:00:00.000Z"));
  await unlockLocalOwner(page);
  await page.goto("/work?date=2026-11-03");
  await expect(page.locator(".work-week-bucket .work-week-add:not(:disabled)")).toHaveCount(21);
  await expectNamedButtons(page.locator("main#calendar-main"));

  const widgetToggle = page.getByRole("button", { name: "Mở hoặc đóng điều hướng lịch" });
  await widgetToggle.click();
  await expectNamedButtons(page.locator(".calendar-widget"));
  await page.getByRole("button", { name: "Thêm công việc", exact: true }).click();
  const taskDialog = page.getByRole("dialog", { name: "Thêm công việc" });
  await expectNamedButtons(taskDialog);
  await expectLabeledControls(taskDialog);
  await taskDialog.getByRole("button", { name: "Tạo kế hoạch", exact: true }).click();
  const planDialog = page.locator(".plan-manager");
  await planDialog.getByRole("button", { name: "Tạo kế hoạch", exact: true }).click();
  await expectLabeledControls(planDialog);
  await planDialog.getByRole("button", { name: "Đóng kế hoạch", exact: true }).click();
  await expect(taskDialog).toBeVisible();
  await taskDialog.getByLabel("Tên công việc").fill("Nộp hồ sơ kiểm tra");
  await taskDialog.getByLabel("Buổi").selectOption("morning");
  await taskDialog.getByRole("button", { name: "Lưu công việc", exact: true }).click();

  const taskCard = page.getByRole("button", { name: /Nộp hồ sơ kiểm tra.*Chưa hoàn thành/ });
  await expect(taskCard).toBeVisible();
  await expect(taskCard).toHaveAccessibleName(/Chưa hoàn thành/);
  await expect(taskCard.locator(".work-task-state")).toContainText("Chưa hoàn thành");

  await page.goto("/milestones?date=2026-11-03&scale=week");
  await expect(page.locator(".milestone-week-day[data-milestone-date='2026-11-03']")).toBeVisible();
  await widgetToggle.click();
  await page.getByRole("button", { name: "Thêm dấu mốc", exact: true }).click();
  const milestoneDialog = page.getByRole("dialog", { name: "Thêm dấu mốc" });
  await expectNamedButtons(milestoneDialog);
  await expectLabeledControls(milestoneDialog);
  await milestoneDialog.getByLabel("Tên dấu mốc").fill("Ngày nộp hồ sơ");
  await milestoneDialog.getByLabel("Ghi chú liên quan (không bắt buộc)").fill("Gửi bản PDF đã ký.");
  await milestoneDialog.getByRole("button", { name: "Thêm dấu mốc", exact: true }).click();
  const marker = page.getByRole("button", { name: /Ngày nộp hồ sơ, Cả ngày, Có ghi chú/ });
  await expect(marker).toBeVisible();
  await expect(marker).toHaveAccessibleName(/Có ghi chú/);
  await expect(marker.locator(".milestone-event-note")).toBeVisible();
  await expectNamedButtons(page.locator("main#calendar-main"));

  await page.locator(".milestone-week-day[data-milestone-date='2026-11-03'] button").first().click();
  const dayDialog = page.locator("dialog.milestone-day-dialog");
  await expect(dayDialog).toBeVisible();
  await expectNamedButtons(dayDialog);
});

test("calendarFocusAndTextMeetContrastTargets", async ({ page }) => {
  await unlockLocalOwner(page);
  await page.goto("/work?date=2026-11-03");
  const toggle = page.getByRole("button", { name: "Mở hoặc đóng điều hướng lịch" });
  // Prime the client event boundary before testing keyboard focus after production hydration.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Thêm nhanh", exact: true }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(toggle).toBeFocused();
  const focusStyle = await toggle.evaluate((element) => {
    const style = getComputedStyle(element);
    const background = getComputedStyle(element.parentElement ?? element).backgroundColor;
    return { color: style.outlineColor, background, width: style.outlineWidth, offset: style.outlineOffset };
  });
  expect(Number.parseFloat(focusStyle.width)).toBeGreaterThanOrEqual(2);
  expect(Number.parseFloat(focusStyle.offset)).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(focusStyle.color, focusStyle.background)).toBeGreaterThanOrEqual(3);

  await toggle.click();
  const controls = await page.locator(".calendar-widget button:not(:disabled), .calendar-widget a, .calendar-widget input, .calendar-widget select").evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    return { name: element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName, border: style.borderTopColor, background: style.backgroundColor };
  }));
  for (const control of controls) {
    expect(contrastRatio(control.border, control.background), `${control.name} border: ${control.border} on ${control.background}`).toBeGreaterThanOrEqual(3);
  }

  const pairs = await textPairs(page, ".calendar-heading h1, .calendar-kicker, .work-week-day-heading h2, .work-week-day-heading p, .work-week-period-title, .work-week-message, .widget-summary span");
  expect(pairs.length).toBeGreaterThan(0);
  for (const pair of pairs) {
    const large = Number.parseFloat(pair.fontSize) >= 24 || (Number.parseFloat(pair.fontSize) >= 18.66 && Number(pair.fontWeight) >= 700);
    const minimum = large ? 3 : 4.5;
    expect(contrastRatio(pair.foreground, pair.background), `${pair.text}: ${pair.foreground} on ${pair.background}`).toBeGreaterThanOrEqual(minimum);
  }
});

test("calendarFlowsRemainOperableAtDesktopAndZoomViewports", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-04T12:00:00.000Z"));
  await unlockLocalOwner(page);

  for (const viewport of [{ width: 1024, height: 768 }, { width: 1920, height: 1080 }, { width: 512, height: 384 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/work?date=2026-11-03");
    await expectNoDocumentHorizontalOverflow(page);
    const widget = page.locator(".calendar-widget");
    await expectInsideViewport(page, widget.locator(".widget-bar"), `widget bar at ${viewport.width}x${viewport.height}`);
    const toggle = page.getByRole("button", { name: "Mở hoặc đóng điều hướng lịch" });
    await toggle.click();
    const widgetPanel = page.getByRole("region", { name: "Điều khiển lịch" });
    await expectInsideViewport(page, widgetPanel, `open widget panel at ${viewport.width}x${viewport.height}`);
    const panelScroll = await widgetPanel.evaluate((element) => ({ height: element.clientHeight, scrollHeight: element.scrollHeight, overflowY: getComputedStyle(element).overflowY }));
    expect(panelScroll.overflowY).toBe("auto");
    await widgetPanel.getByRole("link", { name: "Tài khoản", exact: true }).scrollIntoViewIfNeeded();
    await expect(widgetPanel.getByRole("link", { name: "Tài khoản", exact: true })).toBeVisible();

    await widgetPanel.getByRole("button", { name: "Thêm công việc", exact: true }).click();
    const taskDialog = page.getByRole("dialog", { name: "Thêm công việc" });
    await expectInsideViewport(page, taskDialog, `task editor at ${viewport.width}x${viewport.height}`);
    expect(await taskDialog.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
    const taskClose = taskDialog.getByRole("button", { name: "Đóng công việc", exact: true });
    const taskSave = taskDialog.getByRole("button", { name: "Lưu công việc", exact: true });
    for (const button of [taskClose, taskSave]) {
      await button.scrollIntoViewIfNeeded();
      await expectInsideViewport(page, button, `task editor ${await button.getAttribute("aria-label") ?? await button.textContent()} at ${viewport.width}x${viewport.height}`);
    }
    await taskClose.click();

    await page.goto("/milestones?date=2026-11-03&scale=week");
    await expectNoDocumentHorizontalOverflow(page);
    await toggle.click();
    await page.getByRole("button", { name: "Thêm dấu mốc", exact: true }).click();
    const milestoneDialog = page.getByRole("dialog", { name: "Thêm dấu mốc" });
    await expectInsideViewport(page, milestoneDialog, `milestone editor at ${viewport.width}x${viewport.height}`);
    expect(await milestoneDialog.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
    const milestoneClose = milestoneDialog.getByRole("button", { name: "Đóng dấu mốc", exact: true });
    const milestoneSave = milestoneDialog.getByRole("button", { name: "Thêm dấu mốc", exact: true });
    for (const button of [milestoneClose, milestoneSave]) {
      await button.scrollIntoViewIfNeeded();
      await expectInsideViewport(page, button, `milestone editor action at ${viewport.width}x${viewport.height}`);
    }
    await milestoneClose.click();

    const dayTrigger = page.locator(".milestone-week-day[data-milestone-date='2026-11-03'] button").first();
    await dayTrigger.click();
    const dayDialog = page.locator("dialog.milestone-day-dialog");
    await expectInsideViewport(page, dayDialog, `milestone day dialog at ${viewport.width}x${viewport.height}`);
    const closeDay = dayDialog.getByRole("button", { name: "Đóng chi tiết ngày", exact: true });
    const openWeek = dayDialog.getByRole("button", { name: "Mở tuần công việc", exact: true });
    for (const button of [closeDay, openWeek]) {
      await button.scrollIntoViewIfNeeded();
      await expectInsideViewport(page, button, `day dialog action at ${viewport.width}x${viewport.height}`);
    }
    await closeDay.click();
  }
});

test("calendarDialogsHonorReducedMotionTransformsAndTransitions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await unlockLocalOwner(page);
  await page.goto("/work?date=2026-11-03");

  const widget = page.locator(".calendar-widget");
  const widgetMotion = await widget.evaluate((element) => {
    const style = getComputedStyle(element);
    return { transform: style.transform, translate: style.translate, scale: style.scale, transitions: style.transitionDuration.split(",").map((value) => Number.parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000)), reduced: matchMedia("(prefers-reduced-motion: reduce)").matches };
  });
  expectNoVisualTransform(widgetMotion.transform);
  expect(widgetMotion.translate, JSON.stringify(widgetMotion)).toBe("none");
  expect(widgetMotion.scale).toBe("none");
  expect(widgetMotion.transitions.every((duration) => duration <= 80)).toBe(true);

  await page.getByRole("button", { name: "Mở hoặc đóng điều hướng lịch" }).click();
  await page.getByRole("button", { name: "Thêm công việc", exact: true }).click();
  const taskDialog = page.getByRole("dialog", { name: "Thêm công việc" });
  const taskMotion = await taskDialog.evaluate((element) => {
    const style = getComputedStyle(element);
    return { transform: style.transform, translate: style.translate, scale: style.scale, animation: style.animationName, transitions: style.transitionDuration.split(",").map((value) => Number.parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000)) };
  });
  expectNoVisualTransform(taskMotion.transform);
  expect(taskMotion.translate).toBe("none");
  expect(taskMotion.scale).toBe("none");
  expect(taskMotion.animation).toBe("none");
  expect(taskMotion.transitions.every((duration) => duration <= 80)).toBe(true);
  await taskDialog.getByRole("button", { name: "Đóng công việc", exact: true }).click();

  await page.goto("/milestones?date=2026-11-03&scale=week");
  await page.locator(".milestone-week-day[data-milestone-date='2026-11-03'] button").first().click();
  const dayDialog = page.locator("dialog.milestone-day-dialog");
  const dayMotion = await dayDialog.evaluate((element) => {
    const style = getComputedStyle(element);
    return { transform: style.transform, translate: style.translate, scale: style.scale, animation: style.animationName, transitions: style.transitionDuration.split(",").map((value) => Number.parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000)) };
  });
  expectNoVisualTransform(dayMotion.transform);
  expect(dayMotion.translate).toBe("none");
  expect(dayMotion.scale).toBe("none");
  expect(dayMotion.animation).toBe("none");
  expect(dayMotion.transitions.every((duration) => duration <= 80)).toBe(true);
});
