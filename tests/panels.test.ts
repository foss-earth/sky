// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { SKY_PARAMETERS, SKY_SECTION_TITLES } from "../src/settings.js";
import { fixedTimeValues, instantInUse } from "../src/time.js";
import { HOUR_MS, solarClockMs, solarDayStartMs } from "../src/solarDay.js";
import { createDateTimePanel } from "../src/panels/dateTimePanel.js";
import { createSkyPanel, describeSun } from "../src/panels/skyPanel.js";
import type { DialFrame, DialOptions, SkyDateTimeUiPorts, SkyPanelRefreshPort } from "../src/panels/ports.js";
afterEach(() => document.body.replaceChildren());
function harness(page: Document = globalThis.document) {
  const document = page;
  const settings = createSettingsRegistry({ storage: null }); settings.register(SKY_PARAMETERS); for (const [tab, section, title] of SKY_SECTION_TITLES) settings.setSectionTitle(tab, section, title);
  const dials: { options: DialOptions; frame: DialFrame | null; destroy: ReturnType<typeof vi.fn> }[] = [];
  const sectionDestroy = vi.fn(); const hostDestroy = vi.fn(); const sectionOptions: unknown[] = [];
  const ui: SkyDateTimeUiPorts = {
    createParameterSection(_settings, options) { expect(_settings).toBe(settings); sectionOptions.push(options); const element = document.createElement("div"); if (options.main) element.append(options.main); return { element, destroy: sectionDestroy }; },
    createSectionsElement(entries) { const element = document.createElement("div"); const ids = new Set<string>(); const append = (entry: typeof entries[number]) => { ids.add(entry.id); element.append(entry.element); }; for (const entry of entries) append(entry); return { element, append, has: id => ids.has(id), destroy: () => element.remove() }; },
    appendHostSections: () => ({ destroy: hostDestroy }),
    wrapTurn: turn => turn - Math.floor(turn),
    createDial(options) { const element = document.createElement("div"); element.className = "host-dial"; element.append(options.centre); const record = { options, frame: null as DialFrame | null, destroy: vi.fn() }; dials.push(record); return { element, render: frame => { record.frame = frame; }, isDragging: () => false, destroy: record.destroy }; },
  };
  let refresh = () => {}; const stopRefresh = vi.fn(); const source: SkyPanelRefreshPort = { subscribe: listener => { refresh = listener; return stopRefresh; } };
  const now = { utcMs: Date.UTC(2026, 9, 7, 20) }; const place = { value: { latDeg: 44.977753, lonDeg: -93.265011 } };
  return { settings, ui, dials, sectionDestroy, hostDestroy, sectionOptions, source, refresh: () => refresh(), stopRefresh, now, place };
}
describe("Sky/Time injected panel lifecycle", () => {
  it("keeps pure fixed-time records compatible and falls back explicitly for invalid dates", () => {
    const h = harness(); const instant = Date.UTC(2026, 9, 7, 23, 59, 59, 700); const fixed = fixedTimeValues(instant); expect(fixed).toEqual({ "sky.time.mode": "fixed", "sky.time.date": "2026-10-08", "sky.time.utcHours": 0 }); h.settings.setMany(fixed); expect(instantInUse(h.settings, () => h.now.utcMs)).toEqual({ utcMs: Date.UTC(2026, 9, 8), following: false }); h.settings.set("sky.time.date", "invalid"); expect(instantInUse(h.settings, () => h.now.utcMs).utcMs).toBe(h.now.utcMs);
  });
  it("renders time through host dials, sets the existing home and advances from host clock refreshes", () => {
    const h = harness(); const interval = vi.spyOn(window, "setInterval"); const panel = createDateTimePanel({ document, settings: h.settings, getPlace: () => h.place.value, now: () => h.now.utcMs, ui: h.ui, refresh: h.source, panelStorage: null, deviceZone: () => ({ name: "UTC", id: "UTC", offsetMinutes: 0 }) }); document.body.append(panel.element);
    expect(h.dials).toHaveLength(2); expect(h.sectionOptions[0]).toMatchObject({ tab: "time", section: "instant", panelStorage: null }); expect(interval).not.toHaveBeenCalled(); interval.mockRestore();
    const initialText = h.dials[0].frame!.valueText; h.now.utcMs += HOUR_MS; h.refresh(); expect(h.dials[0].frame!.valueText).not.toBe(initialText);
    h.dials[0].options.onPress(0); expect(h.settings.get("sky.time.mode")).toBe("fixed"); const fixed = instantInUse(h.settings, () => h.now.utcMs).utcMs; const solar = solarClockMs(fixed, h.place.value.lonDeg); expect(Math.abs(solar - solarDayStartMs(solar))).toBeLessThan(60_000);
    const before = fixed; h.dials[0].options.onKey("pageNext"); expect(instantInUse(h.settings, () => h.now.utcMs).utcMs).toBeGreaterThan(before + HOUR_MS - 2000);
    panel.destroy();panel.destroy(); expect(h.stopRefresh).toHaveBeenCalledOnce(); for (const dial of h.dials) expect(dial.destroy).toHaveBeenCalledOnce(); expect(h.hostDestroy).toHaveBeenCalledOnce(); expect(h.sectionDestroy).toHaveBeenCalledOnce(); expect(panel.element.isConnected).toBe(false);
    const stopped = h.settings.get("sky.time.utcHours");h.dials[0].options.onPress(0);expect(h.settings.get("sky.time.utcHours")).toBe(stopped);
  });
  it("links Sky to the host Time tab and updates the Sun line from host place/time refreshes", () => {
    const h = harness(); const open = vi.fn(); const panel = createSkyPanel({ document, settings: h.settings, getPlace: () => h.place.value, now: () => h.now.utcMs, ui: h.ui, refresh: h.source, panelStorage: null, openDateTime: open }); document.body.append(panel.element); const line = panel.element.querySelector("p")!; const initial = line.textContent;
    panel.element.querySelector("button")!.click(); expect(open).toHaveBeenCalledOnce(); h.now.utcMs += 3 * HOUR_MS; h.refresh(); expect(line.textContent).not.toBe(initial); expect(h.sectionOptions).toHaveLength(5); expect(describeSun(h.settings, null, () => h.now.utcMs)).toBe("The place shown is not known yet."); panel.destroy(); expect(h.stopRefresh).toHaveBeenCalledOnce(); expect(h.sectionDestroy).toHaveBeenCalledTimes(5);
  });
  it("creates controls in the supplied document while the ambient DOM factory is unavailable", () => {
    const page = document.implementation.createHTMLDocument("supplied host"), h = harness(page);
    const ambient = vi.spyOn(document, "createElement").mockImplementation(() => { throw new Error("Ambient document used"); });
    const options = { document: page, settings: h.settings, getPlace: () => h.place.value, now: () => h.now.utcMs, ui: h.ui, refresh: h.source, panelStorage: null };
    try {
      const sky = createSkyPanel(options), time = createDateTimePanel({ ...options, deviceZone: () => ({ name: "UTC", id: "UTC", offsetMinutes: 0 }) });
      expect(sky.element.ownerDocument).toBe(page); expect(time.element.ownerDocument).toBe(page);
      expect(time.element.querySelectorAll("input").length).toBe(2);
      expect(h.sectionOptions.every(value => (value as { refresh: unknown }).refresh === h.source)).toBe(true);
      expect(h.sectionOptions.every(value => (value as { document: Document }).document === page)).toBe(true);
      sky.destroy(); time.destroy();
    } finally { ambient.mockRestore(); }
  });
  it("ignores stale shared pulses after a disposed panel element is reattached", () => {
    const h = harness();const panel = createSkyPanel({ document,settings: h.settings,getPlace: () => h.place.value,now: () => h.now.utcMs,ui: h.ui,refresh: h.source,panelStorage: null });
    const before = panel.element.querySelector("p")!.textContent;panel.destroy();document.body.append(panel.element);h.now.utcMs += 3 * HOUR_MS;h.refresh();
    expect(panel.element.querySelector("p")!.textContent).toBe(before);panel.destroy();expect(h.stopRefresh).toHaveBeenCalledOnce();expect(h.hostDestroy).toHaveBeenCalledOnce();
  });
});
