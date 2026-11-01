import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

export function buildStorageBrowserHarness(globalName: string): string {
  const storageDir = path.resolve(__dirname, "../../lib/storage");
  const testsDir = path.resolve(__dirname, "..");
  const moduleSources: Record<string, string> = {};
  for (const file of fs.readdirSync(storageDir).filter((entry) => entry.endsWith(".ts"))) {
    const id = `lib/storage/${file.slice(0, -3)}`;
    const source = fs.readFileSync(path.join(storageDir, file), "utf-8");
    moduleSources[id] = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
  }
  const adapterPath = path.join(testsDir, "storage-api.ts");
  moduleSources["tests/storage-api"] = ts.transpileModule(fs.readFileSync(adapterPath, "utf-8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;

  const factories = Object.entries(moduleSources).map(([id, source]) => `${JSON.stringify(id)}: function(require, module, exports) {\n${source}\n}`).join(",");
  return `(function(){
    const factories = {${factories}};
    const cache = Object.create(null);
    function resolve(from, request) {
      if (!request.startsWith(".")) throw new Error("Unsupported storage harness import: " + request);
      const segments = from.split("/").slice(0, -1).concat(request.split("/"));
      const normalized = [];
      for (const segment of segments) {
        if (!segment || segment === ".") continue;
        if (segment === "..") normalized.pop(); else normalized.push(segment);
      }
      return normalized.join("/").replace(/\.ts$/, "");
    }
    function load(id) {
      if (cache[id]) return cache[id].exports;
      const factory = factories[id];
      if (factory === undefined) throw new Error("Storage harness module missing: " + id);
      const module = { exports: {} };
      cache[id] = module;
      const localRequire = (request) => load(resolve(id, request));
      factory(localRequire, module, module.exports);
      return module.exports;
    }
    window[${JSON.stringify(globalName)}] = load("tests/storage-api");
  })();`;
}
