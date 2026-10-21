import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MessageChannel, Worker } from "node:worker_threads";
import { createSkyEvaluationState, lunarEphemeris, observerFromGeodetic, solarEphemeris } from "@foss-earth/sky";
import { createSharedSkyCore } from "../sharedCore.js";
import { runSkySharedHelper } from "../helper.js";
import { CONTROL, FIELD, MAX_THREADS, MEMORY_PAGES, STATUS, mathImports } from "../threads.js";

// Adversarial ownership and concurrency checks of the shared sky core with
// real worker_threads helpers over one shared WebAssembly.Memory.
const wasm = new URL("../shared/sky-shared.wasm", import.meta.url);
const bytes = readFileSync(wasm);
const module = await WebAssembly.compile(bytes);
const fixture = new URL("./fixtures/sky-shared-helper.mjs", import.meta.url);
const PARAMETERS = { aerosolOpticalDepth: 0.1, groundAlbedo: 0.3 };
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

function startCore(modes, options = {}) {
  const core = createSharedSkyCore(module, { helpers: modes.length, ...options });
  const workers = modes.map(mode => {
    const worker = new Worker(fixture, { workerData: typeof mode === "string" ? { mode } : mode });
    worker.on("error", () => {});
    const { port1, port2 } = new MessageChannel();
    worker.postMessage({ kind: "sky-shared-port", port: port2 }, [port2]);
    assert.equal(core.connectHelper(port1), true);
    return worker;
  });
  if (modes.length) assert.equal(core.waitForHelpers(modes.length, 10_000), true, "helpers start");
  return { core, workers, async close() { core.dispose(); await Promise.all(workers.map(worker => worker.terminate())); } };
}
/** A batch of `rows` rows of `count` directions whose expected bits come from a solo core. */
function batch(rows, count, { steps = 16, altitude = 260, muSun = 0.3, seed = 0 } = {}) {
  const mus = Float64Array.from({ length: rows }, (_, r) => Math.cos((r + 0.5 + seed * 0.1) / rows * Math.PI));
  const counts = new Uint32Array(rows).fill(count);
  const nus = Float64Array.from({ length: rows * count }, (_, i) => Math.cos(i * 0.37 + seed));
  return { altitude, muSun, rows, mus, counts, nus, steps, out: new Float64Array(rows * count * 3) };
}
const run = (kernel, job) => kernel.radianceFanRows(job.altitude, job.muSun, job.rows, job.mus, job.counts, job.nus, job.steps, job.out);
const solo = createSharedSkyCore(module, { helpers: 0 });
const snapshot = solo.createTables(PARAMETERS);
const soloKernel = solo.createAtmosphere(snapshot);
function expected(job) {
  const copy = { ...job, out: new Float64Array(job.out.length) };
  assert.equal(run(soloKernel, copy), "solo");
  return copy.out;
}
const bitsOf = array => Buffer.from(array.buffer, array.byteOffset, array.byteLength);
const assertSameBits = (actual, wanted, message) => assert.ok(bitsOf(actual).equals(bitsOf(wanted)), message);
test("admitted widths change only between generations and preserve exact rows through shrink and recovery", async () => {
  const { core, close } = startCore(["normal", "normal", "normal"]);
  try {
    const kernel = core.createAtmosphere(snapshot);
    for (const lanes of [4, 1, 2, 1, 4]) {
      core.setActiveThreads(lanes);
      const job = batch(24, 64, { seed: lanes });
      run(kernel, job); assertSameBits(job.out, expected(job));
      assert.ok(core.status().lastBatch.rowsByThread.slice(lanes).every(rows => rows === 0), "no unadmitted helper computed a row");
      if (lanes === 1) assert.equal(core.status().lastBatch.mode, "solo");
    }
    assert.throws(() => core.setActiveThreads(0)); assert.throws(() => core.setActiveThreads(9));
  } finally { await close(); }
});
function assertRetired(core, kernel, reason) {
  assert.equal(core.status().actual, "retired");
  assert.equal(core.status().retiredReason, reason);
  assert.throws(() => run(kernel, batch(4, 64)), error => error.reason === reason);
  assert.throws(() => core.createAtmosphere(snapshot), error => error.reason === reason);
}

test("parallel batches are bit-identical to one thread and every participant claims rows", async () => {
  const { core, close } = startCore(["normal", "normal", "normal"]);
  try {
    const kernel = core.createAtmosphere(snapshot);
    for (let seed = 0; seed < 20; seed++) {
      const job = batch(32, 64, { seed, muSun: -0.05 + seed * 0.05 });
      assert.equal(run(kernel, job), "parallel");
      assertSameBits(job.out, expected(job), `batch ${seed}`);
      const last = core.status().lastBatch;
      assert.equal(last.rowsByThread.reduce((sum, rows) => sum + rows, 0), 32);
    }
    const status = core.status();
    assert.equal(status.actual, "threaded");
    assert.equal(status.sharedMemory, true);
    assert.equal(status.threads.ready, 4);
    assert.ok(status.rowsByThread.slice(1, 4).some(rows => rows > 0), "helpers did work");
    assert.equal(status.copiedInBytes, 20 * (32 * 64 * 8 + 32 * 16));
    assert.equal(status.copiedOutBytes, 20 * 32 * 64 * 24);
    const stack = core.stackUse();
    assert.ok(stack[0] > 0 && stack[0] < 65536 - 4096 && stack.slice(1, 4).every(use => use > 0 && use < 65536 - 4096));
  } finally { await close(); }
});

test("small batches stay on the coordinator without waking helpers", async () => {
  const { core, close } = startCore(["normal"]);
  try {
    const kernel = core.createAtmosphere(snapshot);
    const job = batch(4, 32, { steps: 16 });
    assert.equal(run(kernel, job), "solo");
    assertSameBits(job.out, expected(job));
    const { lastBatch, parallelBatches } = core.status();
    assert.equal(parallelBatches, 0);
    assert.equal(lastBatch.helpersReady, 1);
    assert.deepEqual(lastBatch.rowsByThread.slice(0, 2), [4, 0]);
  } finally { await close(); }
});

test("helpers that wake late for a closed generation never write into a later one", async () => {
  const { core, close } = startCore([{ mode: "late", delayMs: 2 }, { mode: "late", delayMs: 3 }, "normal"]);
  try {
    const kernel = core.createAtmosphere(snapshot);
    for (let seed = 0; seed < 300; seed++) {
      // Alternating shapes and sizes so a stale participant would be visible.
      const job = seed % 3 === 0 ? batch(64, 64, { seed }) : batch(2 + (seed % 5), 2048 / (2 + (seed % 5)) | 0, { seed, steps: 16 });
      run(kernel, job);
      assertSameBits(job.out, expected(job), `batch ${seed}`);
      const last = core.status().lastBatch;
      assert.equal(last.rowsByThread.reduce((sum, rows) => sum + rows, 0), job.rows);
    }
    assert.equal(core.status().actual, "threaded");
  } finally { await close(); }
});

test("a helper that dies holding a claimed row retires the core within its deadline", async () => {
  const { core, workers, close } = startCore(["claim-and-exit"], { firstDeadlineMs: 150, deadlineMs: 100 });
  try {
    const kernel = core.createAtmosphere(snapshot);
    const exited = new Promise(resolve => workers[0].once("exit", resolve));
    const started = performance.now();
    assert.throws(() => run(kernel, batch(32, 64)), error => error.reason === "helper-timeout");
    assert.ok(performance.now() - started < 1000, "bounded");
    assertRetired(core, kernel, "helper-timeout");
    await exited;
  } finally { await close(); }
});

test("a helper that hangs holding a claimed row is abandoned with its memory", async () => {
  const { core, close } = startCore(["claim-and-hang", "normal"], { firstDeadlineMs: 150, deadlineMs: 100 });
  try {
    const kernel = core.createAtmosphere(snapshot);
    assert.throws(() => run(kernel, batch(32, 64)), error => error.reason === "helper-timeout");
    assertRetired(core, kernel, "helper-timeout");
  } finally { await close(); }
  // A new core has its own memory: nothing the abandoned helper still holds reaches it.
  const fresh = startCore(["normal"]);
  try {
    const job = batch(32, 64);
    assert.equal(run(fresh.core.createAtmosphere(snapshot), job), "parallel");
    assertSameBits(job.out, expected(job));
  } finally { await fresh.close(); }
});

test("a trapping helper stops, and the core retires without copying the batch out", async () => {
  const { core, close } = startCore(["trap", "normal"]);
  try {
    const kernel = core.createAtmosphere(snapshot);
    const job = batch(32, 64);
    job.out.fill(-1);
    assert.throws(() => run(kernel, job), error => error.reason === "helper-trapped" && error.status === STATUS.TRAP);
    assert.ok(job.out.every(value => value === -1), "caller's output untouched");
    assertRetired(core, kernel, "helper-trapped");
    for (let i = 0; i < 50 && core.status().threads.helpers[0].state !== "stopped"; i++) await tick(10);
    assert.deepEqual({ ...core.status().threads.helpers[0] }, { thread: 1, state: "stopped", reason: "trapped" });
  } finally { await close(); }
});

test("a helper that overwrites its stack slot's guard band retires the core", async () => {
  const { core, close } = startCore(["smash-stack"]);
  try {
    const kernel = core.createAtmosphere(snapshot);
    assert.throws(() => run(kernel, batch(32, 64)), error => error.reason === "stack-canary");
    assertRetired(core, kernel, "stack-canary");
  } finally { await close(); }
});

test("the module rejects every malformed job before any participant computes", () => {
  const core = createSharedSkyCore(module, { helpers: 0 });
  try {
    core.createAtmosphere(snapshot);
    // A second instance over the same memory, as a helper has.
    const { exports } = new WebAssembly.Instance(module, { env: { memory: core.memory }, sky_math: mathImports() });
    const buffer = core.memory.buffer, at = field => exports.sky_shared_layout(field);
    const job = new DataView(buffer, at(FIELD.JOB), 32), rows = new DataView(buffer, at(FIELD.ROWS), 16 * 4);
    const nus = new Float64Array(buffer, at(FIELD.NUS), 16), ctl = new Int32Array(buffer, at(FIELD.CONTROL), CONTROL.WORDS);
    const model = exports.sky_shared_model();
    function write({ altitude = 260, muSun = 0.3, rowCount = 2, steps = 16, total = 8, generation = model, layout = [[0, 4], [4, 4]], nu = 0.5 } = {}) {
      job.setFloat64(0, altitude, true); job.setFloat64(8, muSun, true);
      job.setUint32(16, rowCount, true); job.setUint32(20, steps, true); job.setUint32(24, total, true); job.setUint32(28, generation, true);
      layout.forEach(([start, count], r) => { rows.setFloat64(r * 16, 0.2, true); rows.setUint32(r * 16 + 8, start, true); rows.setUint32(r * 16 + 12, count, true); });
      nus.fill(nu);
    }
    write();
    assert.equal(exports.sky_shared_prepare(), STATUS.OK, "positive control");
    const cases = {
      "no rows": [{ rowCount: 0, total: 0 }, STATUS.INVALID],
      "too many rows": [{ rowCount: 513 }, STATUS.CAPACITY],
      "gap between rows": [{ layout: [[0, 4], [5, 3]] }, STATUS.INVALID],
      "overlapping rows": [{ layout: [[0, 4], [3, 5]] }, STATUS.INVALID],
      "empty row": [{ layout: [[0, 8], [8, 0]] }, STATUS.INVALID],
      "rows do not cover the directions": [{ total: 9 }, STATUS.INVALID],
      "too many steps": [{ steps: 257 }, STATUS.CAPACITY],
      "no steps": [{ steps: 0 }, STATUS.INVALID],
      "too many directions": [{ total: 65537, layout: [[0, 4], [4, 65533]] }, STATUS.CAPACITY],
      "stale model": [{ generation: model + 1 }, STATUS.NO_MODEL],
      "nonfinite direction": [{ nu: NaN }, STATUS.INVALID],
      "nonfinite altitude": [{ altitude: Infinity }, STATUS.INVALID],
    };
    for (const [name, [fields, status]] of Object.entries(cases)) {
      write(fields);
      const got = exports.sky_shared_prepare();
      assert.notEqual(got, STATUS.OK, name);
      assert.ok(got === status || got === STATUS.INVALID || got === STATUS.CAPACITY, `${name}: ${got}`);
      Atomics.store(ctl, CONTROL.ERROR, 0);
      Atomics.store(ctl, CONTROL.ROWS_DONE, 0);
      assert.notEqual(exports.sky_shared_fan_claimed(1), STATUS.OK, `${name}: a participant revalidates`);
      assert.equal(Atomics.load(ctl, CONTROL.ROWS_DONE), 0, `${name}: nothing computed`);
      Atomics.store(ctl, CONTROL.ERROR, 0);
    }
    write();
    assert.equal(exports.sky_shared_prepare(), STATUS.OK);
    assert.equal(exports.sky_shared_fan_claimed(MAX_THREADS), STATUS.THREAD, "no thread outside the stack slots");
  } finally { core.dispose(); }
});

test("batches outside the shared bounds return false and write nothing", () => {
  const core = createSharedSkyCore(module, { helpers: 0 }), kernel = core.createAtmosphere(snapshot);
  try {
    for (const job of [batch(2, 4097), batch(513, 1), batch(2, 8, { steps: 257 }), batch(17, 4096)]) {
      job.out.fill(-1);
      assert.equal(run(kernel, job), false);
      assert.ok(job.out.every(value => value === -1));
    }
    assert.throws(() => run(kernel, { ...batch(2, 8), out: new Float64Array(8) }), RangeError);
    assert.throws(() => run(kernel, { ...batch(2, 8), nus: new Float64Array(16).fill(NaN) }), RangeError);
  } finally { core.dispose(); }
});

test("a replaced model refuses work and a disposed kernel stays disposed", () => {
  const core = createSharedSkyCore(module, { helpers: 0 });
  try {
    const first = core.createAtmosphere(snapshot);
    const second = core.createAtmosphere(core.createTables({ aerosolOpticalDepth: 0.4, groundAlbedo: 0.3 }));
    assert.throws(() => run(first, batch(2, 8)), /replaced/);
    assert.equal(run(second, batch(2, 8)), "solo");
    second.dispose();
    assert.throws(() => run(second, batch(2, 8)), /disposed/);
    assert.equal(core.status().actual, "threaded", "misuse is refused without retiring");
  } finally { core.dispose(); }
});

test("memory is shared, bounded and never grows; the build receipt matches the binary", () => {
  const core = createSharedSkyCore(module, { helpers: 0 });
  try {
    assert.ok(core.memory.buffer instanceof SharedArrayBuffer);
    assert.equal(core.memory.buffer.byteLength, MEMORY_PAGES * 65536);
    assert.throws(() => core.memory.grow(1), RangeError);
  } finally { core.dispose(); }
  const metadata = JSON.parse(readFileSync(new URL("../shared-build-metadata.json", import.meta.url)));
  assert.equal(metadata.outputs["shared/sky-shared.wasm"].sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(Object.fromEntries(Object.entries(metadata.checks).filter(([key]) => typeof metadata.checks[key] === "boolean")),
    { importsSharedMemory: true, importsOnlyMemoryAndMath: true, exportsStackPointer: true, noMemoryGrow: true, noThreadLocalStorage: true, noAllocator: true, onceOnlyDataInitialisation: true });
  assert.equal(metadata.checks.maximumPages, MEMORY_PAGES);
});

test("repeated create and dispose stops every helper", async () => {
  for (let round = 0; round < 6; round++) {
    const { core, close } = startCore(["normal", "normal", "normal"]);
    try {
      const job = batch(16, 64, { seed: round });
      assert.equal(run(core.createAtmosphere(snapshot), job), "parallel");
      assertSameBits(job.out, expected(job));
      core.dispose();
      for (let i = 0; i < 100 && core.status().threads.helpers.some(helper => helper.state !== "stopped"); i++) await tick(5);
      assert.deepEqual(core.status().threads.helpers.map(helper => [helper.state, helper.reason]), [["stopped", "stopped"], ["stopped", "stopped"], ["stopped", "stopped"]]);
      assert.equal(core.connectHelper(new MessageChannel().port1), false, "a retired core takes no helpers");
    } finally { await close(); }
  }
});

test("neither the coordinator nor a helper runs in a page realm", () => {
  globalThis.document = {};
  try {
    assert.throws(() => createSharedSkyCore(module), /never a browser page/);
    assert.throws(() => runSkySharedHelper({}), /never a browser page/);
  } finally { delete globalThis.document; }
});

test("a sky evaluation whose helper traps mid-frame keeps exact output and reports why", async () => {
  const { core, close } = startCore(["trap"]);
  try {
    const utcMs = Date.UTC(2026, 9, 17, 23, 30), ephemeris = solarEphemeris(utcMs), lat = 44.98 * Math.PI / 180, lon = -93.27 * Math.PI / 180;
    const n = 6378137 / Math.sqrt(1 - 6.69437999014e-3 * Math.sin(lat) ** 2);
    const observer = observerFromGeodetic([(n + 260) * Math.cos(lat) * Math.cos(lon), (n + 260) * Math.cos(lat) * Math.sin(lon), (n * (1 - 6.69437999014e-3) + 260) * Math.sin(lat)], { latRad: lat, lonRad: lon, altMeters: 260 });
    const request = { parameters: PARAMETERS, ephemeris, lunar: lunarEphemeris(utcMs, ephemeris), observer, nightLuminance: 0.001, dome: { layout: { zenithSamples: 32, azimuthSamples: 32, integrationSteps: 16 }, moonlitSky: true } };
    const reference = createSkyEvaluationState({ now: () => performance.now() });
    const wanted = reference.evaluate(request).result;
    reference.dispose();
    const ports = { execution: "worker", kind: "threaded", createKernel: value => core.createAtmosphere(value), createTables: value => core.createTables(value) };
    const native = createSkyEvaluationState({ now: () => performance.now(), numericPorts: ports });
    const first = native.evaluate(request).result, second = native.evaluate(request).result;
    native.dispose();
    for (const result of [first, second]) {
      assertSameBits(result.dome.luminances, wanted.dome.luminances);
      assertSameBits(result.dome.directions, wanted.dome.directions);
    }
    assert.equal(first.numeric.actual, "typescript");
    assert.match(first.numeric.fallbackReason ?? "", /helper-trapped/);
    assert.equal(core.status().retiredReason, "helper-trapped");
  } finally { await close(); }
});

test.after(() => solo.dispose());
