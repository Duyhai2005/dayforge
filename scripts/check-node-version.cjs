const { engines } = require("../package.json");
const actual = process.versions.node;
const expected = engines.node;

if (actual !== expected) {
  console.error(`DAYFORGE requires Node.js ${expected}; current runtime is ${actual}.`);
  process.exit(1);
}
