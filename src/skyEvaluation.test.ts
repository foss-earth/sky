import { describe, expect, it, vi } from "vitest";
import { atmosphereTables, createAtmosphere, createAtmosphereFromTables, type Rgb } from "./atmosphere.js";
import { lunarEphemeris } from "./lunarPosition.js";
import { solarEphemeris } from "./solarPosition.js";
import { createSkyEvaluationState, type SkyEvaluationRequest } from "./skyEvaluation.js";
import { createSkyWorkerEvaluator, installSkyEvaluationWorker, type SkyEvaluationWorkerReply, type SkyEvaluationWorkerRequest } from "./skyEvaluationWorker.js";
import { computeSkyIllumination, createSkyDomeGeometry, fillSkyDome, groundLightTable, observerFromGeodetic } from "./skyState.js";

const DEG = Math.PI / 180;
const geodeticToEcef = (latDeg: number, lonDeg: number, altMeters: number): [number, number, number] => {
  const a = 6378137, e2 = 6.69437999014e-3, lat = latDeg * DEG, lon = lonDeg * DEG;
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [(n + altMeters) * Math.cos(lat) * Math.cos(lon), (n + altMeters) * Math.cos(lat) * Math.sin(lon), (n * (1 - e2) + altMeters) * Math.sin(lat)];
};
const observer = (latDeg: number, lonDeg: number, altMeters: number) =>
  observerFromGeodetic(geodeticToEcef(latDeg, lonDeg, altMeters), { latRad: latDeg * DEG, lonRad: lonDeg * DEG, altMeters });

function request(utcMs: number, altMeters: number, parameters = { aerosolOpticalDepth: 0.1, groundAlbedo: 0.3 }, withDome = true): SkyEvaluationRequest {
  const ephemeris = solarEphemeris(utcMs);
  return {
    parameters, ephemeris, lunar: lunarEphemeris(utcMs, ephemeris), observer: observer(44.98, -93.27, altMeters), nightLuminance: 0.001,
    dome: withDome ? { layout: { zenithSamples: 16, azimuthSamples: 12, integrationSteps: 12 }, moonlitSky: true } : null,
  };
}

/** The page's own evaluation, as createSkyRuntime does it. */
function onPage(input: SkyEvaluationRequest) {
  const atmosphere = createAtmosphere(input.parameters);
  const illumination = computeSkyIllumination(atmosphere, input.ephemeris, input.observer, { nightLuminance: input.nightLuminance, lunar: input.lunar });
  const geometry = createSkyDomeGeometry(input.dome!.layout);
  fillSkyDome(geometry, atmosphere, illumination, { moonlitSky: input.dome!.moonlitSky });
  return { atmosphere, illumination, geometry, groundTable: groundLightTable(atmosphere) };
}

/** Each value's bit pattern, so -0 and NaN compare exactly. */
const bits = (values: ArrayLike<number>): string[] => {
  const view = new DataView(new ArrayBuffer(8));
  return Array.from(values, value => { view.setFloat64(0, value); return view.getBigUint64(0).toString(16); });
};

describe("sky evaluation away from the page", () => {
  it("answers each request with the page's values, bit for bit", () => {
    const state = createSkyEvaluationState({ now: () => 0 });
    // Dusk, night with the Moon, and a high viewpoint above most of the air.
    for (const [utcMs, alt] of [[Date.UTC(2026, 9, 17, 23, 30), 300], [Date.UTC(2026, 9, 18, 4, 0), 300], [Date.UTC(2026, 9, 17, 18, 0), 40_000]] as const) {
      const input = request(utcMs, alt);
      const page = onPage(input);
      const { result } = state.evaluate(input);
      expect(result.illumination).toEqual(page.illumination);
      expect(bits(result.dome!.luminances)).toEqual(bits(page.geometry.luminances));
      expect(bits(result.dome!.directions)).toEqual(bits(page.geometry.directions));
      expect(result.dome!.evaluations).toBe(page.geometry.evaluations);
      expect(result.dome!.moonEvaluations).toBe(page.geometry.moonEvaluations);
    }
    state.dispose();
  });

  it("sends tables only when the air changes, and the page's atmosphere over them answers as the original", () => {
    const state = createSkyEvaluationState({ now: () => 0 });
    const first = state.evaluate(request(Date.UTC(2026, 9, 17, 23, 30), 300));
    expect(first.result.tables).not.toBeNull();
    expect(first.transfer.length).toBe(6);
    const again = state.evaluate(request(Date.UTC(2026, 9, 17, 23, 40), 300, undefined, false));
    expect(again.result.tables).toBeNull();
    expect(again.result.dome).toBeNull();
    const hazy = state.evaluate(request(Date.UTC(2026, 9, 17, 23, 40), 300, { aerosolOpticalDepth: 0.4, groundAlbedo: 0.3 }));
    expect(hazy.result.tables).not.toBeNull();

    const reference = createAtmosphere({ aerosolOpticalDepth: 0.4, groundAlbedo: 0.3 });
    const rebuilt = createAtmosphereFromTables(hazy.result.tables!);
    expect(bits(hazy.result.groundTable!)).toEqual(bits(groundLightTable(reference)));
    const a: Rgb = [0, 0, 0], b: Rgb = [0, 0, 0];
    for (const altitude of [0, 1500, 40_000, 150_000]) for (let mu = -1; mu <= 1; mu += 0.0625) {
      expect(rebuilt.sunTransmittance(altitude, mu, a)).toEqual(reference.sunTransmittance(altitude, mu, b));
      expect(rebuilt.radiance(altitude, mu, 0.2, 0.5, 16, a)).toEqual(reference.radiance(altitude, mu, 0.2, 0.5, 16, b));
      expect(rebuilt.groundSkyIrradiance(mu, a)).toEqual(reference.groundSkyIrradiance(mu, b));
    }
    expect(rebuilt.skyIrradiance(0, 0.3, a)).toEqual(reference.skyIrradiance(0, 0.3, b));
    expect(atmosphereTables(rebuilt)!.transmittance).toEqual(atmosphereTables(reference)!.transmittance);
    state.dispose();
  });

  it("rejects incomplete tables", () => {
    const tables = atmosphereTables(createAtmosphere({ aerosolOpticalDepth: 0.1, groundAlbedo: 0.3 }))!;
    expect(() => createAtmosphereFromTables({ ...tables, transmittance: tables.transmittance.subarray(1) })).toThrow(RangeError);
    expect(() => createAtmosphereFromTables({ ...tables, groundAlbedo: 2 })).toThrow(RangeError);
  });
});

/** A worker pair in one realm: messages cross by structured clone, as between threads. */
function connectedPair(kernel: "typescript" | "threaded") {
  const workerListeners: Array<(event: { data: unknown }) => void> = [];
  const pageListeners = new Map<string, Array<(event: { data?: unknown; message?: string }) => void>>();
  const terminated = vi.fn();
  installSkyEvaluationWorker({
    scope: {
      addEventListener: (_type, listener) => { workerListeners.push(listener); },
      postMessage: (message: SkyEvaluationWorkerReply) => {
        const data = structuredClone(message);
        queueMicrotask(() => { for (const listener of pageListeners.get("message") ?? []) listener({ data }); });
      },
    },
    kernel, now: () => 0, timers: { set: (callback, delay) => setTimeout(callback, delay), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
  });
  const transfers: unknown[][] = [];
  const port = {
    postMessage: (message: SkyEvaluationWorkerRequest, transfer: unknown[] = []) => {
      transfers.push(transfer);
      // Transferred ports move as themselves.
      const data = message.type === "helpers" ? message : structuredClone(message);
      queueMicrotask(() => { for (const listener of workerListeners) listener({ data }); });
    },
    addEventListener: (type: "message" | "error" | "messageerror", listener: (event: { data?: unknown; message?: string }) => void) => {
      pageListeners.set(type, [...(pageListeners.get(type) ?? []), listener]);
    },
    terminate: terminated,
  };
  return { port, terminated, transfers };
}

describe("sky worker protocol", () => {
  const timers = { set: (callback: () => void, delay: number) => setTimeout(callback, delay), clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  it("cancels an obsolete queued generation without retiring the evaluator or starting a timeout", async () => {
    const pair = connectedPair("typescript"), release = vi.fn();
    let grant!: (lease: { lanes: number; release: typeof release }) => void;
    const port = Object.assign(pair.port, { compute: { acquire: () => new Promise<{ lanes: number; release: typeof release }>(resolve => { grant = resolve; }) } });
    const evaluator = createSkyWorkerEvaluator({ createWorker: () => port, kernel: "typescript", now: () => 0, timers });
    const abort = new AbortController(), result = evaluator.evaluate(request(Date.UTC(2026, 9, 17), 300), { signal: abort.signal });
    abort.abort(new Error("sky switched off")); await expect(result).rejects.toThrow("sky switched off");
    expect(pair.terminated).not.toHaveBeenCalled(); expect(evaluator.status()).toMatchObject({ state: "idle", failure: null });
    grant({ lanes: 1, release }); await Promise.resolve(); expect(release).toHaveBeenCalledWith("stale"); evaluator.dispose();
  });

  it("admits coordinator and helpers as one team, waits outside execution timeout, and accepts a smaller generation", async () => {
    vi.useFakeTimers();
    try {
      const pair = connectedPair("threaded"), release = vi.fn();
      let grant!: (lease: { lanes: number; release: typeof release }) => void;
      const acquire = vi.fn(() => new Promise<{ lanes: number; release: typeof release }>(resolve => { grant = resolve; }));
      const port = Object.assign(pair.port, { compute: { acquire } });
      const evaluator = createSkyWorkerEvaluator({ createWorker: () => port, kernel: "threaded", now: () => 0, timers, firstTimeoutMs: 10,
        createHelpers: () => ({ ports: [{ postMessage() {} }, { postMessage() {} }], terminate() {} }) });
      const pending = evaluator.evaluate(request(Date.UTC(2026, 9, 17, 23, 30), 300));
      expect(acquire.mock.calls[0]?.[0]).toMatchObject({ lanes: 3 });
      await vi.advanceTimersByTimeAsync(100);
      expect(evaluator.status().state).toBe("busy"); expect(pair.terminated).not.toHaveBeenCalled();
      grant({ lanes: 1, release }); await pending;
      expect(release).toHaveBeenCalledOnce(); expect(evaluator.status().jobs).toBe(1); evaluator.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("creates no worker until asked, and returns the page's values through structured clone", async () => {
    const pair = connectedPair("typescript");
    const createWorker = vi.fn(() => pair.port);
    const evaluator = createSkyWorkerEvaluator({ createWorker, kernel: "typescript", now: () => 0, timers });
    expect(createWorker).not.toHaveBeenCalled();
    expect(evaluator.status().started).toBe(false);
    const input = request(Date.UTC(2026, 9, 17, 23, 30), 300);
    const result = await evaluator.evaluate(input);
    const page = onPage(input);
    expect(result.illumination).toEqual(page.illumination);
    expect(bits(result.dome!.luminances)).toEqual(bits(page.geometry.luminances));
    expect(evaluator.status()).toMatchObject({ state: "idle", jobs: 1, started: true, backend: { kernel: "typescript", actual: "typescript", state: "typescript" } });
    evaluator.dispose();
    expect(pair.terminated).toHaveBeenCalledOnce();
    await expect(evaluator.evaluate(input)).rejects.toThrow();
  });

  it("reports the threaded request as an explicit reference fallback", async () => {
    const pair = connectedPair("threaded");
    const evaluator = createSkyWorkerEvaluator({ createWorker: () => pair.port, kernel: "threaded", now: () => 0, timers });
    await evaluator.evaluate(request(Date.UTC(2026, 9, 17, 23, 30), 300));
    expect(evaluator.status().backend).toMatchObject({ actual: "typescript", state: "fallback", fallbackReason: "threaded-unsupported" });
    evaluator.dispose();
  });

  it("hands a threaded sky its helpers once, and ends them as soon as no shared core runs", async () => {
    const pair = connectedPair("threaded");
    const ports = [{ postMessage: vi.fn(), close: vi.fn() }, { postMessage: vi.fn(), close: vi.fn() }];
    const terminate = vi.fn();
    const createHelpers = vi.fn(() => ({ ports, terminate }));
    const evaluator = createSkyWorkerEvaluator({ createWorker: () => pair.port, kernel: "threaded", now: () => 0, timers, createHelpers });
    await evaluator.evaluate(request(Date.UTC(2026, 9, 17, 23, 30), 300));
    expect(createHelpers).toHaveBeenCalledOnce();
    expect(pair.transfers[0]).toEqual(ports);
    // This sky worker has no shared core: it closes the ports, and the page ends the helpers.
    for (const port of ports) expect(port.close).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
    expect(evaluator.status().backend).toMatchObject({ kernel: "threaded", actual: "typescript", threads: null, fallbackReason: "threaded-unsupported" });
    await evaluator.evaluate(request(Date.UTC(2026, 9, 17, 23, 30), 300));
    evaluator.dispose();
    expect(createHelpers).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
    // Other kernels never start helpers.
    const plain = connectedPair("typescript");
    const unused = vi.fn(() => ({ ports: [], terminate: vi.fn() }));
    const single = createSkyWorkerEvaluator({ createWorker: () => plain.port, kernel: "typescript", now: () => 0, timers, createHelpers: unused });
    await single.evaluate(request(Date.UTC(2026, 9, 17, 23, 30), 300));
    single.dispose();
    expect(unused).not.toHaveBeenCalled();
  });

  it("ends a threaded sky's helpers with its worker", async () => {
    const silent = { postMessage: vi.fn(), addEventListener: vi.fn(), terminate: vi.fn() };
    const terminate = vi.fn();
    const evaluator = createSkyWorkerEvaluator({ createWorker: () => silent, kernel: "threaded", now: () => 0, timers,
      createHelpers: () => ({ ports: [{ postMessage: vi.fn() }], terminate }) });
    void evaluator.evaluate(request(Date.UTC(2026, 9, 17, 23, 30), 300)).catch(() => {});
    expect(silent.postMessage.mock.calls[0]?.[0]).toMatchObject({ type: "helpers" });
    evaluator.dispose();
    expect(silent.terminate).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("retires a worker that does not answer, and one that cannot start", async () => {
    vi.useFakeTimers();
    try {
      const silent = { postMessage: vi.fn(), addEventListener: vi.fn(), terminate: vi.fn() };
      const evaluator = createSkyWorkerEvaluator({ createWorker: () => silent, kernel: "typescript", now: () => 0, timers, firstTimeoutMs: 100 });
      const pending = evaluator.evaluate(request(Date.UTC(2026, 9, 17, 23, 30), 300));
      const settled = expect(pending).rejects.toThrow("worker-timeout");
      await vi.advanceTimersByTimeAsync(100);
      await settled;
      expect(silent.terminate).toHaveBeenCalledOnce();
      expect(evaluator.status()).toMatchObject({ state: "failed", failure: "worker-timeout" });
    } finally { vi.useRealTimers(); }
    const none = createSkyWorkerEvaluator({ createWorker: () => null, kernel: "typescript", now: () => 0, timers });
    await expect(none.evaluate(request(Date.UTC(2026, 9, 17, 23, 30), 300))).rejects.toThrow("worker-unavailable");
    expect(none.status()).toMatchObject({ state: "failed", started: false });
  });
});
