import { describe, expect, it } from "vitest";
import { ATMOSPHERE, createAtmosphere, miePhase, rayleighPhase, type Rgb } from "./atmosphere";

const CLEAR = { aerosolOpticalDepth: 0.1, groundAlbedo: 0.2 };
const Y = (c: Readonly<Rgb>): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const RG = ATMOSPHERE.planetRadiusMeters;
const sinDeg = (degrees: number): number => Math.sin((degrees * Math.PI) / 180);
const cosDeg = (degrees: number): number => Math.cos((degrees * Math.PI) / 180);

/** Optical depth to the top of the air by brute force: many short steps, the densities as the model defines them. */
function opticalDepth(altitude: number, mu: number, aerosol: number): Rgb {
  const r = RG + altitude;
  const top = RG + ATMOSPHERE.thicknessMeters;
  const length = -r * mu + Math.sqrt(r * r * (mu * mu - 1) + top * top);
  const steps = 20_000;
  const depth: Rgb = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const s = ((i + 0.5) / steps) * length;
    const h = Math.sqrt(r * r + s * s + 2 * r * mu * s) - RG;
    const air = Math.exp(-h / ATMOSPHERE.rayleighScaleHeightMeters);
    const haze = Math.exp(-h / ATMOSPHERE.mieScaleHeightMeters) * (aerosol / ATMOSPHERE.mieScaleHeightMeters);
    const ozone = Math.max(0, 1 - Math.abs(h - ATMOSPHERE.ozoneCenterMeters) / ATMOSPHERE.ozoneHalfWidthMeters);
    for (let c = 0; c < 3; c++) depth[c] += (ATMOSPHERE.rayleighScattering[c] * air + haze + ATMOSPHERE.ozoneAbsorption[c] * ozone) * (length / steps);
  }
  return depth;
}

describe("atmosphere", () => {
  const atmosphere = createAtmosphere(CLEAR);
  const out: Rgb = [0, 0, 0];

  it("keeps its phase functions' energy: each integrates to one over the sphere", () => {
    let air = 0, haze = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const nu = ((i + 0.5) / n) * 2 - 1;
      air += rayleighPhase(nu) * (2 / n) * 2 * Math.PI;
      haze += miePhase(nu) * (2 / n) * 2 * Math.PI;
    }
    expect(air).toBeCloseTo(1, 6);
    expect(haze).toBeCloseTo(1, 3);
  });

  it("passes the share of sunlight the air's optical depth leaves, to within 1.5%", () => {
    // Straight up from the sea: the closed form of each layer.
    const vertical = atmosphere.sunTransmittance(0, 1, out);
    for (let c = 0; c < 3; c++) {
      const depth = ATMOSPHERE.rayleighScattering[c] * ATMOSPHERE.rayleighScaleHeightMeters * (1 - Math.exp(-ATMOSPHERE.thicknessMeters / ATMOSPHERE.rayleighScaleHeightMeters))
        + CLEAR.aerosolOpticalDepth + ATMOSPHERE.ozoneAbsorption[c] * ATMOSPHERE.ozoneHalfWidthMeters;
      expect(vertical[c] / Math.exp(-depth), `band ${c}`).toBeCloseTo(1, 2);
    }
    // And along slanting paths from several heights, against brute force.
    let worst = 0;
    for (const altitude of [0, 500, 3_000, 12_000, 40_000]) {
      for (const elevation of [80, 30, 10, 4, 1.5]) {
        const mu = sinDeg(elevation);
        const expected = opticalDepth(altitude, mu, CLEAR.aerosolOpticalDepth);
        const actual = atmosphere.sunTransmittance(altitude, mu, out);
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(actual[c] / Math.exp(-expected[c]) - 1));
      }
    }
    expect(worst).toBeLessThan(0.015);
  });

  it("hides the Sun's disc as it crosses the horizon, and lets it through from a height", () => {
    const radius = ATMOSPHERE.sunAngularRadius;
    const whole = Y(atmosphere.sunTransmittance(0, 2 * radius, out));
    const half = Y(atmosphere.sunTransmittance(0, 0, out));
    expect(Y(atmosphere.sunTransmittance(0, -1.01 * radius, out))).toBe(0);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(whole);
    // From 10 km the horizon is 3° down: a Sun 1° below level is still up.
    expect(Y(atmosphere.sunTransmittance(10_000, sinDeg(-1), out))).toBeGreaterThan(0);
    expect(Y(atmosphere.sunTransmittance(10_000, sinDeg(-4), out))).toBe(0);
  });

  it("reads the same sunlight above the air whatever the height, unless the Earth is in the way", () => {
    expect(atmosphere.sunTransmittance(400_000, 0.3, out)).toEqual([1, 1, 1]);
    expect(atmosphere.sunTransmittance(2e7, -0.2, out)).toEqual([1, 1, 1]);
    // From 400 km the Earth's limb is 19.6° below level: a Sun 30° below it is behind the planet.
    expect(Y(atmosphere.sunTransmittance(400_000, sinDeg(-50), out))).toBe(0);
  });

  it("converges: sixteen steps are within 8% of five hundred", () => {
    const reference: Rgb = [0, 0, 0];
    let worst = 0;
    for (const sun of [60, 10, 0, -4]) {
      for (const view of [90, 45, 10, 2, 0.2]) {
        for (const bearing of [0, 90, 180]) {
          const muSun = sinDeg(sun);
          const mu = sinDeg(view);
          const nu = mu * muSun + cosDeg(view) * cosDeg(sun) * cosDeg(bearing);
          atmosphere.radiance(0, mu, muSun, nu, 512, reference);
          atmosphere.radiance(0, mu, muSun, nu, 16, out);
          worst = Math.max(worst, Math.abs(Y(out) / Y(reference) - 1));
        }
      }
    }
    expect(worst).toBeLessThan(0.08);
  });

  it("is blue overhead by day and red towards a setting Sun", () => {
    const noon = atmosphere.radiance(0, 1, sinDeg(50), sinDeg(50), 16, out);
    expect(noon[2]).toBeGreaterThan(noon[1]);
    expect(noon[1]).toBeGreaterThan(noon[0]);
    const muSun = sinDeg(0.5);
    const mu = sinDeg(2);
    const sunset = atmosphere.radiance(0, mu, muSun, mu * muSun + cosDeg(2) * cosDeg(0.5), 32, out);
    expect(sunset[0]).toBeGreaterThan(sunset[2]);
  });

  it("darkens overhead with height and is black above the air", () => {
    const muSun = 0.5;
    const ground = Y(atmosphere.radiance(0, 1, muSun, muSun, 16, out));
    const cruise = Y(atmosphere.radiance(12_000, 1, muSun, muSun, 16, out));
    const space = Y(atmosphere.radiance(400_000, 1, muSun, muSun, 16, out));
    expect(cruise).toBeLessThan(ground * 0.4);
    expect(space).toBe(0);
    // From orbit the lit ground shows straight down, and the air's edge glows.
    expect(Y(atmosphere.radiance(400_000, -1, muSun, -muSun, 16, out))).toBeGreaterThan(0);
    const limb = Math.PI - Math.asin((RG + 20_000) / (RG + 400_000));
    expect(Y(atmosphere.radiance(400_000, Math.cos(limb), muSun, Math.cos(limb) * muSun + Math.sin(limb) * Math.sqrt(1 - muSun * muSun), 32, out))).toBeGreaterThan(0);
  });

  it("never returns more light than arrives: Sun and sky on level ground stay under the Sun's above the air", () => {
    for (const elevation of [90, 60, 30, 15]) {
      const muSun = sinDeg(elevation);
      const direct = Y(atmosphere.sunTransmittance(0, muSun, out)) * muSun;
      const sky = Y(atmosphere.skyIrradiance(0, muSun, out));
      expect((direct + sky) / muSun, `Sun at ${elevation}°`).toBeLessThan(1);
      expect((direct + sky) / muSun, `Sun at ${elevation}°`).toBeGreaterThan(0.6);
    }
  });

  it("gathers the sky's light on a level surface to within 2% of a fine sum by day and civil twilight, and 10% beyond", () => {
    const sample: Rgb = [0, 0, 0];
    // Rings in equal steps of zenith angle, each weighted by its cosine and solid angle.
    const fine = (muSun: number): number => {
      const zeniths = 72, azimuths = 72;
      const sinSun = Math.sqrt(1 - muSun * muSun);
      let sum = 0;
      for (let i = 0; i < zeniths; i++) {
        const theta = ((i + 0.5) / zeniths) * (Math.PI / 2);
        for (let j = 0; j < azimuths; j++) {
          const phi = ((j + 0.5) / azimuths) * Math.PI;
          const nu = Math.cos(theta) * muSun + Math.sin(theta) * sinSun * Math.cos(phi);
          sum += Y(atmosphere.radiance(0, Math.cos(theta), muSun, nu, 32, sample)) * Math.cos(theta) * Math.sin(theta) * (Math.PI / 2 / zeniths) * (2 * Math.PI / azimuths);
        }
      }
      return sum;
    };
    for (const elevation of [90, 75, 45, 15, 3, 0, -3, -6, -10, -13]) {
      const error = Math.abs(Y(atmosphere.skyIrradiance(0, sinDeg(elevation), out)) / fine(sinDeg(elevation)) - 1);
      expect(error, `Sun at ${elevation}°`).toBeLessThan(elevation >= -6 ? 0.02 : 0.1);
    }
  });

  it("keeps the sky's light on level ground in a table that agrees with the sum it was built from, through twilight", () => {
    // Every quarter degree from the Sun 18° down to overhead: several points
    // between each pair of the table's samples. Below civil twilight the sum
    // itself is only good to 10% (above), and the table to the same.
    for (let elevation = -18; elevation <= 90; elevation += 0.25) {
      const direct = Y(atmosphere.skyIrradiance(0, sinDeg(elevation), out));
      const table = Y(atmosphere.groundSkyIrradiance(sinDeg(elevation), out));
      expect(Math.abs(table / direct - 1), `Sun at ${elevation}°`).toBeLessThan(elevation >= -6 ? 0.02 : 0.1);
    }
  });

  it("fades through twilight without a step, by orders of magnitude", () => {
    let previous = Infinity;
    const lux: Record<number, number> = {};
    for (let elevation = 10; elevation >= -18; elevation -= 0.5) {
      const muSun = sinDeg(elevation);
      const total = Y(atmosphere.sunTransmittance(0, muSun, out)) * Math.max(0, muSun) + Y(atmosphere.skyIrradiance(0, muSun, out));
      expect(total, `Sun at ${elevation}°`).toBeLessThanOrEqual(previous);
      // Half a degree never changes the light by more than a factor of four.
      if (Number.isFinite(previous) && previous > 1e-9) expect(total / previous, `Sun at ${elevation}°`).toBeGreaterThan(0.25);
      previous = total;
      lux[elevation] = total;
    }
    expect(lux[-6] / lux[0]).toBeLessThan(0.02);
    expect(lux[-12] / lux[-6]).toBeLessThan(0.01);
  });

  it("dims the Sun and brightens the sky around it as haze thickens", () => {
    const hazy = createAtmosphere({ aerosolOpticalDepth: 0.4, groundAlbedo: 0.2 });
    const muSun = sinDeg(40);
    const other: Rgb = [0, 0, 0];
    expect(Y(hazy.sunTransmittance(0, muSun, other))).toBeLessThan(Y(atmosphere.sunTransmittance(0, muSun, out)));
    const near = sinDeg(45);
    const nu = near * muSun + cosDeg(45) * cosDeg(40);
    expect(Y(hazy.radiance(0, near, muSun, nu, 16, other))).toBeGreaterThan(Y(atmosphere.radiance(0, near, muSun, nu, 16, out)));
  });

  it("reports what its tables cost", () => {
    let clock = 0;
    const timed = createAtmosphere(CLEAR, () => (clock += 5));
    expect(timed.build.buildMs).toBe(5);
    expect(timed.build.tableBytes).toBeGreaterThan(40_000);
    expect(timed.build.tableBytes).toBeLessThan(200_000);
  });
});
