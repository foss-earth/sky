import { describe, expect, it } from "vitest";
import { ATMOSPHERE } from "./atmosphere";
import {
  MERCATOR_MAX_LAT_DEG, NIGHT_RADIANCE_CLIP, NIGHT_RADIANCE_UNITS, RADIANCE_BY_GREY, centredNightWindow, chooseNightWindow, distanceToTileMeters,
  horizonDistanceMeters, illuminancePerRadiance, isNightLightDate, leastSunElevationDeg, luminancePerRadiance, mercatorSpan, mercatorXY,
  neededNightTiles, nightGreysFromPixels, nightLightTileUrl, nightPixelAt, nightTexels, radianceAboveFloor, radianceOfGrey, windowCovers,
  windowSlot, windowTiles, type MercatorSpan, type NightLightPhotometry,
} from "./nightLights";

const DEG = Math.PI / 180;
const R = ATMOSPHERE.planetRadiusMeters;
/** The defaults of `sky.nightLights.*`: Otus 3's geometric mean k, its ground reflectance, and the floor. */
const DEFAULTS: NightLightPhotometry = { radiancePerEmittance: 431, groundReflectance: 0.15, floor: 0.5 };
/** The Sun over the equator at 90° E: deep night in Minneapolis, 45° N 93° W. */
const SUN_OVER_ASIA = [0, 1, 0] as const;

describe("night lights", () => {
  it("addresses a day's tile of either satellite, row before column, and refuses zooms GIBS does not serve and text that is no date", () => {
    expect(nightLightTileUrl("NOAA20", "2025-09-21", { z: 8, x: 61, y: 92 })).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_GapFilled_BRDF_Corrected_DayNightBand_Radiance/default/2025-09-21/GoogleMapsCompatible_Level8/8/92/61.png",
    );
    expect(nightLightTileUrl("SNPP", "2024-02-29", { z: 0, x: 0, y: 0 })).toContain("/VIIRS_SNPP_GapFilled_BRDF_Corrected_DayNightBand_Radiance/default/2024-02-29/GoogleMapsCompatible_Level8/0/0/0.png");
    // GIBS answers zoom 9 with 400.
    for (const z of [9, -1, 1.5]) expect(() => nightLightTileUrl("NOAA20", "2025-09-21", { z, x: 0, y: 0 })).toThrow();
    expect(() => nightLightTileUrl("NOAA20", "yesterday", { z: 1, x: 0, y: 0 })).toThrow();
    for (const day of ["2025-09-21", "2024-02-29", "2000-01-01"]) expect(isNightLightDate(day)).toBe(true);
    for (const text of ["2025-02-29", "2025-13-01", "2025-9-21", " 2025-09-21", "2025-09-21T00:00", ""]) expect(isNightLightDate(text)).toBe(false);
  });

  it("reads the colour map's greys as radiance: a bin's middle, the open last bin at its start, and other greys as no data", () => {
    const bins = [...RADIANCE_BY_GREY.entries()].filter(([, value]) => !Number.isNaN(value));
    expect(bins).toHaveLength(180);
    expect(bins[0][0]).toBe(7);
    expect(bins[179][0]).toBe(255);
    for (let bin = 1; bin < bins.length; bin++) expect(bins[bin][1]).toBeGreaterThan(bins[bin - 1][1]);
    // Bins a tenth wide up to 6.8, wider after; greys one apart from 126 on.
    expect(radianceOfGrey(7)).toBeCloseTo(0.05, 6);
    expect(radianceOfGrey(13)).toBeCloseTo(0.15, 6);
    expect(radianceOfGrey(144)).toBeCloseTo(6.9, 5);
    expect(radianceOfGrey(145)).toBeCloseTo(7.05, 5);
    expect(radianceOfGrey(254)).toBeCloseTo(37.9, 5);
    expect(NIGHT_RADIANCE_CLIP).toBe(38.2);
    expect(radianceOfGrey(255)).toBeCloseTo(NIGHT_RADIANCE_CLIP, 5);
    for (const grey of [0, 1, 6, 8, 12]) expect(radianceOfGrey(grey)).toBeNull();
  });

  it("takes a tile's pixels as greys, leaving as no data what is transparent, coloured or no bin's, and packs radiance in two bytes", () => {
    const pixels = [
      [7, 7, 7, 255], [255, 255, 255, 255], [144, 144, 144, 0], [100, 101, 100, 255], [8, 8, 8, 255], [0, 0, 0, 255], [144, 144, 144, 128],
    ];
    const greys = new Uint8Array(pixels.length);
    expect(nightGreysFromPixels(pixels.flat(), greys)).toBe(3);
    expect([...greys]).toEqual([7, 255, 0, 0, 0, 0, 144]);
    const texels = nightTexels(greys, new Uint8Array(greys.length * 4));
    // 50, 38,200 and 6,900 thousandths of a nW/(cm² sr); no data is zero; blue unused, alpha opaque.
    expect([...texels.slice(0, 8)]).toEqual([0, 50, 0, 255, 149, 56, 0, 255]);
    expect([...texels.slice(8, 12)]).toEqual([0, 0, 0, 255]);
    expect([...texels.slice(24, 28)]).toEqual([26, 244, 0, 255]);
    // Every bin survives the bytes to a thousandth, and the shader's sum of them is linear, so filtering is exact.
    const all = Uint8Array.from(RADIANCE_BY_GREY.keys()).filter(grey => radianceOfGrey(grey) !== null);
    const packed = nightTexels(all, new Uint8Array(all.length * 4));
    all.forEach((grey, index) => {
      expect((packed[index * 4] * 256 + packed[index * 4 + 1]) / NIGHT_RADIANCE_UNITS).toBeCloseTo(radianceOfGrey(grey)!, 3);
    });
  });

  it("turns radiance into the lamps' light on the ground and the luminance the satellite saw, by Otus 3's emission function", () => {
    // A city centre the colour map clips, above the floor: the parameter's reason quotes these.
    const above = radianceAboveFloor(NIGHT_RADIANCE_CLIP, DEFAULTS);
    expect(above).toBeCloseTo(37.7, 6);
    expect(above * illuminancePerRadiance(DEFAULTS)).toBeCloseTo(1.83, 2);
    expect(above * luminancePerRadiance(DEFAULTS)).toBeCloseTo(0.0875, 4);
    // What the satellite saw is the lit ground's luminance, G E / π.
    expect((DEFAULTS.groundReflectance * illuminancePerRadiance(DEFAULTS)) / Math.PI).toBeCloseTo(luminancePerRadiance(DEFAULTS), 12);
    // The sensor's threshold, two 8,000 lm lamps in a 750 m pixel, is about the default floor.
    const threshold = (DEFAULTS.radiancePerEmittance * (16_000 / 750 ** 2) * DEFAULTS.groundReflectance) / Math.PI;
    expect(threshold).toBeGreaterThan(0.4);
    expect(threshold).toBeLessThan(0.7);
    expect(radianceAboveFloor(0.3, DEFAULTS)).toBe(0);
  });

  it("places the ground to the horizon on the Mercator square, the whole width when it holds a pole", () => {
    expect(horizonDistanceMeters(0)).toBe(0);
    expect(horizonDistanceMeters(-50)).toBe(0);
    expect(horizonDistanceMeters(10_000)).toBeCloseTo(Math.sqrt(2 * R * 10_000), -3);
    expect(mercatorXY(0, 0)).toEqual([0.5, 0.5]);
    expect(mercatorXY(0, -180)[0]).toBe(0);
    expect(mercatorXY(0, 180)[0]).toBe(0);
    expect(mercatorXY(MERCATOR_MAX_LAT_DEG, 0)[1]).toBe(0);
    expect(mercatorXY(-89, 0)[1]).toBe(1);

    const radius = 100_000;
    const angleDeg = radius / R / DEG;
    const equator = mercatorSpan(0, 0, radius);
    expect(equator.width).toBeCloseTo((2 * angleDeg) / 360, 9);
    expect(equator.west).toBeCloseTo((180 - angleDeg) / 360, 9);
    expect(equator.north).toBeCloseTo(mercatorXY(angleDeg, 0)[1], 12);
    expect(equator.south).toBeCloseTo(mercatorXY(-angleDeg, 0)[1], 12);
    // At 60° the same ground spans twice the longitude.
    expect(mercatorSpan(60, 0, radius).width / equator.width).toBeCloseTo(2, 3);
    expect(mercatorSpan(89, 0, 300_000)).toEqual({ west: 0, width: 1, north: 0, south: 0 });
    expect(mercatorSpan(80, 0, 1_000_000).width).toBeLessThan(1);
    expect(mercatorSpan(80, 0, 1_200_000)).toEqual({ west: 0, width: 1, north: 0, south: mercatorXY(80 - 1_200_000 / R / DEG, 0)[1] });
    expect(mercatorSpan(30, 50, Math.PI * R)).toEqual({ west: 0, width: 1, north: 0, south: 1 });
  });

  it("chooses the finest window that holds the view with a tile to spare, keeps it while it still does, and wraps at the antimeridian", () => {
    // Zoom 3 has 8 tiles across; a window of 4 holds a span of 2 with one to spare each way.
    const small: MercatorSpan = { west: 0.3, width: 0.2, north: 0.3, south: 0.45 };
    const first = chooseNightWindow(null, small, 4, 3);
    expect(first).toEqual({ zoom: 3, x: 1, y: 1, tiles: 4 });
    expect(windowCovers(first, small)).toBe(true);
    // A span of 3 has no tile to spare in 4, so a new window would be zoom 2, the whole world; the one in use still holds it.
    const larger: MercatorSpan = { west: 0.26, width: 0.3, north: 0.26, south: 0.5 };
    expect(chooseNightWindow(null, larger, 4, 3)).toEqual({ zoom: 2, x: 0, y: 0, tiles: 4 });
    expect(chooseNightWindow(first, larger, 4, 3)).toBe(first);
    // Moved off it, it is replaced; so it is when a finer zoom fits again, and when the size changes.
    expect(chooseNightWindow(first, { ...larger, west: 0.05 }, 4, 3)).toEqual({ zoom: 2, x: 0, y: 0, tiles: 4 });
    expect(chooseNightWindow({ zoom: 2, x: 0, y: 0, tiles: 4 }, small, 4, 3)).toEqual(first);
    expect(chooseNightWindow(first, small, 8, 3)).toEqual({ zoom: 3, x: 0, y: 0, tiles: 8 });

    // Across the antimeridian the window's columns wrap, each tile to its own slot.
    const straddling: MercatorSpan = { west: -0.02, width: 0.04, north: 0.45, south: 0.55 };
    const wrapped = chooseNightWindow(null, straddling, 4, 3);
    expect(wrapped).toEqual({ zoom: 3, x: 6, y: 2, tiles: 4 });
    expect(windowCovers(wrapped, straddling)).toBe(true);
    const tiles = windowTiles(wrapped);
    expect(tiles.slice(0, 4).map(tile => tile.x)).toEqual([6, 7, 0, 1]);
    expect(new Set(tiles.map(tile => { const { column, row } = windowSlot(wrapped, tile); return row * 4 + column; })).size).toBe(16);
    // Rows stop at the grid's edges.
    expect(centredNightWindow({ west: 0.4, width: 0.1, north: 0, south: 0.01 }, 3, 4).y).toBe(0);
    expect(centredNightWindow({ west: 0.4, width: 0.1, north: 0.99, south: 1 }, 3, 4).y).toBe(4);
  });

  it("holds zoom 8 low over the ground, coarser zooms higher up, and the whole world from space", () => {
    const at = (altitudeMeters: number, tiles = 8, maxZoom = 8) =>
      chooseNightWindow(null, mercatorSpan(45, -93, horizonDistanceMeters(altitudeMeters)), tiles, maxZoom);
    expect(at(1_000).zoom).toBe(8);
    expect(at(1_000, 8, 5).zoom).toBe(5);
    expect(at(20_000).zoom).toBe(7);
    expect(at(20_000, 16).zoom).toBe(8);
    expect(at(36_000_000)).toEqual({ zoom: 3, x: 0, y: 0, tiles: 8 });
    expect(at(36_000_000, 16)).toEqual({ zoom: 4, x: 0, y: 0, tiles: 16 });
    // A count that is no power of two still ends at a whole world.
    expect(chooseNightWindow(null, mercatorSpan(0, 0, Math.PI * R), 6, 8)).toEqual({ zoom: 2, x: 0, y: 0, tiles: 4 });
  });

  it("measures the least distance to a tile along the ground, through a great circle's foot on its nearer meridian", () => {
    // Zoom 3, column 4, row 3: 0° to 45° E, the equator to 40.98° N.
    const tile = { z: 3, x: 4, y: 3 };
    expect(distanceToTileMeters(20, 10, tile)).toBe(0);
    expect(distanceToTileMeters(0, -10, tile)).toBeCloseTo(10 * DEG * R, 3);
    // From 30° N 20° W the nearest point is on the meridian 0° at 31.6° N: sin d = cos 30° sin 20°.
    expect(distanceToTileMeters(30, -20, tile)).toBeCloseTo(Math.asin(Math.cos(30 * DEG) * Math.sin(20 * DEG)) * R, 0);
    // Due north of it, the nearest point is on its top edge; from the far side of the Earth, a corner.
    expect(distanceToTileMeters(60, 20, tile)).toBeCloseTo((60 - 40.979898) * DEG * R, -2);
    expect(distanceToTileMeters(-30, -160, tile)).toBeCloseTo(Math.min(
      ...[[0, 0], [0, 45], [40.979898, 0], [40.979898, 45]].map(([lat, lon]) => {
        const cos = Math.sin(-30 * DEG) * Math.sin(lat * DEG) + Math.cos(-30 * DEG) * Math.cos(lat * DEG) * Math.cos((lon + 160) * DEG);
        return Math.acos(cos) * R;
      }),
    ), -1);
  });

  it("needs the tiles in view where the Sun is low enough somewhere, nearest first", () => {
    const world = { zoom: 3, x: 0, y: 0, tiles: 8 };
    const place = { latDeg: 45, lonDeg: -93 };
    const radius = horizonDistanceMeters(1_000_000);
    const needed = neededNightTiles(world, place, radius, SUN_OVER_ASIA, 0);
    expect(needed[0]).toEqual(nightPixelAt(45, -93, 3).tile);
    const distances = needed.map(tile => distanceToTileMeters(45, -93, tile));
    for (let index = 1; index < distances.length; index++) expect(distances[index]).toBeGreaterThanOrEqual(distances[index - 1]);
    for (const tile of needed) expect(leastSunElevationDeg(tile, SUN_OVER_ASIA)).toBeLessThan(0);
    for (const tile of windowTiles(world)) {
      const wanted = distanceToTileMeters(45, -93, tile) <= radius && leastSunElevationDeg(tile, SUN_OVER_ASIA) < 0;
      expect(needed.some(other => other.x === tile.x && other.y === tile.y)).toBe(wanted);
    }
    // Under the Sun, at the corner of four tiles, nothing is needed; the Sun is 32° up at their far corners, so below 40° it is all four.
    expect(neededNightTiles(world, { latDeg: 0, lonDeg: 90 }, 100_000, SUN_OVER_ASIA, 0)).toEqual([]);
    expect(neededNightTiles(world, { latDeg: 0, lonDeg: 90 }, 100_000, SUN_OVER_ASIA, 40)).toHaveLength(4);
    expect(neededNightTiles(world, { latDeg: 0, lonDeg: 90 }, 100_000, SUN_OVER_ASIA, 30)).toEqual([]);
    // A tile holding the point opposite the Sun has it straight down.
    expect(leastSunElevationDeg(nightPixelAt(0, -90, 3).tile, SUN_OVER_ASIA)).toBe(-90);
  });

  it("finds the pixel a place falls on, at the grid's edges too", () => {
    expect(nightPixelAt(0, 0, 0)).toEqual({ tile: { z: 0, x: 0, y: 0 }, column: 128, row: 128 });
    expect(nightPixelAt(MERCATOR_MAX_LAT_DEG, -180, 1)).toEqual({ tile: { z: 1, x: 0, y: 0 }, column: 0, row: 0 });
    expect(nightPixelAt(-89, 179.99999, 8)).toEqual({ tile: { z: 8, x: 255, y: 255 }, column: 255, row: 255 });
  });
});
