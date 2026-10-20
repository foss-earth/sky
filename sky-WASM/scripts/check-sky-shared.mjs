import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { MessageChannel, Worker } from "node:worker_threads";
import { createSkyEvaluationState, lunarEphemeris, observerFromGeodetic, solarEphemeris } from "@foss-earth/sky";
import { createSharedSkyCore } from "../sharedCore.js";

// The real sky-shared.wasm with real helper threads (worker_threads over one
// shared WebAssembly.Memory) against the sky package's TypeScript, as built in
// dist/, through the
// evaluation a sky worker runs, at 1, 2, 4 and 8 threads.
const bytes = readFileSync(new URL("../shared/sky-shared.wasm", import.meta.url));
const module = await WebAssembly.compile(bytes);
const sha = value => createHash("sha256").update(value).digest("hex");
const sameBits = (a, b) => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
function same(a, b, path = "") {
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.constructor !== b.constructor || !sameBits(a, b)) throw new Error(`differs at ${path}`);
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) same(a[key], b[key], `${path}.${key}`);
    return;
  }
  if (!Object.is(a, b)) throw new Error(`differs at ${path}: ${a} vs ${b}`);
}
const hashOf = arrays => { const hash = createHash("sha256"); for (const array of arrays) hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength)); return hash.digest("hex"); };

const PARAMETERS = [
  { aerosolOpticalDepth: 0.1, groundAlbedo: 0.3 }, { aerosolOpticalDepth: 0, groundAlbedo: 0 }, { aerosolOpticalDepth: 0.4, groundAlbedo: 0.3 },
  { aerosolOpticalDepth: 1, groundAlbedo: 0.8 }, { aerosolOpticalDepth: 0.05, groundAlbedo: 1 },
];
const DEG = Math.PI / 180;
const observer = (latDeg, lonDeg, altMeters) => {
  const a = 6378137, e2 = 6.69437999014e-3, lat = latDeg * DEG, lon = lonDeg * DEG, n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return observerFromGeodetic([(n + altMeters) * Math.cos(lat) * Math.cos(lon), (n + altMeters) * Math.cos(lat) * Math.sin(lon), (n * (1 - e2) + altMeters) * Math.sin(lat)],
    { latRad: lat, lonRad: lon, altMeters });
};
const PLACES = [[44.98, -93.27, 260], [0, 0, 500], [-33.9, 151.2, 11_000], [69.6, 18.9, 40_000], [44.98, -93.27, 400_000]];
const INSTANTS = [Date.UTC(2026, 5, 21, 18), Date.UTC(2026, 9, 17, 23, 30), Date.UTC(2026, 9, 18, 0, 40), Date.UTC(2026, 11, 21, 4), Date.UTC(2027, 2, 20, 12)];
const LAYOUTS = [{ zenithSamples: 32, azimuthSamples: 32, integrationSteps: 16 }, { zenithSamples: 8, azimuthSamples: 8, integrationSteps: 4 }, { zenithSamples: 96, azimuthSamples: 64, integrationSteps: 48 }];
const requests = [];
for (const parameters of PARAMETERS) for (const [lat, lon, alt] of PLACES) for (const utcMs of INSTANTS) {
  const ephemeris = solarEphemeris(utcMs);
  requests.push({ parameters, ephemeris, lunar: lunarEphemeris(utcMs, ephemeris), observer: observer(lat, lon, alt), nightLuminance: 0.001,
    dome: { layout: LAYOUTS[requests.length % LAYOUTS.length], moonlitSky: true } });
}
// The reference once; every thread count must give its bits.
const reference = createSkyEvaluationState({ now: () => performance.now() });
const expected = requests.map(request => reference.evaluate(request).result);
reference.dispose();
const expectedHash = hashOf(expected.flatMap(result => [result.dome.directions, result.dome.luminances]));

const runs = [];
for (const threads of [1, 2, 4, 8]) {
  const workers = [];
  const core = createSharedSkyCore(module, { helpers: threads - 1 });
  try {
    const started = performance.now();
    for (let i = 1; i < threads; i++) {
      const worker = new Worker(new URL("../tests/fixtures/sky-shared-helper.mjs", import.meta.url));
      workers.push(worker);
      const { port1, port2 } = new MessageChannel();
      worker.postMessage({ kind: "sky-shared-port", port: port2 }, [port2]);
      if (!core.connectHelper(port1)) throw new Error("helper slot refused");
    }
    if (!core.waitForHelpers(threads - 1, 10_000)) throw new Error("helpers did not start");
    const helperStartMs = performance.now() - started;
    const ports = { execution: "worker", kind: "threaded", createKernel: snapshot => core.createAtmosphere(snapshot), createTables: parameters => core.createTables(parameters) };
    const native = createSkyEvaluationState({ now: () => performance.now(), numericPorts: ports });
    const results = [];
    let workMs = 0, domeMs = 0;
    for (const [index, request] of requests.entries()) {
      const actual = native.evaluate(request).result;
      for (const key of ["illumination", "tables", "groundTable", "dome"]) same(actual[key], expected[index][key], `${threads} threads, request ${index}: ${key}`);
      if (actual.numeric?.actual !== "threaded" || actual.numeric.state !== "ready") throw new Error(`Shared sky was not used: ${JSON.stringify(actual.numeric)}`);
      workMs += actual.timing.workMs; domeMs += actual.timing.domeMs;
      results.push(actual);
    }
    const last = results.at(-1).numeric;
    native.dispose();
    const status = core.status();
    if (status.actual !== "threaded") throw new Error(`Shared core retired: ${status.retiredReason}`);
    if (threads > 1 && (status.parallelBatches === 0 || last.batches.parity.parallel !== "same")) throw new Error("No parallel batch was compared");
    runs.push({
      threads, helperStartMs: Math.round(helperStartMs * 10) / 10, outputHash: hashOf(results.flatMap(result => [result.dome.directions, result.dome.luminances])),
      numericStatus: last, core: { ...status, threads: { ...status.threads, helpers: status.threads.helpers.length } }, stackUseBytes: core.stackUse().slice(0, threads),
      nodeTimingMs: { workMs: Math.round(workMs * 10) / 10, domeMs: Math.round(domeMs * 10) / 10 },
    });
  } finally {
    core.dispose();
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}
if (runs.some(run => run.outputHash !== expectedHash)) throw new Error("Output hashes differ");
const result = {
  implementation: "actual Rust/WASM shared-memory sky core with worker_threads helpers versus @foss-earth/sky TypeScript, through createSkyEvaluationState",
  wasmSha256: sha(bytes), wasmBytes: bytes.length,
  wrapperSha256: Object.fromEntries(["sharedCore.js", "helper.js", "threads.js", "core.js"].map(file => [file, sha(readFileSync(new URL(`../${file}`, import.meta.url)))])),
  requests: requests.length, layouts: LAYOUTS, referenceOutputHash: expectedHash,
  compared: "illumination, transferred tables, ground light table and dome luminances/directions: identical bits at every thread count",
  runs,
  performanceClaim: false,
  note: "Node worker_threads on a shared machine; timings include first-use comparisons against the reference. Browser A/B is measured in the app.",
};
mkdirSync(new URL("../../build/sky-WASM/", import.meta.url), { recursive: true });
writeFileSync(new URL("../../build/sky-WASM/sky-shared-parity.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ ...result, runs: runs.map(run => ({ threads: run.threads, outputHash: run.outputHash.slice(0, 16), parallelBatches: run.core.parallelBatches, soloBatches: run.core.soloBatches, rowsByThread: run.core.rowsByThread, waitMs: Math.round(run.core.waitMs), nodeTimingMs: run.nodeTimingMs, stack: run.stackUseBytes, batches: run.numericStatus.batches })) }, null, 2));
