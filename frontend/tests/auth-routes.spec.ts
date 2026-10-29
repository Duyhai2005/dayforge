import { expect, test, type Page, type Request } from "@playwright/test";

const callbackRoutes = ["/verify-email", "/reset-password"] as const;
const token = "dayforge-test-token";
const incompleteStatus = "Chức năng tài khoản chưa được kết nối.";

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
  await expect(page.getByRole("status")).toHaveText(incompleteStatus);
  await expect(page.locator("form, input[type=password]")).toHaveCount(0);
  expect(await page.locator("html").innerHTML()).not.toContain(token);
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(JSON.stringify(storage)).not.toContain(token);
  expect(JSON.stringify(requests)).not.toContain(token);
  expect(requests.filter(request => request.method === "POST" && new URL(request.url).pathname.startsWith("/api/"))).toEqual([]);
  expect(errors.join("\n")).not.toContain(token);
}

test("accountRouteIsAnExplicitPlaceholder", async ({ page }) => {
  const response = await page.goto("/account");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Tài khoản", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText(incompleteStatus);
  await expect(page.locator("form, input[type=password]")).toHaveCount(0);
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

test("callbackWithoutTokenRemainsNeutral", async ({ page }) => {
  for (const route of callbackRoutes) {
    const requests = observeRequests(page);
    const response = await page.goto(`${route}#unrelated=discard`, { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`${route}$`));
    await expect(page.getByRole("status")).toHaveText(incompleteStatus);
    expect(requests.filter(request => new URL(request.url).pathname.startsWith("/api/"))).toEqual([]);
  }
});

test("callbacksLoadNoThirdPartyScripts", async ({ page }) => {
  const scripts: string[] = [];
  page.on("request", request => {
    if (request.resourceType() === "script") scripts.push(request.url());
  });
  for (const route of callbackRoutes) {
    await page.goto(route, { waitUntil: "networkidle" });
    await expect(page.getByRole("status")).toHaveText(incompleteStatus);
    const origin = new URL(page.url()).origin;
    const scriptSources = await page.locator("script[src]").evaluateAll(elements => elements.map(element => (element as HTMLScriptElement).src));
    expect([...scripts, ...scriptSources].every(source => new URL(source).origin === origin)).toBe(true);
  }
});
