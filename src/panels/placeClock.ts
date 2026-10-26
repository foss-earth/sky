import tzLookup from "@photostructure/tz-lookup";
import type { ClockZone } from "../time.js";

export type ClockPlace = { latDeg: number; lonDeg: number };
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Offline geographic lookup; the browser supplies the zone's dated DST rules. */
export function placeClockZone(place: ClockPlace | null, utcMs: number): ClockZone | null {
  if (!place || !Number.isFinite(place.latDeg) || !Number.isFinite(place.lonDeg)
    || Math.abs(place.latDeg) > 90 || Math.abs(place.lonDeg) > 180) return null;
  const id = tzLookup(place.latDeg, place.lonDeg);
  let formatter = formatters.get(id);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: id, timeZoneName: "longOffset", year: "numeric", month: "2-digit", day: "2-digit",
    });
    if (formatters.size >= 16) formatters.clear();
    formatters.set(id, formatter);
  }
  const name = formatter.formatToParts(utcMs).find(part => part.type === "timeZoneName")!.value;
  const offset = /^GMT(?:([+-])(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(name);
  if (!offset) throw new Error(`Cannot read the UTC offset for ${id}: ${name}`);
  const offsetMinutes = offset[1]
    ? (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]) + Number(offset[4] ?? 0) / 60) : 0;
  return { id, name: id, offsetMinutes };
}
