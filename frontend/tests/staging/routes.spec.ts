import { expect, test } from "@playwright/test";
import { readStagingRelease } from "./fixtures";

test("publicCandidateMatchesImmutableRelease", async ({ page, request, baseURL }) => {
  const release = readStagingRelease();
  const manifestResponse = await request.get("/dayforge-build.json");
  expect(manifestResponse.status()).toBe(200);
  expect(manifestResponse.headers()["x-dayforge-build"]).toBe(release.build_id);
  const manifest = await manifestResponse.json() as Record<string, unknown>;
  expect(manifest).toMatchObject({
    build_id: release.build_id,
    protocol_version: 1,
    routes: ["/work", "/milestones"],
  });

  for (const route of ["/work", "/milestones"]) {
    const response = await request.get(route);
    expect(response.status(), route).toBe(200);
    expect(response.headers()["x-dayforge-build"], route).toBe(release.build_id);
  }

  await page.goto("/work");
  await expect(page.getByRole("heading", { name: "Lịch công việc" })).toBeVisible();
  expect(new URL(page.url()).origin).toBe(baseURL);
});

test("realApiAndServiceWorkerAreHealthyAndNotCached", async ({ request }) => {
  const health = await request.get("/api/v1/health");
  expect(health.status()).toBe(200);
  expect(health.headers()["cache-control"]).toContain("no-store");
  expect(await health.json()).toMatchObject({ status: "ok" });

  const version = await request.get("/api/v1/version");
  expect(version.status()).toBe(200);
  expect(version.headers()["cache-control"]).toContain("no-store");
  expect(await version.json()).toMatchObject({ protocol_versions: [1], reducer_versions: [1] });

  const serviceWorker = await request.get("/sw.js");
  expect(serviceWorker.status()).toBe(200);
  expect(serviceWorker.headers()["cache-control"]).toContain("no-store");
  expect(serviceWorker.headers()["service-worker-allowed"]).toBe("/");
});

test("authCallbacksArePrivateAndNeverUseHarnessRoutes", async ({ page, request }) => {
  for (const route of ["/verify-email", "/reset-password"]) {
    const response = await request.get(route);
    expect(response.status(), route).toBe(200);
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  }

  await page.goto("/verify-email#token=staging-sentinel-not-a-credential");
  await expect(page.getByRole("heading", { name: "Xác minh email" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");

  for (const route of ["/sync-browser", "/offline-update"]) {
    expect((await request.get(route)).status(), route).toBe(404);
  }
});

test("crossOriginAuthMutationIsRejectedBeforeAnyAccountChange", async ({ request }) => {
  const response = await request.post("/api/v1/auth/login", {
    headers: {
      Origin: "https://attacker.invalid",
      "Content-Type": "application/json",
    },
    data: {
      email: "staging-csrf-probe@example.invalid",
      password: "unused-staging-csrf-probe",
      remember_me: false,
    },
  });
  expect(response.status()).toBe(403);
  expect(response.headers()["cache-control"]).toContain("no-store");
});
