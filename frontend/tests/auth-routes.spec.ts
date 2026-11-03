import { expect, test, type Page, type Request } from "@playwright/test";

const callbackRoutes = ["/verify-email", "/reset-password"] as const;
const token = "dayforge-test-token";

type ObservedRequest = { url: string; method: string; body: string | null; headers: Record<string, string> };

function observeRequests(page: Page): ObservedRequest[] {
  const requests: ObservedRequest[] = [];
  page.on("request", (request: Request) => {
    requests.push({ url: request.url(), method: request.method(), body: request.postData(), headers: request.headers() });
  });
  return requests;
}

async function expectNeutralCallback(page: Page, route: string): Promise<void> {
  const requests = observeRequests(page);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => errors.push(message.text()));
  const response = await page.goto(`${route}?source=email#token=${token}&extra=discard`, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`${route}\\?source=email$`));
  await expect(page.getByRole("heading", { name: route === "/verify-email" ? "Xác minh email" : "Đặt lại mật khẩu" })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(2);
  expect(await page.locator("html").innerHTML()).not.toContain(token);
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(JSON.stringify(storage)).not.toContain(token);
  expect(JSON.stringify(requests)).not.toContain(token);
  expect(requests.filter(request => request.method === "POST" && new URL(request.url).pathname.startsWith("/api/"))).toEqual([]);
  expect(errors.join("\n")).not.toContain(token);
}

test("accountRouteRendersLoginAndAccountActions", async ({ page }) => {
  await page.route("**/api/v1/auth/session", route => route.fulfill({ json: {
    authenticated: false,
    owner: null,
    session: null,
    csrf_token: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    server_time: "2026-11-01T00:00:00.000Z",
    logout_ticket: null,
  }, headers: { "cache-control": "no-store" } }));
  const response = await page.goto("/account");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Tài khoản", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Mật khẩu")).toBeVisible();
  await expect(page.getByLabel("Ghi nhớ phiên trên thiết bị này")).toBeChecked();
  await expect(page.getByRole("button", { name: "Tạo tài khoản" })).toBeVisible();
});

test("callbackRoutesCarryNoStoreHeaders", async ({ request }) => {
  for (const route of callbackRoutes) {
    const response = await request.get(route);
    expect(response.status()).toBe(200);
    // Next dev forces no-store; the external production-server run also enforces private.
    if (process.env.PLAYWRIGHT_BASE_URL) {
      expect(response.headers()["cache-control"]).toContain("private");
    }
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(response.headers()["pragma"]).toBe("no-cache");
    expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  }
});

test("callbackScrubsTokenWithoutPersistingOrPosting", async ({ page }) => {
  await expectNeutralCallback(page, "/verify-email");
});

test("resetCallbackScrubsTokenToo", async ({ page }) => {
  await expectNeutralCallback(page, "/reset-password");
});

for (const route of callbackRoutes) {
  test(`${route.slice(1)}ScrubsTokenAfterSameDocumentHashChange`, async ({ page }) => {
    const tokens = ["dayforge-first-token", "dayforge-second-token"];
    const requests = observeRequests(page);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => errors.push(message.text()));
    await page.goto(`${route}?source=email#token=${tokens[0]}&extra=discard`, { waitUntil: "networkidle" });
    const scrubbedUrl = new RegExp(`${route}\\?source=email$`);
    await expect(page).toHaveURL(scrubbedUrl);
    await page.evaluate(nextToken => { window.location.hash = `token=${nextToken}&extra=discard`; }, tokens[1]);
    await expect(page).toHaveURL(scrubbedUrl);
    await expect(page.locator('input[type="password"]')).toHaveCount(2);
    const markup = await page.locator("html").innerHTML();
    const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
    for (const secret of tokens) {
      expect(markup).not.toContain(secret);
      expect(JSON.stringify(storage)).not.toContain(secret);
      expect(JSON.stringify(requests)).not.toContain(secret);
      expect(errors.join("\n")).not.toContain(secret);
    }
    expect(requests.filter(request => request.method === "POST" && new URL(request.url).pathname.startsWith("/api/"))).toEqual([]);
  });
}

test("callbackWithoutTokenRemainsNeutral", async ({ page }) => {
  for (const route of callbackRoutes) {
    const requests = observeRequests(page);
    const response = await page.goto(`${route}#unrelated=discard`, { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`${route}$`));
    await expect(page.locator('input[type="password"]')).toHaveCount(2);
    expect(requests.filter(request => request.method === "POST" && new URL(request.url).pathname.startsWith("/api/"))).toEqual([]);
  }
});

test("callbacksLoadNoThirdPartyScripts", async ({ page }) => {
  const scripts: string[] = [];
  page.on("request", request => {
    if (request.resourceType() === "script") scripts.push(request.url());
  });
  for (const route of callbackRoutes) {
    await page.goto(route, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: route === "/verify-email" ? "Xác minh email" : "Đặt lại mật khẩu" })).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(2);
    const origin = new URL(page.url()).origin;
    const scriptSources = await page.locator("script[src]").evaluateAll(elements => elements.map(element => (element as HTMLScriptElement).src));
    expect([...scripts, ...scriptSources].every(source => new URL(source).origin === origin)).toBe(true);
  }
});
