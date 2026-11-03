const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { mkdirSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const frontendDirectory = process.cwd();
const buildId = process.env.DAYFORGE_BUILD_ID || randomUUID();
if (!/^[A-Za-z0-9._-]{1,128}$/.test(buildId)) {
  throw new Error("DAYFORGE_BUILD_ID must be 1..128 safe ASCII characters.");
}

const build = spawnSync(process.execPath, ["./node_modules/next/dist/bin/next", "build"], {
  cwd: frontendDirectory,
  stdio: "inherit",
  env: {
    ...process.env,
    NEXT_PUBLIC_DAYFORGE_BUILD_ID: buildId,
  },
});

if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const publicDirectory = path.join(frontendDirectory, "public");
mkdirSync(publicDirectory, { recursive: true });
const staticDirectory = path.join(frontendDirectory, ".next", "static");
function collectStaticAssets(directory, relativeDirectory = "") {
  const assets = [];
  for (const entry of readdirSync(directory)) {
    const absolutePath = path.join(directory, entry);
    const relativePath = path.join(relativeDirectory, entry).split(path.sep).join("/");
    if (statSync(absolutePath).isDirectory()) {
      assets.push(...collectStaticAssets(absolutePath, relativePath));
    } else if (!relativePath.endsWith(".map")) {
      assets.push(`/_next/static/${relativePath}`);
    }
  }
  return assets.sort();
}
writeFileSync(
  path.join(publicDirectory, "dayforge-build.json"),
  `${JSON.stringify({
    build_id: buildId,
    protocol_version: 1,
    schema_version: 2,
    routes: ["/work", "/milestones"],
    assets: collectStaticAssets(staticDirectory),
  })}\n`,
  { encoding: "utf8" },
);
