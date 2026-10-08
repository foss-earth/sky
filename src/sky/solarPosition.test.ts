import { describe, expect, it } from "vitest";
import { DEG_TO_RAD, geodeticToEcef } from "../camera/cameraMath";
import { julianDayFromUtcMs, solarEphemeris, solarPosition, spaRefractionDeg, sunDirectionFrom } from "./solarPosition";

/**
 * The worked example of NREL/TP-560-34302 (revised January 2008), section A.5
 * and Table A5.1: 17 October 2003, 12:30:30 local standard time at UTC-7,
 * 39.742476°N 105.1786°W, 1830.14 m, 820 mbar, 11 °C, ΔT = 67 s.
 */
const EXAMPLE = {
  utcMs: Date.UTC(2003, 9, 17, 19, 30, 30),
  latDeg: 39.742476,
  lonDeg: -105.1786,
  elevationMeters: 1830.14,
  pressureMbar: 820,
  temperatureC: 11,
  deltaTSeconds: 67,
};

describe("solar position (NREL/TP-560-34302)", () => {
  it("counts Julian days as the report's Table A4.1 does", () => {
    const cases: Array<[number, number]> = [
      [Date.UTC(2000, 0, 1, 12), 2451545.0],
      [Date.UTC(1999, 0, 1), 2451179.5],
      [Date.UTC(1987, 0, 27), 2446822.5],
      [Date.UTC(1987, 5, 19, 12), 2446966.0],
      [Date.UTC(1988, 0, 27), 2447187.5],
      [Date.UTC(1988, 5, 19, 12), 2447332.0],
      [Date.UTC(1900, 0, 1), 2415020.5],
      [Date.UTC(1600, 0, 1), 2305447.5],
      [Date.UTC(1600, 11, 31), 2305812.5],
    ];
    for (const [utcMs, julianDay] of cases) expect(julianDayFromUtcMs(utcMs)).toBe(julianDay);
  });

  it("reproduces every value of the report's example", () => {
    const sun = solarPosition(EXAMPLE);
    expect(sun.julianDay).toBeCloseTo(2452930.312847, 6);
    // The sums of each periodic series, which check the tables row by row.
    const longitude = [172067561.526586, 628332010650.051147, 61368.682493, -26.902819, -121.279536, -0.999999];
    const latitude = [-176.502688, 3.067582];
    const radius = [99653849.037796, 100378.567146, -1140.953507, -141.115419, 1.232361];
    sun.series.longitude.forEach((sum, index) => expect(sum, `L${index}`).toBeCloseTo(longitude[index], index === 1 ? 3 : 5));
    sun.series.latitude.forEach((sum, index) => expect(sum, `B${index}`).toBeCloseTo(latitude[index], 5));
    sun.series.radius.forEach((sum, index) => expect(sum, `R${index}`).toBeCloseTo(radius[index], 5));
    expect(sun.heliocentricLongitudeDeg).toBeCloseTo(24.0182616917, 9);
    expect(sun.heliocentricLatitudeDeg).toBeCloseTo(-0.0001011219, 9);
    expect(sun.radiusVectorAu).toBeCloseTo(0.9965422974, 9);
    expect(sun.nutationLongitudeDeg).toBeCloseTo(-0.00399840, 7);
    expect(sun.nutationObliquityDeg).toBeCloseTo(0.00166657, 7);
    expect(sun.obliquityDeg).toBeCloseTo(23.440465, 5);
    expect(sun.apparentLongitudeDeg).toBeCloseTo(204.0085519281, 9);
    expect(sun.rightAscensionDeg).toBeCloseTo(202.22741, 4);
    expect(sun.declinationDeg).toBeCloseTo(-9.31434, 4);
    expect(sun.hourAngleDeg).toBeCloseTo(11.105900, 5);
    expect(sun.topocentricHourAngleDeg).toBeCloseTo(11.10629, 4);
    expect(sun.topocentricRightAscensionDeg).toBeCloseTo(202.22704, 4);
    expect(sun.topocentricDeclinationDeg).toBeCloseTo(-9.316179, 5);
    expect(sun.zenithDeg).toBeCloseTo(50.11162, 5);
    expect(sun.azimuthDeg).toBeCloseTo(194.34024, 5);
  });

  it("gives the same direction as a vector fixed to the Earth", () => {
    // The vector form serves every observer at once; it must agree with the
    // report's own topocentric angles, which carry the observer's parallax.
    const sun = solarPosition(EXAMPLE);
    const observer = geodeticToEcef(EXAMPLE.latDeg * DEG_TO_RAD, EXAMPLE.lonDeg * DEG_TO_RAD, EXAMPLE.elevationMeters);
    const direction = sunDirectionFrom(solarEphemeris(EXAMPLE.utcMs, EXAMPLE.deltaTSeconds), observer.x, observer.y, observer.z);
    const lat = EXAMPLE.latDeg * DEG_TO_RAD;
    const lon = EXAMPLE.lonDeg * DEG_TO_RAD;
    const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    const east = [-Math.sin(lon), Math.cos(lon), 0];
    const north = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
    const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const elevationDeg = Math.asin(dot(direction, up)) / DEG_TO_RAD;
    const azimuthDeg = (Math.atan2(dot(direction, east), dot(direction, north)) / DEG_TO_RAD + 360) % 360;
    // The report's ellipsoid is not WGS84: the two differ by metres, far under this.
    expect(elevationDeg).toBeCloseTo(sun.elevationDeg, 4);
    expect(azimuthDeg).toBeCloseTo(sun.azimuthDeg, 4);
    expect(Math.hypot(...sun.sunEcef)).toBeCloseTo(1, 12);
  });

  it("applies the report's refraction, and none once the disc is below the horizon", () => {
    const sun = solarPosition(EXAMPLE);
    expect(sun.elevationDeg + sun.refractionDeg).toBeCloseTo(90 - 50.11162, 5);
    expect(spaRefractionDeg(0, 1010, 10)).toBeCloseTo(1.02 / (60 * Math.tan((10.3 / 5.11) * DEG_TO_RAD)), 12);
    expect(spaRefractionDeg(-0.9, 1010, 10)).toBe(0);
    expect(spaRefractionDeg(45, 1010, 10)).toBeLessThan(0.02);
  });

  it("puts the Sun on the equator at the equinoxes and at its farthest at the solstices", () => {
    // Instants published to the minute (US Naval Observatory), so the Sun's
    // apparent longitude is within a minute's motion, 0.0007°, of each quarter.
    const seasons: Array<[number, number]> = [
      [Date.UTC(2024, 2, 20, 3, 6), 0],
      [Date.UTC(2024, 5, 20, 20, 51), 90],
      [Date.UTC(2024, 8, 22, 12, 44), 180],
      [Date.UTC(2024, 11, 21, 9, 21), 270],
    ];
    for (const [utcMs, longitudeDeg] of seasons) {
      const sun = solarPosition({ utcMs, latDeg: 0, lonDeg: 0 });
      const offset = ((sun.apparentLongitudeDeg - longitudeDeg + 540) % 360) - 180;
      expect(Math.abs(offset), new Date(utcMs).toISOString()).toBeLessThan(0.002);
      if (longitudeDeg % 180 === 0) expect(Math.abs(sun.declinationDeg)).toBeLessThan(0.001);
      // The Sun's own latitude, up to 0.0003°, keeps the declination from being the obliquity exactly.
      else expect(Math.abs(sun.declinationDeg)).toBeCloseTo(sun.obliquityDeg, 3);
    }
  });

  it("is overhead where its vector points, and below the horizon on the far side", () => {
    const utcMs = Date.UTC(2026, 9, 7, 18, 0, 0);
    const sun = solarPosition({ utcMs, latDeg: 0, lonDeg: 0 });
    // The zenith is the ellipsoid's normal, so the Sun is overhead where the geodetic latitude is its declination.
    const overhead = solarPosition({ utcMs, latDeg: sun.subsolarLatDeg, lonDeg: sun.subsolarLonDeg });
    expect(overhead.elevationDeg).toBeGreaterThan(89.999);
    const antipode = solarPosition({ utcMs, latDeg: -sun.subsolarLatDeg, lonDeg: sun.subsolarLonDeg + 180 });
    expect(antipode.elevationDeg).toBeLessThan(-89.9);
    expect(antipode.refractionDeg).toBe(0);
  });
});
