import type { Atmosphere, AtmosphereParameters, Rgb, RadianceFan } from "./atmosphere.js";

/** ABI v1 tables; copies are handed to a kernel so the reference stays intact. */
export interface AtmosphereNumericSnapshot {
  aerosolOpticalDepth: number;
  groundAlbedo: number;
  transmittance: Float32Array;
  multipleScattering: Float32Array;
  groundIrradiance: Float32Array;
}
export interface AtmosphereNumericKernel {
  radiance(altitudeMeters: number, mu: number, muSun: number, nu: number, steps: number, out: Rgb): Rgb;
  radianceFan: RadianceFan;
  skyIrradiance(altitudeMeters: number, muSun: number, out: Rgb): Rgb;
  dispose(): void;
}
type Operation = "radiance" | "fan" | "irradiance";
export interface AtmosphereNumericStatus {
  requested: "single";
  actual: "typescript" | "single";
  state: "checking" | "ready" | "fallback" | "disposed";
  fallbackReason: string | null;
  cleanupFailed: boolean;
  tableBackend: "typescript" | "single";
  tableParity: "unchecked" | "same" | "different";
  /** Each operation needs its own first-input exact comparison. */
  parity: Record<Operation, "unchecked" | "same" | "different">;
  nativeCalls: number;
}
export interface AtmosphereNumericPorts {
  /** Only a worker host may opt in; the browser page is rejected as well. */
  execution: "worker";
  /** Already-loaded synchronous worker module. The host bounds async startup. */
  createKernel(snapshot: AtmosphereNumericSnapshot): AtmosphereNumericKernel;
  /** Optional native precompute. Its first complete tables are checked against JS. */
  createTables?(parameters: AtmosphereParameters): AtmosphereNumericSnapshot;
  onStatus?(status: AtmosphereNumericStatus): void;
}
const statuses = new WeakMap<Atmosphere, () => AtmosphereNumericStatus>();
interface TableGate { parity: "unchecked" | "same" | "different"; reason: string | null }
const tableGates = new WeakMap<AtmosphereNumericPorts, TableGate>();
export interface AtmosphereNumericTableAttempt { candidate: AtmosphereNumericSnapshot; admitted: boolean }
const workerContext = (ports: AtmosphereNumericPorts): boolean => ports.execution === "worker" && typeof document === "undefined" && typeof window === "undefined";
/** Reuse a ports object per worker: only later builds may skip the JS precompute. */
export function prepareAtmosphereNumericTables(parameters: AtmosphereParameters, ports: AtmosphereNumericPorts): AtmosphereNumericTableAttempt | null {
  if (!ports.createTables || !workerContext(ports)) return null;
  const gate: TableGate = tableGates.get(ports) ?? { parity: "unchecked", reason: null };
  tableGates.set(ports, gate);
  if (gate.reason) return null;
  try {
    const candidate = ports.createTables({ ...parameters });
    if (!candidate || !Object.is(candidate.aerosolOpticalDepth, parameters.aerosolOpticalDepth) || !Object.is(candidate.groundAlbedo, parameters.groundAlbedo)
      || !(candidate.transmittance instanceof Float32Array) || candidate.transmittance.length !== 128 * 64 * 3
      || !(candidate.multipleScattering instanceof Float32Array) || candidate.multipleScattering.length !== 33 * 24 * 3
      || !(candidate.groundIrradiance instanceof Float32Array) || candidate.groundIrradiance.length !== 48 * 3
      || ![candidate.transmittance, candidate.multipleScattering, candidate.groundIrradiance].every(table => table.every(Number.isFinite))) throw new Error("Invalid native atmosphere tables");
    return { candidate: { ...candidate, transmittance: candidate.transmittance.slice(), multipleScattering: candidate.multipleScattering.slice(), groundIrradiance: candidate.groundIrradiance.slice() }, admitted: gate.parity === "same" };
  } catch { gate.reason = "table-build-failed"; return null; }
}
export function finishAtmosphereNumericTables(attempt: AtmosphereNumericTableAttempt | null, reference: AtmosphereNumericSnapshot, ports: AtmosphereNumericPorts): void {
  if (!attempt || attempt.admitted) return;
  const gate = tableGates.get(ports)!;
  const same = (["transmittance", "multipleScattering", "groundIrradiance"] as const)
    .every(key => reference[key].every((value, index) => Object.is(value, attempt.candidate[key][index])));
  gate.parity = same ? "same" : "different";
  if (!same) gate.reason = "table-parity-mismatch";
}
/** A reference-only atmosphere has no native status. No global singleton. */
export function atmosphereNumericStatusOf(atmosphere: Atmosphere): AtmosphereNumericStatus | undefined {
  return statuses.get(atmosphere)?.();
}
/** Internal composition after the unmodified reference tables have been built. */
export function attachAtmosphereNumericKernel(reference: Atmosphere, referenceFan: RadianceFan,
  snapshot: AtmosphereNumericSnapshot, ports: AtmosphereNumericPorts, tableBackend: "typescript" | "single" = "typescript"): { atmosphere: Atmosphere; fan: RadianceFan } {
  const status: AtmosphereNumericStatus = { requested: "single", actual: "typescript", state: "checking", fallbackReason: null,
    cleanupFailed: false, tableBackend, tableParity: tableGates.get(ports)?.parity ?? "unchecked",
    parity: { radiance: "unchecked", fan: "unchecked", irradiance: "unchecked" }, nativeCalls: 0 };
  const readStatus = (): AtmosphereNumericStatus => ({ ...status, parity: { ...status.parity } });
  const report = (): void => { try { ports.onStatus?.(readStatus()); } catch { /* Snapshot remains available through atmosphereNumericStatusOf. */ } };
  let kernel: AtmosphereNumericKernel | null = null;
  function release(): void {
    const current = kernel; kernel = null;
    if (current) current.dispose();
  }
  function fallback(reason: string): void {
    status.actual = "typescript"; status.state = "fallback"; status.fallbackReason = reason;
    try { release(); } catch { status.cleanupFailed = true; }
    report();
  }
  if (!workerContext(ports)) fallback("worker-context-required");
  else if (tableGates.get(ports)?.reason) fallback(tableGates.get(ports)!.reason!);
  else {
    try {
      kernel = ports.createKernel(snapshot);
      if (!kernel || typeof kernel.radiance !== "function" || typeof kernel.radianceFan !== "function"
        || typeof kernel.skyIrradiance !== "function" || typeof kernel.dispose !== "function") throw new Error("Invalid atmosphere numeric kernel");
    } catch { fallback("kernel-startup-failed"); }
  }
  function admitted(operation: Operation): void {
    status.parity[operation] = "same";
    status.actual = "single"; status.state = "ready"; report();
  }
  function activeKernel(): AtmosphereNumericKernel | null {
    const gate = tableGates.get(ports);
    if (kernel && gate?.reason) { status.tableParity = gate.parity; fallback(gate.reason); }
    return kernel;
  }
  function rgb(operation: "radiance" | "irradiance", out: Rgb, onReference: () => Rgb,
    onNative: (native: AtmosphereNumericKernel, sample: Rgb) => Rgb): Rgb {
    const native = activeKernel();
    if (!native) return onReference();
    const expected = status.parity[operation] === "unchecked" ? onReference() : null;
    const sample: Rgb = [0, 0, 0];
    try { status.nativeCalls++; onNative(native, sample); }
    catch { fallback(`${operation}-failed`); return expected ?? onReference(); }
    if (!sample.every(Number.isFinite)) { fallback(`${operation}-nonfinite`); return expected ?? onReference(); }
    if (expected) {
      if (!sample.every((value, c) => Object.is(value, expected[c]))) {
        status.parity[operation] = "different"; fallback(`${operation}-parity-mismatch`); return expected;
      }
      admitted(operation); return expected;
    }
    out[0] = sample[0]; out[1] = sample[1]; out[2] = sample[2];
    return out;
  }
  const fan: RadianceFan = (altitude, mu, muSun, nus, count, steps, out) => {
    const onReference = (): void => referenceFan(altitude, mu, muSun, nus, count, steps, out);
    const native = activeKernel();
    if (!native) { onReference(); return; }
    if (!Number.isSafeInteger(count) || count < 0 || count > 4096 || out.length < count * 3 || nus.length < count) {
      fallback("fan-input-outside-native-bound"); onReference(); return;
    }
    if (count === 0) { onReference(); return; }
    const expected = status.parity.fan === "unchecked" ? new Float64Array(count * 3) : null;
    if (expected) referenceFan(altitude, mu, muSun, nus, count, steps, expected);
    const actual = new Float64Array(count * 3);
    try { status.nativeCalls++; native.radianceFan(altitude, mu, muSun, nus.slice(0, count), count, steps, actual); }
    catch { fallback("fan-failed"); if (expected) out.set(expected); else onReference(); return; }
    if (!actual.every(Number.isFinite)) { fallback("fan-nonfinite"); if (expected) out.set(expected); else onReference(); return; }
    if (expected) {
      if (!actual.every((value, index) => Object.is(value, expected[index]))) {
        status.parity.fan = "different"; fallback("fan-parity-mismatch"); out.set(expected); return;
      }
      admitted("fan"); out.set(expected); return;
    }
    out.set(actual);
  };
  const atmosphere: Atmosphere = { ...reference,
    radiance: (altitude, mu, muSun, nu, steps, out) => rgb("radiance", out,
      () => reference.radiance(altitude, mu, muSun, nu, steps, out),
      (native, sample) => native.radiance(altitude, mu, muSun, nu, steps, sample)),
    skyIrradiance: (altitude, muSun, out) => rgb("irradiance", out,
      () => reference.skyIrradiance(altitude, muSun, out),
      (native, sample) => native.skyIrradiance(altitude, muSun, sample)),
    dispose() {
      if (status.state === "disposed") return;
      status.actual = "typescript"; status.state = "disposed";
      try { release(); } catch (error) { status.cleanupFailed = true; throw error; }
      finally { report(); }
    },
  };
  statuses.set(atmosphere, readStatus); report();
  return { atmosphere, fan };
}
