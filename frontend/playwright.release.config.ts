import { defineConfig } from "@playwright/test";
import path from "node:path";

const baseURL = process.env.PLAYWRIGHT_BASE_URL;
const outputDir = process.env.DAYFORGE_RELEASE_OUTPUT_DIR;
if (!baseURL || !outputDir) {
  throw new Error("The guarded release runner must provide origin and private output directory.");
}

const origin = new URL(baseURL);
if (origin.protocol !== "https:" || origin.origin !== baseURL || origin.pathname !== "/") {
  throw new Error("Release rehearsal requires the exact HTTPS origin root.");
}

export default defineConfig({
  testDir: "./tests/release",
  outputDir: path.resolve(outputDir),
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
