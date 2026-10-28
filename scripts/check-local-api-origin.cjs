const fs = require("node:fs");
const path = require("node:path");

const expected = "http://127.0.0.1:8000";
const envFile = path.join(__dirname, "..", "frontend", ".env.local");
let actual = process.env.API_INTERNAL_ORIGIN;

if (actual === undefined) {
  let contents;
  try {
    contents = fs.readFileSync(envFile, "utf8");
  } catch {
    console.error("frontend/.env.local is missing; run pnpm setup:local first.");
    process.exit(1);
  }

  const values = contents
    .split(/\r?\n/)
    .filter((line) => line.startsWith("API_INTERNAL_ORIGIN="))
    .map((line) => line.slice("API_INTERNAL_ORIGIN=".length));

  if (values.length !== 1) {
    console.error("frontend/.env.local must define API_INTERNAL_ORIGIN exactly once.");
    process.exit(1);
  }
  [actual] = values;
}

if (actual !== expected) {
  console.error("API_INTERNAL_ORIGIN must be http://127.0.0.1:8000 before dev:web starts.");
  process.exit(1);
}
