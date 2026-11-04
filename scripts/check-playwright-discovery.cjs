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
];

for (const check of checks) {
  const env = { ...process.env };
  if (check.suite === "staging") env.PLAYWRIGHT_BASE_URL = "https://staging.example.test";
  else delete env.PLAYWRIGHT_BASE_URL;
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
      : basenames.length > 0 && basenames.every((name) => ["routes.spec.ts", "auth.spec.ts", "calendar.spec.ts", "offline-sync.spec.ts"].includes(name));
  if (!valid) {
    process.stderr.write(`${check.config} discovered an unexpected test set:\n${output}`);
    process.exit(1);
  }
  process.stdout.write(`${check.config}: ${listed.length} tests; suite isolation verified\n`);
}
