const fs = require("node:fs");
const path = require("node:path");

const expected = "http://127.0.0.1:8000";
const frontendDir = path.join(__dirname, "..", "frontend");
const envFile = path.join(frontendDir, ".env.local");
let actual = process.env.API_INTERNAL_ORIGIN;

if (actual === undefined) {
  let contents;
  try {
    contents = fs.readFileSync(envFile, "utf8");
  } catch {
    console.error("frontend/.env.local is missing; run pnpm setup:local first.");
    process.exit(1);
  }

  // Use the env parser bundled with the pinned Next.js installation.
  const nextDir = path.dirname(require.resolve("next/package.json", { paths: [frontendDir] }));
  const { processEnv } = require(require.resolve("@next/env", { paths: [nextDir] }));
  const [combinedEnv] = processEnv(
    [{ path: ".env.local", contents, env: {} }], frontendDir, console, true,
  );
  actual = combinedEnv.API_INTERNAL_ORIGIN;

  if (actual === undefined) {
    console.error("frontend/.env.local must define API_INTERNAL_ORIGIN.");
    process.exit(1);
  }
}

if (actual !== expected) {
  console.error("API_INTERNAL_ORIGIN must be http://127.0.0.1:8000 before dev:web starts.");
  process.exit(1);
}
