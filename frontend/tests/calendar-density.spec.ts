import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, release, totalmem, version as osVersion } from "node:os";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  buildDensityMilestoneCommands,
  seedCalendarDensityFixture,
  type CalendarDensityHarness,
  expectedDensityYearCounts,
} from "./helpers/calendar-density-fixture";
import type { UUID } from "../lib/sync/protocol";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const CSRF_TOKEN = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const LOCAL_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const MILESTONE_COMMANDS = buildDensityMilestoneCommands();
const YEAR_COUNTS = expectedDensityYearCounts(MILESTONE_COMMANDS);
const EXPECTED_YEAR_TOTAL = [...YEAR_COUNTS.values()].reduce((total, count) => total + count, 0);

type DensityWindow = Window & {
  __dayforgeSyncBrowserHarness?: CalendarDensityHarness;
  __dayforgeDensityStartedAt?: number;
  __dayforgeDensityMetrics?: { longTasks: number[]; layoutShifts: number[] };
};

function apiSession(authenticated: boolean) {
  return {
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
  };
}

async function installTestAuth(page: Page): Promise<void> {
  let authenticated = false;
  await page.route("**/api/v1/sync/**", (route) => route.abort());
  await page.route("**/api/v1/version", (route) => route.abort());
  await page.route("**/api/v1/auth/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const headers = { "cache-control": "no-store", "content-type": "application/json" };
    if (pathname === "/api/v1/auth/session" && request.method() === "GET") {
      await route.fulfill({ status: 200, headers, body: JSON.stringify(apiSession(authenticated)) });
      return;
    }
    if (pathname === "/api/v1/auth/login" && request.method() === "POST") {
      authenticated = true;
      await route.fulfill({ status: 200, headers, body: JSON.stringify(apiSession(true)) });
      return;
    }
    if (pathname === "/api/v1/auth/local-key" && request.method() === "GET") {
      await route.fulfill({ status: 200, headers, body: JSON.stringify({
        owner_id: OWNER_ID,
        key_id: KEY_ID,
        algorithm: "A256GCM",
        key_base64url: LOCAL_KEY,
      }) });
      return;
    }
    await route.fulfill({ status: 404, headers, body: JSON.stringify({ code: "not_found" }) });
  });
}

async function installPerformanceObservers(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const target = window as DensityWindow;
    target.__dayforgeDensityStartedAt = performance.now();
    const metrics = { longTasks: [] as number[], layoutShifts: [] as number[] };
    target.__dayforgeDensityMetrics = metrics;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) metrics.longTasks.push(entry.duration);
      }).observe({ type: "longtask", buffered: true });
    } catch { /* Long task entries are optional outside Chromium. */ }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!(entry as PerformanceEntry & { hadRecentInput?: boolean }).hadRecentInput) {
            metrics.layoutShifts.push((entry as PerformanceEntry & { value?: number }).value ?? 0);
          }
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch { /* Layout shift entries are optional outside Chromium. */ }
  });
}

async function setupDensityDataset(page: Page): Promise<void> {
  await installTestAuth(page);
  await page.goto("/account");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Mật khẩu").fill("Sundial Maple Crane 7429");
  await page.getByRole("button", { name: "Đăng nhập và mở kho local", exact: true }).click();
  await expect(page.locator(".account-status").filter({ hasText: "Kho local đang mở" })).toHaveCount(1);
  await page.goto("/sync-browser");
  await expect(page.getByText("Test sync harness sẵn sàng.")).toBeVisible();
  await page.waitForFunction(() => Boolean(window.__dayforgeSyncBrowserHarness));
  await seedCalendarDensityFixture(page);
}

async function waitForWorkWeek(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelectorAll(".work-week .work-task-entry[data-work-item-id]").length === 168);
}

async function waitForDensityYear(page: Page): Promise<void> {
  await page.waitForFunction((expectedTotal) => {
    const months = [...document.querySelectorAll<HTMLElement>(".milestone-year-month")];
    const counts = months.map((month) => Number(month.getAttribute("aria-label")?.match(/,\s*(\d+) dấu mốc$/)?.[1] ?? NaN));
    return months.length === 12 && counts.every(Number.isFinite) && counts.reduce((total, count) => total + count, 0) === expectedTotal;
  }, EXPECTED_YEAR_TOTAL);
}

async function refreshOwnerProjection(page: Page): Promise<void> {
  await page.evaluate((ownerId) => new Promise<void>((resolve, reject) => {
    let sawLoading = false;
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      reject(new Error("Calendar projection refresh did not finish"));
    }, 10_000);
    const inspect = () => {
      const loading = [...document.querySelectorAll(".milestone-calendar-message")]
        .some((message) => message.textContent?.includes("Đang đọc dấu mốc trên thiết bị") ?? false);
      if (loading) sawLoading = true;
      else if (sawLoading) {
        window.clearTimeout(timeout);
        observer.disconnect();
        resolve();
      }
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.dispatchEvent(new CustomEvent("dayforge:owner-state-changed", { detail: { ownerId } }));
    requestAnimationFrame(inspect);
  }), OWNER_ID);
}

async function closeDayDialogIfOpen(page: Page): Promise<void> {
  const dialog = page.locator(".milestone-day-dialog[open]");
  if (await dialog.count()) await dialog.getByRole("button", { name: "Đóng chi tiết ngày" }).click();
}

async function openCalendarControls(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Mở hoặc đóng điều hướng lịch" });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}

async function switchCalendar(page: Page, label: "Lịch công việc" | "Lịch dấu mốc"): Promise<void> {
  await openCalendarControls(page);
  await page.locator(".widget-calendars").getByRole("link", { name: label, exact: true }).click();
  await expect(page.locator(".calendar-heading h1")).toHaveText(label);
}

async function setMilestoneScale(page: Page, scale: "week" | "month" | "year"): Promise<void> {
  await openCalendarControls(page);
  await page.getByLabel("Quy mô").selectOption(scale);
  await page.waitForURL(new RegExp(`/milestones\\?date=2026-11-04&scale=${scale}$`));
}

async function resetPerformanceSample(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as DensityWindow;
    target.__dayforgeDensityStartedAt = performance.now();
    if (target.__dayforgeDensityMetrics) {
      target.__dayforgeDensityMetrics.longTasks.length = 0;
      target.__dayforgeDensityMetrics.layoutShifts.length = 0;
    }
  });
}

async function readPerformanceSample(page: Page): Promise<{
  duration_ms: number;
  long_task_count: number;
  long_task_total_ms: number;
  layout_shift_count: number;
  cls: number;
}> {
  return page.evaluate(() => {
    const target = window as DensityWindow;
    const tasks = target.__dayforgeDensityMetrics?.longTasks ?? [];
    const shifts = target.__dayforgeDensityMetrics?.layoutShifts ?? [];
    return {
      duration_ms: performance.now() - (target.__dayforgeDensityStartedAt ?? 0),
      long_task_count: tasks.length,
      long_task_total_ms: tasks.reduce((total, duration) => total + duration, 0),
      layout_shift_count: shifts.length,
      cls: shifts.reduce((total, value) => total + value, 0),
    };
  });
}

function summarizeSamples(samples: ReadonlyArray<Awaited<ReturnType<typeof readPerformanceSample>>>) {
  const summarize = (key: keyof Awaited<ReturnType<typeof readPerformanceSample>>) => {
    const values = samples.map((sample) => sample[key]).sort((left, right) => left - right);
    return {
      median: Number(values[Math.floor(values.length / 2)].toFixed(2)),
      p95: Number(values[Math.ceil(values.length * 0.95) - 1].toFixed(2)),
    };
  };
  return {
    duration_ms: summarize("duration_ms"),
    long_task_count: summarize("long_task_count"),
    long_task_total_ms: summarize("long_task_total_ms"),
    layout_shift_count: summarize("layout_shift_count"),
    cls: summarize("cls"),
  };
}

function appendScenarioRow(rows: Array<Record<string, unknown>>, viewport: { width: number; height: number }, scenario: string, samples: Array<Awaited<ReturnType<typeof readPerformanceSample>>>) {
  rows.push({ viewport, scenario, warmups: 3, runs: samples.length, ...summarizeSamples(samples) });
}

async function profileCpuDuring(page: Page, action: () => Promise<void>): Promise<Array<{ function: string; url: string; line: number; sampled_ms: number }>> {
  type ProfileResponse = {
    profile: {
      nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>;
      samples?: number[];
      timeDeltas?: number[];
    };
  };
  const session = await page.context().newCDPSession(page);
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 1_000 });
  await session.send("Profiler.start");
  let actionError: unknown;
  try {
    await action();
  } catch (error) {
    actionError = error;
  }
  let response: ProfileResponse;
  try {
    response = await session.send("Profiler.stop") as unknown as ProfileResponse;
  } finally {
    await session.send("Profiler.disable");
    await session.detach();
  }
  if (actionError !== undefined) throw actionError;
  const durations = new Map<number, number>();
  for (let index = 0; index < (response.profile.samples?.length ?? 0); index += 1) {
    const nodeId = response.profile.samples![index];
    durations.set(nodeId, (durations.get(nodeId) ?? 0) + (response.profile.timeDeltas?.[index] ?? 0));
  }
  const nodes = new Map(response.profile.nodes.map((node) => [node.id, node]));
  return [...durations.entries()]
    .map(([id, micros]) => {
      const frame = nodes.get(id)?.callFrame;
      return frame ? {
        function: frame.functionName || "(anonymous)",
        url: frame.url,
        line: frame.lineNumber + 1,
        sampled_ms: Number((micros / 1_000).toFixed(2)),
      } : null;
    })
    .filter((entry): entry is { function: string; url: string; line: number; sampled_ms: number } => entry !== null)
    .sort((left, right) => right.sampled_ms - left.sampled_ms)
    .slice(0, 12);
}

test.describe("dense calendar behavior", () => {
  test.describe.configure({ mode: "serial" });
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const baseURL = test.info().project.use.baseURL as string;
    context = await browser.newContext({ baseURL, viewport: { width: 1_024, height: 768 } });
    await installPerformanceObservers(context);
    page = await context.newPage();
    await setupDensityDataset(page);
  });

  test.afterAll(async () => { await context?.close(); });

  test("denseWorkWeekKeepsMovedAndDetachedOccurrencesExactlyOnce", async () => {
    await page.goto("/work?date=2026-11-04");
    await waitForWorkWeek(page);
    const taskEntries = page.locator(".work-week .work-task-entry[data-work-item-id]");
    await expect(taskEntries).toHaveCount(168);
    const movedEntry = page.locator(".work-task-entry", { hasText: "Moved dense occurrence" });
    await expect(movedEntry).toHaveCount(1);
    await expect(movedEntry).toContainText("Một lần");
    const ids = await taskEntries.evaluateAll((entries) => entries.map((entry) => entry.getAttribute("data-work-item-id")));
    expect(new Set(ids).size).toBe(168);
  });

  test("denseMilestoneDayKeepsEveryMarkerOpenable", async () => {
    test.setTimeout(120_000);
    await page.goto("/milestones?date=2026-11-04&scale=week");
    const day = page.locator('.milestone-week-day[data-milestone-date="2026-11-04"]');
    await expect.poll(() => day.locator(".milestone-calendar-event").count()).toBe(20);
    await day.locator(".milestone-day-heading button").click();
    const list = page.locator(".milestone-day-dialog-list");
    await expect(list.locator("[data-milestone-id]")).toHaveCount(20);
    const ids = await list.locator("[data-milestone-id]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-milestone-id")!));
    expect(new Set(ids).size).toBe(20);

    for (const id of ids) {
      const marker = list.locator(`[data-milestone-id="${id}"]`);
      await expect(marker).toBeVisible();
      await expect(marker).toHaveAccessibleName(/\S+/);
      await marker.click();
      await expect(page.getByRole("dialog", { name: "Sửa dấu mốc" })).toBeVisible();
      await page.getByRole("button", { name: "Đóng dấu mốc" }).click();
      await day.locator(".milestone-day-heading button").click();
      await expect(list.locator("[data-milestone-id]")).toHaveCount(20);
    }
    await page.locator(".milestone-day-dialog").getByRole("button", { name: "Đóng chi tiết ngày" }).click();
  });

  test("milestoneYearGroupsOnlyItsCalendarYear", async () => {
    await page.goto("/milestones?date=2026-11-04&scale=year");
    await waitForDensityYear(page);
    const actualCounts = await page.locator(".milestone-year-month").evaluateAll((months) =>
      months.map((month) => Number(month.getAttribute("aria-label")?.match(/,\s*(\d+) dấu mốc$/)?.[1])),
    );
    const expectedCounts = Array.from({ length: 12 }, (_, monthIndex) => {
      const month = `2026-${String(monthIndex + 1).padStart(2, "0")}`;
      return YEAR_COUNTS.get(month) ?? 0;
    });
    expect(actualCounts).toEqual(expectedCounts);
    await expect(page.locator(".milestone-year-grid")).not.toContainText("Density marker 0021");
    await expect(page.locator(".milestone-year-grid")).not.toContainText("Density marker 0022");
  });

  test("denseCalendarSyncKeepsCurrentViewAndScrollStable", async () => {
    await page.goto("/milestones?date=2026-11-04&scale=year");
    await waitForDensityYear(page);
    await page.evaluate(() => window.scrollTo(0, 400));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    const before = await page.evaluate(() => {
      const heading = document.querySelector(".calendar-heading")!.getBoundingClientRect();
      const calendar = document.querySelector(".milestone-calendar")!.getBoundingClientRect();
      return {
        href: `${location.pathname}${location.search}`,
        scrollY: window.scrollY,
        headingTop: heading.top,
        calendarTop: calendar.top,
      };
    });
    await refreshOwnerProjection(page);
    await waitForDensityYear(page);
    const after = await page.evaluate(() => ({
      href: `${location.pathname}${location.search}`,
      scrollY: window.scrollY,
      headingTop: document.querySelector(".calendar-heading")!.getBoundingClientRect().top,
      calendarTop: document.querySelector(".milestone-calendar")!.getBoundingClientRect().top,
      counts: [...document.querySelectorAll<HTMLElement>(".milestone-year-month")]
        .map((month) => Number(month.getAttribute("aria-label")?.match(/,\s*(\d+) dấu mốc$/)?.[1])),
    }));
    expect(after.href).toBe(before.href);
    expect(after.scrollY).toBeCloseTo(before.scrollY, -1);
    expect(after.headingTop).toBeCloseTo(before.headingTop, 0);
    expect(after.calendarTop).toBeCloseTo(before.calendarTop, 0);
    expect(after.counts).toHaveLength(12);
    expect(after.counts.reduce((total, count) => total + count, 0)).toBe(EXPECTED_YEAR_TOTAL);
  });

  test("productionDensityBenchmark", async ({ browser }) => {
    test.skip(process.env.DAYFORGE_RUN_DENSITY_BENCHMARK !== "1", "Run explicitly for the 3 warmup and 20 sample production benchmark.");
    test.setTimeout(900_000);
    const rows: Array<Record<string, unknown>> = [];
    const cpuProfiles: Record<string, Array<{ function: string; url: string; line: number; sampled_ms: number }>> = {};
    for (const viewport of [{ width: 1_024, height: 768 }, { width: 1_920, height: 1_080 }]) {
      await page.setViewportSize(viewport);
      await page.goto("/work?date=2026-11-04", { waitUntil: "domcontentloaded" });
      await waitForWorkWeek(page);

      const openWorkSamples: Array<Awaited<ReturnType<typeof readPerformanceSample>>> = [];
      for (let run = 0; run < 23; run += 1) {
        await resetPerformanceSample(page);
        const date = run % 2 === 0 ? "2026-11-11" : "2026-11-04";
        const period = date === "2026-11-11" ? "09/11/2026 – 15/11/2026" : "02/11/2026 – 08/11/2026";
        await page.evaluate((anchor) => window.history.pushState(null, "", `/work?date=${anchor}`), date);
        await expect(page.locator(".calendar-heading .calendar-period")).toHaveText(period);
        await waitForWorkWeek(page);
        const sample = await readPerformanceSample(page);
        if (run >= 3) openWorkSamples.push(sample);
      }
      appendScenarioRow(rows, viewport, "open-work-week", openWorkSamples);

      const navigateSamples: Array<Awaited<ReturnType<typeof readPerformanceSample>>> = [];
      for (let run = 0; run < 23; run += 1) {
        await resetPerformanceSample(page);
        const direction = run % 2 === 0 ? "Lùi" : "Tiến";
        const expectedDate = run % 2 === 0 ? "2026-11-04" : "2026-11-11";
        await openCalendarControls(page);
        await page.getByRole("button", { name: direction, exact: true }).click();
        await page.waitForURL(new RegExp(`/work\\?date=${expectedDate}$`));
        await waitForWorkWeek(page);
        const sample = await readPerformanceSample(page);
        if (run >= 3) navigateSamples.push(sample);
      }
      appendScenarioRow(rows, viewport, "navigate-one-week", navigateSamples);

      await switchCalendar(page, "Lịch dấu mốc");
      await setMilestoneScale(page, "week");
      await expect(page.locator('.milestone-week-day[data-milestone-date="2026-11-04"] .milestone-calendar-event')).toHaveCount(20);
      const weekDay = page.locator('.milestone-week-day[data-milestone-date="2026-11-04"]');
      const daySamples: Array<Awaited<ReturnType<typeof readPerformanceSample>>> = [];
      for (let run = 0; run < 23; run += 1) {
        await resetPerformanceSample(page);
        await weekDay.locator(".milestone-day-heading button").click();
        await expect(page.locator(".milestone-day-dialog-list [data-milestone-id]")).toHaveCount(20);
        const sample = await readPerformanceSample(page);
        if (run >= 3) daySamples.push(sample);
        await closeDayDialogIfOpen(page);
      }
      appendScenarioRow(rows, viewport, "open-milestone-day", daySamples);

      await setMilestoneScale(page, "month");
      const monthDay = page.locator('.milestone-month-day[data-milestone-date="2026-11-04"]');
      await expect(monthDay.locator(".milestone-more")).toBeVisible();
      const monthSamples: Array<Awaited<ReturnType<typeof readPerformanceSample>>> = [];
      for (let run = 0; run < 23; run += 1) {
        await resetPerformanceSample(page);
        await monthDay.locator(".milestone-more").click();
        await expect(page.locator(".milestone-day-dialog-list [data-milestone-id]")).toHaveCount(20);
        const sample = await readPerformanceSample(page);
        if (run >= 3) monthSamples.push(sample);
        await closeDayDialogIfOpen(page);
      }
      appendScenarioRow(rows, viewport, "open-month-day-list", monthSamples);

      const yearSamples: Array<Awaited<ReturnType<typeof readPerformanceSample>>> = [];
      for (let run = 0; run < 23; run += 1) {
        await resetPerformanceSample(page);
        await setMilestoneScale(page, "year");
        await waitForDensityYear(page);
        const sample = await readPerformanceSample(page);
        if (run >= 3) yearSamples.push(sample);
        await setMilestoneScale(page, "month");
      }
      appendScenarioRow(rows, viewport, "open-milestone-year", yearSamples);

      if (viewport.width === 1_024) {
        cpuProfiles.yearNavigation = await profileCpuDuring(page, async () => {
          await setMilestoneScale(page, "year");
          await waitForDensityYear(page);
        });
        await setMilestoneScale(page, "month");
      }

      await setMilestoneScale(page, "year");
      await waitForDensityYear(page);
      const refreshSamples: Array<Awaited<ReturnType<typeof readPerformanceSample>>> = [];
      for (let run = 0; run < 23; run += 1) {
        await resetPerformanceSample(page);
        await refreshOwnerProjection(page);
        await waitForDensityYear(page);
        const sample = await readPerformanceSample(page);
        if (run >= 3) refreshSamples.push(sample);
      }
      appendScenarioRow(rows, viewport, "projection-refresh", refreshSamples);
      if (viewport.width === 1_024) {
        cpuProfiles.projectionRefresh = await profileCpuDuring(page, () => refreshOwnerProjection(page));
      }
    }

    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
    const report = {
      commit_sha: commitSha,
      recorded_at_utc: new Date().toISOString(),
      platform: `${osVersion()} (${release()}) ${process.arch}`,
      cpu: cpus()[0]?.model ?? "unknown",
      logical_cpus: cpus().length,
      total_memory_gb: Number((totalmem() / (1024 ** 3)).toFixed(1)),
      browser: `Chromium ${browser.version()}`,
      dataset: { recurrence_series: 24, work_week_items: 168, milestones: 1_200, same_day_milestones: 20, in_year_milestones: EXPECTED_YEAR_TOTAL },
      measurement: { warmups_per_scenario: 3, runs_per_scenario: 20, scenarios: rows },
      cpu_profiles: cpuProfiles,
    };
    const phase = process.env.DAYFORGE_DENSITY_BENCHMARK_PHASE === "baseline" ? "baseline" : "optimized";
    const artifactPath = test.info().outputPath(`calendar-density-${phase}.json`);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  });
});

