const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const backend = path.join(root, "backend");
const windowsPython = path.join(backend, ".venv", "Scripts", "python.exe");
const unixPython = path.join(backend, ".venv", "bin", "python");
const python = process.platform === "win32" ? windowsPython : unixPython;
const uvProbe = spawnSync("uv", ["--version"], { cwd: root, stdio: "ignore" });

let command;
let args;
let cwd;
if (!uvProbe.error && uvProbe.status === 0) {
  command = "uv";
  args = ["run", "--directory", "backend", "--locked", "python", "../scripts/test_backend.py", "--mysql", "--sync-browser"];
  cwd = root;
} else if (existsSync(python)) {
  command = python;
  args = [path.join(root, "scripts", "test_backend.py"), "--mysql", "--sync-browser"];
  cwd = backend;
} else {
  process.stderr.write("Sync browser tests need uv or an existing backend/.venv Python environment.\n");
  process.exit(1);
}

const result = spawnSync(command, args, { cwd, env: process.env, stdio: "inherit" });
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
