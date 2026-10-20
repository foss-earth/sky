import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The shared-memory sky core: one module for a coordinator and its helper
// workers over one imported shared memory. Stable Rust with the atomics target
// feature; no nightly, build-std or wasm-bindgen. The crate is no_std with no
// allocator or thread-local storage, so std's single-threaded runtime is never
// linked. rustc warns that `atomics` is an unstable target feature; the output
// is checked structurally below and functionally by scripts/check-sky-shared.mjs.
const root = fileURLToPath(new URL("../", import.meta.url));
// Intermediates go under the owning repository's ignored build/.
const targetDirectory = path.join(root, "..", "build", path.basename(root), "target", "shared");
const lock = JSON.parse(readFileSync(path.join(root, "toolchain.lock.json")));
const shared = lock.threaded;
if (!shared?.maximumMemoryBytes || !shared.stackBytes || !shared.targetFeatures) throw new Error("toolchain.lock.json has no threaded build entry");
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`);
  return { stdout: result.stdout.trim(), stderr: result.stderr };
}
const rust = run("rustup", ["run", "stable", "rustc", "--version"]).stdout;
const cargo = run("rustup", ["run", "stable", "cargo", "--version"]).stdout;
if (!rust.startsWith(`rustc ${lock.rust} `) || !cargo.startsWith(`cargo ${lock.cargo} `)) throw new Error("Installed Rust/cargo differs from toolchain.lock.json; nothing was installed");
const binaryenDir = process.env.BINARYEN_BIN ?? (existsSync("/opt/homebrew/opt/emscripten/libexec/binaryen/bin/wasm-opt") ? "/opt/homebrew/opt/emscripten/libexec/binaryen/bin" : "");
const binaryen = process.env.WASM_OPT ?? (binaryenDir ? path.join(binaryenDir, "wasm-opt") : "wasm-opt");
const disassembler = binaryenDir ? path.join(binaryenDir, "wasm-dis") : "wasm-dis";
const optimizer = run(binaryen, ["--version"]).stdout;
if (!new RegExp(`\\b${lock.binaryen}\\b`).test(optimizer)) throw new Error("Binaryen differs from toolchain.lock.json");
const flags = [
  `-C target-feature=${shared.targetFeatures.map(feature => `+${feature}`).join(",")}`,
  "-C link-arg=--shared-memory", "-C link-arg=--import-memory",
  `-C link-arg=--max-memory=${shared.maximumMemoryBytes}`, `-C link-arg=-zstack-size=${shared.stackBytes}`,
  "-C link-arg=--export=__stack_pointer",
].join(" ");
const sha = file => createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex");
function files(directory) {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  }).sort();
}

const crate = "earth-sky-shared";
const args = ["+stable", "build", "-p", crate, "--release", "--locked", "--offline", "--target", lock.target];
const built = run("cargo", args, { ...process.env, RUSTFLAGS: flags, CARGO_TARGET_DIR: targetDirectory });
const warnings = [...new Set(built.stderr.split("\n").filter(line => /^warning: /.test(line) && !/generated \d+ warning/.test(line)).map(line => line.slice(9)))];
const allowed = ["unstable feature specified for `-Ctarget-feature`: `atomics`"];
if (warnings.some(warning => !allowed.includes(warning))) throw new Error(`Unexpected build warnings: ${warnings.join("; ")}`);
const input = path.join(targetDirectory, lock.target, "release", `${crate.replaceAll("-", "_")}.wasm`);
const output = "shared/sky-shared.wasm";
mkdirSync(path.dirname(path.join(root, output)), { recursive: true });
const optimize = ["-O3", ...shared.targetFeatures.map(feature => `--enable-${({ simd128: "simd", atomics: "threads" })[feature] ?? feature}`), "--strip-debug"];
run(binaryen, [input, ...optimize, "-o", path.join(root, output)]);
const bytes = readFileSync(path.join(root, output));
if (bytes.length > lock.maximumBinaryBytes) throw new Error("sky-shared exceeds the declared binary size limit");

// Structural requirements of the threading model: names from the linked
// binary (wasm-opt strips them), the rest from the optimised one.
const linked = run(disassembler, [input]).stdout;
const text = run(disassembler, [path.join(root, output)]).stdout;
const pageBytes = 65536, maximumPages = shared.maximumMemoryBytes / pageBytes;
const memory = text.match(/\(import "env" "memory" \(memory \S+ (\d+) (\d+) shared\)\)/);
const imports = [...text.matchAll(/\(import "([^"]+)" "([^"]+)"/g)].map(match => `${match[1]}.${match[2]}`).sort();
const exported = [...text.matchAll(/\(export "([^"]+)"/g)].map(match => match[1]).sort();
const checks = {
  importsSharedMemory: Boolean(memory),
  minimumPages: memory ? Number(memory[1]) : null,
  maximumPages: memory ? Number(memory[2]) : null,
  importsOnlyMemoryAndMath: imports.every(name => name === "env.memory" || /^sky_math\.(exp|log|sqrt|sin|cos|pow)$/.test(name)),
  exportsStackPointer: exported.includes("__stack_pointer"),
  stackPointerStart: Number(linked.match(/\(global \$__stack_pointer \(mut i32\) \(i32\.const (\d+)\)\)/)?.[1] ?? NaN),
  noMemoryGrow: !/memory\.grow/.test(text),
  // The linker declares __tls_base for shared memory; nothing may use it.
  noThreadLocalStorage: !/__wasm_init_tls|__tls_size|__tls_align/.test(linked) && !/global\.(get|set) \$__tls_base/.test(linked),
  noAllocator: !/\b(__rust_alloc|__rdl_alloc|dlmalloc|__rust_realloc|__rust_dealloc)\b/.test(linked),
  atomicInstructions: (text.match(/i32\.atomic\./g) ?? []).length,
  onceOnlyDataInitialisation: /\(start \$__wasm_init_memory\)/.test(linked) && /\(start /.test(text),
};
if (!checks.importsSharedMemory || checks.maximumPages !== maximumPages || checks.minimumPages > maximumPages || !checks.importsOnlyMemoryAndMath
  || !checks.exportsStackPointer || checks.stackPointerStart !== shared.stackBytes || !checks.noMemoryGrow || !checks.noThreadLocalStorage || !checks.noAllocator
  || checks.atomicInstructions === 0 || !checks.onceOnlyDataInitialisation) {
  throw new Error(`sky-shared failed its structural checks: ${JSON.stringify(checks)}`);
}

const inputs = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "toolchain.lock.json", "scripts/build-shared.mjs",
  ...files(`crates/${crate}`), ...files("crates/earth-sky-kernel"),
  ...["threads.js", "sharedCore.js", "helper.js"].filter(file => existsSync(path.join(root, file)))];
const metadata = {
  schema: 1, core: "sky-shared", abiVersion: 1, rust, cargo, optimizer, target: lock.target,
  build: { command: ["cargo", ...args], rustflags: flags, optimize: ["wasm-opt", ...optimize], warnings },
  memory: { shared: true, imported: true, initialPages: maximumPages, maximumPages, stackBytes: shared.stackBytes, threadStackBytes: shared.threadStackBytes, maximumThreads: shared.maximumThreads, grows: false },
  checks, exports: exported, imports,
  inputs: Object.fromEntries(inputs.sort().map(file => [file, sha(file)])),
  outputs: { [output]: { sha256: sha(output), bytes: bytes.length } },
  threaded: true, functionality: "build receipt only; parity and concurrency evidence is recorded by scripts/check-sky-shared.mjs and tests/sky-shared.test.mjs", performance: "unmeasured", power: "unmeasured",
};
writeFileSync(path.join(root, "shared-build-metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
console.log(JSON.stringify({ core: "sky-shared", output, ...metadata.outputs[output], checks }));
