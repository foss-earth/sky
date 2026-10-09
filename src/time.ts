import { parseUtcDate } from "./skyState.js";
import { DAY_MS, HOUR_MS, solarClockMs } from "./solarDay.js";
type Place = { latDeg: number; lonDeg: number };
const TIME = { secondMs: 1000, minuteMs: 60_000, yearDays: 365.2425 } as const;
export const TIME_PARAMETER_IDS = ["sky.time.mode", "sky.time.date", "sky.time.utcHours"] as const;
/** Only the injected value lookup needed by pure time helpers; no optional UI type dependency. */
export interface SkyTimeSettings { get(id: string): unknown }

const pad = (value: number, width: number): string => String(Math.abs(value)).padStart(width, "0");

/** A day as year-month-day, as the date parameter is written, whatever the year. */
export function isoDate(ms: number): string {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  return `${year < 0 ? "-" : ""}${pad(year, 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

/** Hours of a day as a clock shows them, to the nearest minute: 06:12. */
export function clockTime(hours: number): string {
  const minutes = Math.round(hours * 60);
  return `${pad(Math.floor(minutes / 60), 2)}:${pad(minutes % 60, 2)}`;
}

/** A set time's parameters for an instant, to the second. */
export function fixedTimeValues(utcMs: number): { "sky.time.mode": "fixed"; "sky.time.date": string; "sky.time.utcHours": number } {
  const rounded = Math.round(utcMs / TIME.secondMs) * TIME.secondMs;
  const day = Math.floor(rounded / DAY_MS) * DAY_MS;
  return { "sky.time.mode": "fixed", "sky.time.date": isoDate(day), "sky.time.utcHours": (rounded - day) / HOUR_MS };
}

/** The instant the Sun is placed for: the clock's, or the set time's while one is set and its date can be read. */
export function instantInUse(settings: SkyTimeSettings, now: () => number): { utcMs: number; following: boolean } {
  const following = settings.get("sky.time.mode") !== "fixed";
  const day = following ? null : parseUtcDate(String(settings.get("sky.time.date")));
  return { utcMs: day === null ? now() : day + (settings.get("sky.time.utcHours") as number) * HOUR_MS, following };
}

/** A place as latitude and longitude, to a hundredth of a degree. */
export function describePlace(place: Place): string {
  return `${Math.abs(place.latDeg).toFixed(2)}° ${place.latDeg < 0 ? "S" : "N"}, ${Math.abs(place.lonDeg).toFixed(2)}° ${place.lonDeg < 0 ? "W" : "E"}`;
}

/** The time zone a clock keeps at an instant: its name, its IANA id where the device gives one, and its minutes ahead of UTC. */
export interface ClockZone {
  name: string;
  id: string | null;
  offsetMinutes: number;
}

/** This device's time zone at an instant, from its own settings. No place is looked up. */
export function deviceClockZone(utcMs: number): ClockZone {
  const date = new Date(utcMs);
  let id: string | null = null;
  let name = "its own time zone";
  try {
    id = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
    name = new Intl.DateTimeFormat(undefined, { timeZoneName: "long" }).formatToParts(date).find(part => part.type === "timeZoneName")?.value ?? name;
  } catch {
    // A device with no zone names still keeps an offset.
  }
  return { name, id, offsetMinutes: -date.getTimezoneOffset() };
}

/** Minutes ahead of UTC as a zone is written: UTC−5, UTC+5:30, UTC. */
export function utcOffsetText(minutes: number): string {
  if (minutes === 0) return "UTC";
  const size = Math.abs(minutes);
  return `UTC${minutes < 0 ? "−" : "+"}${Math.floor(size / 60)}${size % 60 ? `:${pad(size % 60, 2)}` : ""}`;
}

/**
 * The zone a longitude lies in where zones follow the meridians alone, as
 * they do at sea, in minutes ahead of UTC: whole hours, each 15° wide about
 * its own meridian. The civil time a country keeps may differ from it by
 * hours, and by another in summer.
 */
export function zoneByLongitudeMinutes(lonDeg: number): number {
  const wrapped = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
  return Math.round(wrapped / 15) * 60;
}

/** The solar clock at an instant, to the nearest minute, which is what the tab shows and steps by. */
export function solarMinuteMs(utcMs: number, lonDeg: number): number {
  return Math.round(solarClockMs(utcMs, lonDeg) / TIME.minuteMs) * TIME.minuteMs;
}
