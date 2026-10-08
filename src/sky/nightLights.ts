/**
 * Night lights: the light people put out at night as the VIIRS Day/Night
 * Band sees it from orbit, which NASA's Global Imagery Browse Services (GIBS)
 * serve as daily tiles of radiance. The scene uses it as the light it puts
 * on the ground, or shows it as the satellite saw it. No renderer here: the
 * tiles' addresses, their greys as radiance, the light a radiance stands
 * for, and which tiles a view needs.
 * docs/proposals/sky.md, "Night lights", is the specification.
 */

import { ATMOSPHERE } from "./atmosphere";

/** The satellites whose Day/Night Band GIBS serves as gap-filled, moonlight-corrected radiance, as their layers name them. */
export const NIGHT_LIGHT_SATELLITES = ["NOAA20", "SNPP"] as const;
export type NightLightSatellite = (typeof NIGHT_LIGHT_SATELLITES)[number];

/** The tile matrix set the layers are served in: Web Mercator, zoom 0 to 8, 256-pixel tiles. Zoom 9 is refused. */
export const NIGHT_TILE_MAX_ZOOM = 8;
export const NIGHT_TILE_PIXELS = 256;
/** Where Web Mercator ends, degrees of latitude. */
export const MERCATOR_MAX_LAT_DEG = 85.0511287798066;

/** A tile of the night lights' Web Mercator grid: `y` counts down from the north. */
export interface NightTile {
  z: number;
  x: number;
  y: number;
}

export const nightTileKey = (tile: NightTile): string => `${tile.z}/${tile.x}/${tile.y}`;

/** Whether a text is a calendar day as GIBS takes it, year-month-day. */
export function isNightLightDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return day.getUTCFullYear() === Number(match[1]) && day.getUTCMonth() === Number(match[2]) - 1 && day.getUTCDate() === Number(match[3]);
}

/** A tile's address: the day's gap-filled, BRDF-corrected Day/Night Band radiance of one satellite. */
export function nightLightTileUrl(satellite: NightLightSatellite, date: string, tile: NightTile): string {
  if (!Number.isInteger(tile.z) || tile.z < 0 || tile.z > NIGHT_TILE_MAX_ZOOM) throw new Error(`Night light tiles have zooms 0 to ${NIGHT_TILE_MAX_ZOOM}, not ${tile.z}.`);
  if (!isNightLightDate(date)) throw new Error(`"${date}" is not a date as year-month-day.`);
  const layer = `VIIRS_${satellite}_GapFilled_BRDF_Corrected_DayNightBand_Radiance`;
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/GoogleMapsCompatible_Level8/${tile.z}/${tile.y}/${tile.x}.png`;
}

/**
 * GIBS's colour map for these layers, `VIIRS_DayNightBand_At_Sensor_Radiance`
 * v1.3: each bin's grey, increasing, and its lower bound in tenths of
 * nW/(cm² sr). A bin ends where the next begins; the last is open. Index 0,
 * no data, is transparent, as are the palette's entries past the bins.
 */
const BIN_GREYS = [
  7, 13, 19, 24, 29, 33, 37, 41, 45, 48, 52, 55, 58, 61, 64, 67, 69, 72, 74, 77, 79, 81, 83, 85, 87, 89, 91, 93, 95, 96, 98, 100, 101, 103, 105, 106, 108, 109, 111, 112, 113, 115, 116, 117, 118, 120, 121, 122, 123, 125,
  126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175,
  176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225,
  226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255,
] as const;
const BIN_LOWS_TENTHS = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
  50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 70, 71, 72, 73, 74, 76, 77, 78, 79, 81, 82, 83, 85, 86, 88, 89, 90, 92, 93, 95, 96, 98, 100, 101, 103, 104, 106, 108, 110, 111, 113,
  115, 117, 118, 120, 122, 124, 126, 128, 130, 132, 134, 136, 139, 141, 143, 145, 147, 150, 152, 154, 157, 159, 162, 164, 167, 169, 172, 175, 177, 180, 183, 186, 188, 191, 194, 197, 200, 203, 207, 210, 213, 216, 219, 223, 226, 230, 233, 237, 240, 244,
  248, 251, 255, 259, 263, 267, 271, 275, 279, 283, 288, 292, 296, 301, 305, 310, 315, 319, 324, 329, 334, 339, 344, 349, 355, 360, 365, 371, 376, 382,
] as const;

/** The colour map's last bin opens here, nW/(cm² sr): brighter ground, as city centres are, is clipped to it. */
export const NIGHT_RADIANCE_CLIP = BIN_LOWS_TENTHS[BIN_LOWS_TENTHS.length - 1] / 10;

/**
 * Radiance by grey, nW/(cm² sr): a bin's middle, and the open last bin's
 * lower bound. NaN for a grey that is no bin's.
 */
export const RADIANCE_BY_GREY: Float32Array = (() => {
  const table = new Float32Array(256).fill(Number.NaN);
  BIN_GREYS.forEach((grey, bin) => {
    const low = BIN_LOWS_TENTHS[bin] / 10;
    table[grey] = bin + 1 < BIN_LOWS_TENTHS.length ? (low + BIN_LOWS_TENTHS[bin + 1] / 10) / 2 : low;
  });
  return table;
})();

/** Radiance as the GPU and the tile store hold it: an unsigned 16-bit count of these parts of a nW/(cm² sr). */
export const NIGHT_RADIANCE_UNITS = 1000;

/** Radiance by grey in `NIGHT_RADIANCE_UNITS`; 0 for a grey that is no bin's. */
const UNITS_BY_GREY: Uint16Array = Uint16Array.from(RADIANCE_BY_GREY, value => (Number.isNaN(value) ? 0 : Math.round(value * NIGHT_RADIANCE_UNITS)));

/**
 * A decoded tile's pixels, RGBA, as greys of the colour map: 0 where the
 * pixel is transparent, not grey or no bin's grey, which is no data. Returns
 * how many pixels hold data.
 */
export function nightGreysFromPixels(rgba: ArrayLike<number>, out: Uint8Array): number {
  let data = 0;
  for (let pixel = 0; pixel < out.length; pixel++) {
    const r = rgba[pixel * 4], g = rgba[pixel * 4 + 1], b = rgba[pixel * 4 + 2], a = rgba[pixel * 4 + 3];
    const grey = a >= 128 && r === g && g === b && UNITS_BY_GREY[g] > 0 ? g : 0;
    out[pixel] = grey;
    if (grey) data++;
  }
  return data;
}

/**
 * A tile's greys as the texture holds them: radiance in
 * `NIGHT_RADIANCE_UNITS`, its high byte in red and its low byte in green, so
 * that filtering the two filters the radiance. No data is zero radiance.
 */
export function nightTexels(greys: Uint8Array, out: Uint8Array): Uint8Array {
  for (let pixel = 0; pixel < greys.length; pixel++) {
    const units = UNITS_BY_GREY[greys[pixel]];
    out[pixel * 4] = units >> 8;
    out[pixel * 4 + 1] = units & 0xff;
    out[pixel * 4 + 2] = 0;
    out[pixel * 4 + 3] = 255;
  }
  return out;
}

/** The radiance a grey stands for, or null for no data. */
export function radianceOfGrey(grey: number): number | null {
  const value = RADIANCE_BY_GREY[grey];
  return grey > 0 && !Number.isNaN(value) ? value : null;
}

/**
 * How radiance becomes light, by Otus 3's emission function looking
 * straight down (Monnier and others, arXiv:2510.02977, equations 1 and 3):
 * ground of reflectance G under lamps' direct light E sends up a luminance
 * G E / π, which the satellite measures as k G E / π.
 */
export interface NightLightPhotometry {
  /** k: the radiance measured per lm/m² of lamp light, nW/(cm² sr) per lm/m². */
  radiancePerEmittance: number;
  /** G: the reflectance of the ground the lamps light. */
  groundReflectance: number;
  /** Radiance taken as no lamp's at all, subtracted first: airglow and the sensor's noise. nW/(cm² sr). */
  floor: number;
}

/** Lux of lamps' light on the ground per nW/(cm² sr) above the floor: π / (k G). */
export function illuminancePerRadiance(photometry: NightLightPhotometry): number {
  return Math.PI / (photometry.radiancePerEmittance * photometry.groundReflectance);
}

/** The luminance the satellite saw, cd/m², per nW/(cm² sr) above the floor: 1 / k. */
export function luminancePerRadiance(photometry: NightLightPhotometry): number {
  return 1 / photometry.radiancePerEmittance;
}

/** Radiance above the floor, nW/(cm² sr). */
export const radianceAboveFloor = (radiance: number, photometry: NightLightPhotometry): number => Math.max(0, radiance - photometry.floor);

/** Web Mercator coordinates of a place, each from 0 to 1: x east from the antimeridian, y south from the grid's top. */
export function mercatorXY(latDeg: number, lonDeg: number): [number, number] {
  const lat = (Math.max(-MERCATOR_MAX_LAT_DEG, Math.min(MERCATOR_MAX_LAT_DEG, latDeg)) * Math.PI) / 180;
  const x = (((lonDeg + 180) / 360) % 1 + 1) % 1;
  // Clamped: at Mercator's edge rounding would leave the square by a hair, and a row would be -1.
  const y = Math.min(1, Math.max(0, 0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI)));
  return [x, y];
}

const latitudeOfMercatorY = (y: number): number => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/** The distance along the ground from below a height to the horizon, m, over a sphere of the Earth's mean radius. */
export function horizonDistanceMeters(altitudeMeters: number): number {
  const radius = ATMOSPHERE.planetRadiusMeters;
  return radius * Math.acos(radius / (radius + Math.max(0, altitudeMeters)));
}

/**
 * The part of the Mercator square a cap of ground spans: the ground within
 * `radiusMeters` of a place, in tiles of zoom 0. `west` may be negative or
 * the span wider than the square's 1, which is the whole width.
 */
export interface MercatorSpan {
  west: number;
  width: number;
  north: number;
  south: number;
}

export function mercatorSpan(latDeg: number, lonDeg: number, radiusMeters: number): MercatorSpan {
  const angle = Math.min(Math.PI, radiusMeters / ATMOSPHERE.planetRadiusMeters);
  const angleDeg = (angle * 180) / Math.PI;
  const cosLat = Math.cos((latDeg * Math.PI) / 180);
  // A cap's widest longitude: sin Δλ = sin r / cos φ, or every longitude when it holds a pole.
  const lonSpanDeg = Math.sin(angle) >= cosLat || angle >= Math.PI / 2 ? 180 : (Math.asin(Math.sin(angle) / cosLat) * 180) / Math.PI;
  const [, north] = mercatorXY(Math.min(90, latDeg + angleDeg), 0);
  const [, south] = mercatorXY(Math.max(-90, latDeg - angleDeg), 0);
  return lonSpanDeg >= 180
    ? { west: 0, width: 1, north, south }
    : { west: (lonDeg - lonSpanDeg + 180) / 360, width: (2 * lonSpanDeg) / 360, north, south };
}

/**
 * A square of `tiles` × `tiles` tiles of one zoom, from (`x`, `y`): the
 * part of the night lights the texture holds. Columns wrap at the
 * antimeridian; rows do not. At `tiles` = 2^zoom it is the whole world.
 */
export interface NightWindow {
  zoom: number;
  x: number;
  y: number;
  tiles: number;
}

export const sameNightWindow = (a: NightWindow | null, b: NightWindow | null): boolean =>
  a === b || (a !== null && b !== null && a.zoom === b.zoom && a.x === b.x && a.y === b.y && a.tiles === b.tiles);

/** Whether a window holds every tile a span touches. */
export function windowCovers(window: NightWindow, span: MercatorSpan): boolean {
  const count = 2 ** window.zoom;
  if (window.tiles >= count) return true;
  if (span.width >= 1) return false;
  const west = Math.floor(span.west * count);
  const east = Math.floor((span.west + span.width) * count - 1e-9);
  const north = Math.floor(span.north * count);
  const south = Math.floor(span.south * count - 1e-9);
  const offset = (((west - window.x) % count) + count) % count;
  return offset + (east - west) < window.tiles && north >= window.y && south < window.y + window.tiles;
}

/** A window of `tiles` across at a zoom, centred on a span; the whole world where the zoom has no more tiles than that. */
export function centredNightWindow(span: MercatorSpan, zoom: number, tiles: number): NightWindow {
  const count = 2 ** zoom;
  if (tiles >= count) return { zoom, x: 0, y: 0, tiles: count };
  const centreX = (span.width >= 1 ? 0.5 : span.west + span.width / 2) * count;
  const centreY = ((span.north + span.south) / 2) * count;
  const x = ((Math.round(centreX - tiles / 2) % count) + count) % count;
  const y = Math.max(0, Math.min(count - tiles, Math.round(centreY - tiles / 2)));
  return { zoom, x, y, tiles };
}

/**
 * The window a view needs: the finest zoom, at most `maxZoom`, at which
 * `tiles` across hold the span with a tile to spare on every side, so the
 * view travels a tile before the window must follow. A window already in use
 * is kept while it still holds the span and is no coarser than that zoom:
 * the texture changes only when it must.
 */
export function chooseNightWindow(current: NightWindow | null, span: MercatorSpan, tiles: number, maxZoom: number): NightWindow {
  const top = Math.max(0, Math.min(NIGHT_TILE_MAX_ZOOM, Math.floor(maxZoom)));
  // A window of `tiles` holds the whole world at this zoom, and so any span.
  const least = Math.min(top, Math.max(0, Math.floor(Math.log2(tiles))));
  let zoom = least;
  for (let candidate = top; candidate > least; candidate--) {
    const count = 2 ** candidate;
    const across = Math.floor((span.west + span.width) * count - 1e-9) - Math.floor(span.west * count) + 1;
    const down = Math.floor(span.south * count - 1e-9) - Math.floor(span.north * count) + 1;
    if (span.width < 1 && across + 2 <= tiles && down + 2 <= tiles) {
      zoom = candidate;
      break;
    }
  }
  const size = Math.min(tiles, 2 ** zoom);
  if (current && current.tiles === size && current.zoom >= zoom && current.zoom <= top && windowCovers(current, span)) return current;
  return centredNightWindow(span, zoom, size);
}

/** The window's tiles, by their place in it. */
export function windowTiles(window: NightWindow): NightTile[] {
  const count = 2 ** window.zoom;
  const out: NightTile[] = [];
  for (let row = 0; row < window.tiles; row++) {
    for (let column = 0; column < window.tiles; column++) {
      out.push({ z: window.zoom, x: (window.x + column) % count, y: window.y + row });
    }
  }
  return out;
}

/** A tile's slot in the texture: the texture wraps, so a tile keeps its slot while the window moves over it. */
export function windowSlot(window: NightWindow, tile: NightTile): { column: number; row: number } {
  return { column: ((tile.x % window.tiles) + window.tiles) % window.tiles, row: ((tile.y % window.tiles) + window.tiles) % window.tiles };
}

const DEG = Math.PI / 180;

/** The distance along the ground between two places, m, over a sphere of the Earth's mean radius. */
function groundDistanceMeters(latA: number, lonA: number, latB: number, lonB: number): number {
  const a = Math.sin(((latB - latA) * DEG) / 2) ** 2 + Math.cos(latA * DEG) * Math.cos(latB * DEG) * Math.sin(((lonB - lonA) * DEG) / 2) ** 2;
  return 2 * ATMOSPHERE.planetRadiusMeters * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The least distance from a place to a tile along the ground, m. */
export function distanceToTileMeters(latDeg: number, lonDeg: number, tile: NightTile): number {
  const count = 2 ** tile.z;
  const north = latitudeOfMercatorY(tile.y / count);
  const south = latitudeOfMercatorY((tile.y + 1) / count);
  const west = (tile.x / count) * 360 - 180;
  const width = 360 / count;
  const east = (((lonDeg - west) % 360) + 360) % 360;
  // Between the tile's meridians the nearest point is on the place's own, at the nearest latitude.
  if (east <= width) return groundDistanceMeters(latDeg, lonDeg, Math.max(south, Math.min(north, latDeg)), lonDeg);
  // Otherwise it is on the nearer meridian: at a corner, or where a great circle from the place meets that meridian square.
  const edge = east - width < 360 - east ? west + width : west;
  const cosApart = Math.cos((lonDeg - edge) * DEG);
  let least = Math.min(groundDistanceMeters(latDeg, lonDeg, north, edge), groundDistanceMeters(latDeg, lonDeg, south, edge));
  if (cosApart > 0) {
    const foot = Math.atan(Math.tan(latDeg * DEG) / cosApart) / DEG;
    least = Math.min(least, groundDistanceMeters(latDeg, lonDeg, Math.max(south, Math.min(north, foot)), edge));
  }
  return least;
}

/** Points across a tile on which the Sun's height is looked at: a grid this many a side. */
const SUN_SAMPLES_ACROSS = 5;

/**
 * The Sun's least height over a tile, degrees: the lowest of a grid of its
 * points, and -90 where the point opposite the Sun lies on it. `sun` is a
 * unit vector in the Earth's axes.
 */
export function leastSunElevationDeg(tile: NightTile, sun: readonly [number, number, number]): number {
  const count = 2 ** tile.z;
  const north = latitudeOfMercatorY(tile.y / count);
  const south = latitudeOfMercatorY((tile.y + 1) / count);
  const west = (tile.x / count) * 360 - 180;
  const width = 360 / count;
  const antiLat = Math.asin(Math.max(-1, Math.min(1, -sun[2]))) / DEG;
  const antiLon = Math.atan2(-sun[1], -sun[0]) / DEG;
  if (antiLat <= north && antiLat >= south && ((((antiLon - west) % 360) + 360) % 360) <= width) return -90;
  let least = 1;
  for (let i = 0; i < SUN_SAMPLES_ACROSS; i++) {
    const lat = (south + ((north - south) * i) / (SUN_SAMPLES_ACROSS - 1)) * DEG;
    for (let j = 0; j < SUN_SAMPLES_ACROSS; j++) {
      const lon = (west + (width * j) / (SUN_SAMPLES_ACROSS - 1)) * DEG;
      const sine = Math.cos(lat) * Math.cos(lon) * sun[0] + Math.cos(lat) * Math.sin(lon) * sun[1] + Math.sin(lat) * sun[2];
      least = Math.min(least, sine);
    }
  }
  return Math.asin(least) / DEG;
}

/**
 * The tiles of a window a view needs, nearest first: those within
 * `radiusMeters` of the place, the ground it can see, on which the Sun is
 * below `sunBelowDeg` somewhere, where lamps' light could show.
 */
export function neededNightTiles(
  window: NightWindow, place: { latDeg: number; lonDeg: number }, radiusMeters: number,
  sun: readonly [number, number, number], sunBelowDeg: number,
): NightTile[] {
  return windowTiles(window)
    .map(tile => ({ tile, distance: distanceToTileMeters(place.latDeg, place.lonDeg, tile) }))
    .filter(({ tile, distance }) => distance <= radiusMeters && leastSunElevationDeg(tile, sun) < sunBelowDeg)
    .sort((a, b) => a.distance - b.distance)
    .map(({ tile }) => tile);
}

/** The pixel of a tile of zoom `z` a place falls on: the tile, and the pixel's column and row in it. */
export function nightPixelAt(latDeg: number, lonDeg: number, z: number): { tile: NightTile; column: number; row: number } {
  const count = 2 ** z;
  const [x, y] = mercatorXY(latDeg, lonDeg);
  const px = Math.min(count * NIGHT_TILE_PIXELS - 1, Math.floor(x * count * NIGHT_TILE_PIXELS));
  const py = Math.min(count * NIGHT_TILE_PIXELS - 1, Math.max(0, Math.floor(y * count * NIGHT_TILE_PIXELS)));
  return {
    tile: { z, x: Math.floor(px / NIGHT_TILE_PIXELS), y: Math.floor(py / NIGHT_TILE_PIXELS) },
    column: px % NIGHT_TILE_PIXELS,
    row: py % NIGHT_TILE_PIXELS,
  };
}
