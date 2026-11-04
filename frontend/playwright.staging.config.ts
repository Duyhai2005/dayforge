import { defineConfig } from "@playwright/test";
import path from "node:path";

const baseURL = process.env.PLAYWRIGHT_BASE_URL;
if (!baseURL) {
  throw new Error("PLAYWRIGHT_BASE_URL must be set by the staging acceptance runner.");
}

const origin = new URL(baseURL);
if (origin.protocol !== "https:" || origin.origin !== baseURL) {
  throw new Error("Staging Playwright requires an HTTPS origin without a path.");
}

export default defineConfig({
  testDir: "./tests/staging",
  outputDir: process.env.DAYFORGE_STAGING_OUTPUT_DIR ?? path.join(process.cwd(), ".test-artifacts/staging"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    baseURL,
    serviceWorkers: "allow",
    ignoreHTTPSErrors: false,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});
