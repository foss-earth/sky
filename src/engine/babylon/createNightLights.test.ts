import { NullEngine, Scene } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FOSS_EARTH_PARAMETERS } from "../../settings/catalogue";
import { createSettingsRegistry, type SettingsRegistry } from "../../settings/registry";
import {
  NIGHT_TILE_PIXELS, chooseNightWindow, horizonDistanceMeters, mercatorSpan, neededNightTiles, nightLightTileUrl, radianceOfGrey,
  type NightTile, type NightWindow,
} from "../../sky/nightLights";
import { retryDelayMs } from "../../terrain/retryDelay";
import { createNightLights, type DecodedImage, type NightLights, type NightLightsView } from "./createNightLights";
import { getTerrainNightLightMap } from "./imagery/terrainLightPlugin";

/** The Sun over the equator at 90° E: night over the Americas, day over Asia. */
const SUN_OVER_ASIA = [0, 1, 0] as const;
const MINNEAPOLIS: NightLightsView = { latDeg: 44.98, lonDeg: -93.27, altitudeMeters: 100_000, sun: SUN_OVER_ASIA };
const BUENOS_AIRES: NightLightsView = { latDeg: -34.6, lonDeg: -58.4, altitudeMeters: 100_000, sun: SUN_OVER_ASIA };
const TILE_BYTES = NIGHT_TILE_PIXELS * NIGHT_TILE_PIXELS;

interface TileRequest {
  url: string;
  signal: AbortSignal;
  /** Answers with the tile, or with a status and no body. */
  answer(status?: number): void;
  fail(error: Error): void;
}

interface Harness {
  scene: Scene;
  settings: SettingsRegistry;
  lights: NightLights;
  requests: TileRequest[];
  requestRender: ReturnType<typeof vi.fn>;
  updateTextureData: ReturnType<typeof vi.fn>;
  onDownloadBytes: ReturnType<typeof vi.fn>;
  timers: Array<{ id: number; callback: () => void; delayMs: number }>;
  clock: { ms: number };
}

const engines: NullEngine[] = [];
const created: NightLights[] = [];
afterEach(() => {
  for (const lights of created.splice(0)) lights.dispose();
  for (const engine of engines.splice(0)) engine.dispose();
});

/**
 * Night lights with a fetch that waits to be answered, a decoder that gives
 * each tile one grey, and timers and a clock of the test's own. A tile's
 * body is its address, which the decoder reads its tile from.
 */
function harness(values: Record<string, string | number> = {}, greyOf: (tile: NightTile) => number = () => 200, decode = true): Harness {
  const engine = new NullEngine();
  engines.push(engine);
  const updateTextureData = vi.fn();
  Object.assign(engine, { updateTextureData });
  const scene = new Scene(engine);
  const settings = createSettingsRegistry({ storage: null });
  settings.register(FOSS_EARTH_PARAMETERS);
  settings.setMany({ "map.imagery.concurrentRequests": 2, ...values });
  const requests: TileRequest[] = [];
  const fetchTile = (url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    requests.push({
      url,
      signal: init.signal!,
      answer: (status = 200) => resolve(new Response(status === 200 ? url : null, { status })),
      fail: reject,
    });
  });
  const decodeImage = async (blob: Blob): Promise<DecodedImage> => {
    const [z, y, x] = /(\d+)\/(\d+)\/(\d+)\.png$/.exec(await blob.text())!.slice(1).map(Number);
    const grey = greyOf({ z, x, y });
    const data = new Uint8Array(TILE_BYTES * 4);
    // Red, green, blue and alpha in one little-endian word a pixel.
    new Uint32Array(data.buffer).fill((grey | (grey << 8) | (grey << 16) | ((grey > 0 ? 255 : 0) << 24)) >>> 0);
    return { width: NIGHT_TILE_PIXELS, height: NIGHT_TILE_PIXELS, data };
  };
  const timers: Harness["timers"] = [];
  const clock = { ms: 0 };
  let nextTimer = 1;
  const requestRender = vi.fn();
  const onDownloadBytes = vi.fn();
  const lights = createNightLights({
    scene, settings, requestRender, onDownloadBytes, fetchTile,
    ...(decode ? { decodeImage } : {}),
    now: () => clock.ms,
    timers: {
      set: (callback, delayMs) => { timers.push({ id: nextTimer, callback, delayMs }); return nextTimer++; },
      clear: id => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); },
    },
  });
  created.push(lights);
  return { scene, settings, lights, requests, requestRender, updateTextureData, onDownloadBytes, timers, clock };
}

/** Lets answered downloads be read, decoded and kept. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
}

/** The window and the tiles a view needs, as src/sky/nightLights.ts chooses them, at the defaults. */
function expected(view: NightLightsView, tiles = 8): { window: NightWindow; needed: NightTile[] } {
  const radius = horizonDistanceMeters(view.altitudeMeters);
  const window = chooseNightWindow(null, mercatorSpan(view.latDeg, view.lonDeg, radius), tiles, 8);
  return { window, needed: neededNightTiles(window, view, radius, view.sun, 0) };
}

const url = (tile: NightTile, date = "2025-09-21") => nightLightTileUrl("NOAA20", date, tile);

/** Answers every download as it is asked for until none is left. */
async function answerAll(h: Harness, status = 200): Promise<void> {
  for (let index = 0; index < h.requests.length; index++) {
    if (h.requests[index].signal.aborted) continue;
    h.requests[index].answer(status);
    await flush();
  }
}

describe("night lights' tiles", () => {
  it("downloads nothing where the Sun is up, and gives the terrain no map", () => {
    const h = harness();
    h.lights.update({ latDeg: 0, lonDeg: 90, altitudeMeters: 100_000, sun: SUN_OVER_ASIA });
    expect(h.requests).toHaveLength(0);
    expect(h.lights.getState()).toMatchObject({ needed: 0, loading: 0, gpuBytes: 0, pending: null, error: null });
    expect(getTerrainNightLightMap(h.scene)).toBeNull();
    expect(h.requestRender).not.toHaveBeenCalled();
    expect(h.lights.radianceAt(0, 90)).toBeNull();
  });

  it("downloads the tiles a view needs nearest first, no more at once than the limit, and shows them when all are here, in one frame", async () => {
    const h = harness();
    const { window, needed } = expected(MINNEAPOLIS);
    expect(window.zoom).toBe(6);
    expect(needed.length).toBeGreaterThan(16);
    h.lights.update(MINNEAPOLIS);
    expect(h.requests.map(request => request.url)).toEqual(needed.slice(0, 2).map(tile => url(tile)));
    expect(h.lights.getState()).toMatchObject({ window: null, pending: window, needed: needed.length, here: 0, loading: 2 });
    for (let index = 0; index < needed.length; index++) {
      h.requests[index].answer();
      await flush();
      // Each arrival starts the next; nothing shows until the last is here.
      expect(h.requests).toHaveLength(Math.min(needed.length, index + 3));
      if (index < needed.length - 1) {
        expect(getTerrainNightLightMap(h.scene)).toBeNull();
        expect(h.requestRender).not.toHaveBeenCalled();
      }
    }
    expect(h.requests.map(request => request.url)).toEqual(needed.map(tile => url(tile)));
    const map = getTerrainNightLightMap(h.scene)!;
    expect(map).toMatchObject(window);
    expect(map.texture.getSize()).toEqual({ width: 8 * NIGHT_TILE_PIXELS, height: 8 * NIGHT_TILE_PIXELS });
    expect(h.requestRender).toHaveBeenCalledTimes(1);
    // The tiles here written once each; the other slots keep the zeros a new texture starts with.
    expect(h.updateTextureData).toHaveBeenCalledTimes(needed.length);
    const bytes = needed.reduce((sum, tile) => sum + url(tile).length, 0);
    expect(h.lights.getState()).toEqual({
      window, pending: null, needed: needed.length, here: needed.length, loading: 0, failed: 0,
      memoryBytes: needed.length * TILE_BYTES, gpuBytes: 64 * TILE_BYTES * 4, downloadedBytes: bytes, error: null,
    });
    expect(h.onDownloadBytes.mock.calls.reduce((sum, [chunk]) => sum + chunk, 0)).toBe(bytes);
    expect(h.lights.radianceAt(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg)).toBe(radianceOfGrey(200));

    // A view that has not moved is nothing new.
    h.lights.update({ ...MINNEAPOLIS });
    await flush();
    expect(h.requests).toHaveLength(needed.length);
    expect(h.requestRender).toHaveBeenCalledTimes(1);
    expect(h.updateTextureData).toHaveBeenCalledTimes(needed.length);
  });

  it("keeps showing the window it has while the next is made ready, then swaps it in one frame, and stops what the view left", async () => {
    const h = harness();
    const first = expected(MINNEAPOLIS);
    h.lights.update(MINNEAPOLIS);
    await answerAll(h);
    const shown = getTerrainNightLightMap(h.scene);
    expect(shown).toMatchObject(first.window);

    const next = expected(BUENOS_AIRES);
    const asked = h.requests.length;
    h.lights.update(BUENOS_AIRES);
    const started = h.requests.slice(asked);
    expect(started).toHaveLength(2);
    expect(h.lights.getState()).toMatchObject({ window: first.window, pending: next.window, here: 0 });
    // Meanwhile the view goes over the Pacific and back: what it left is stopped.
    h.lights.update({ ...BUENOS_AIRES, latDeg: 20, lonDeg: -150 });
    expect(started.every(request => request.signal.aborted)).toBe(true);
    h.lights.update(BUENOS_AIRES);
    for (let index = asked; index < h.requests.length; index++) {
      if (h.requests[index].signal.aborted) continue;
      expect(getTerrainNightLightMap(h.scene)).toBe(shown);
      h.requests[index].answer();
      await flush();
    }
    expect(getTerrainNightLightMap(h.scene)).toMatchObject(next.window);
    expect(getTerrainNightLightMap(h.scene)!.texture).toBe(shown!.texture);
    expect(h.requestRender).toHaveBeenCalledTimes(2);
    expect(h.lights.getState()).toMatchObject({ window: next.window, pending: null, here: next.needed.length });
  });

  it("tries a failed tile again after the retry delay, never one GIBS refuses, and does not hold a window back for either", async () => {
    const h = harness({ "map.imagery.concurrentRequests": 32 });
    const { needed } = expected(MINNEAPOLIS);
    h.lights.update(MINNEAPOLIS);
    expect(h.requests).toHaveLength(needed.length);
    h.requests[0].fail(new TypeError("Failed to fetch"));
    h.requests[1].answer(404);
    for (const request of h.requests.slice(2)) request.answer();
    await flush();
    expect(h.lights.getState()).toMatchObject({ here: needed.length - 2, failed: 2 });
    expect(h.lights.getState().error).toMatch(/404|Failed to fetch/);
    expect(getTerrainNightLightMap(h.scene)).not.toBeNull();
    expect(h.requestRender).toHaveBeenCalledTimes(1);

    // One timer, for the soonest retry; the refused tile has none.
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].delayMs).toBe(retryDelayMs(1));
    h.clock.ms += h.timers[0].delayMs;
    h.timers.shift()!.callback();
    expect(h.requests.slice(needed.length).map(request => request.url)).toEqual([url(needed[0])]);
    h.requests[needed.length].answer();
    await flush();
    expect(h.lights.getState()).toMatchObject({ here: needed.length - 1, failed: 1 });
    expect(h.requestRender).toHaveBeenCalledTimes(2);
    expect(h.timers).toHaveLength(0);
    // A new view still does not ask for it.
    h.lights.update({ ...MINNEAPOLIS, latDeg: MINNEAPOLIS.latDeg + 0.05 });
    expect(h.requests.slice(needed.length + 1).map(request => request.url)).not.toContain(url(needed[1]));
  });

  it("forgets the tiles least recently needed beyond its memory, never those of a window in use", async () => {
    const h = harness({ "sky.nightLights.memory": 1, "map.imagery.concurrentRequests": 32 });
    const first = expected(MINNEAPOLIS);
    const second = expected(BUENOS_AIRES);
    // Each view needs more than the 16 tiles a MiB holds.
    expect(Math.min(first.needed.length, second.needed.length)).toBeGreaterThan(16);
    h.lights.update(MINNEAPOLIS);
    await answerAll(h);
    expect(h.lights.getState().memoryBytes).toBe(first.needed.length * TILE_BYTES);
    h.lights.update(BUENOS_AIRES);
    await answerAll(h);
    expect(h.lights.getState().memoryBytes).toBe(second.needed.length * TILE_BYTES);
    // Back where it started, it downloads again what it forgot.
    const asked = h.requests.length;
    h.lights.update(MINNEAPOLIS);
    expect(h.requests.slice(asked).map(request => request.url)).toEqual(first.needed.slice(0, 32).map(tile => url(tile)));
  });

  it("keeps a tile without lamps as none, and makes no texture while no tile needed holds one", async () => {
    const h = harness({}, () => 0);
    h.lights.update(MINNEAPOLIS);
    await answerAll(h);
    expect(h.lights.getState()).toMatchObject({ window: expected(MINNEAPOLIS).window, memoryBytes: 0, gpuBytes: 0, failed: 0 });
    expect(getTerrainNightLightMap(h.scene)).toBeNull();
    expect(h.updateTextureData).not.toHaveBeenCalled();
    expect(h.requestRender).not.toHaveBeenCalled();
  });

  it("starts again for another night, and downloads nothing for a date that is none, saying so", async () => {
    const h = harness();
    const { needed } = expected(MINNEAPOLIS);
    h.lights.update(MINNEAPOLIS);
    await answerAll(h);
    expect(getTerrainNightLightMap(h.scene)).not.toBeNull();

    h.settings.set("sky.nightLights.date", "2025-09-22");
    h.lights.update(MINNEAPOLIS);
    expect(getTerrainNightLightMap(h.scene)).toBeNull();
    expect(h.lights.getState()).toMatchObject({ window: null, here: 0, memoryBytes: 0, downloadedBytes: 0 });
    expect(h.requests.slice(-2).map(request => request.url)).toEqual(needed.slice(0, 2).map(tile => url(tile, "2025-09-22")));

    const asked = h.requests.length;
    h.settings.set("sky.nightLights.date", "2025-02-30");
    h.lights.update(MINNEAPOLIS);
    expect(h.requests.slice(-2).every(request => request.signal.aborted)).toBe(true);
    expect(h.requests).toHaveLength(asked);
    expect(h.settings.inspect("sky.nightLights.date").note).toMatch(/^Not a date/);
    h.settings.set("sky.nightLights.date", "2025-09-21");
    h.lights.update(MINNEAPOLIS);
    expect(h.settings.inspect("sky.nightLights.date").note).toBeNull();
    expect(h.requests.length).toBeGreaterThan(asked);
  });

  it("downloads nothing where it could not decode a tile, as outside a browser, and says why", () => {
    expect(typeof globalThis.createImageBitmap).toBe("undefined");
    const h = harness({}, () => 200, false);
    h.lights.update(MINNEAPOLIS);
    expect(h.requests).toHaveLength(0);
    expect(h.lights.getState().error).toMatch(/createImageBitmap/);
  });

  it("stops downloads and retries and takes its map away when disposed", async () => {
    const h = harness({ "map.imagery.concurrentRequests": 32 });
    h.lights.update(MINNEAPOLIS);
    await answerAll(h);
    expect(getTerrainNightLightMap(h.scene)).not.toBeNull();
    // Higher up, a coarser window is made ready: one of its tiles fails and waits to be tried again, the rest are on their way.
    const asked = h.requests.length;
    h.lights.update({ ...MINNEAPOLIS, altitudeMeters: 400_000 });
    expect(h.lights.getState().pending).toEqual(expected({ ...MINNEAPOLIS, altitudeMeters: 400_000 }).window);
    expect(h.lights.getState().pending!.zoom).toBeLessThan(6);
    h.requests[asked].fail(new TypeError("Failed to fetch"));
    await flush();
    expect(h.timers).toHaveLength(1);
    const open = h.requests.slice(asked + 1).filter(request => !request.signal.aborted);
    expect(open.length).toBeGreaterThan(0);
    const renders = h.requestRender.mock.calls.length;
    h.lights.dispose();
    expect(getTerrainNightLightMap(h.scene)).toBeNull();
    expect(h.timers).toHaveLength(0);
    expect(open.every(request => request.signal.aborted)).toBe(true);
    for (const request of open) request.answer();
    await flush();
    expect(h.requestRender).toHaveBeenCalledTimes(renders);
    const count = h.requests.length;
    h.lights.update({ ...MINNEAPOLIS, latDeg: 30 });
    expect(h.requests).toHaveLength(count);
  });
});
