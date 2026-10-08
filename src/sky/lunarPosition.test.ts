import { describe, expect, it } from "vitest";
import { DEG_TO_RAD, geodeticToEcef } from "../camera/cameraMath";
import { lunarEphemeris, lunarPosition, MOONLIGHT_TINT, moonIlluminanceLux, moonMagnitude, moonViewFrom } from "./lunarPosition";
import { solarEphemeris, sunDirectionFrom } from "./solarPosition";
import { PHOTOMETRY } from "./skyState";

const angleBetweenDeg = (a: readonly number[], b: readonly number[]): number =>
  Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) / DEG_TO_RAD;
/** The difference of two longitudes, -180 to 180 degrees. */
const wrap = (degrees: number): number => ((((degrees + 180) % 360) + 360) % 360) - 180;

describe("the Moon's place", () => {
  it("reproduces Meeus's example 47.a to every printed digit", () => {
    // 1992 April 12, 0h TD: with ΔT zero the clock's instant is the ephemeris day.
    const moon = lunarPosition(Date.UTC(1992, 3, 12), 0);
    expect(moon.julianEphemerisDay).toBe(2448724.5);
    expect(moon.sums.longitude).toBeCloseTo(-1127527, -0.5);
    expect(moon.sums.latitude).toBeCloseTo(-3229126, -0.5);
    expect(moon.sums.distance).toBeCloseTo(-16590875, -0.5);
    expect(moon.longitudeDeg).toBeCloseTo(133.162655, 6);
    expect(moon.latitudeDeg).toBeCloseTo(-3.229126, 6);
    expect(moon.distanceKm).toBeCloseTo(368409.7, 1);
    expect(moon.parallaxDeg).toBeCloseTo(0.991990, 6);
    // With the solar position algorithm's nutation and obliquity, to Meeus's precision.
    expect(moon.apparentLongitudeDeg).toBeCloseTo(133.167265, 4);
    expect(moon.rightAscensionDeg).toBeCloseTo(134.688470, 4);
    expect(moon.declinationDeg).toBeCloseTo(13.768368, 4);
  });

  it("puts the phases of October 2024 at the U.S. Naval Observatory's instants", () => {
    // New Moon 2 Oct 18:49, first quarter 10 Oct 18:55, full 17 Oct 11:26, last quarter 24 Oct 08:03 UTC.
    // The Moon gains half a degree an hour on the Sun, so a minute is 0.008°.
    for (const [utc, elongation] of [
      [Date.UTC(2024, 9, 2, 18, 49), 0],
      [Date.UTC(2024, 9, 10, 18, 55), 90],
      [Date.UTC(2024, 9, 17, 11, 26), 180],
      [Date.UTC(2024, 9, 24, 8, 3), 270],
    ] as const) {
      const moon = lunarPosition(utc);
      expect(Math.abs(wrap(moon.apparentLongitudeDeg - moon.sunApparentLongitudeDeg - elongation))).toBeLessThan(0.01);
    }
  });

  it("lines the Moon up with the Sun on the centre line of the eclipse of 8 April 2024", () => {
    // The point of greatest eclipse, 25.29° N, 104.14° W, lies on the centre line: there the
    // shadow's axis passes through the observer, so the two centres meet, a little after 18:16 UT.
    const [x, y, z] = (({ x, y, z }) => [x, y, z])(geodeticToEcef(25.29 * DEG_TO_RAD, -104.14 * DEG_TO_RAD, 1200));
    let closest = { separation: Infinity, utc: 0 };
    for (let utc = Date.UTC(2024, 3, 8, 18, 6); utc <= Date.UTC(2024, 3, 8, 18, 26); utc += 1000) {
      const sun = solarEphemeris(utc);
      const separation = angleBetweenDeg(moonViewFrom(lunarEphemeris(utc, sun), x, y, z).direction, sunDirectionFrom(sun, x, y, z));
      if (separation < closest.separation) closest = { separation, utc };
    }
    // Within 11″, a fiftieth of the discs' radii; the parallax it depends on is near a degree.
    expect(closest.separation).toBeLessThan(0.003);
    expect(Math.abs(closest.utc - Date.UTC(2024, 3, 8, 18, 17))).toBeLessThan(150_000);
    const sun = solarEphemeris(closest.utc);
    const view = moonViewFrom(lunarEphemeris(closest.utc, sun), x, y, z);
    // Seen from the Earth's centre, without the parallax, they are apart.
    expect(angleBetweenDeg(moonViewFrom(lunarEphemeris(closest.utc, sun), 0, 0, 0).direction, sunDirectionFrom(sun, 0, 0, 0))).toBeGreaterThan(0.2);
    expect(view.phaseAngleDeg).toBeGreaterThan(179.9);
    expect(view.illuminatedFraction).toBeLessThan(1e-6);
    // The Moon covers the Sun: its disc is the larger, which made the eclipse total.
    expect(view.angularRadius).toBeGreaterThan(0.2667 * DEG_TO_RAD);
  });

  it("lights the Earth by its phase and distance, redder than sunlight at the same luminance", () => {
    expect(moonMagnitude(0)).toBe(-12.73);
    expect(moonMagnitude(90)).toBeCloseTo(-10.128, 3);
    const full = moonIlluminanceLux({ phaseAngleDeg: 0, distanceMeters: 384_400_000 }, PHOTOMETRY.solarIlluminanceLux);
    // About 0.3 lux above the air at full Moon, a quarter's an eleventh of that, and 12% more at perigee.
    expect(full).toBeGreaterThan(0.3);
    expect(full).toBeLessThan(0.36);
    expect(moonIlluminanceLux({ phaseAngleDeg: 90, distanceMeters: 384_400_000 }, PHOTOMETRY.solarIlluminanceLux) / full).toBeCloseTo(0.091, 3);
    expect(moonIlluminanceLux({ phaseAngleDeg: 0, distanceMeters: 363_300_000 }, PHOTOMETRY.solarIlluminanceLux) / full).toBeCloseTo((384_400 / 363_300) ** 2, 9);
    expect(0.2126 * MOONLIGHT_TINT[0] + 0.7152 * MOONLIGHT_TINT[1] + 0.0722 * MOONLIGHT_TINT[2]).toBeCloseTo(1, 12);
    expect(MOONLIGHT_TINT[0]).toBeGreaterThan(MOONLIGHT_TINT[1]);
    expect(MOONLIGHT_TINT[2]).toBeLessThan(MOONLIGHT_TINT[1]);
  });
});
