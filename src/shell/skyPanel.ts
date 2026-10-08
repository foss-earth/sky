import { getAppSettings } from "../settings/appSettings";
import { SKY_TAB } from "../settings/catalogue/sky";
import type { SettingsRegistry } from "../settings/registry";
import { HOUR_MS, solarDayStartMs } from "../sky/solarDay";
import { solarPosition } from "../sky/solarPosition";
import { TIME_PARAMETER_IDS, clockTime, instantInUse, isoDate, solarMinuteMs } from "./dateTimePanel";
import { appendHostSections, createParameterSection, createSectionsElement } from "./settings/parameterSection";

export interface SkyPanelOptions {
  /** The registry of the tab's parameters; the app's when omitted. */
  settings?: SettingsRegistry;
  /**
   * The place the sky is seen from: the runtime's
   * `sky.getEnvironment()?.illumination.observer`, or the view's place while
   * the sky model is off. Null while it is not known.
   */
  getPlace(): { latDeg: number; lonDeg: number } | null;
  /** The device's clock, in ms of UTC since 1970; `Date.now` when omitted. */
  now?: () => number;
  /** Opens the Date and time tab, where the time the Sun is placed for is set; the Sky tab links to it when given. */
  openDateTime?: () => void;
}

export interface SkyPanelHandle {
  element: HTMLElement;
  destroy(): void;
}

/** How often the line about the Sun looks again at the clock and the place shown while it is on screen. */
const REFRESH_MS = 1000;

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

/**
 * The contents of the Sky tab: where the Sun is, with a link to the Date and
 * time tab that sets the time; then the atmosphere and the sky model, the
 * Moon and the stars, the ground's light, the night lights, and exposure.
 * Any section a host's parameters are homed in follows.
 */
export function createSkyPanel(options: SkyPanelOptions): SkyPanelHandle {
  const settings = options.settings ?? getAppSettings();
  const now = options.now ?? (() => Date.now());

  // Where the Sun is, and a link to the tab that sets when.
  const sun = document.createElement("div");
  sun.className = "foss-earth-choices foss-earth-sky-sun";
  const line = document.createElement("p");
  line.className = "foss-earth-choices__note";
  sun.append(line);
  const open = options.openDateTime;
  const link = open ? document.createElement("button") : null;
  if (link && open) {
    link.type = "button";
    link.className = "foss-earth-choice foss-earth-parameter__action";
    link.textContent = "Date and time";
    link.title = "Opens the Date and time tab, whose dials set the time the Sun is placed for.";
    link.addEventListener("click", open);
    sun.append(link);
  }
  const describe = (): void => {
    const text = describeSun(settings, options.getPlace(), now);
    if (line.textContent !== text) line.textContent = text;
  };
  describe();

  const own = ["atmosphere", "night", "surface", "nightLights", "exposure"].map(section => ({ section, handle: createParameterSection(settings, { tab: SKY_TAB, section }) }));
  const sections = createSectionsElement(own.map(({ section, handle }) => ({
    id: `${SKY_TAB}.${section}`, title: settings.getSectionTitle(SKY_TAB, section), element: handle.element, defaultOpen: section !== "surface" && section !== "nightLights",
  })));
  const hostSections = appendHostSections(settings, SKY_TAB, sections, own.map(({ section }) => section));
  const element = document.createElement("div");
  element.className = "foss-earth-sky-tab";
  element.append(sun, sections.element);

  const unsubscribe = settings.subscribe(changed => {
    if (TIME_PARAMETER_IDS.some(id => changed.has(id))) describe();
  });
  // The clock and the place shown move without the registry knowing: look again while the tab is on screen.
  const timer = window.setInterval(() => {
    if (element.isConnected && !document.hidden) describe();
  }, REFRESH_MS);

  return {
    element,
    destroy(): void {
      window.clearInterval(timer);
      unsubscribe();
      if (link && open) link.removeEventListener("click", open);
      for (const { handle } of own) handle.destroy();
      hostSections.destroy();
      sections.destroy();
      element.remove();
    },
  };
}
