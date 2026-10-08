import { DEG_TO_RAD as RAD } from "../camera/cameraMath";
import { SPA_REFRACTION_CUTOFF_DEG, solarEphemeris, solarPosition } from "./solarPosition";

/**
 * The Sun's day and year at a place, from the solar position algorithm:
 * local apparent solar time, which is what a sundial reads and puts the Sun
 * highest at 12:00 and lowest at midnight; when in a solar day the Sun crosses
 * the horizon and the depths that end each twilight; and the instants of the
 * equinoxes and solstices.
 *
 * Solar time here is kept as a running clock in milliseconds, counted as UTC
 * is but read by a sundial at the place, so its whole days are the place's
 * solar dates and `new Date(ms).getUTC…` reads them.
 */

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/**
 * The Sun's elevation, without refraction, at which each part of the day ends,
 * degrees: the top of its disc on the horizon, as almanacs time sunrise, then
 * the ends of civil, nautical and astronomical twilight.
 */
export const DAY_PART_ELEVATIONS_DEG = {
  sun: SPA_REFRACTION_CUTOFF_DEG,
  civil: -6,
  nautical: -12,
  astronomical: -18,
} as const;
export type DayPart = keyof typeof DAY_PART_ELEVATIONS_DEG;

/**
 * The equinoxes and solstices: the Sun's apparent longitude at each, and a
 * date a day or so from it in any year, where the search starts.
 */
const SEASONS = [
  { id: "march", longitudeDeg: 0, month: 2, day: 20 },
  { id: "june", longitudeDeg: 90, month: 5, day: 21 },
  { id: "september", longitudeDeg: 180, month: 8, day: 22 },
  { id: "december", longitudeDeg: 270, month: 11, day: 21 },
] as const;
export type Season = (typeof SEASONS)[number]["id"];

/** Newton's method for the seasons: its passes, and the Sun's mean motion in longitude, degrees a day. */
const SEASON_SEARCH = { passes: 4, degreesPerDay: 360 / 365.2422 } as const;

/** A whole day's milliseconds and the remainder, for any sign. */
function wrapDay(ms: number): number {
  return ms - Math.floor(ms / DAY_MS) * DAY_MS;
}

/** Apparent less mean solar time, from where the Sun is overhead at an instant. */
function equationOfTimeFrom(utcMs: number, subsolarLonDeg: number): number {
  // At Greenwich a sundial reads 12:00 plus the Sun's hour angle, which is minus the longitude it is overhead at.
  const apparent = DAY_MS / 2 - (subsolarLonDeg / 360) * DAY_MS;
  return wrapDay(apparent - wrapDay(utcMs) + DAY_MS / 2) - DAY_MS / 2;
}

/** Apparent less mean solar time at an instant, ms: the same everywhere on Earth, and never more than 17 minutes either way. */
export function equationOfTimeMs(utcMs: number): number {
  return equationOfTimeFrom(utcMs, solarEphemeris(utcMs).subsolarLonDeg);
}

/** The place's solar clock at an instant, ms: what a sundial at that longitude reads, counted as UTC is. */
export function solarClockMs(utcMs: number, lonDeg: number): number {
  return utcMs + (lonDeg / 360) * DAY_MS + equationOfTimeMs(utcMs);
}

/**
 * The instant at which a sundial at a longitude reads a solar clock time, and
 * the Sun's declination then. The equation of time changes by under 30 s a
 * day, so two passes leave well under a millisecond.
 */
function solveSolarClock(solarMs: number, lonDeg: number): { utcMs: number; declinationDeg: number } {
  const mean = solarMs - (lonDeg / 360) * DAY_MS;
  const first = mean - equationOfTimeMs(mean);
  const sun = solarEphemeris(first);
  return { utcMs: mean - equationOfTimeFrom(first, sun.subsolarLonDeg), declinationDeg: sun.declinationDeg };
}

/** The instant at which a sundial at a longitude reads a solar clock time. */
export function utcForSolarClockMs(solarMs: number, lonDeg: number): number {
  return solveSolarClock(solarMs, lonDeg).utcMs;
}

/** The start of the solar day holding a solar clock time: its midnight. */
export function solarDayStartMs(solarMs: number): number {
  return Math.floor(solarMs / DAY_MS) * DAY_MS;
}

/** Where one part of the day starts and ends in a solar day, in hours of solar time. */
export interface DayPartTimes {
  /** When the Sun climbs through the part's elevation; null where it does not that day, as `always` says. */
  rise: number | null;
  /** When it sinks back below it. */
  set: number | null;
  /** Where it does not cross: above the elevation all day, or below it all day. */
  always: "above" | "below" | null;
}

export interface SolarDay {
  /** The day's midnight on the solar clock, ms: a whole number of days. */
  startMs: number;
  /** The day's sunrise and sunset, then each twilight's start before sunrise and end after sunset. */
  parts: Record<DayPart, DayPartTimes>;
}

/** Half the time the Sun spends above an elevation in a day at a declination, hours; or where it never crosses it. */
function halfDayHours(latDeg: number, declinationDeg: number, elevationDeg: number): number | "above" | "below" {
  const lat = latDeg * RAD;
  const declination = declinationDeg * RAD;
  const cosine = (Math.sin(elevationDeg * RAD) - Math.sin(lat) * Math.sin(declination)) / (Math.cos(lat) * Math.cos(declination));
  if (cosine <= -1) return "above";
  if (cosine >= 1) return "below";
  return Math.acos(cosine) / RAD / 15;
}

/**
 * The times of a solar day at a place: its sunrise and sunset, and when each
 * twilight starts and ends. From the declination at the day's midnights, which
 * changes steadily by at most 0.4° in a day, and the hour angle at which the
 * Sun stands at each elevation, found again at the crossing's own
 * declination: within seconds of the algorithm's own elevations. At the
 * observer's altitude the horizon dips; these are for the sea-level horizon,
 * as an almanac's are.
 */
export function solarDay(startMs: number, place: { latDeg: number; lonDeg: number }): SolarDay {
  const start = solveSolarClock(startMs, place.lonDeg);
  const end = solveSolarClock(startMs + DAY_MS, place.lonDeg);
  const declinationAt = (hours: number): number => start.declinationDeg + ((end.declinationDeg - start.declinationDeg) * hours) / 24;
  const times = (elevationDeg: number): DayPartTimes => {
    const atNoon = halfDayHours(place.latDeg, declinationAt(12), elevationDeg);
    if (typeof atNoon === "string") return { rise: null, set: null, always: atNoon };
    // Each crossing at its own declination, twice; where that would not cross, as near the start of a polar day, the last estimate.
    const crossing = (side: -1 | 1): number => {
      const refine = (hours: number): number => {
        const half = halfDayHours(place.latDeg, declinationAt(hours), elevationDeg);
        return typeof half === "string" ? hours : 12 + side * half;
      };
      return refine(refine(12 + side * atNoon));
    };
    return { rise: crossing(-1), set: crossing(1), always: null };
  };
  return {
    startMs,
    parts: {
      sun: times(DAY_PART_ELEVATIONS_DEG.sun),
      civil: times(DAY_PART_ELEVATIONS_DEG.civil),
      nautical: times(DAY_PART_ELEVATIONS_DEG.nautical),
      astronomical: times(DAY_PART_ELEVATIONS_DEG.astronomical),
    },
  };
}

/**
 * The instants of a year's equinoxes and solstices, ms of UTC: when the Sun's
 * apparent longitude is 0°, 90°, 180° and 270°. Newton's method on the
 * algorithm's longitude, each pass 30 times closer; within a second of it.
 */
export function seasonInstants(year: number): Record<Season, number> {
  const found = {} as Record<Season, number>;
  for (const season of SEASONS) {
    const date = new Date(0);
    date.setUTCFullYear(year, season.month, season.day);
    let utcMs = date.getTime();
    for (let pass = 0; pass < SEASON_SEARCH.passes; pass++) {
      const longitude = solarPosition({ utcMs, latDeg: 0, lonDeg: 0 }).apparentLongitudeDeg;
      const behind = ((((season.longitudeDeg - longitude) % 360) + 540) % 360) - 180;
      utcMs += (behind / SEASON_SEARCH.degreesPerDay) * DAY_MS;
    }
    found[season.id] = utcMs;
  }
  return found;
}

/**
 * How long the Sun is up on days spread evenly through a year, hours, at a
 * latitude: from sunrise to sunset as almanacs time them, 0 through a polar
 * night and 24 through a polar day. Sample `i` is the day that starts
 * `i / samples` of the way through the year, at noon UTC.
 */
export function dayLengthsHours(year: number, latDeg: number, samples: number): number[] {
  const first = new Date(0);
  first.setUTCFullYear(year, 0, 1);
  const next = new Date(0);
  next.setUTCFullYear(year + 1, 0, 1);
  const days = Math.round((next.getTime() - first.getTime()) / DAY_MS);
  return Array.from({ length: samples }, (_, index) => {
    const day = Math.floor((index / samples) * days);
    const declination = solarEphemeris(first.getTime() + day * DAY_MS + DAY_MS / 2).declinationDeg;
    const half = halfDayHours(latDeg, declination, DAY_PART_ELEVATIONS_DEG.sun);
    return half === "above" ? 24 : half === "below" ? 0 : 2 * half;
  });
}
