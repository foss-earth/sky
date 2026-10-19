import type { SkyPanelUiPorts, SkyPanelRefreshPort, SkyPanelStorageOptions } from "./ports.js";
import { SKY_TAB } from "../settings.js";
import type { SettingsRegistry } from "@foss-earth/ui/settings";
import { HOUR_MS, solarDayStartMs } from "../solarDay.js";
import { solarPosition } from "../solarPosition.js";
import { TIME_PARAMETER_IDS, clockTime, instantInUse, isoDate, solarMinuteMs } from "../time.js";

export interface SkyPanelOptions extends SkyPanelStorageOptions {
  document: Document;
  ui: SkyPanelUiPorts;
  refresh: SkyPanelRefreshPort;
  /** The host owns one registry. */
  settings: SettingsRegistry;
  /**
   * The place the sky is seen from: the runtime's
   * `sky.getEnvironment()?.illumination.observer`, or the view's place while
   * the sky model is off. Null while it is not known.
   */
  getPlace(): { latDeg: number; lonDeg: number } | null;
  /** Host UTC clock, ms since 1970. */
  now: () => number;
  /** Opens the Date and time tab, where the time the Sun is placed for is set; the Sky tab links to it when given. */
  openDateTime?: () => void;
}

export interface SkyPanelHandle {
  element: HTMLElement;
  destroy(): void;
}

/** Where the Sun is at the place shown, at the time in use, in a sentence. */
export function describeSun(settings: SettingsRegistry, place: { latDeg: number; lonDeg: number } | null, now: () => number): string {
  if (!place) return "The place shown is not known yet.";
  const { utcMs, following } = instantInUse(settings, now);
  const sun = solarPosition({ utcMs, latDeg: place.latDeg, lonDeg: place.lonDeg });
  const elevation = 90 - sun.zenithDeg;
  const solar = solarMinuteMs(utcMs, place.lonDeg);
  const day = solarDayStartMs(solar);
  const when = `${clockTime((solar - day) / HOUR_MS)} solar time on ${isoDate(day)}`;
  return `${following ? `Now, ${when}` : `At the set time, ${when}`}, the Sun is ${Math.abs(elevation).toFixed(1)}° ${elevation < 0 ? "below" : "above"} the horizon at the place shown, bearing ${Math.round(sun.azimuthDeg) % 360}°.`;
}

/** Where the Sun is, in a few words: "Now: Sun 12.3° up · bearing 213°". `describeSun` says it in full. */
export function sunSummary(settings: SettingsRegistry, place: { latDeg: number; lonDeg: number } | null, now: () => number): string {
  if (!place) return "Place not known yet";
  const { utcMs, following } = instantInUse(settings, now);
  const sun = solarPosition({ utcMs, latDeg: place.latDeg, lonDeg: place.lonDeg });
  const elevation = 90 - sun.zenithDeg;
  return `${following ? "Now" : "Set time"}: Sun ${Math.abs(elevation).toFixed(1)}° ${elevation < 0 ? "down" : "up"} · bearing ${Math.round(sun.azimuthDeg) % 360}°`;
}

/**
 * The contents of the Sky tab: where the Sun is, with a link to the Date and
 * time tab that sets the time; then the atmosphere and the sky model, the
 * Moon and the stars, the ground's light, the night lights, and exposure.
 * Any section a host's parameters are homed in follows.
 */
export function createSkyPanel(options: SkyPanelOptions): SkyPanelHandle {
  const document = options.document;
  const settings = options.settings;
  let disposed = false;
  const now = options.now;
  const { createParameterSection, createSectionsElement, appendHostSections, createHelpTooltip, createIconButton } = options.ui;

  // "Now: Sun 12.3° up · bearing 213° [clock] [?]": where the Sun is, a link to the tab that sets when, and the full sentence.
  const sun = document.createElement("div");
  sun.className = "foss-earth-choices foss-earth-sky-sun";
  const line = document.createElement("p");
  line.className = "foss-earth-choices__note foss-earth-sky-sun__line";
  sun.append(line);
  const open = options.openDateTime;
  const link = open ? createIconButton(document, { icon: "clock", label: "Open Date and time" }) : null;
  if (link && open) {
    link.addEventListener("click", open);
    sun.append(link);
  }
  const full = document.createElement("p");
  const help = createHelpTooltip({ label: "Explain where the Sun is", content: full });
  sun.append(help.element);
  const describe = (): void => {
    if (disposed) return;
    const place = options.getPlace();
    const text = sunSummary(settings, place, now);
    if (line.textContent !== text) line.textContent = text;
    const sentence = `${describeSun(settings, place, now)}${open ? " The Date and time tab sets when." : ""}`;
    if (full.textContent !== sentence) full.textContent = sentence;
  };
  describe();

  const own = ["atmosphere", "night", "surface", "nightLights", "exposure"].map(section => ({ section, handle: createParameterSection(settings, { document, tab: SKY_TAB, section, refresh: options.refresh, panelStorage: options.panelStorage }) }));
  const sections = createSectionsElement(own.map(({ section, handle }) => ({
    id: `${SKY_TAB}.${section}`, title: settings.getSectionTitle(SKY_TAB, section), element: handle.element, defaultOpen: section !== "surface" && section !== "nightLights",
  })), { document, storage: options.panelStorage });
  const hostSections = appendHostSections(settings, SKY_TAB, sections, own.map(({ section }) => section), { document, refresh: options.refresh, panelStorage: options.panelStorage });
  const element = document.createElement("div");
  element.className = "foss-earth-sky-tab";
  element.append(sun, sections.element);

  const unsubscribe = settings.subscribe(changed => {
    if (TIME_PARAMETER_IDS.some(id => changed.has(id))) describe();
  });
  // The clock and the place shown move without the registry knowing: look again while the tab is on screen.
  const stopRefresh = options.refresh.subscribe(() => {
    if (element.isConnected && !document.hidden) describe();
  });

  return {
    element,
    destroy(): void {
      if (disposed) return;
      disposed = true;
      stopRefresh();
      unsubscribe();
      if (link && open) link.removeEventListener("click", open);
      help.destroy();
      for (const { handle } of own) handle.destroy();
      hostSections.destroy();
      sections.destroy();
      element.remove();
    },
  };
}
