import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./.next/playwright-results",
  use: { baseURL: "http://127.0.0.1:3001" },
  webServer: {
    command: "pnpm start",
    url: "http://127.0.0.1:3001",
    env: { API_INTERNAL_ORIGIN: "http://127.0.0.1:8000" },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
