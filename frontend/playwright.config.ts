import { defineConfig } from "@playwright/test";

const productionBaseURL = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./tests",
  outputDir: "./.next/playwright-results",
  use: {
    baseURL: productionBaseURL ?? "http://127.0.0.1:3010",
    trace: "retain-on-failure",
  },
  webServer: productionBaseURL
    ? undefined
    : {
        command: "pnpm exec next dev --hostname 127.0.0.1 --port 3010",
        url: "http://127.0.0.1:3010",
        env: { API_INTERNAL_ORIGIN: "http://127.0.0.1:8000" },
        reuseExistingServer: false,
      },
});
