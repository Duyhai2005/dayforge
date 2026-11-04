import { defineConfig } from "@playwright/test";

const productionBaseURL = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./tests",
  testIgnore: ["**/offline-*.spec.ts", "**/staging/**", "**/release/**"],
  outputDir: "./.test-artifacts/web-dev",
  use: {
    baseURL: productionBaseURL ?? "http://127.0.0.1:3010",
    trace: "retain-on-failure",
    serviceWorkers: "block",
  },
  webServer: productionBaseURL
    ? undefined
    : {
        command: "pnpm exec next dev --hostname 127.0.0.1 --port 3010",
        url: "http://127.0.0.1:3010",
        env: {
          API_INTERNAL_ORIGIN: "http://127.0.0.1:8000",
          DAYFORGE_SYNC_TEST_HARNESS: "1",
        },
        reuseExistingServer: false,
      },
});
