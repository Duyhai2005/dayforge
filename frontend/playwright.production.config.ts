import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testIgnore: ["**/offline-*.spec.ts", "**/staging/**", "**/release/**"],
  outputDir: "./.test-artifacts/web-prod",
  use: {
    baseURL: "http://127.0.0.1:3001",
    trace: process.env.DAYFORGE_RUN_DENSITY_BENCHMARK === "1" ? "off" : "retain-on-failure",
    serviceWorkers: "block",
  },
  webServer: {
    command: "pnpm start",
    url: "http://127.0.0.1:3001",
    env: {
      API_INTERNAL_ORIGIN: "http://127.0.0.1:8000",
      DAYFORGE_PLAYWRIGHT_MOCK_API: "1",
      DAYFORGE_SYNC_TEST_HARNESS: "1",
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
