const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const frontend = path.join(root, "frontend");
const usage = "Usage: node scripts/run_staging_acceptance.cjs --config <staging.json> --release <release.json> --output <private-dir> [-- <Playwright args>]";

function fail(code, exitCode = 2) {
  process.stderr.write(`${code}\n`);
  process.exit(exitCode);
}

function parseArguments(argv) {
  const separator = argv.indexOf("--");
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const playwrightArgs = separator < 0 ? [] : argv.slice(separator + 1);
  const values = {};
  for (let index = 0; index < options.length; index += 1) {
    const item = options[index];
    const match = /^--(config|release|output)=(.+)$/.exec(item);
    if (match) {
      if (values[match[1]]) fail("staging_arguments_invalid");
      values[match[1]] = match[2];
      continue;
    }
    if (!["--config", "--release", "--output"].includes(item) || values[item.slice(2)]) {
      fail("staging_arguments_invalid");
    }
    const next = options[index + 1];
    if (!next || next.startsWith("--")) fail("staging_arguments_invalid");
    values[item.slice(2)] = next;
    index += 1;
  }
  if (!(values.config && values.release && values.output)) fail(`staging_arguments_invalid\n${usage}`);
  return { values, playwrightArgs };
}

function validatePlaywrightArgs(args) {
  const valueOptions = new Set(["--grep", "--grep-invert"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const key = argument.split("=", 1)[0];
    if (valueOptions.has(key)) {
      if (!argument.includes("=") && (!args[index + 1] || args[index + 1].startsWith("--"))) {
        fail("staging_playwright_arguments_invalid");
      }
      if (!argument.includes("=")) index += 1;
      continue;
    }
    fail("staging_playwright_arguments_invalid");
  }
}

const { values, playwrightArgs } = parseArguments(process.argv.slice(2));
validatePlaywrightArgs(playwrightArgs);
for (const variable of [
  "DAYFORGE_SYNC_TEST_HARNESS",
  "DAYFORGE_OFFLINE_UPDATE_TEST_HARNESS",
  "DAYFORGE_PLAYWRIGHT_MOCK_API",
]) {
  if (process.env[variable]) fail("staging_harness_environment_detected");
}
if (process.env.PLAYWRIGHT_BASE_URL && process.env.PLAYWRIGHT_BASE_URL !== "") {
  const selectedOrigin = process.env.PLAYWRIGHT_BASE_URL.replace(/\/$/, "");
  const configuredOrigin = (() => {
    try {
      const raw = fs.readFileSync(path.resolve(values.config), "utf8");
      return JSON.parse(raw).public_origin;
    } catch {
      return null;
    }
  })();
  if (!configuredOrigin || selectedOrigin !== configuredOrigin) fail("staging_origin_mismatch");
}

const credentialsPath = process.env.DAYFORGE_STAGING_CREDENTIALS_FILE;
if (!credentialsPath) fail("staging_credentials_path_required");
const python = process.env.PYTHON || (process.platform === "win32" ? "py" : "python3");
const pythonVersionArgs = process.env.PYTHON || process.platform !== "win32" ? [] : ["-3.14"];
const absolute = (value) => path.resolve(process.cwd(), value);
const preflight = spawnSync(python, [
  ...pythonVersionArgs,
  path.join(root, "scripts", "staging_acceptance.py"),
  "--config", absolute(values.config),
  "--release", absolute(values.release),
  "--credentials", absolute(credentialsPath),
  "--output", absolute(values.output),
], { cwd: root, encoding: "utf8", windowsHide: true });
if (preflight.error || preflight.status !== 0) fail("staging_preflight_failed");

let target;
try {
  target = JSON.parse(preflight.stdout);
} catch {
  fail("staging_preflight_invalid_output");
}

const environment = { ...process.env };
for (const variable of [
  "DAYFORGE_SYNC_TEST_HARNESS",
  "DAYFORGE_OFFLINE_UPDATE_TEST_HARNESS",
  "DAYFORGE_PLAYWRIGHT_MOCK_API",
  "API_INTERNAL_ORIGIN",
  "PLAYWRIGHT_HTML_OUTPUT_DIR",
  "PLAYWRIGHT_JSON_OUTPUT_NAME",
  "PLAYWRIGHT_JUNIT_OUTPUT_NAME",
  "PLAYWRIGHT_BLOB_OUTPUT_DIR",
  "PLAYWRIGHT_BLOB_OUTPUT_NAME",
]) delete environment[variable];
environment.PLAYWRIGHT_BASE_URL = target.origin;
environment.DAYFORGE_STAGING_ORIGIN = target.origin;
environment.DAYFORGE_STAGING_RELEASE_FILE = target.release_path;
environment.DAYFORGE_STAGING_CREDENTIALS_FILE = target.credentials_path;
environment.DAYFORGE_STAGING_OUTPUT_DIR = target.output_path;

const cli = path.join(frontend, "node_modules", "@playwright", "test", "cli.js");
const result = spawnSync(process.execPath, [
  cli,
  "test",
  "--config=playwright.staging.config.ts",
  "--reporter=line",
  ...playwrightArgs,
], {
  cwd: frontend,
  env: environment,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) fail("staging_playwright_launch_failed", 1);
process.exit(result.status ?? 1);
