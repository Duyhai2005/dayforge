const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const frontend = path.join(root, "frontend");
const cli = path.join(frontend, "node_modules", "@playwright", "test", "cli.js");
const checks = [
  { config: "playwright.config.ts", suite: "regular" },
  { config: "playwright.production.config.ts", suite: "regular" },
  { config: "playwright.offline.config.ts", suite: "offline" },
  { config: "playwright.staging.config.ts", suite: "staging" },
  { config: "playwright.release.config.ts", suite: "release" },
];

for (const check of checks) {
  const env = { ...process.env };
  delete env.PLAYWRIGHT_BASE_URL;
  for (const name of Object.keys(env)) {
    if (name.startsWith("DAYFORGE_RELEASE_")) delete env[name];
  }
  if (check.suite === "staging") env.PLAYWRIGHT_BASE_URL = "https://staging.example.test";
  if (check.suite === "release") {
    const outputRoot = path.join(process.env.TEMP || process.env.TMP || "C:\\temp", "dayforge-release-discovery");
    env.PLAYWRIGHT_BASE_URL = "https://release.example.test";
    env.DAYFORGE_RELEASE_ORIGIN = "https://release.example.test";
    env.DAYFORGE_RELEASE_OUTPUT_DIR = path.join(outputRoot, "playwright");
    env.DAYFORGE_RELEASE_EVIDENCE_ROOT = outputRoot;
    env.DAYFORGE_RELEASE_RESULTS_FILE = path.join(outputRoot, "rehearsal-results.json");
  }
  const result = spawnSync(process.execPath, [cli, "test", `--config=${check.config}`, "--list"], {
    cwd: frontend,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr || result.error?.message || `${check.config} discovery failed\n`);
    process.exit(result.status || 1);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const listed = [...output.matchAll(/^\s+([^\s:]+\.spec\.ts):/gm)].map((match) => match[1]);
  const basenames = listed.map((name) => path.basename(name));
  const leakedStaging = check.suite !== "staging" && /(?:^|[\\/])staging[\\/]/m.test(output);
  const valid = check.suite === "regular"
    ? basenames.length > 0 && !basenames.some((name) => name.startsWith("offline-")) && !leakedStaging
    : check.suite === "offline"
      ? basenames.length > 0 && basenames.every((name) => name.startsWith("offline-")) && !leakedStaging
      : check.suite === "staging"
        ? basenames.length > 0 && basenames.every((name) => ["routes.spec.ts", "auth.spec.ts", "calendar.spec.ts", "offline-sync.spec.ts"].includes(name))
        : basenames.length > 0 && basenames.every((name) => ["update.spec.ts", "rollback.spec.ts", "restore.spec.ts"].includes(name));
  if (!valid) {
    process.stderr.write(`${check.config} discovered an unexpected test set:\n${output}`);
    process.exit(1);
  }
  process.stdout.write(`${check.config}: ${listed.length} tests; suite isolation verified\n`);
}
