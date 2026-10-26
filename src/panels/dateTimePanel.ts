import { placeClockZone } from "./placeClock.js";
const pad = (value: number, width: number): string => String(Math.abs(value)).padStart(width, "0");
import { parseUtcDate } from "../skyState.js";
import { TIME_TAB } from "../settings.js";
import type { SettingsRegistry } from "@foss-earth/ui/settings";
import {
  DAY_MS, HOUR_MS, dayLengthsHours, seasonInstants, solarClockMs, solarDay, solarDayStartMs, utcForSolarClockMs,
  type DayPart, type Season, type SolarDay,
} from "../solarDay.js";
import type { SkyDateTimeUiPorts, SkyPanelRefreshPort, SkyPanelStorageOptions, DialArc, DialKey, DialMark, DialTick } from "./ports.js";
import { civilClockMs, utcForCivilClockMs, TIME_PARAMETER_IDS, isoDate, clockTime, fixedTimeValues, instantInUse, describePlace, utcOffsetText, type ClockZone } from "../time.js";
export { TIME_PARAMETER_IDS, isoDate, clockTime, fixedTimeValues, instantInUse, describePlace, deviceClockZone, utcOffsetText, zoneByLongitudeMinutes, solarMinuteMs, type ClockZone } from "../time.js";

export interface DateTimePanelOptions extends SkyPanelStorageOptions {
  document: Document;
  ui: SkyDateTimeUiPorts;
  refresh: SkyPanelRefreshPort;
  /** The host owns one registry. */
  settings: SettingsRegistry;
  /**
   * The place the time is read at, as a sundial there would: the runtime's
   * `sky.getEnvironment()?.illumination.observer`, or the view's place while
   * the sky model is off. Null while it is not known.
   */
  getPlace(): { latDeg: number; lonDeg: number } | null;
  /** Host UTC clock, ms since 1970. */
  now: () => number;
  /** Geographic clock lookup. Defaults to an offline IANA lookup at getPlace(). */
  placeZone?: (place: Place | null, utcMs: number) => ClockZone | null;
}

export interface DateTimePanelHandle {
  element: HTMLElement;
  destroy(): void;
}

type Place = { latDeg: number; lonDeg: number };

/** A second and a minute, ms, and the mean Gregorian year, days. */
const TIME = { secondMs: 1000, minuteMs: 60_000, yearDays: 365.2425 } as const;
/**
 * The date dial: the share of a year at its top, the mean June solstice, so
 * the knob stands as high as the Sun climbs in the north; the stretches its
 * ring is shaded in by the length of the day, one for each five days; and how
 * far each runs on under the next, so no seam shows between them.
 */
const DATE_DIAL = { topYearFraction: 171.25 / 365.2425, shades: 73, shadeOverlap: 0.002 } as const;

/** The sky's colours from night through each twilight to day, for the dials' rings. */
const SKY_COLOURS = { night: "#101b3b", astronomical: "#1c3063", nautical: "#2c4d92", civil: "#5c82c8", day: "#a9cff6" } as const;
const DAY_PARTS: ReadonlyArray<readonly [DayPart, string]> = [
  ["astronomical", SKY_COLOURS.astronomical],
  ["nautical", SKY_COLOURS.nautical],
  ["civil", SKY_COLOURS.civil],
  ["sun", SKY_COLOURS.day],
];
const SEASON_NAMES: Readonly<Record<Season, readonly [string, string]>> = {
  march: ["Mar equinox", "The March equinox"],
  june: ["Jun solstice", "The June solstice"],
  september: ["Sep equinox", "The September equinox"],
  december: ["Dec solstice", "The December solstice"],
};

function yearStartMs(year: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, 0, 1);
  return date.getTime();
}

/** The same day of another month, or that month's last day where it is shorter. */
function addMonths(dayStart: number, months: number): number {
  const date = new Date(dayStart);
  const index = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(index / 12);
  const month = index - Math.floor(index / 12) * 12;
  const last = new Date(0);
  last.setUTCFullYear(year, month + 1, 0);
  const target = new Date(0);
  target.setUTCFullYear(year, month, Math.min(date.getUTCDate(), last.getUTCDate()));
  return target.getTime();
}

function hexColour(hex: string): [number, number, number] {
  return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)) as [number, number, number];
}

/** A colour part way from one to another. */
function mix(from: string, to: string, share: number): string {
  const a = hexColour(from);
  const b = hexColour(to);
  return `rgb(${a.map((value, index) => Math.round(value + (b[index] - value) * share)).join(", ")})`;
}

/** What the dials show, from the parameters, the clock and the place. */
interface View {
  place: Place;
  known: boolean;
  following: boolean;
  /** Clock fields in the selected display, to the minute, and the actual instant. */
  clockMs: number;
  utcMs: number;
  dayStart: number;
  year: number;
  yearStart: number;
  daysInYear: number;
  day: SolarDay;
}

function button(document: Document, label: string, title: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "foss-earth-choice foss-earth-parameter__action foss-earth-dial__button";
  element.textContent = label;
  element.title = title;
  return element;
}

function field(document: Document, label: string, className: string): HTMLInputElement {
  const element = document.createElement("input");
  element.type = "text";
  element.className = `foss-earth-dial__field ${className}`;
  element.autocomplete = "off";
  element.spellcheck = false;
  element.setAttribute("aria-label", label);
  return element;
}

function line(document: Document): HTMLParagraphElement {
  const element = document.createElement("p");
  element.className = "foss-earth-choices__note";
  return element;
}

/**
 * The contents of the Date and time tab: the instant the Sun is placed for,
 * on two dials in Civil or Solar time at the place shown. The time dial is
 * one day, 12:00 at the top and 00:00 at the bottom, its ring shaded
 * by night, each twilight and day, with sunrise, noon, sunset and midnight
 * marked; the date dial is one year, the June solstice at the top, shaded by
 * how long the days are, with the equinoxes and solstices marked. Now follows
 * the device's clock; anything else sets a time. Any section a host's
 * parameters are homed in follows.
 */
export function createDateTimePanel(options: DateTimePanelOptions): DateTimePanelHandle {
  const document = options.document;
  let disposed = false;
  const settings = options.settings;
  const now = options.now;
  const { createParameterSection, createSectionsElement, appendHostSections, createHelpTooltip } = options.ui;
  const placeZone = options.placeZone ?? placeClockZone;
  const zoneAt = (utcMs: number): ClockZone => placeZone(options.getPlace(), utcMs) ?? { id: "UTC", name: "UTC (location unavailable)", offsetMinutes: 0 };
  const { createDial, wrapTurn, createChoiceGroup, checkChoice } = options.ui;
  /** The time dial: midnight at the bottom and noon at the top, the morning on the left. */
  const timeTurn = (hours: number): number => wrapTurn(hours / 24 + 0.5);
  const hoursAtTurn = (turn: number): number => wrapTurn(turn - 0.5) * 24;
  /** The date dial: the mean June solstice at the top, the year running clockwise. */
  const dateTurn = (yearFraction: number): number => wrapTurn(yearFraction - DATE_DIAL.topYearFraction);
  const yearFractionAtTurn = (turn: number): number => wrapTurn(turn + DATE_DIAL.topYearFraction);
  const wholeMinute = (ms: number): number => Math.round(ms / TIME.minuteMs) * TIME.minuteMs;

  const HOUR_TICKS: readonly DialTick[] = Array.from({ length: 24 }, (_, hour) => ({ turn: timeTurn(hour), major: hour % 6 === 0 }));

  let daysKey = "";
  let dayCache: SolarDay | null = null;
  const solarDayAt = (dayStart: number, place: Place): SolarDay => {
    const key = `${dayStart}|${place.latDeg.toFixed(2)}|${place.lonDeg.toFixed(2)}`;
    if (key !== daysKey || !dayCache) {
      daysKey = key;
      dayCache = solarDay(dayStart, place);
    }
    return dayCache;
  };
  const seasons = new Map<number, Record<Season, number>>();
  const seasonsOf = (year: number): Record<Season, number> => {
    let found = seasons.get(year);
    if (!found) {
      found = seasonInstants(year);
      seasons.set(year, found);
    }
    return found;
  };
  let yearKey = "";
  let yearArcs: DialArc[] = [];
  let monthTicks: DialTick[] = [];

  const view = (): View => {
    const known = options.getPlace();
    const place = known ?? { latDeg: 0, lonDeg: 0 };
    const { utcMs, following } = instantInUse(settings, now);
    const clockMs = displayMinute(utcMs, place);
    const dayStart = solarDayStartMs(clockMs);
    const year = new Date(dayStart).getUTCFullYear();
    const yearStart = yearStartMs(year);
    const daysInYear = Math.round((yearStartMs(year + 1) - yearStart) / DAY_MS);
    return { place, known: known !== null, following, clockMs, utcMs, dayStart, year, yearStart, daysInYear, day: solarDayAt(solarDayStartMs(solarClockMs(utcMs, place.lonDeg)), place) };
  };
  const timeOfDay = (current: View): number => current.clockMs - current.dayStart;
  const solar = (): boolean => settings.get("sky.clock.display") === "solar";
  const clockLabel = (): string => solar() ? "solar time" : "civil time";
  function toClock(utcMs: number, place: Place): number { return solar() ? solarClockMs(utcMs, place.lonDeg) : civilClockMs(utcMs, zoneAt); }
  function fromClock(clockMs: number, place: Place): number { return solar() ? utcForSolarClockMs(clockMs, place.lonDeg) : utcForCivilClockMs(clockMs, zoneAt); }
  const displayMinute = (utcMs: number, place: Place): number => solar() ? wholeMinute(toClock(utcMs, place)) : Math.floor(toClock(utcMs, place) / TIME.minuteMs) * TIME.minuteMs;
  const setClock = (clockMs: number, place: Place): void => {
    if (!disposed) settings.setMany(fixedTimeValues(fromClock(clockMs, place)));
  };
  const solarHourOnClock = (hours: number, current: View): number => {
    const instant = utcForSolarClockMs(current.day.startMs + hours * HOUR_MS, current.place.lonDeg);
    const clock = toClock(instant, current.place);
    return (clock - solarDayStartMs(clock)) / HOUR_MS;
  };

  // The time dial, and in its middle the time and Now.
  const timeField = field(document, "Time, as hours and minutes", "foss-earth-dial__field--time");
  timeField.inputMode = "numeric";
  const nowButton = button(document, "Now", "Follow this device's clock, so the Sun moves as the day goes.");
  const timeMiddle = document.createElement("div");
  timeMiddle.className = "foss-earth-dial__readout";
  timeMiddle.append(timeField, nowButton);
  let timeDrag: number | null = null;
  const timeDial = createDial({
    ariaLabel: "Time of day",
    valueMax: 24 * 60 - 1,
    centre: timeMiddle,
    onPress: turn => {
      const current = view();
      setClock(wholeMinute(current.dayStart + hoursAtTurn(turn) * HOUR_MS), current.place);
    },
    onDragStart: () => { timeDrag = view().clockMs; },
    onDrag: travel => {
      if (timeDrag !== null) setClock(wholeMinute(timeDrag + travel * DAY_MS), view().place);
    },
    onDragEnd: () => { timeDrag = null; },
    onKey: (key: DialKey) => {
      const current = view();
      const target = key === "start" ? current.dayStart
        : key === "end" ? current.dayStart + DAY_MS - TIME.minuteMs
          : current.clockMs + { next: TIME.minuteMs, previous: -TIME.minuteMs, pageNext: HOUR_MS, pagePrevious: -HOUR_MS }[key];
      setClock(target, current.place);
    },
    onMark: id => {
      const current = view();
      const sun = current.day.parts.sun;
      const hours = id === "noon" ? 12 : id === "midnight" ? 0 : id === "sunrise" ? sun.rise : id === "sunset" ? sun.set : null;
      if (hours !== null) setClock(wholeMinute(current.dayStart + solarHourOnClock(hours, current) * HOUR_MS), current.place);
    },
  });

  // The date dial, and in its middle the date and Today.
  const dateField = field(document, "Date, as year-month-day", "foss-earth-dial__field--date");
  const todayButton = button(document, "Today", "Set today's date at the place shown, keeping the time of day.");
  const dateMiddle = document.createElement("div");
  dateMiddle.className = "foss-earth-dial__readout";
  dateMiddle.append(dateField, todayButton);
  let dateDrag: { dayStart: number; time: number } | null = null;
  const dateDial = createDial({
    ariaLabel: "Day of the year",
    valueMax: 365,
    centre: dateMiddle,
    onPress: turn => {
      const current = view();
      const day = Math.min(current.daysInYear - 1, Math.floor(yearFractionAtTurn(turn) * current.daysInYear));
      setClock(current.yearStart + day * DAY_MS + timeOfDay(current), current.place);
    },
    onDragStart: () => {
      const current = view();
      dateDrag = { dayStart: current.dayStart, time: timeOfDay(current) };
    },
    onDrag: travel => {
      if (dateDrag) setClock(dateDrag.dayStart + Math.round(travel * TIME.yearDays) * DAY_MS + dateDrag.time, view().place);
    },
    onDragEnd: () => { dateDrag = null; },
    onKey: (key: DialKey) => {
      const current = view();
      const time = timeOfDay(current);
      const target = key === "next" ? current.clockMs + DAY_MS
        : key === "previous" ? current.clockMs - DAY_MS
          : key === "pageNext" ? addMonths(current.dayStart, 1) + time
            : key === "pagePrevious" ? addMonths(current.dayStart, -1) + time
              : key === "start" ? current.yearStart + time
                : current.yearStart + (current.daysInYear - 1) * DAY_MS + time;
      setClock(target, current.place);
    },
    onMark: id => {
      const current = view();
      const instant = seasonsOf(current.year)[id as Season];
      if (instant === undefined) return;
      setClock(solarDayStartMs(toClock(instant, current.place)) + timeOfDay(current), current.place);
    },
  });

  // What the dials read and which zone each clock keeps, behind the ? after them.
  const placeLine = document.createElement("p");
  const zoneLine = document.createElement("p");
  const explanation = document.createElement("div");
  explanation.append(placeLine, zoneLine);
  const help = createHelpTooltip({ label: "Explain solar time and time zones", content: explanation });
  const dials = document.createElement("div");
  dials.className = "foss-earth-choices foss-earth-date-time__dials";
  dials.append(timeDial.element, dateDial.element, help.element);
  const instantLine = line(document);
  const sunLine = line(document);
  const main = document.createElement("div");
  main.className = "foss-earth-date-time";
  const clockGroup = createChoiceGroup("sky-clock-display", "Clock", [{ id:"civil", label:"Civil" }, { id:"solar", label:"Solar" }], document, {
    help: "Civil uses the time zone at the place shown, including daylight saving time. Solar reads a sundial at the place shown. Switching keeps the same instant and lighting.",
  });
  const clockZone = document.createElement("span");
  clockZone.className = "foss-earth-choice-group__status";
  clockGroup.insertBefore(clockZone, clockGroup.lastElementChild);
  const onClockChange = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    if (input.matches('input[type="radio"]') && input.checked) settings.set("sky.clock.display", input.value);
  };
  clockGroup.addEventListener("change", onClockChange);
  main.append(clockGroup, dials, instantLine, sunLine);

  const onNow = (): void => { if (!disposed) settings.set("sky.time.mode", "now"); };
  const onToday = (): void => {
    const current = view();
    if (current.following) return;
    setClock(solarDayStartMs(toClock(now(), current.place)) + timeOfDay(current), current.place);
  };
  const showTime = (): void => { timeField.value = clockTime(timeOfDay(view()) / HOUR_MS); };
  const showDate = (): void => { dateField.value = isoDate(view().dayStart); };
  /** A typed time or date, which then reads as the dial does; one that cannot be read puts back what was there. */
  const onTimeField = (): void => {
    const match = /^\s*(\d{1,2})(?::?(\d{2}))?\s*$/.exec(timeField.value);
    const hours = match ? Number(match[1]) : NaN;
    const minutes = match?.[2] ? Number(match[2]) : 0;
    if (hours < 24 && minutes < 60) {
      const current = view();
      setClock(current.dayStart + hours * HOUR_MS + minutes * TIME.minuteMs, current.place);
    }
    showTime();
  };
  const onDateField = (): void => {
    const day = parseUtcDate(dateField.value);
    if (day !== null) {
      const current = view();
      setClock(day + timeOfDay(current), current.place);
    }
    showDate();
  };
  const onFieldKey = (event: KeyboardEvent): void => {
    const isTime = event.target === timeField;
    if (event.key === "Enter") {
      if (isTime) onTimeField(); else onDateField();
    } else if (event.key === "Escape") {
      if (isTime) showTime(); else showDate();
      (event.target as HTMLInputElement).blur();
    } else return;
    event.preventDefault();
  };
  nowButton.addEventListener("click", onNow);
  todayButton.addEventListener("click", onToday);
  timeField.addEventListener("change", onTimeField);
  dateField.addEventListener("change", onDateField);
  timeField.addEventListener("keydown", onFieldKey);
  dateField.addEventListener("keydown", onFieldKey);

  const timeMarks = (current: View): DialMark[] => {
    const sun = current.day.parts.sun;
    const marks: DialMark[] = [
      { id: "noon", label: "Noon", turn: timeTurn(solarHourOnClock(12, current)), title: "Noon, 12:00 solar time: the Sun at its highest." },
      { id: "midnight", label: "Midnight", turn: timeTurn(solarHourOnClock(0, current)), title: "Midnight, 00:00 solar time: the Sun at its lowest." },
    ];
    if (sun.rise !== null) marks.push({ id: "sunrise", label: "Sunrise", turn: timeTurn(solarHourOnClock(sun.rise, current)), title: `Sunrise, ${clockTime(sun.rise)} solar time.` });
    if (sun.set !== null) marks.push({ id: "sunset", label: "Sunset", turn: timeTurn(solarHourOnClock(sun.set, current)), title: `Sunset, ${clockTime(sun.set)} solar time.` });
    return marks;
  };
  const dayArcs = (current: View): DialArc[] => {
    const day = current.day;
    const arcs: DialArc[] = [{ from: 0, to: 1, colour: SKY_COLOURS.night }];
    for (const [part, colour] of DAY_PARTS) {
      const { rise, set, always } = day.parts[part];
      if (always === "above") arcs.push({ from: 0, to: 1, colour });
      else if (rise !== null && set !== null) arcs.push({ from: timeTurn(solarHourOnClock(rise, current)), to: timeTurn(solarHourOnClock(rise, current)) + wrapTurn(timeTurn(solarHourOnClock(set, current)) - timeTurn(solarHourOnClock(rise, current))), colour });
    }
    return arcs;
  };
  /** The year's ring, shaded by the day's length at the latitude, and a tick where each month starts. */
  const yearFace = (current: View): void => {
    const key = `${current.year}|${current.place.latDeg.toFixed(1)}`;
    if (key === yearKey) return;
    yearKey = key;
    const shades = DATE_DIAL.shades;
    yearArcs = dayLengthsHours(current.year, current.place.latDeg, shades).map((hours, index) => ({
      from: dateTurn(index / shades),
      to: dateTurn(index / shades) + 1 / shades + DATE_DIAL.shadeOverlap,
      colour: mix(SKY_COLOURS.night, SKY_COLOURS.day, hours / 24),
    }));
    monthTicks = Array.from({ length: 12 }, (_, month) => {
      const start = new Date(0);
      start.setUTCFullYear(current.year, month, 1);
      return { turn: dateTurn((start.getTime() - current.yearStart) / DAY_MS / current.daysInYear), major: month === 0 };
    });
  };
  const yearFraction = (current: View, solarMs: number): number => (solarMs - current.yearStart) / DAY_MS / current.daysInYear;

  let shown = "";
  function render(force = false): void {
    if (disposed) return;
    const current = view();
    const nowSolar = displayMinute(now(), current.place);
    const locked = TIME_PARAMETER_IDS.some(id => settings.inspect(id).provenance === "host");
    const key = [current.known, zoneAt(current.utcMs).id, solar(), current.following, current.clockMs, nowSolar, current.place.latDeg.toFixed(3), current.place.lonDeg.toFixed(3), locked].join("|");
    if (!force && key === shown) return;
    shown = key;
    const hours = timeOfDay(current) / HOUR_MS;
    const nowDay = solarDayStartMs(nowSolar);
    const nowHours = (nowSolar - nowDay) / HOUR_MS;
    const date = isoDate(current.dayStart);
    timeDial.render({
      turn: timeTurn(hours),
      valueNow: Math.round(hours * 60),
      valueText: `${clockTime(hours)} ${clockLabel()} on ${date}`,
      arcs: dayArcs(current),
      ticks: HOUR_TICKS,
      marks: timeMarks(current),
      ring: current.following ? null : { turn: timeTurn(nowHours), title: `Now: ${clockTime(nowHours)} ${clockLabel()} on ${isoDate(nowDay)}.` },
      disabled: locked,
    });
    yearFace(current);
    const seasonsNow = seasonsOf(current.year);
    dateDial.render({
      turn: dateTurn(yearFraction(current, current.clockMs)),
      valueNow: Math.round((current.dayStart - current.yearStart) / DAY_MS),
      valueText: date,
      arcs: yearArcs,
      ticks: monthTicks,
      marks: (Object.keys(SEASON_NAMES) as Season[]).map(season => {
        const instant = seasonsNow[season];
        const utc = Math.round(instant / TIME.minuteMs) * TIME.minuteMs;
        return {
          id: season,
          label: SEASON_NAMES[season][0],
          turn: dateTurn(yearFraction(current, toClock(instant, current.place))),
          title: `${SEASON_NAMES[season][1]}, ${isoDate(utc)} ${clockTime((utc - solarDayStartMs(utc)) / HOUR_MS)} UTC.`,
        };
      }),
      ring: current.following || nowDay === current.dayStart ? null : { turn: dateTurn(yearFraction(current, nowSolar)), title: `Today: ${isoDate(nowDay)}.` },
      disabled: locked,
    });

    if (document.activeElement !== timeField) timeField.value = clockTime(hours);
    if (document.activeElement !== dateField) dateField.value = date;
    for (const element of [timeField, dateField, nowButton, todayButton]) element.disabled = locked;
    nowButton.setAttribute("aria-pressed", String(current.following));
    todayButton.setAttribute("aria-pressed", String(current.following || nowDay === current.dayStart));

    const utcMs = current.utcMs;
    checkChoice(clockGroup, "sky-clock-display", solar() ? "solar" : "civil");
    const zoneName = zoneAt(utcMs);
    clockZone.textContent = solar() ? "At the place shown" : `${current.known ? zoneName.id ?? zoneName.name : "UTC · location unavailable"} · ${utcOffsetText(zoneName.offsetMinutes)}`;
    timeField.setAttribute("aria-label", `Time, as hours and minutes, in ${clockLabel()}`);
    const utcRounded = Math.floor(utcMs / TIME.minuteMs) * TIME.minuteMs;
    const utc = `${isoDate(utcRounded)} ${clockTime((utcRounded - solarDayStartMs(utcRounded)) / HOUR_MS)} UTC`;
    const local = new Date(utcMs).toLocaleString(undefined, { timeZone: zoneName.id ?? "UTC", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
    instantLine.textContent = `${current.following ? "Now" : "Set time"}: ${utc} · ${local} at the place shown`;
    zoneLine.textContent = current.known
      ? `Civil time: ${zoneName.id ?? zoneName.name}, ${utcOffsetText(zoneName.offsetMinutes)} at the place shown, including daylight saving time. Geographic zone boundaries are approximate.`
      : "The place shown is not known yet; Civil time temporarily reads UTC.";
    const sun = current.day.parts.sun;
    const daylight = sun.rise === null || sun.set === null ? 0 : Math.round((sun.set - sun.rise) * 60);
    sunLine.textContent = sun.always === "above" ? "The Sun stays above the horizon all day."
      : sun.always === "below" ? "The Sun stays below the horizon all day."
        : `Sunrise ${clockTime(solarHourOnClock(sun.rise!, current))} · sunset ${clockTime(solarHourOnClock(sun.set!, current))} ${solar() ? "solar" : "civil"} · ${Math.floor(daylight / 60)} h ${pad(daylight % 60, 2)} min daylight`;
    placeLine.textContent = current.known
      ? `Solar time is what a sundial reads at the place shown, ${describePlace(current.place)}: 12:00 with the Sun at its highest. Turning a dial on past midnight or the year's end carries on into the next day or year.`
      : "The place shown is not known yet, so the dials read a sundial at 0° N, 0° E.";
  }

  const section = createParameterSection(settings, { document, tab: TIME_TAB, section: "instant", main, covers: [...TIME_PARAMETER_IDS, "sky.clock.display"], refresh: options.refresh, panelStorage: options.panelStorage });
  const sections = createSectionsElement([], { document, storage: options.panelStorage });
  const hostSections = appendHostSections(settings, TIME_TAB, sections, ["instant"], { document, refresh: options.refresh, panelStorage: options.panelStorage });
  const element = document.createElement("div");
  element.className = "foss-earth-date-time-tab";
  element.append(section.element, sections.element);

  render(true);
  const unsubscribe = settings.subscribe(changed => {
    if (changed.has("sky.clock.display") || TIME_PARAMETER_IDS.some(id => changed.has(id))) render();
  });
  // The clock and the place shown move without the registry knowing: look again while the tab is on screen.
  const stopRefresh = options.refresh.subscribe(() => {
    if (element.isConnected && !document.hidden) render();
  });

  return {
    element,
    destroy(): void {
      if (disposed) return;
      disposed = true;
      stopRefresh();
      unsubscribe();
      nowButton.removeEventListener("click", onNow);
      todayButton.removeEventListener("click", onToday);
      timeField.removeEventListener("change", onTimeField);
      dateField.removeEventListener("change", onDateField);
      timeField.removeEventListener("keydown", onFieldKey);
      dateField.removeEventListener("keydown", onFieldKey);
      timeDial.destroy();
      dateDial.destroy();
      clockGroup.removeEventListener("change", onClockChange);
      help.destroy();
      section.destroy();
      hostSections.destroy();
      sections.destroy();
      element.remove();
    },
  };
}
