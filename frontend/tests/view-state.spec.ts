import { expect, test, type Page } from "@playwright/test";
import { todayInUtc7, parseViewState, moveAnchor, readPreference, writePreference, serializeViewState } from "../lib/calendar/view-state";

async function openWidget(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Mở hoặc đóng điều hướng lịch" });
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

const now = new Date("2026-10-29T00:00:00.000Z");
const preference = { anchor: "2026-01-31", scale: "month" as const, scrollY: 80 };
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(), key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null, removeItem: key => { values.delete(key); }, setItem: (key, value) => { values.set(key, value); } };
}
test("todayInUtc7RollsAtBangkokMidnight", () => {
  expect(todayInUtc7(new Date("2026-10-29T16:59:59.999Z"))).toBe("2026-10-29");
  expect(todayInUtc7(new Date("2026-10-29T17:00:00.000Z"))).toBe("2026-10-30");
});
test("parseViewStateUsesPreferenceOnlyForMissingFields", () => {
  expect(parseViewState("/milestones", new URLSearchParams("scale=year"), now, preference)).toEqual({ calendar: "milestones", anchor: "2026-01-31", scale: "year" });
  expect(parseViewState("/work", new URLSearchParams("date=2024-02-29&scale=year"), now, null)).toEqual({ calendar: "work", anchor: "2024-02-29", scale: "week" });
});
test("parseViewStateDefaultsInvalidFields", () => {
  expect(parseViewState("/milestones", new URLSearchParams("date=2026-02-30&scale=decade"), now, preference)).toEqual({ calendar: "milestones", anchor: "2026-10-29", scale: "month" });
  expect(parseViewState("/milestones", new URLSearchParams("date=&scale="), now, preference)).toEqual({ calendar: "milestones", anchor: "2026-10-29", scale: "month" });
});
test("parseViewStateEnforcesT03Domain", () => {
  for (const anchor of ["0001-01-01", "9999-12-31"]) {
    expect(parseViewState("/work", new URLSearchParams({ date: anchor }), now, null).anchor).toBe(anchor);
  }
  for (const anchor of ["0000-01-01", "10000-01-01"]) {
    expect(parseViewState("/work", new URLSearchParams({ date: anchor }), now, null).anchor).toBe("2026-10-29");
  }
});
test("preferencesEnforceT03Domain", () => {
  const storage = memoryStorage();
  const invalid = { anchor: "0000-01-01", scale: "month" as const, scrollY: 0 };
  expect(parseViewState("/milestones", new URLSearchParams(), now, invalid).anchor).toBe("2026-10-29");
  storage.setItem("dayforge:view:v1:milestones", JSON.stringify(invalid));
  expect(readPreference("milestones", storage)).toBeNull();
  storage.clear();
  writePreference("milestones", invalid, storage);
  expect(storage.getItem("dayforge:view:v1:milestones")).toBeNull();
});
test("moveAnchorPreservesEndOfMonth", () => {
  expect(moveAnchor({ calendar: "milestones", anchor: "2026-01-31", scale: "month" }, 1).anchor).toBe("2026-02-28");
  expect(moveAnchor({ calendar: "milestones", anchor: "2026-03-31", scale: "month" }, -1).anchor).toBe("2026-02-28");
});
test("moveAnchorClampsLeapDay", () => {
  expect(moveAnchor({ calendar: "milestones", anchor: "2024-02-29", scale: "year" }, 1).anchor).toBe("2025-02-28");
  expect(moveAnchor({ calendar: "work", anchor: "2026-12-28", scale: "week" }, 1).anchor).toBe("2027-01-04");
});
test("moveAnchorStopsAtT03DomainBounds", () => {
  for (const scale of ["week", "month", "year"] as const) {
    expect(moveAnchor({ calendar: "milestones", anchor: "0001-01-01", scale }, -1).anchor).toBe("0001-01-01");
    expect(moveAnchor({ calendar: "milestones", anchor: "9999-12-31", scale }, 1).anchor).toBe("9999-12-31");
  }
  expect(moveAnchor({ calendar: "work", anchor: "0001-01-01", scale: "week" }, -1).anchor).toBe("0001-01-01");
  expect(moveAnchor({ calendar: "work", anchor: "9999-12-31", scale: "week" }, 1).anchor).toBe("9999-12-31");
});
test("readPreferenceRejectsMalformedOrUnavailableStorage", () => {
  const storage = memoryStorage();
  for (const value of ["{", JSON.stringify({ ...preference, anchor: "2026-02-30" }), JSON.stringify({ ...preference, scrollY: -1 }), JSON.stringify({ ...preference, scale: "decade" })]) {
    storage.setItem("dayforge:view:v1:milestones", value);
    expect(readPreference("milestones", storage)).toBeNull();
  }
  storage.getItem = () => { throw new Error("unavailable"); };
  expect(readPreference("work", storage)).toBeNull();
});
test("writePreferenceUsesCalendarSpecificKey", () => {
  const storage = memoryStorage();
  writePreference("work", { ...preference, scale: "week", scrollY: 80.8 }, storage);
  writePreference("milestones", { ...preference, scrollY: 80.8 }, storage);
  expect(JSON.parse(storage.getItem("dayforge:view:v1:work")!)).toEqual({ anchor: "2026-01-31", scale: "week", scrollY: 81 });
  expect(readPreference("milestones", storage)).toEqual({ ...preference, scrollY: 81 });
  storage.setItem = () => { throw new Error("unavailable"); };
  expect(() => writePreference("work", { ...preference, scale: "week" }, storage)).not.toThrow();
});
test("serializeViewStateOrdersDateBeforeScale", () => {
  expect(serializeViewState({ calendar: "milestones", anchor: "2026-02-28", scale: "year" })).toBe("/milestones?date=2026-02-28&scale=year");
  expect(serializeViewState({ calendar: "work", anchor: "2026-01-31", scale: "week" })).toBe("/work?date=2026-01-31");
});
test("calendarHistoryRestoresRouteDateAndScale", async ({ page }) => {
  await page.goto("/work?date=2026-01-31");
  await openWidget(page);
  await expect(page.getByLabel("Ngày đang xem")).toHaveValue("2026-01-31");
  await page.getByRole("link", { name: "Lịch dấu mốc", exact: true }).click();
  await expect(page).toHaveURL(/\/milestones\?date=\d{4}-\d{2}-\d{2}&scale=month$/);
  await openWidget(page);
  await expect(page.getByLabel("Quy mô")).toHaveValue("month");
  await page.getByLabel("Ngày đang xem").fill("2026-02-28");
  await expect(page).toHaveURL(/\/milestones\?date=2026-02-28&scale=month$/);
  await page.getByLabel("Quy mô").selectOption("year");
  await expect(page).toHaveURL(/\/milestones\?date=2026-02-28&scale=year$/);
  await page.goBack();
  await openWidget(page);
  await expect(page.getByLabel("Quy mô")).toHaveValue("month");
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/\/work\?date=2026-01-31$/);
  await openWidget(page);
  await expect(page.getByLabel("Ngày đang xem")).toHaveValue("2026-01-31");
  await page.goForward();
  await page.goForward();
  await page.goForward();
  await expect(page).toHaveURL(/\/milestones\?date=2026-02-28&scale=year$/);
  await openWidget(page);
  await expect(page.getByLabel("Ngày đang xem")).toHaveValue("2026-02-28");
  await openWidget(page);
  await expect(page.getByLabel("Quy mô")).toHaveValue("year");
});


test("calendarPreferencesSurviveReloadAndRemainSeparate", async ({ page }) => {
  await page.goto("/milestones?date=2026-01-31&scale=month");
  await openWidget(page);
  await expect(page.getByLabel("Ngày đang xem")).toHaveValue("2026-01-31");
  await page.getByRole("button", { name: "Tiến", exact: true }).click();
  await expect(page).toHaveURL(/\/milestones\?date=2026-02-28&scale=month$/);
  await page.reload();
  await openWidget(page);
  await expect(page.getByLabel("Ngày đang xem")).toHaveValue("2026-02-28");
  await page.goto("/work?date=2026-06-01");
  await openWidget(page);
  await expect(page.getByLabel("Ngày đang xem")).toHaveValue("2026-06-01");
  await page.getByRole("link", { name: "Lịch dấu mốc", exact: true }).click();
  await expect(page).toHaveURL(/\/milestones\?date=\d{4}-\d{2}-\d{2}&scale=month$/);
  await openWidget(page);
  await expect(page.getByLabel("Ngày đang xem")).toHaveValue("2026-02-28");
  await openWidget(page);
  await expect(page.getByLabel("Quy mô")).toHaveValue("month");
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("dayforge:view:v1:work")!))).toEqual({ anchor: "2026-06-01", scale: "week", scrollY: 0 });
});

test("historyRestoresInitialPreferenceAfterDateChanges", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("dayforge:view:v1:milestones", JSON.stringify({ anchor: "2026-01-31", scale: "month", scrollY: 0 }));
  });
  await page.goto("/milestones");
  await openWidget(page);
  await expect(page.getByLabel("Ngày đang xem")).toHaveValue("2026-01-31");
  await page.getByRole("button", { name: "Tiến", exact: true }).click();
  await expect(page).toHaveURL(/\/milestones\?date=2026-02-28&scale=month$/);
  await page.goBack();
  await openWidget(page);
  await expect(page.getByLabel("Ngày đang xem")).toHaveValue("2026-01-31");
});

test("calendarScrollPreferencesRestoreAndPersistSeparately", async ({ page }) => {
  await page.route("**/*.css*", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nhtml { min-height: 4000px; scroll-behavior: auto; }` });
  });
  await page.addInitScript(() => {
    // Test-only space, with native restoration disabled to exercise application restoration.
    history.scrollRestoration = "manual";
    for (const [key, value] of [
      ["dayforge:view:v1:work", { anchor: "2026-01-31", scale: "week", scrollY: 120 }],
      ["dayforge:view:v1:milestones", { anchor: "2026-02-28", scale: "year", scrollY: 640 }],
    ] as const) {
      if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, JSON.stringify(value));
    }
  });

  await page.goto("/work?date=2026-01-31");
  await openWidget(page);
  await expect(page.getByLabel("Ngày đang xem")).toHaveValue("2026-01-31");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(120);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(120);

  await page.evaluate(() => window.scrollTo(0, 720));
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("dayforge:view:v1:work")!))).toEqual({ anchor: "2026-01-31", scale: "week", scrollY: 720 });
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("dayforge:view:v1:milestones")!))).toEqual({ anchor: "2026-02-28", scale: "year", scrollY: 640 });

  await page.goto("/milestones?date=2026-02-28&scale=year");
  await openWidget(page);
  await expect(page.getByLabel("Quy mô")).toHaveValue("year");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(640);
  await page.evaluate(() => window.scrollTo(0, 1100));
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("dayforge:view:v1:milestones")!))).toEqual({ anchor: "2026-02-28", scale: "year", scrollY: 1100 });
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("dayforge:view:v1:work")!))).toEqual({ anchor: "2026-01-31", scale: "week", scrollY: 720 });

  await page.reload();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(1100);
  await page.goto("/work?date=2026-01-31");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(720);
});
