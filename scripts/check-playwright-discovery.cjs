const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const frontend = path.join(root, "frontend");
const cli = path.join(frontend, "node_modules", "@playwright", "test", "cli.js");
const checks = [
  { config: "playwright.config.ts", expectOffline: false, expectExisting: true },
  { config: "playwright.production.config.ts", expectOffline: false, expectExisting: true },
  { config: "playwright.offline.config.ts", expectOffline: true, expectExisting: false },
];

for (const check of checks) {
  const result = spawnSync(process.execPath, [cli, "test", `--config=${check.config}`, "--list"], {
    cwd: frontend,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr || result.error?.message || `${check.config} discovery failed\n`);
    process.exit(result.status || 1);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const listed = [...output.matchAll(/^\s+([^\s:]+\.spec\.ts):/gm)].map((match) => match[1]);
  const hasOffline = listed.some((name) => name.startsWith("offline-"));
  const hasExisting = listed.some((name) => !name.startsWith("offline-"));
  if (hasOffline !== check.expectOffline || hasExisting !== check.expectExisting) {
    process.stderr.write(`${check.config} discovered an unexpected test set:\n${output}`);
    process.exit(1);
  }
  process.stdout.write(`${check.config}: ${listed.length} tests; offline isolation verified\n`);
}
