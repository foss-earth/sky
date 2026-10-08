import { describe, expect, it } from "vitest";
import { DEG_TO_RAD, geodeticToEcef } from "../camera/cameraMath";
import { ATMOSPHERE, createAtmosphere, type Rgb } from "./atmosphere";
import { solarEphemeris, solarPosition, spaRefractionDeg } from "./solarPosition";
import {
  adaptEv100, computeSkyIllumination, createSkyDomeGeometry, drawnRefractionDeg, ev100ForIlluminance, ev100ForWhiteLuminance,
  fillSkyDome, horizonDipDeg, luminance, observerAt, standardAtmosphere, starEv100, whiteLuminanceForEv100, type SkyObserver,
} from "./skyState";

const atmosphere = createAtmosphere({ aerosolOpticalDepth: 0.1, groundAlbedo: 0.2 });
const NIGHT = { nightLuminance: 2e-4 };

function observerAtGeodetic(latDeg: number, lonDeg: number, altitudeMeters: number): SkyObserver {
  const { x, y, z } = geodeticToEcef(latDeg * DEG_TO_RAD, lonDeg * DEG_TO_RAD, altitudeMeters);
  return observerAt(x, y, z);
}

/** An instant at which the Sun stands at a geometric elevation over 0°N 0°E, found by bisection on a morning. */
function instantForElevation(elevationDeg: number): number {
  let low = Date.UTC(2026, 2, 20, 0, 0);
  let high = Date.UTC(2026, 2, 20, 12, 0);
  for (let i = 0; i < 50; i++) {
    const middle = (low + high) / 2;
    if (solarPosition({ utcMs: middle, latDeg: 0, lonDeg: 0 }).elevationDeg < elevationDeg) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function illuminationAt(elevationDeg: number, altitudeMeters = 0) {
  const utcMs = instantForElevation(elevationDeg);
  return computeSkyIllumination(atmosphere, solarEphemeris(utcMs), observerAtGeodetic(0, 0, altitudeMeters), NIGHT);
}

describe("exposure", () => {
  it("follows the photographic standards: a sunny day meters near EV 15, and white is 1.2 × 2^EV cd/m²", () => {
    expect(ev100ForIlluminance(100_000)).toBeCloseTo(Math.log2(40_000), 12);
    expect(ev100ForIlluminance(100_000)).toBeGreaterThan(15);
    expect(whiteLuminanceForEv100(15)).toBeCloseTo(39_321.6, 6);
    expect(ev100ForWhiteLuminance(whiteLuminanceForEv100(-3.25))).toBeCloseTo(-3.25, 12);
    // The reference emitters used before exposure was calibrated: white at 1,000 cd/m².
    expect(ev100ForWhiteLuminance(1000)).toBeCloseTo(9.7027, 4);
  });

  it("follows the light down from a high Sun's by the adaptation's share of each stop", () => {
    // A camera follows all of it; eyes, part; none holds the high Sun's exposure.
    expect(adaptEv100(8, 16, 1)).toBe(8);
    expect(adaptEv100(8, 16, 0.75)).toBe(10);
    expect(adaptEv100(8, 16, 0)).toBe(16);
    // Light two stops under exposure's own: a surface shows a quarter as bright at 0.75 as at 1.
    expect(2 ** (adaptEv100(8, 16, 1) - adaptEv100(8, 16, 0.75))).toBe(0.25);
    // Brighter than a high Sun's, as above snow or cloud, is followed whole; a share out of range is held to it.
    expect(adaptEv100(17, 16, 0.5)).toBe(17);
    expect(adaptEv100(8, 16, 3)).toBe(8);
    expect(adaptEv100(8, 16, -1)).toBe(16);
  });

  it("shows the stars at the scene's exposure near the ground and at the darkest above the air, a stop for each equal step of height between", () => {
    // By day, EV 15 for the scene and EV 1 the darkest allowed, between the ground and 80 km.
    const at = (meters: number) => starEv100(15, 1, meters, 0, 80_000);
    expect(at(0)).toBe(15);
    expect(at(20_000)).toBe(11.5);
    expect(at(40_000)).toBe(8);
    expect(at(80_000)).toBe(1);
    expect(at(400_000)).toBe(1);
    expect(at(-50)).toBe(15);
    // From a lower height than the ground's: unchanged below it.
    expect(starEv100(15, 1, 15_000, 20_000, 80_000)).toBe(15);
    expect(starEv100(15, 1, 50_000, 20_000, 80_000)).toBe(8);
    // At night the scene's exposure is the darkest already: the same at every height, and never brighter than the scene's.
    expect(starEv100(1, 1, 40_000, 0, 80_000)).toBe(1);
    expect(starEv100(0.5, 1, 400_000, 0, 80_000)).toBe(0.5);
    // Two equal heights make a step.
    expect(starEv100(15, 1, 99_999, 100_000, 100_000)).toBe(15);
    expect(starEv100(15, 1, 100_000, 100_000, 100_000)).toBe(1);
  });

  it("dips the horizon by the viewpoint's height", () => {
    expect(horizonDipDeg(0)).toBe(0);
    expect(horizonDipDeg(-20)).toBe(0);
    // √(2 h / R) radians near the ground: 1.0° from a kilometre up.
    expect(horizonDipDeg(1000)).toBeCloseTo(Math.sqrt(2000 / ATMOSPHERE.planetRadiusMeters) / DEG_TO_RAD, 3);
    expect(horizonDipDeg(400_000)).toBeCloseTo(19.8, 1);
    // From far off the planet is a small disc: the horizon nears straight down.
    expect(horizonDipDeg(20_000_000)).toBeCloseTo(76.0, 1);
  });
});

describe("refraction for drawing", () => {
  it("is the standard atmosphere's at the observer's height", () => {
    expect(standardAtmosphere(0).pressureMbar).toBe(1013.25);
    expect(standardAtmosphere(0).temperatureC).toBeCloseTo(15, 9);
    const tropopause = standardAtmosphere(11_000);
    expect(tropopause.pressureMbar).toBeCloseTo(226.32, 1);
    expect(tropopause.temperatureC).toBeCloseTo(-56.5, 6);
    expect(standardAtmosphere(20_000).pressureMbar).toBeCloseTo(54.7, 0);
    expect(drawnRefractionDeg(10, 0)).toBeCloseTo(spaRefractionDeg(10, 1013.25, 15), 12);
    expect(drawnRefractionDeg(10, 10_000)).toBeLessThan(drawnRefractionDeg(10, 0) * 0.4);
  });

  it("has no step where the report's ends, and is gone by six degrees down", () => {
    const above = drawnRefractionDeg(-0.8333, 0);
    const below = drawnRefractionDeg(-0.8334, 0);
    expect(above).toBeGreaterThan(0.5);
    expect(Math.abs(above - below)).toBeLessThan(1e-3);
    expect(drawnRefractionDeg(-3.4, 0)).toBeGreaterThan(0);
    expect(drawnRefractionDeg(-6, 0)).toBe(0);
    expect(drawnRefractionDeg(-30, 0)).toBe(0);
  });
});

describe("sky illumination", () => {
  it("puts the Sun where the solar position report's example does", () => {
    const utcMs = Date.UTC(2003, 9, 17, 19, 30, 30);
    const state = computeSkyIllumination(atmosphere, solarEphemeris(utcMs, 67), observerAtGeodetic(39.742476, -105.1786, 1830.14), NIGHT);
    // The report's zenith angle is for 820 mbar and 11 °C; the standard atmosphere at that height differs by 0.0003°.
    expect(90 - state.sunElevationDeg).toBeCloseTo(50.11162, 2);
    expect(state.sunAzimuthDeg).toBeCloseTo(194.34024, 3);
    expect(Math.hypot(...state.sunDirection)).toBeCloseTo(1, 12);
    const up = state.observer.up;
    expect(Math.asin(state.sunDirection[0] * up[0] + state.sunDirection[1] * up[1] + state.sunDirection[2] * up[2]) / DEG_TO_RAD).toBeCloseTo(state.sunElevationDeg, 9);
  });

  it("gives a clear day's light: about 100,000 lux from a high Sun and a sixth of that from the sky", () => {
    const noon = illuminationAt(75);
    expect(noon.sunElevationDeg).toBeCloseTo(75, 1);
    const direct = luminance(noon.sunIlluminance);
    const sky = luminance(noon.skyIlluminance);
    expect(direct).toBeGreaterThan(95_000);
    expect(direct).toBeLessThan(115_000);
    expect(sky).toBeGreaterThan(10_000);
    expect(sky).toBeLessThan(22_000);
    expect(noon.meteredLux).toBeCloseTo(direct + sky, 6);
    // The Sun is nearer in March than at its mean distance.
    expect(noon.solarIlluminanceLux).toBeGreaterThan(133_334);
    // Ground of albedo 0.2: L = ρ E / π.
    expect(noon.groundLuminance[1]).toBeCloseTo((0.2 * noon.groundIlluminance[1]) / Math.PI, 9);
    expect(luminance(noon.groundIlluminance)).toBeGreaterThan(100_000);
  });

  it("falls through twilight to the night sky, within a factor of three of the published illuminances", () => {
    // American Meteorological Society, Glossary of Meteorology: level illuminance of about 3.5 to 2 lux at the end of
    // civil twilight (Sun 6° down), 0.008 lux at the end of nautical (12°), and 0.0006 lux at the end of astronomical (18°).
    const level = (elevation: number): number => luminance(illuminationAt(elevation).groundIlluminance);
    const civil = level(-6);
    const nautical = level(-12);
    const astronomical = level(-18);
    expect(civil).toBeGreaterThan(2 / 3);
    expect(civil).toBeLessThan(3.5 * 3);
    expect(nautical).toBeGreaterThan(0.008 / 3);
    expect(nautical).toBeLessThan(0.008 * 3);
    expect(astronomical).toBeGreaterThan(6e-4 / 3);
    expect(astronomical).toBeLessThan(6e-4 * 3);
    let previous = Infinity;
    for (let elevation = 20; elevation >= -20; elevation -= 2) {
      const lux = level(elevation);
      expect(lux, `Sun at ${elevation}°`).toBeLessThan(previous);
      previous = lux;
    }
  });

  it("leaves only the night sky's own light once the Sun is far down", () => {
    const night = illuminationAt(-40);
    expect(luminance(night.sunIlluminance)).toBe(0);
    for (const band of night.skyIlluminance) expect(band).toBeCloseTo(Math.PI * 2e-4, 9);
    expect(night.meteredLux).toBeCloseTo(Math.PI * 2e-4, 9);
    const dark = computeSkyIllumination(atmosphere, solarEphemeris(night.utcMs), night.observer, { nightLuminance: 0 });
    expect(dark.meteredLux).toBe(0);
  });

  it("is brighter in the Sun and darker under the sky at altitude", () => {
    const low = illuminationAt(20);
    const high = illuminationAt(20, 11_000);
    expect(luminance(high.sunIlluminance)).toBeGreaterThan(luminance(low.sunIlluminance));
    expect(luminance(high.skyIlluminance)).toBeLessThan(luminance(low.skyIlluminance));
    // The ground below is lit the same wherever the observer is above it.
    expect(luminance(high.groundIlluminance) / luminance(low.groundIlluminance)).toBeCloseTo(1, 2);
  });

  it("does not depend on which way the Earth's axes point: the same Sun over any meridian", () => {
    const utcMs = instantForElevation(30);
    const shifted = utcMs - (90 / 360) * 86_164_090.5;
    const here = computeSkyIllumination(atmosphere, solarEphemeris(utcMs), observerAtGeodetic(0, 0, 500), NIGHT);
    const there = computeSkyIllumination(atmosphere, solarEphemeris(shifted), observerAtGeodetic(0, 90, 500), NIGHT);
    // A quarter turn of the Earth earlier, a quarter of the way round: the Sun's own motion in six hours is all that differs.
    expect(there.sunElevationDeg).toBeCloseTo(here.sunElevationDeg, 0);
    expect(luminance(there.sunIlluminance) / luminance(here.sunIlluminance)).toBeCloseTo(1, 1);
  });
});

describe("sky dome", () => {
  const layout = { zenithSamples: 24, azimuthSamples: 16, integrationSteps: 16 };

  it("has one grid of triangles, the Sun's disc and the Moon's, sized by its layout", () => {
    const dome = createSkyDomeGeometry(layout);
    expect(dome.columns).toBe(32);
    expect(dome.rows).toBe(24 + 1 + 9);
    // The Moon's disc: a centre and six rings of 24, a fan and five bands of triangles.
    expect(dome.moonDiscStart).toBe(dome.rows * dome.columns + 21);
    expect(dome.vertexCount).toBe(dome.rows * dome.columns + 21 + 1 + 6 * 24);
    expect(dome.indices.length).toBe((dome.rows - 1) * dome.columns * 6 + 20 * 3 + 24 * (1 + 2 * 5) * 3);
    expect(Math.max(...dome.indices)).toBe(dome.vertexCount - 1);
    expect(createSkyDomeGeometry({ zenithSamples: 1, azimuthSamples: 1, integrationSteps: 0 }).layout).toEqual({ zenithSamples: 4, azimuthSamples: 4, integrationSteps: 2 });
  });

  it("samples the model's sky in every direction, mirrored about the Sun", () => {
    const dome = createSkyDomeGeometry(layout);
    const state = illuminationAt(35);
    fillSkyDome(dome, atmosphere, state);
    expect(dome.evaluations).toBe(dome.rows * (dome.columns / 2 + 1) + 1);
    const out: Rgb = [0, 0, 0];
    const muSun = Math.sin(state.sunElevationDeg * DEG_TO_RAD);
    for (let vertex = 0; vertex < dome.vertexCount; vertex++) {
      const [x, y, z] = dome.directions.subarray(vertex * 3, vertex * 3 + 3);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 5);
      for (let c = 0; c < 3; c++) expect(Number.isFinite(dome.luminances[vertex * 3 + c])).toBe(true);
    }
    // The first row is the zenith: the model's own value there, plus the night sky.
    atmosphere.radiance(0, 1, muSun, muSun, 16, out);
    expect(dome.directions[1]).toBeCloseTo(1, 6);
    expect(dome.luminances[1]).toBeCloseTo(out[1] * state.solarIlluminanceLux + 2e-4, 0);
    // Left of the Sun looks like right of it.
    const row = 12;
    for (let column = 1; column < dome.columns / 2; column++) {
      const a = (row * dome.columns + column) * 3;
      const b = (row * dome.columns + dome.columns - column) * 3;
      expect(dome.luminances[b]).toBe(dome.luminances[a]);
      expect(dome.directions[b + 2]).toBe(-dome.directions[a + 2]);
      expect(dome.directions[b]).toBe(dome.directions[a]);
    }
    // One row lies on the horizon, where the rows are closest together.
    const elevations = Array.from({ length: dome.rows }, (_, index) => Math.asin(dome.directions[index * dome.columns * 3 + 1]) / DEG_TO_RAD);
    expect(elevations.some(elevation => Math.abs(elevation) < 1e-3)).toBe(true);
    const nearHorizon = elevations.filter(elevation => elevation > 0 && elevation < 5).length;
    const nearZenith = elevations.filter(elevation => elevation > 85).length;
    expect(nearHorizon).toBeGreaterThan(nearZenith);
  });

  it("draws the Sun as a disc of its own size and luminance, where the Sun is", () => {
    const dome = createSkyDomeGeometry(layout);
    const state = illuminationAt(35);
    fillSkyDome(dome, atmosphere, state);
    const centre = dome.rows * dome.columns;
    const direction = dome.directions.subarray(centre * 3, centre * 3 + 3);
    expect(Math.asin(direction[1]) / DEG_TO_RAD).toBeCloseTo(state.sunElevationDeg, 4);
    expect(direction[2]).toBe(0);
    for (let rim = 1; rim <= 20; rim++) {
      const edge = dome.directions.subarray((centre + rim) * 3, (centre + rim) * 3 + 3);
      const cosine = direction[0] * edge[0] + direction[1] * edge[1] + direction[2] * edge[2];
      expect(Math.acos(Math.min(1, cosine))).toBeCloseTo(ATMOSPHERE.sunAngularRadius, 4);
    }
    // About 1.5 billion cd/m² through a clear sky: its illuminance over the solid angle it fills.
    const solidAngle = Math.PI * ATMOSPHERE.sunAngularRadius ** 2;
    const disc: Rgb = [dome.luminances[centre * 3], dome.luminances[centre * 3 + 1], dome.luminances[centre * 3 + 2]];
    expect(luminance(disc)).toBeGreaterThan(luminance(state.sunIlluminance) / solidAngle);
    expect(luminance(disc)).toBeGreaterThan(1e9);
    expect(luminance(disc)).toBeLessThan(2e9);
  });

  it("puts its closest rows on the horizon the observer sees from a height, and shows black above the air", () => {
    const dome = createSkyDomeGeometry(layout);
    const state = illuminationAt(35, 400_000);
    fillSkyDome(dome, atmosphere, state);
    const dip = Math.acos(ATMOSPHERE.planetRadiusMeters / (ATMOSPHERE.planetRadiusMeters + 400_000)) / DEG_TO_RAD;
    const elevations = Array.from({ length: dome.rows }, (_, index) => Math.asin(dome.directions[index * dome.columns * 3 + 1]) / DEG_TO_RAD);
    expect(elevations.some(elevation => Math.abs(elevation + dip) < 1e-3)).toBe(true);
    // Overhead there is no air: only the night sky's luminance.
    expect(dome.luminances[1]).toBeCloseTo(2e-4, 9);
  });
});
