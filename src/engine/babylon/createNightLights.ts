import { Constants, RawTexture, Texture, type InternalTexture, type Scene } from "@babylonjs/core";
import type { SettingsRegistry } from "../../settings/registry";
import { isNumberRange } from "../../settings/values";
import {
  NIGHT_LIGHT_SATELLITES, NIGHT_TILE_PIXELS, chooseNightWindow, horizonDistanceMeters, isNightLightDate, mercatorSpan, neededNightTiles,
  nightGreysFromPixels, nightLightTileUrl, nightPixelAt, nightTexels, nightTileKey, radianceOfGrey, sameNightWindow, windowSlot,
  windowTiles, type NightLightSatellite, type NightTile, type NightWindow,
} from "../../sky/nightLights";
import { fetchMapTile } from "../../terrain/mapCache";
import { DEFAULT_RETRY_DELAY_MS, retryDelayMs, type RetryDelay } from "../../terrain/retryDelay";
import { setTerrainNightLightMap } from "./imagery/terrainLightPlugin";
import { measureMapResponse } from "./mapDownloadMeter";

/**
 * The night lights' tiles for the scene (src/sky/nightLights.ts): those the
 * view needs downloaded, decoded and kept, and a square window of them in a
 * texture the terrain shader reads through `setTerrainNightLightMap`.
 *
 * The window is the finest zoom whose square holds the ground to the horizon
 * with a tile to spare. Tiles are downloaded only where the Sun is below
 * `sky.nightLights.sunBelow` on ground within the horizon, nearest first, no
 * more at once than `map.imagery.concurrentRequests`, and tried again after
 * `map.retryDelay`. A new window is shown only when every tile it needs is
 * here or has failed once, all of it in one task; until then the last one
 * stays. Within a window shown, a tile shows as it arrives, at the horizon or
 * where the Sun has just set, where it is not yet seen.
 */

export interface NightLightsView {
  latDeg: number;
  lonDeg: number;
  altitudeMeters: number;
  /** Unit vector to the Sun in the Earth's axes. */
  sun: readonly [number, number, number];
}

export interface NightLightsState {
  /** The window in the texture, or null before the first is ready. */
  window: NightWindow | null;
  /** The window being made ready to replace it, or null. */
  pending: NightWindow | null;
  /** Tiles the view needs, of them those here, those on their way and those whose last try failed. */
  needed: number;
  here: number;
  loading: number;
  failed: number;
  /** Bytes of tiles kept, of the texture, and downloaded since the source last changed. */
  memoryBytes: number;
  gpuBytes: number;
  downloadedBytes: number;
  /** The last failure, in words, or null. */
  error: string | null;
}

export interface NightLights {
  /** Brings the tiles and the window up to date for a view; cheap while nothing has moved. */
  update(view: NightLightsView): void;
  /** The radiance a tile here holds at a place, nW/(cm² sr), at the shown window's zoom; null where none does. */
  radianceAt(latDeg: number, lonDeg: number): number | null;
  getState(): NightLightsState;
  dispose(): void;
}

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, a byte each, row by row from the top. */
  data: ArrayLike<number>;
}

export interface NightLightsOptions {
  scene: Scene;
  settings: SettingsRegistry;
  /** Asks for a frame, when tiles are shown. */
  requestRender(): void;
  /** Called with each chunk of a tile's bytes as it arrives, for the download meter. */
  onDownloadBytes?: (bytes: number) => void;
  /** Fetches a tile; the map cache's `fetchMapTile` when omitted. */
  fetchTile?: (url: string, init: RequestInit) => Promise<Response>;
  /** Decodes an image to RGBA; the browser's decoder when omitted. */
  decodeImage?: (blob: Blob) => Promise<DecodedImage>;
  /** A clock, ms; `performance.now` when omitted. */
  now?: () => number;
  timers?: { set(callback: () => void, delayMs: number): number; clear(id: number): void };
}

/** A tile's pixels as the colour map's greys, or null for a tile without any data. */
interface KeptTile {
  tile: NightTile;
  greys: Uint8Array | null;
  /** When it was last needed, for keeping the most recent within `sky.nightLights.memory`. */
  used: number;
}

interface Failure {
  count: number;
  retryAt: number;
}

const PIXELS = NIGHT_TILE_PIXELS * NIGHT_TILE_PIXELS;
const BYTES_PER_TEXEL = 4;
const MEBIBYTE = 1024 * 1024;
const NO_DECODER = "This browser cannot decode images off the page (it has no createImageBitmap), so no night lights are downloaded.";

/** A tile decoded by the browser, without colour conversion: the colour map's greys must stay the greys it gives. */
async function decodeInBrowser(blob: Blob): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  try {
    const canvas = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : Object.assign(document.createElement("canvas"), { width: bitmap.width, height: bitmap.height });
    const context = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new Error("No 2D canvas to decode a night light tile with.");
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: image.width, height: image.height, data: image.data };
  } finally {
    bitmap.close();
  }
}

/** A failure the source will give again: a request it refuses, such as a day it has no layer for. */
class RefusedError extends Error {}

export function createNightLights(options: NightLightsOptions): NightLights {
  const { scene, settings } = options;
  const now = options.now ?? (() => performance.now());
  const timers = options.timers ?? {
    set: (callback: () => void, delayMs: number) => window.setTimeout(callback, delayMs),
    clear: (id: number) => window.clearTimeout(id),
  };
  const fetchTile = options.fetchTile ?? ((url, init) => fetchMapTile(url, init));
  const decodeImage = options.decodeImage ?? decodeInBrowser;
  // Every tile would fail without a decoder, as outside a browser: download none.
  const canDecode = options.decodeImage !== undefined || typeof createImageBitmap === "function";
  const engine = scene.getEngine() as unknown as {
    updateTextureData(texture: InternalTexture, data: ArrayBufferView, x: number, y: number, width: number, height: number, faceIndex?: number, lod?: number, generateMipMaps?: boolean): void;
  };

  const kept = new Map<string, KeptTile>();
  const failures = new Map<string, Failure>();
  const loading = new Map<string, AbortController>();
  let source = "";
  let shown: NightWindow | null = null;
  let target: NightWindow | null = null;
  let needed: NightTile[] = [];
  let neededKey = "";
  let texture: RawTexture | null = null;
  /** The tile each slot of the texture holds, by key, or null for none. */
  let slots: (string | null)[] = [];
  let uses = 0;
  let downloadedBytes = 0;
  let error: string | null = null;
  let retryTimer: number | null = null;
  /** Whether the date was last found to be one, so its note is set only when that changes. */
  let dateValid: boolean | null = null;
  let disposed = false;
  const texels = new Uint8Array(PIXELS * BYTES_PER_TEXEL);
  const blank = new Uint8Array(PIXELS * BYTES_PER_TEXEL);

  const satellite = (): NightLightSatellite => {
    const value = settings.get("sky.nightLights.satellite");
    return NIGHT_LIGHT_SATELLITES.includes(value as NightLightSatellite) ? (value as NightLightSatellite) : "NOAA20";
  };
  const date = (): string => String(settings.get("sky.nightLights.date")).trim();
  const retryDelay = (): RetryDelay => {
    const range = settings.get("map.retryDelay");
    return isNumberRange(range) ? { min: range.min * 1000, max: range.max * 1000 } : DEFAULT_RETRY_DELAY_MS;
  };

  function abortAll(): void {
    for (const controller of loading.values()) controller.abort();
    loading.clear();
  }

  function stopRetry(): void {
    if (retryTimer !== null) timers.clear(retryTimer);
    retryTimer = null;
  }

  function disposeTexture(): void {
    if (texture) setTerrainNightLightMap(scene, null);
    texture?.dispose();
    texture = null;
    slots = [];
  }

  /** Drops every tile and the window, for a new source. */
  function reset(): void {
    abortAll();
    stopRetry();
    kept.clear();
    failures.clear();
    disposeTexture();
    shown = null;
    target = null;
    needed = [];
    neededKey = "";
    downloadedBytes = 0;
    error = null;
  }

  function ensureTexture(tiles: number): RawTexture {
    if (texture && slots.length === tiles * tiles) return texture;
    disposeTexture();
    const size = tiles * NIGHT_TILE_PIXELS;
    // Without mipmaps, filtered between texels; it wraps, so a tile keeps its slot while the window moves over it.
    texture = new RawTexture(null, size, size, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
    texture.name = "night-lights";
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    slots = new Array<string | null>(tiles * tiles).fill(null);
    return texture;
  }

  /** Writes what a slot should hold, if it does not already: the tile when it is here, or nothing. Returns whether it wrote. */
  function writeSlot(window: NightWindow, tile: NightTile): boolean {
    const internal = texture?.getInternalTexture();
    if (!internal) return false;
    const key = nightTileKey(tile);
    const entry = kept.get(key);
    const want = entry ? key : null;
    const { column, row } = windowSlot(window, tile);
    const index = row * window.tiles + column;
    if (slots[index] === want) return false;
    engine.updateTextureData(internal, entry?.greys ? nightTexels(entry.greys, texels) : blank, column * NIGHT_TILE_PIXELS, row * NIGHT_TILE_PIXELS, NIGHT_TILE_PIXELS, NIGHT_TILE_PIXELS, 0, 0, false);
    slots[index] = want;
    return true;
  }

  const settled = (tile: NightTile): boolean => {
    const key = nightTileKey(tile);
    return kept.has(key) || failures.has(key);
  };

  /**
   * Shows the target window once every tile it needs is here or has failed
   * once, all of it in this task; within the window shown, writes tiles as
   * they arrive. While no tile needed holds a lamp, as by day, there is no
   * texture, and the terrain's shader has no night lights to read. Returns
   * whether what is drawn changed.
   */
  function showWhenReady(): boolean {
    if (!target || disposed) return false;
    const next = target;
    if (!sameNightWindow(shown, next) && !needed.every(settled)) return false;
    shown = next;
    if (!needed.some(tile => kept.get(nightTileKey(tile))?.greys)) {
      const had = texture !== null;
      disposeTexture();
      return had;
    }
    ensureTexture(next.tiles);
    let changed = false;
    for (const tile of windowTiles(next)) if (writeSlot(next, tile)) changed = true;
    if (setTerrainNightLightMap(scene, { texture: texture!, zoom: next.zoom, x: next.x, y: next.y, tiles: next.tiles })) changed = true;
    return changed;
  }

  /** Forgets the tiles least recently needed beyond `sky.nightLights.memory`, keeping those of the windows in use. */
  function trim(): void {
    const limit = settings.get<number>("sky.nightLights.memory") * MEBIBYTE;
    let bytes = 0;
    for (const entry of kept.values()) bytes += entry.greys ? entry.greys.byteLength : 0;
    if (bytes <= limit) return;
    const inUse = new Set<string>([...(shown ? windowTiles(shown) : []), ...(target ? windowTiles(target) : [])].map(nightTileKey));
    const oldest = [...kept.entries()].filter(([key, entry]) => entry.greys && !inUse.has(key)).sort((a, b) => a[1].used - b[1].used);
    for (const [key, entry] of oldest) {
      if (bytes <= limit) break;
      kept.delete(key);
      bytes -= entry.greys!.byteLength;
    }
  }

  function scheduleRetry(): void {
    stopRetry();
    let soonest = Infinity;
    for (const tile of needed) {
      const key = nightTileKey(tile);
      const failure = failures.get(key);
      if (failure && Number.isFinite(failure.retryAt) && !loading.has(key)) soonest = Math.min(soonest, failure.retryAt);
    }
    if (!Number.isFinite(soonest) || disposed) return;
    retryTimer = timers.set(() => {
      retryTimer = null;
      pump();
    }, Math.max(0, soonest - now()));
  }

  async function load(tile: NightTile, key: string, url: string, controller: AbortController): Promise<void> {
    try {
      const response = await fetchTile(url, { signal: controller.signal, mode: "cors" });
      // A day without a layer, a tile out of range: asking again gives the same.
      if (response.status === 400 || response.status === 404 || response.status === 204) throw new RefusedError(`GIBS answered ${response.status} for ${url}`);
      if (!response.ok) throw new Error(`GIBS answered ${response.status} for ${url}`);
      const blob = await measureMapResponse(response, bytes => {
        downloadedBytes += bytes;
        options.onDownloadBytes?.(bytes);
      }).blob();
      const image = await decodeImage(blob);
      if (image.width !== NIGHT_TILE_PIXELS || image.height !== NIGHT_TILE_PIXELS) throw new RefusedError(`A night light tile was ${image.width}×${image.height} pixels, not ${NIGHT_TILE_PIXELS}.`);
      const greys = new Uint8Array(PIXELS);
      const data = nightGreysFromPixels(image.data, greys);
      if (controller.signal.aborted || disposed) return;
      kept.set(key, { tile, greys: data > 0 ? greys : null, used: ++uses });
      failures.delete(key);
    } catch (reason) {
      if (controller.signal.aborted || disposed) return;
      const previous = failures.get(key);
      const count = (previous?.count ?? 0) + 1;
      const refused = reason instanceof RefusedError;
      failures.set(key, { count, retryAt: refused ? Infinity : now() + retryDelayMs(count, retryDelay()) });
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      if (loading.get(key) === controller) loading.delete(key);
    }
    if (disposed) return;
    // Trimmed after a swap, when the window it replaced is no longer in use.
    if (showWhenReady()) options.requestRender();
    trim();
    pump();
  }

  /** Starts downloads of the tiles needed, nearest first, within the limit at once. */
  function pump(): void {
    if (disposed || !canDecode || !isNightLightDate(date())) return;
    const limit = Math.max(1, Math.round(settings.get<number>("map.imagery.concurrentRequests")));
    const at = now();
    for (const tile of needed) {
      if (loading.size >= limit) break;
      const key = nightTileKey(tile);
      const failure = failures.get(key);
      if (kept.has(key) || loading.has(key) || (failure && failure.retryAt > at)) continue;
      const controller = new AbortController();
      loading.set(key, controller);
      void load(tile, key, nightLightTileUrl(satellite(), date(), tile), controller);
    }
    scheduleRetry();
  }

  function update(view: NightLightsView): void {
    if (disposed) return;
    const day = date();
    const nextSource = `${satellite()}/${day}`;
    if (nextSource !== source) {
      reset();
      source = nextSource;
    }
    const valid = isNightLightDate(day);
    if (valid !== dateValid) {
      dateValid = valid;
      settings.setNote("sky.nightLights.date", valid ? null : "Not a date: write it as year-month-day, such as 2025-09-21. No night lights are downloaded meanwhile.");
    }
    if (!valid) return;
    const radius = horizonDistanceMeters(view.altitudeMeters);
    const span = mercatorSpan(view.latDeg, view.lonDeg, radius);
    // The texture wraps a tile's column and row into its slot, which needs a power of two across.
    const tilesAcross = 2 ** Math.round(Math.log2(Math.max(1, settings.get<number>("sky.nightLights.windowTiles"))));
    const next = chooseNightWindow(target ?? shown, span, tilesAcross, settings.get<number>("sky.nightLights.maxZoom"));
    const sunBelow = settings.get<number>("sky.nightLights.sunBelow");
    // The tiles needed change as the view moves a kilometre or the Sun a twentieth of a degree; what is kept and asked for at once, with their settings.
    const key = [
      `${next.zoom}/${next.x}/${next.y}/${next.tiles}`, view.latDeg.toFixed(2), view.lonDeg.toFixed(2), Math.round(radius / 1000),
      view.sun.map(value => value.toFixed(3)).join("/"), sunBelow, settings.get<number>("sky.nightLights.memory"), settings.get<number>("map.imagery.concurrentRequests"),
    ].join("|");
    if (key === neededKey) return;
    neededKey = key;
    target = next;
    needed = neededNightTiles(next, view, radius, view.sun, sunBelow);
    const wanted = new Set(needed.map(nightTileKey));
    for (const tile of needed) {
      const entry = kept.get(nightTileKey(tile));
      if (entry) entry.used = ++uses;
    }
    // A view that moved on, such as one zooming out, no longer waits for what it left.
    for (const [loadingKey, controller] of loading) {
      if (wanted.has(loadingKey)) continue;
      controller.abort();
      loading.delete(loadingKey);
    }
    if (showWhenReady()) options.requestRender();
    trim();
    pump();
  }

  return {
    update,
    radianceAt(latDeg, lonDeg) {
      if (!shown) return null;
      const { tile, column, row } = nightPixelAt(latDeg, lonDeg, shown.zoom);
      const greys = kept.get(nightTileKey(tile))?.greys;
      return greys ? radianceOfGrey(greys[row * NIGHT_TILE_PIXELS + column]) : null;
    },
    getState() {
      let memoryBytes = 0;
      for (const entry of kept.values()) memoryBytes += entry.greys ? entry.greys.byteLength : 0;
      const here = needed.filter(tile => kept.has(nightTileKey(tile))).length;
      const failed = needed.filter(tile => !kept.has(nightTileKey(tile)) && failures.has(nightTileKey(tile))).length;
      return {
        window: shown,
        pending: target && !sameNightWindow(target, shown) ? target : null,
        needed: needed.length,
        here,
        loading: loading.size,
        failed,
        memoryBytes,
        gpuBytes: texture ? slots.length * PIXELS * BYTES_PER_TEXEL : 0,
        downloadedBytes,
        error: !canDecode ? NO_DECODER : failed > 0 ? error : null,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      abortAll();
      stopRetry();
      disposeTexture();
      kept.clear();
      failures.clear();
      if (dateValid === false) settings.setNote("sky.nightLights.date", null);
    },
  };
}
