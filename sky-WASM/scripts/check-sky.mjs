import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  atmosphereTables, createAtmosphere, createSkyEvaluationState, lunarEphemeris, observerFromGeodetic, solarEphemeris,
} from "@foss-earth/sky";
import { instantiateSkyCore } from "../index.js";

// The real sky.wasm against the sky package's TypeScript, as built in dist/, through the evaluation a sky worker runs.
const bytes = readFileSync(new URL("../single/sky.wasm", import.meta.url));
const core = await instantiateSkyCore(bytes);
const sha = value => createHash("sha256").update(value).digest("hex");
const sameBits = (a, b) => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
/** Deep equality with Object.is at the leaves: -0 and NaN count. */
function same(a, b, path = "") {
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.constructor !== b.constructor || !sameBits(a, b)) throw new Error(`differs at ${path}`);
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) same(a[key], b[key], `${path}.${key}`);
    return;
  }
  if (!Object.is(a, b)) throw new Error(`differs at ${path}: ${a} vs ${b}`);
}

const PARAMETERS = [
  { aerosolOpticalDepth: 0.1, groundAlbedo: 0.3 }, { aerosolOpticalDepth: 0, groundAlbedo: 0 }, { aerosolOpticalDepth: 0.4, groundAlbedo: 0.3 },
  { aerosolOpticalDepth: 1, groundAlbedo: 0.8 }, { aerosolOpticalDepth: 0.05, groundAlbedo: 1 },
];
let tableValues = 0;
for (const parameters of PARAMETERS) {
  const expected = atmosphereTables(createAtmosphere(parameters));
  const actual = core.createTables(parameters);
  for (const name of ["transmittance", "multipleScattering", "groundIrradiance"]) {
    if (!sameBits(actual[name], expected[name])) throw new Error(`Rust/WASM ${name} table differs for ${JSON.stringify(parameters)}`);
    tableValues += expected[name].length;
  }
}

const DEG = Math.PI / 180;
const observer = (latDeg, lonDeg, altMeters) => {
  const a = 6378137, e2 = 6.69437999014e-3, lat = latDeg * DEG, lon = lonDeg * DEG, n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return observerFromGeodetic([(n + altMeters) * Math.cos(lat) * Math.cos(lon), (n + altMeters) * Math.cos(lat) * Math.sin(lon), (n * (1 - e2) + altMeters) * Math.sin(lat)],
    { latRad: lat, lonRad: lon, altMeters });
};
const PLACES = [[44.98, -93.27, 260], [0, 0, 500], [-33.9, 151.2, 11_000], [69.6, 18.9, 40_000], [44.98, -93.27, 400_000]];
const INSTANTS = [Date.UTC(2026, 5, 21, 18), Date.UTC(2026, 9, 17, 23, 30), Date.UTC(2026, 9, 18, 0, 40), Date.UTC(2026, 11, 21, 4), Date.UTC(2027, 2, 20, 12)];
const ports = {
  execution: "worker",
  createKernel: snapshot => core.createAtmosphere(snapshot),
  createTables: parameters => core.createTables(parameters),
};
const reference = createSkyEvaluationState({ now: () => performance.now() });
const native = createSkyEvaluationState({ now: () => performance.now(), numericPorts: ports });
let requests = 0, domeValues = 0;
const timing = { typescript: { workMs: 0, tablesMs: 0 }, single: { workMs: 0, tablesMs: 0 } };
for (const parameters of PARAMETERS) for (const [lat, lon, alt] of PLACES) for (const utcMs of INSTANTS) {
  const ephemeris = solarEphemeris(utcMs);
  const request = {
    parameters, ephemeris, lunar: lunarEphemeris(utcMs, ephemeris), observer: observer(lat, lon, alt), nightLuminance: 0.001,
    dome: { layout: { zenithSamples: 32, azimuthSamples: 32, integrationSteps: 16 }, moonlitSky: true },
  };
  const expected = reference.evaluate(request).result;
  const actual = native.evaluate(request).result;
  for (const key of ["illumination", "tables", "groundTable", "dome"]) same(actual[key], expected[key], key);
  if (actual.numeric?.actual !== "single" || actual.numeric.state !== "ready") throw new Error(`Native sky was not used: ${JSON.stringify(actual.numeric)}`);
  timing.typescript.workMs += expected.timing.workMs; timing.typescript.tablesMs += expected.timing.tablesMs;
  timing.single.workMs += actual.timing.workMs; timing.single.tablesMs += actual.timing.tablesMs;
  domeValues += expected.dome.luminances.length;
  requests++;
}
const last = native.evaluate({
  parameters: PARAMETERS[0], ephemeris: solarEphemeris(INSTANTS[0]), lunar: null, observer: observer(0, 0, 0), nightLuminance: 0.001, dome: null,
}).result.numeric;
reference.dispose(); native.dispose();
const round = value => Math.round(value * 10) / 10;
const result = {
  implementation: "actual Rust/WASM sky core versus @foss-earth/sky TypeScript, through createSkyEvaluationState",
  wasmSha256: sha(bytes), wasmBytes: bytes.length,
  wrapperSha256: { "index.js": sha(readFileSync(new URL("../index.js", import.meta.url))), "core.js": sha(readFileSync(new URL("../core.js", import.meta.url))) },
  tableCases: PARAMETERS.length, tableValues, requests, domeValues,
  compared: "illumination, transferred tables, ground light table and dome luminances/directions: identical bits",
  numericStatus: last,
  nodeTimingMs: { typescript: { workMs: round(timing.typescript.workMs), tablesMs: round(timing.typescript.tablesMs) }, single: { workMs: round(timing.single.workMs), tablesMs: round(timing.single.tablesMs) } },
  performanceClaim: false,
  note: "Node timings include the first-use comparisons the single path runs against the reference; browser A/B is measured in the app.",
};
mkdirSync(new URL("../../build/sky-WASM/", import.meta.url), { recursive: true });
writeFileSync(new URL("../../build/sky-WASM/sky-parity.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
