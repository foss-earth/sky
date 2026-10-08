// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { getAppSettings } from "../settings/appSettings";
import { HOUR_MS, solarClockMs, solarDay, solarDayStartMs, utcForSolarClockMs } from "../sky/solarDay";
import { createDateTimePanel, deviceClockZone, fixedTimeValues, instantInUse, utcOffsetText, zoneByLongitudeMinutes, type ClockZone } from "./dateTimePanel";

const MINNEAPOLIS = { latDeg: 44.977753, lonDeg: -93.265011 };
/** 20:00 UTC on 2026-10-07: 13:59 solar time in Minneapolis, 6 h 13 min behind for its longitude and 12 min ahead for the equation of time. */
const NOW = Date.UTC(2026, 9, 7, 20, 0);

afterEach(() => {
  getAppSettings().resetAll({ tab: "time" });
  document.body.replaceChildren();
});

/** The zone the tests' device keeps, whatever the machine running them does: Central Daylight Time. */
const CENTRAL: ClockZone = { name: "Central Daylight Time", id: "America/Chicago", offsetMinutes: -300 };

function mount(place: { latDeg: number; lonDeg: number } | null = MINNEAPOLIS, deviceZone: (utcMs: number) => ClockZone = () => CENTRAL) {
  const settings = getAppSettings();
  let shown = place;
  const panel = createDateTimePanel({ settings, getPlace: () => shown, now: () => NOW, deviceZone });
  document.body.append(panel.element);
  const [timeDial, dateDial] = [...panel.element.querySelectorAll<HTMLElement>(".foss-earth-dial")];
  const knob = (dial: HTMLElement) => dial.querySelector<SVGCircleElement>('[role="slider"]')!;
  const key = (dial: HTMLElement, name: string) => knob(dial).dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  const mark = (dial: HTMLElement, id: string) => dial.querySelector(`[data-mark="${id}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const button = (label: string) => [...panel.element.querySelectorAll("button")].find(element => element.textContent === label)!;
  const field = (dial: HTMLElement) => dial.querySelector<HTMLInputElement>("input")!;
  /** The solar clock of the time in use at the place, to the minute. */
  const solar = () => Math.round(solarClockMs(instantInUse(settings, () => NOW).utcMs, MINNEAPOLIS.lonDeg) / 60_000) * 60_000;
  const clock = () => new Date(solar()).toISOString().slice(0, 16).replace("T", " ");
  return { settings, panel, timeDial, dateDial, knob, key, mark, button, field, solar, clock, move: (next: typeof place) => { shown = next; } };
}

describe("Date and time tab", () => {
  it("lays its two dials out as a paragraph grid, and covers the time's parameters with them", () => {
    const { panel, timeDial, dateDial } = mount();
    const grid = timeDial.parentElement!;
    expect(grid.classList.contains("foss-earth-choices")).toBe(true);
    expect(dateDial.parentElement).toBe(grid);
    expect(panel.element.querySelector('[data-settings-section="time/instant"]')).not.toBeNull();
    for (const id of ["sky.time.mode", "sky.time.date", "sky.time.utcHours"]) expect(panel.element.querySelector(`.foss-earth-parameter-section__main [data-parameter="${id}"]`)).toBeNull();
    expect([...timeDial.querySelectorAll("[data-mark] textPath")].map(label => label.textContent).sort()).toEqual(["Midnight", "Noon", "Sunrise", "Sunset"]);
    expect([...dateDial.querySelectorAll("[data-mark] textPath")].map(label => label.textContent).sort()).toEqual(["Dec solstice", "Jun solstice", "Mar equinox", "Sep equinox"]);
    panel.destroy();
  });

  it("follows the clock until a moment is pressed, and Now follows it again", () => {
    const { settings, panel, timeDial, mark, button, clock, knob } = mount();
    expect(settings.get("sky.time.mode")).toBe("now");
    expect(button("Now").getAttribute("aria-pressed")).toBe("true");
    expect(clock()).toBe("2026-10-07 13:59");
    mark(timeDial, "sunset");
    expect(settings.get("sky.time.mode")).toBe("fixed");
    // Sunset in Minneapolis on 2026-10-07 is about 18:41 CDT, 23:41 UTC: within a minute of the algorithm's.
    const day = solarDay(solarDayStartMs(solarClockMs(NOW, MINNEAPOLIS.lonDeg)), MINNEAPOLIS);
    const sunset = utcForSolarClockMs(day.startMs + day.parts.sun.set! * HOUR_MS, MINNEAPOLIS.lonDeg);
    expect(Math.abs(instantInUse(settings, () => NOW).utcMs - sunset)).toBeLessThan(31_000);
    expect(new Date(sunset).toISOString().slice(0, 13)).toBe("2026-10-07T23");
    expect(knob(timeDial).getAttribute("aria-valuetext")).toMatch(/^17:\d\d solar time on 2026-10-07$/);
    expect(button("Now").getAttribute("aria-pressed")).toBe("false");
    // The clock's place on the dial while another time is set.
    expect(timeDial.querySelector<SVGElement>(".foss-earth-dial__ring")!.style.display).toBe("");
    mark(timeDial, "noon");
    expect(clock()).toBe("2026-10-07 12:00");
    mark(timeDial, "midnight");
    expect(clock()).toBe("2026-10-07 00:00");
    button("Now").click();
    expect(settings.get("sky.time.mode")).toBe("now");
    panel.destroy();
  });

  it("steps by minutes and hours, and carries a step past midnight into the next day", () => {
    const { panel, timeDial, key, mark, clock } = mount();
    mark(timeDial, "noon");
    key(timeDial, "ArrowRight");
    expect(clock()).toBe("2026-10-07 12:01");
    key(timeDial, "PageUp");
    expect(clock()).toBe("2026-10-07 13:01");
    key(timeDial, "End");
    expect(clock()).toBe("2026-10-07 23:59");
    key(timeDial, "ArrowUp");
    expect(clock()).toBe("2026-10-08 00:00");
    key(timeDial, "ArrowDown");
    expect(clock()).toBe("2026-10-07 23:59");
    key(timeDial, "Home");
    expect(clock()).toBe("2026-10-07 00:00");
    panel.destroy();
  });

  it("winds on through midnight when the time is dragged past it", () => {
    const { panel, timeDial, mark, clock } = mount();
    mark(timeDial, "noon");
    const face = timeDial.querySelector<SVGSVGElement>(".foss-earth-dial__face")!;
    face.getBoundingClientRect = () => ({ left: 0, top: 0, width: 140, height: 140, right: 140, bottom: 140, x: 0, y: 0, toJSON: () => ({}) });
    const at = (turn: number) => ({ clientX: 70 + 46 * Math.sin(turn * 2 * Math.PI), clientY: 70 - 46 * Math.cos(turn * 2 * Math.PI), pointerId: 1, button: 0, bubbles: true, cancelable: true });
    // Press the track at 21:00, three quarters of the way from the bottom, then turn on through midnight to 03:00.
    face.dispatchEvent(new PointerEvent("pointerdown", at(0.375)));
    expect(clock()).toBe("2026-10-07 21:00");
    for (const turn of [0.42, 0.47, 0.52, 0.57, 0.625]) face.dispatchEvent(new PointerEvent("pointermove", at(turn)));
    expect(clock()).toBe("2026-10-08 03:00");
    face.dispatchEvent(new PointerEvent("pointerup", at(0.625)));
    panel.destroy();
  });

  it("sets dates from the date dial, keeping the solar time of day", () => {
    const { panel, timeDial, dateDial, key, mark, button, clock } = mount();
    mark(timeDial, "noon");
    mark(dateDial, "december");
    expect(clock()).toBe("2026-12-21 12:00");
    key(dateDial, "ArrowRight");
    expect(clock()).toBe("2026-12-22 12:00");
    key(dateDial, "PageUp");
    expect(clock()).toBe("2027-01-22 12:00");
    key(dateDial, "ArrowLeft");
    key(dateDial, "Home");
    expect(clock()).toBe("2027-01-01 12:00");
    key(dateDial, "ArrowLeft");
    expect(clock()).toBe("2026-12-31 12:00");
    mark(dateDial, "june");
    expect(clock()).toBe("2026-06-21 12:00");
    button("Today").click();
    expect(clock()).toBe("2026-10-07 12:00");
    expect(button("Today").getAttribute("aria-pressed")).toBe("true");
    panel.destroy();
  });

  it("winds on through the year's end when the date is dragged past it", () => {
    const { panel, timeDial, dateDial, mark, clock } = mount();
    mark(timeDial, "noon");
    mark(dateDial, "december");
    const face = dateDial.querySelector<SVGSVGElement>(".foss-earth-dial__face")!;
    face.getBoundingClientRect = () => ({ left: 0, top: 0, width: 140, height: 140, right: 140, bottom: 140, x: 0, y: 0, toJSON: () => ({}) });
    const knobAt = dateDial.querySelector<SVGCircleElement>('[role="slider"]')!;
    const start = Math.atan2(Number(knobAt.getAttribute("cx")) - 70, 70 - Number(knobAt.getAttribute("cy"))) / (2 * Math.PI);
    const at = (turn: number) => ({ clientX: 70 + 46 * Math.sin(turn * 2 * Math.PI), clientY: 70 - 46 * Math.cos(turn * 2 * Math.PI), pointerId: 2, button: 0, bubbles: true, cancelable: true });
    knobAt.dispatchEvent(new PointerEvent("pointerdown", at(start)));
    // A twelfth of a turn on: about a month, into the next year.
    for (let step = 1; step <= 4; step++) face.dispatchEvent(new PointerEvent("pointermove", at(start + step / 48)));
    expect(clock()).toBe("2027-01-20 12:00");
    face.dispatchEvent(new PointerEvent("pointerup", at(start + 1 / 12)));
    panel.destroy();
  });

  it("reads a typed time and date, and puts back one it cannot read", () => {
    const { panel, timeDial, dateDial, field, clock } = mount();
    const type = (input: HTMLInputElement, text: string) => {
      input.value = text;
      input.dispatchEvent(new Event("change"));
    };
    type(field(timeDial), "9");
    expect(clock()).toBe("2026-10-07 09:00");
    expect(field(timeDial).value).toBe("09:00");
    type(field(timeDial), "1745");
    expect(clock()).toBe("2026-10-07 17:45");
    type(field(dateDial), "1969-07-20");
    expect(clock()).toBe("1969-07-20 17:45");
    type(field(timeDial), "25:00");
    expect(field(timeDial).value).toBe("17:45");
    type(field(dateDial), "2026-02-30");
    expect(field(dateDial).value).toBe("1969-07-20");
    expect(clock()).toBe("1969-07-20 17:45");
    panel.destroy();
  });

  it("says where the Sun neither rises nor sets, and leaves those moments off", () => {
    const { settings, panel, timeDial } = mount({ latDeg: 80, lonDeg: 0 });
    settings.setMany(fixedTimeValues(Date.UTC(2026, 5, 21, 12)));
    expect([...timeDial.querySelectorAll("[data-mark] textPath")].map(label => label.textContent).sort()).toEqual(["Midnight", "Noon"]);
    expect(panel.element.textContent).toContain("The Sun stays above the horizon all day.");
    expect(panel.element.textContent).toContain("80.00° N, 0.00° E");
    panel.destroy();
  });

  it("says when the place is not known, and locks while the app sets the time", () => {
    const { settings, panel, timeDial, button } = mount(null);
    expect(panel.element.textContent).toContain("The place shown is not known yet");
    const release = settings.force("sky.time.mode", "fixed", "A scenario sets the time");
    expect(timeDial.classList.contains("is-disabled")).toBe(true);
    expect(button("Now").disabled).toBe(true);
    release();
    expect(timeDial.classList.contains("is-disabled")).toBe(false);
    panel.destroy();
  });

  it("keeps a set time to the second, so a date's change keeps its solar time", () => {
    expect(fixedTimeValues(Date.UTC(2026, 0, 2, 6, 29, 40, 400))).toEqual({ "sky.time.mode": "fixed", "sky.time.date": "2026-01-02", "sky.time.utcHours": 6 + 29 / 60 + 40 / 3600 });
    expect(fixedTimeValues(Date.UTC(-44, 2, 15, 12))["sky.time.date"]).toBe("-0044-03-15");
  });

  it("says which time zone each clock is in: the device's by name, and the place's by its longitude alone", () => {
    const { panel, move, settings } = mount();
    const text = () => panel.element.textContent ?? "";
    // The dials are in no zone: solar time is the place's own. The device's clock is named, with its offset.
    expect(text()).toContain("Time zones: this device's clock keeps Central Daylight Time, UTC−5 (America/Chicago).");
    // Minneapolis, 93.27° W, lies in the sixth hour west of Greenwich; its civil time, an hour on in summer, is not known.
    expect(text()).toContain("The place shown is in UTC−6 by its longitude alone, as zones run at sea; which civil time is kept there is not known to the app.");
    // Following the clock, the device's own time is given too.
    expect(text()).toMatch(/Now, .+ by this device's clock: 13:59 solar time on 2026-10-07 at the place shown, which is 2026-10-07 20:00 UTC\./);
    // The place moves on: Kolkata is in the sixth hour east, where India keeps UTC+5:30.
    move({ latDeg: 22.57, lonDeg: 88.36 });
    settings.set("sky.time.mode", "fixed");
    expect(text()).toContain("The place shown is in UTC+6 by its longitude alone");
    move(null);
    settings.set("sky.time.utcHours", 3);
    expect(text()).toContain("Time zones: this device's clock keeps Central Daylight Time, UTC−5 (America/Chicago). The place shown is not known yet.");
  });

  it("writes offsets as zones are written, and finds a longitude's hour", () => {
    expect([0, -300, 330, 765, -210, 60].map(utcOffsetText)).toEqual(["UTC", "UTC−5", "UTC+5:30", "UTC+12:45", "UTC−3:30", "UTC+1"]);
    expect([0, 7.4, 7.6, -93.27, 88.36, 172.6, -172.6, 180, 360 - 93.27].map(zoneByLongitudeMinutes).map(minutes => minutes / 60)).toEqual([0, 0, 1, -6, 6, 12, -12, -12, -6]);
    // This machine's own zone, whichever it is: a name, and the offset its clock has at that instant.
    const own = deviceClockZone(NOW);
    expect(own.name.length).toBeGreaterThan(0);
    expect(own.offsetMinutes).toBe(-new Date(NOW).getTimezoneOffset());
  });
});
