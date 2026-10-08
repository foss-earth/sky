import { describe, expect, it } from "vitest";
import {
  DAY_PART_ELEVATIONS_DEG, HOUR_MS, dayLengthsHours, equationOfTimeMs, seasonInstants, solarClockMs, solarDay, solarDayStartMs,
  utcForSolarClockMs, type DayPart,
} from "./solarDay";
import { solarPosition } from "./solarPosition";

const MINUTE_MS = 60_000;
const MINNEAPOLIS = { latDeg: 44.977753, lonDeg: -93.265011 };

describe("solar time", () => {
  it("runs ahead of mean time by the equation of time, which a sundial shows", () => {
    // The report's example: its hour angle of 11.1059° at 19:30:30 UTC, 105.1786° W, is 12:44:25.4 by the sundial,
    // 14.638 minutes ahead of the place's mean time, 12:29:47.
    expect(equationOfTimeMs(Date.UTC(2003, 9, 17, 19, 30, 30)) / MINUTE_MS).toBeCloseTo(14.638, 2);
    // The year's extremes: about 14.2 minutes slow in mid-February and 16.4 fast in early November.
    expect(equationOfTimeMs(Date.UTC(2026, 1, 11, 12)) / MINUTE_MS).toBeCloseTo(-14.2, 0);
    expect(equationOfTimeMs(Date.UTC(2026, 10, 3, 12)) / MINUTE_MS).toBeCloseTo(16.4, 0);
  });

  it("finds the instant a sundial reads a time, to the millisecond", () => {
    for (const [utcMs, lonDeg] of [[Date.UTC(2026, 9, 7, 20), -93.27], [Date.UTC(2026, 0, 1, 0, 0, 7), 179.9], [Date.UTC(1969, 6, 20, 20, 17), 23.47], [Date.UTC(2026, 11, 31, 23, 59), -179.9]]) {
      expect(Math.abs(utcForSolarClockMs(solarClockMs(utcMs, lonDeg), lonDeg) - utcMs)).toBeLessThan(1);
    }
  });

  it("puts the Sun on the meridian at 12:00 and opposite it at midnight", () => {
    const start = solarDayStartMs(solarClockMs(Date.UTC(2026, 9, 7, 20), MINNEAPOLIS.lonDeg));
    expect(new Date(start).toISOString().slice(0, 10)).toBe("2026-10-07");
    for (const [hours, angle] of [[12, 0], [0, 180], [24, 180]]) {
      const hourAngle = solarPosition({ utcMs: utcForSolarClockMs(start + hours * HOUR_MS, MINNEAPOLIS.lonDeg), ...MINNEAPOLIS }).hourAngleDeg;
      expect(Math.abs(((hourAngle - angle + 540) % 360) - 180)).toBeLessThan(0.002);
    }
  });
});

describe("a solar day's times", () => {
  const places: Array<[string, { latDeg: number; lonDeg: number }, number]> = [
    ["Minneapolis in October", MINNEAPOLIS, Date.UTC(2026, 9, 7, 20)],
    ["Quito at the equinox", { latDeg: -0.18, lonDeg: -78.47 }, Date.UTC(2026, 2, 20, 17)],
    ["Tromsø as the polar night ends", { latDeg: 69.65, lonDeg: 18.96 }, Date.UTC(2026, 0, 20, 11)],
    ["Sydney in winter", { latDeg: -33.87, lonDeg: 151.21 }, Date.UTC(2026, 5, 21, 2)],
    ["Helsinki at midsummer", { latDeg: 60.17, lonDeg: 24.94 }, Date.UTC(2026, 5, 21, 10)],
  ];

  it("puts the Sun at each part's elevation when it starts and ends, by the algorithm's own elevation", () => {
    for (const [name, place, utcMs] of places) {
      const day = solarDay(solarDayStartMs(solarClockMs(utcMs, place.lonDeg)), place);
      for (const part of Object.keys(DAY_PART_ELEVATIONS_DEG) as DayPart[]) {
        const times = day.parts[part];
        for (const hours of [times.rise, times.set]) {
          if (hours === null) continue;
          const elevation = solarPosition({ utcMs: utcForSolarClockMs(day.startMs + hours * HOUR_MS, place.lonDeg), ...place }).elevationDeg;
          expect(Math.abs(elevation - DAY_PART_ELEVATIONS_DEG[part]), `${name}, ${part} at ${hours.toFixed(3)} h`).toBeLessThan(0.02);
        }
      }
    }
  });

  it("orders a day's crossings from the darkest dawn to the darkest dusk", () => {
    const day = solarDay(solarDayStartMs(solarClockMs(Date.UTC(2026, 9, 7, 20), MINNEAPOLIS.lonDeg)), MINNEAPOLIS);
    const { sun, civil, nautical, astronomical } = day.parts;
    const order = [astronomical.rise, nautical.rise, civil.rise, sun.rise, 12, sun.set, civil.set, nautical.set, astronomical.set];
    expect(order.every((hours, index) => hours !== null && (index === 0 || hours > order[index - 1]!))).toBe(true);
    // Early October in Minneapolis: about 11 h 30 min of day, almost evenly either side of noon.
    expect((sun.set! - sun.rise!)).toBeGreaterThan(11.3);
    expect((sun.set! - sun.rise!)).toBeLessThan(11.7);
    expect(Math.abs(12 - sun.rise! - (sun.set! - 12))).toBeLessThan(0.02);
  });

  it("says where the Sun does not cross an elevation all day", () => {
    const at = (place: { latDeg: number; lonDeg: number }, utcMs: number) => solarDay(solarDayStartMs(solarClockMs(utcMs, place.lonDeg)), place).parts;
    expect(at({ latDeg: 80, lonDeg: 0 }, Date.UTC(2026, 5, 21, 12)).sun).toEqual({ rise: null, set: null, always: "above" });
    expect(at({ latDeg: 80, lonDeg: 0 }, Date.UTC(2026, 11, 21, 12)).sun).toEqual({ rise: null, set: null, always: "below" });
    // Helsinki's white nights: the Sun sets and dips below the civil twilight's depth, but never the nautical's.
    const helsinki = at({ latDeg: 60.17, lonDeg: 24.94 }, Date.UTC(2026, 5, 21, 10));
    expect(helsinki.civil.always).toBeNull();
    expect(helsinki.nautical.always).toBe("above");
    expect(helsinki.astronomical.always).toBe("above");
  });
});

describe("the solar year", () => {
  it("times the equinoxes and solstices within minutes of the almanac", () => {
    // The U.S. Naval Observatory's times for 2024, to the minute.
    const seasons = seasonInstants(2024);
    const almanac = {
      march: Date.UTC(2024, 2, 20, 3, 6),
      june: Date.UTC(2024, 5, 20, 20, 51),
      september: Date.UTC(2024, 8, 22, 12, 44),
      december: Date.UTC(2024, 11, 21, 9, 20),
    };
    for (const season of Object.keys(almanac) as Array<keyof typeof almanac>) {
      expect(Math.abs(seasons[season] - almanac[season]) / MINUTE_MS, season).toBeLessThan(2);
    }
  });

  it("gives the length of each day's daylight through the year", () => {
    const minneapolis = dayLengthsHours(2026, MINNEAPOLIS.latDeg, 73);
    expect(minneapolis).toHaveLength(73);
    expect(Math.max(...minneapolis)).toBeGreaterThan(15.5);
    expect(Math.max(...minneapolis)).toBeLessThan(15.7);
    expect(Math.min(...minneapolis)).toBeGreaterThan(8.7);
    expect(Math.min(...minneapolis)).toBeLessThan(8.85);
    // At the equator a little over 12 hours all year: the disc's radius and the horizon's refraction add seven minutes.
    for (const hours of dayLengthsHours(2026, 0, 73)) {
      expect(hours).toBeGreaterThan(12.1);
      expect(hours).toBeLessThan(12.13);
    }
    // Near the pole, the polar day and night: sample 34 is the 20th of June, sample 0 the 1st of January.
    const polar = dayLengthsHours(2026, 80, 73);
    expect(polar[34]).toBe(24);
    expect(polar[0]).toBe(0);
  });
});
