import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(argument => {
  const at = argument.indexOf("=");
  if (!argument.startsWith("--") || at < 0) throw new Error("Use --name=value arguments with exact archive SHA-256 values.");
  return [argument.slice(2, at), argument.slice(at + 1)];
}));
const output = path.resolve(args.out ?? path.join(root, "build", "installed-consumer", new Date().toISOString().replace(/[:.]/g, "-")));
assert.ok(output.startsWith(path.join(root, "build") + path.sep), "Output must stay in this owner's build directory.");
const workspace = path.join(output, "workspace"), dependencies = {}, digests = {};
mkdirSync(workspace, { recursive: true });
for (const [key, name] of [["sky", "@foss-earth/sky"], ["ui", "@foss-earth/ui"], ["babylon", "@babylonjs/core"], ["typescript", "typescript"]]) {
  assert.ok(args[key], `Missing --${key}`);
  assert.match(args[`${key}-sha256`] ?? "", /^[a-f0-9]{64}$/, `Missing --${key}-sha256`);
  const archive = path.resolve(args[key]), sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  assert.equal(sha256, args[`${key}-sha256`], `${key} archive differs from the provided exact pin`);
  dependencies[name] = `file:${archive}`;
  digests[name] = sha256;
}
writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "sky-public-artifact-fixture", version: "1.0.0", private: true, type: "module", dependencies }, null, 2));
const run = (command, argv, log, extra = {}) => {
  const filename = path.join(output, log), fd = openSync(filename, "w");
  let result;
  const env = { ...process.env,...extra.env };delete env.NODE_PATH;delete env.NODE_OPTIONS;
  try { result = spawnSync(command, argv, { cwd: workspace, ...extra,env, stdio: ["ignore", fd, fd] }); }
  finally { closeSync(fd); }
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Consumer failed; inspect ${filename}`);
  return readFileSync(filename, "utf8");
};
run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", path.join(root, "build", "npm-cache")], "install.log");
const installedVersions = {};
for (const [name,version] of [["@foss-earth/sky","0.1.0"],["@foss-earth/ui","0.1.0"],["@babylonjs/core","8.56.2"],["typescript","5.9.3"]]) {
  const installed = JSON.parse(readFileSync(path.join(workspace,"node_modules",name,"package.json"),"utf8"));assert.equal(installed.name,name);assert.equal(installed.version,version,`Exact installed version for ${name}`);installedVersions[name]=installed.version;
}
writeFileSync(path.join(workspace, "guard.mjs"), `
import { registerHooks } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = realpathSync(${JSON.stringify(workspace)}) + path.sep;
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (result.url.startsWith("node:")) return result;
  if (!result.url.startsWith("file:")) throw new Error("UNSUPPORTED_MODULE_PROTOCOL: " + result.url);
  if (result.url.startsWith("file:")) {
    const resolved = realpathSync(fileURLToPath(result.url));
    if (!resolved.startsWith(root)) throw new Error("OUTSIDE_ISOLATED_WORKSPACE: " + resolved);
    if (process.env.SKY_FORBID_PEERS === "1" && /[/\\\\]node_modules[/\\\\](?:@babylonjs[/\\\\]core|@foss-earth[/\\\\](?:ui|engine|renderer)|react(?:-dom)?)(?:[/\\\\]|$)/.test(resolved)) throw new Error("PURE_IMPORTED_PEER: " + resolved);
  }
  return result;
}});
`);
for (const name of ["minimal", "babylon"]) writeFileSync(path.join(workspace, `${name}.mjs`), readFileSync(path.join(root, "fixtures", "consumer", `${name}.mjs`)));
run(process.execPath, ["--import", "./guard.mjs", "./minimal.mjs"], "pure-runtime.log", { env: { ...process.env, SKY_FORBID_PEERS: "1" } });
run(process.execPath, ["--import", "./guard.mjs", "./babylon.mjs"], "babylon-runtime.log");
writeFileSync(path.join(output, "outside.mjs"), "export const outside = true;\n");
writeFileSync(path.join(workspace, "negative.mjs"), `import assert from "node:assert/strict"; await assert.rejects(import(${JSON.stringify(path.join(output, "outside.mjs"))}), /OUTSIDE_ISOLATED_WORKSPACE/);`);
run(process.execPath, ["--import", "./guard.mjs", "./negative.mjs"], "isolation-negative.log");
writeFileSync(path.join(workspace, "peer-negative.mjs"), `import assert from "node:assert/strict"; await assert.rejects(import("@babylonjs/core"), /PURE_IMPORTED_PEER/);`);
run(process.execPath, ["--import", "./guard.mjs", "./peer-negative.mjs"], "peer-negative.log",{ env: { SKY_FORBID_PEERS: "1" } });
writeFileSync(path.join(workspace, "public.ts"), readFileSync(path.join(root, "fixtures", "consumer", "minimal.ts")));
writeFileSync(path.join(workspace, "pure.ts"), `import { solarEphemeris, observerFromGeodetic, whiteLuminanceForEv100, type SkyObserver } from "@foss-earth/sky";
const observer: SkyObserver = observerFromGeodetic([6378137,0,0],{latRad:0,lonRad:0,altMeters:0});
void [observer,solarEphemeris(0),whiteLuminanceForEv100(0)];\n`);
for (const [name, lib] of [["pure", ["ES2023"]], ["public", ["ES2023", "DOM", "DOM.Iterable"]]]) {
  const config = { compilerOptions: { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", lib, types: [], noEmit: true, strict: true, skipLibCheck: false, incremental: true, tsBuildInfoFile: `node_modules/.tmp/${name}.tsbuildinfo` }, files: [`${name}.ts`] };
  writeFileSync(path.join(workspace, `tsconfig.${name}.json`), JSON.stringify(config, null, 2));
  const trace = run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", `tsconfig.${name}.json`, "--traceResolution"], `${name}-types.log`);
  const resolvedWorkspace = realpathSync(workspace) + path.sep;
  for (const match of trace.matchAll(/successfully resolved to '([^']+)'/g)) assert.ok(realpathSync(match[1]).startsWith(resolvedWorkspace), `Type resolution escaped workspace: ${match[1]}`);
}
writeFileSync(path.join(workspace,"declaration-closure.mjs"), `import ts from "typescript";import assert from "node:assert/strict";import {realpathSync} from "node:fs";import path from "node:path";
const root=realpathSync(process.cwd())+path.sep;
for(const name of ["pure","public"]){const filename="tsconfig."+name+".json",config=ts.readConfigFile(filename,ts.sys.readFile);if(config.error)throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText,"\\n"));const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,process.cwd());const program=ts.createProgram(parsed.fileNames,parsed.options);for(const file of program.getSourceFiles())assert(realpathSync(file.fileName).startsWith(root),"Declaration escaped isolated workspace: "+file.fileName);if(name==="pure")for(const file of program.getSourceFiles())assert(!/[/\\\\]node_modules[/\\\\](?:@babylonjs[/\\\\]core|@foss-earth[/\\\\](?:ui|engine|renderer)|react(?:-dom)?)(?:[/\\\\]|$)/.test(realpathSync(file.fileName)),"Pure declaration imported peer: "+file.fileName);}
console.log("All pure/public declaration files remain in the installed workspace.");`);
run(process.execPath,["--import","./guard.mjs","./declaration-closure.mjs"],"declaration-closure.log");
const manifest = JSON.parse(readFileSync(path.join(workspace, "node_modules", "@foss-earth", "sky", "package.json"), "utf8"));
const receipt = { status: "local-installed-fixtures-passed", package: manifest.name, version: manifest.version, exactArtifactDigests: digests,installedVersions,
  entries: Object.keys(manifest.exports), checks: ["exact archive digests", "offline installed archives", "realpath resolution guard", "negative isolation control", "pure no DOM/peer access", "provided NullEngine Scene/Sky settings binding", "strict pure/public declarations and resolution"],
  runtime: { node: process.version, platform: process.platform, arch: process.arch }, limitations: ["No hardware/GPU/browser visual qualification", "Source lineage/common CI conformance/full intended refs/actual app adoption/remote admission are separate gates"] };
writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
process.stdout.write(JSON.stringify({ output, receipt }) + "\n");
