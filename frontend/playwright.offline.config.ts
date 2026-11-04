import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3011";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["**/offline-*.spec.ts"],
  testIgnore: ["**/staging/**", "**/release/**"],
  outputDir: "./.test-artifacts/web-offline",
  use: {
    baseURL,
    trace: "retain-on-failure",
    serviceWorkers: "allow",
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "pnpm exec next start --hostname 127.0.0.1 --port 3011",
        url: baseURL,
        env: { API_INTERNAL_ORIGIN: "http://127.0.0.1:8000" },
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
