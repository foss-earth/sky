import type { SettingsRegistry } from "@foss-earth/ui/settings";
import { luminance, whiteLuminanceForEv100 } from "../skyState.js";
import type { SkyEnvironment, SkyNightLights, SkyRuntime } from "./createSkyRuntime.js";

/** Host-owned settings registry; this helper registers no parameters or frame loop. */
export type SkyReadingSettings = Pick<SettingsRegistry, "get" | "watch" | "setNote" | "setReadingSource">;

/** A count of lux or cd/m² as it is read: whole above a hundred, two figures below. */
function formatLight(value: number, unit: string): string {
  const text = value >= 100 ? Math.round(value).toLocaleString("en-US")
    : value === 0 ? "0" : Number(value.toPrecision(2)).toString();
  return `${text} ${unit}`;
}

/** What the sky's parameters show beside them: where the Sun is, the light it gives, the exposure in use and what each computation cost. */
export function skyReadings(environment: () => SkyEnvironment | null, on: () => boolean): Array<[string, () => string | null]> {
  const lux = luminance;
  const waiting = (): string | null => (on() ? "Waiting for a viewpoint on the Earth." : null);
  return [
    ["sky.time.mode", () => {
      const sky = environment();
      if (!sky) return waiting();
      const { illumination: light } = sky;
      const { observer } = light;
      const place = `${Math.abs(observer.latDeg).toFixed(2)}°${observer.latDeg >= 0 ? "N" : "S"} ${Math.abs(observer.lonDeg).toFixed(2)}°${observer.lonDeg >= 0 ? "E" : "W"}, ${Math.round(observer.altitudeMeters).toLocaleString("en-US")} m`;
      const height = light.sunElevationDeg >= 0 ? `${light.sunElevationDeg.toFixed(1)}° above the horizon` : `${(-light.sunElevationDeg).toFixed(1)}° below the horizon`;
      return `${new Date(light.utcMs).toISOString().replace("T", " ").slice(0, 19)} UTC at ${place}: the Sun is ${height}, bearing ${light.sunAzimuthDeg.toFixed(0)}°`;
    }],
    ["sky.model", () => {
      const sky = environment();
      if (!sky) return waiting();
      const { cost, illumination: light } = sky;
      const dome = sky.model === "dome"
        ? `The dome's ${cost.domeSamples.toLocaleString("en-US")} samples${cost.moonSamples > 0 ? `, ${cost.moonSamples.toLocaleString("en-US")} of them the moonlit sky's,` : ""} took ${cost.domeMs.toFixed(1)} ms and its light ${cost.illuminationMs.toFixed(1)} ms`
        : `Its light took ${cost.illuminationMs.toFixed(1)} ms`;
      const moon = light.moon ? `, ${formatLight(lux(light.moon.directIlluminance), "lx")} from the Moon` : "";
      return `${formatLight(lux(light.sunIlluminance), "lx")} from the Sun${moon} and ${formatLight(lux(light.skyIlluminance), "lx")} from the sky. ${dome}; computed ${cost.computations.toLocaleString("en-US")} times`;
    }],
    ["sky.moon.mode", () => {
      const moon = environment()?.illumination.moon;
      if (!moon) return null;
      const height = moon.elevationDeg >= 0 ? `${moon.elevationDeg.toFixed(1)}° above the horizon` : `${(-moon.elevationDeg).toFixed(1)}° below the horizon`;
      return `${Math.round(moon.view.illuminatedFraction * 100)}% lit, ${height}, bearing ${moon.azimuthDeg.toFixed(0)}°, ${Math.round(moon.view.distanceMeters / 1000).toLocaleString("en-US")} km away`;
    }],
    ["sky.stars.mode", () => {
      const sky = environment();
      if (!sky || sky.model !== "dome") return null;
      const stars = sky.stars;
      if (sky.starCatalogue === "not needed") return "No star could show at this exposure: the catalogue is not loaded.";
      if (!stars) return sky.starCatalogue === "loading" ? "Loading the catalogue." : null;
      return `${stars.stars.toLocaleString("en-US")} stars, computed in ${stars.updateMs.toFixed(1)} ms; ${stars.visible ? "drawn" : "none bright enough to show at this exposure, so not drawn"}`;
    }],
    ["sky.stars.daylightAltitude", () => {
      const sky = environment();
      if (!sky || sky.model !== "dome" || sky.starCatalogue === null) return null;
      const km = sky.illumination.observer.altitudeMeters / 1000;
      const height = `${km >= 100 ? Math.round(km).toLocaleString("en-US") : Number(km.toPrecision(2))} km`;
      const stops = sky.ev100 - sky.starEv100;
      return stops < 0.05
        ? `At ${height} the stars keep the scene's exposure, EV ${sky.ev100.toFixed(1)}`
        : `At ${height} the stars are shown at EV ${sky.starEv100.toFixed(1)}, ${stops.toFixed(1)} stops brighter than the scene's EV ${sky.ev100.toFixed(1)}: white for them is ${formatLight(whiteLuminanceForEv100(sky.starEv100), "cd/m²")}`;
    }],
    ["sky.groundLight.mode", () => {
      const ground = environment()?.groundLight;
      if (!ground) return null;
      const latency = ground.latencyMs === null ? "" : `, read back in ${ground.latencyMs.toFixed(0)} ms`;
      return ground.source === "off" ? null : `The ground below sends up ${formatLight(lux(ground.luminance), "cd/m²")}${latency}`;
    }],
    ["sky.atmosphere.aerosolOpticalDepth", () => {
      const sky = environment();
      return sky ? `The atmosphere's tables took ${sky.cost.tablesMs.toFixed(0)} ms and hold ${Math.round(sky.cost.tableBytes / 1024)} KiB` : null;
    }],
    ["sky.exposure.mode", () => {
      const sky = environment();
      if (!sky) return null;
      const adapted = Math.abs(sky.adaptedEv100 - sky.meteredEv100) > 0.05 ? `; the meter reads EV ${sky.meteredEv100.toFixed(1)}, adapted to EV ${sky.adaptedEv100.toFixed(1)}` : "";
      const held = sky.exposureHeld === "dark" ? `, below the range, so the scene is left dark`
        : sky.exposureHeld === "bright" ? `, above the range, so the scene is left bright` : "";
      return `EV ${sky.ev100.toFixed(1)} at ISO 100: white is ${formatLight(sky.whiteLuminance, "cd/m²")}, for ${formatLight(sky.illumination.meteredLux, "lx")} at the viewpoint${adapted || (held ? `; the meter reads EV ${sky.meteredEv100.toFixed(1)}` : "")}${held}`;
    }],
    ["sky.surface.lighting", () => {
      const factor = environment()?.surfaceFactor;
      return factor ? `Below the viewpoint, imagery is shown at ${Number(lux(factor).toPrecision(2))}× its own linear value` : null;
    }],
  ];
}

/** What the night lights' parameters show beside them: the lamps below the viewpoint and where they switch, the tiles, and the memory they take. */
export function nightLightReadings(nightLights: () => SkyNightLights | null): Array<[string, () => string | null]> {
  const mebibytes = (bytes: number): string => `${Number((bytes / 1_048_576).toPrecision(2))} MiB`;
  return [
    ["sky.nightLights.mode", () => {
      const night = nightLights();
      if (!night) return null;
      const { state, below } = night;
      const square = state.window ?? state.pending;
      const tiles = square
        ? `${state.window ? "" : "Making the first window ready: "}zoom ${square.zoom}, ${state.here} of ${state.needed} tiles needed here${state.loading > 0 ? `, ${state.loading} on their way` : ""}${state.failed > 0 ? `, ${state.failed} failed` : ""}${state.error ? `: ${state.error}` : ""}; ${mebibytes(state.downloadedBytes)} downloaded`
        : "Waiting for a viewpoint on the Earth";
      const lamps = below === null ? "no tile here holds the place below the viewpoint"
        : `below the viewpoint the satellite saw ${formatLight(below.radiance, "nW/(cm² sr)")}: lamps' light of ${formatLight(below.illuminanceLux, "lx")}, seen at ${formatLight(below.luminance, "cd/m²")}, ${below.on ? "on now" : "off now"}`;
      const height = night.switchSunDeg;
      const switching = height === null ? "" : `; lamps are on where the Sun is ${Math.abs(height).toFixed(1)}° ${height < 0 ? "below" : "above"} the horizon or lower`;
      return `${tiles}${switching}; ${lamps}`;
    }],
    ["sky.nightLights.windowTiles", () => {
      const night = nightLights();
      if (!night) return null;
      const square = night.state.window ?? night.state.pending;
      const across = square ? `${square.tiles} × ${square.tiles} tiles of zoom ${square.zoom}; ` : "";
      const { gpuBytes, needed } = night.state;
      const empty = !night.state.window ? "nothing on the GPU until the tiles needed are here"
        : needed === 0 ? "nothing on the GPU: the Sun is not low enough on any ground in view" : "nothing on the GPU: no tile needed holds a lamp";
      return `${across}${gpuBytes > 0 ? `${mebibytes(gpuBytes)} on the GPU` : empty}`;
    }],
    ["sky.nightLights.memory", () => {
      const night = nightLights();
      return night ? `${mebibytes(night.state.memoryBytes)} kept` : null;
    }],
  ];
}
export function applySkyNotes(settings: SkyReadingSettings): void {
    const off = settings.get("sky.model") === "off";
    settings.setNote("sky.exposure.mode", off ? "No effect while the sky model is off: nothing in the scene has a luminance to expose for. Exposure compensation still applies." : null);
    settings.setNote("sky.surface.lighting", off ? "No effect while the sky model is off: imagery is shown as photographed." : null);
    const dome = settings.get("sky.model") === "dome";
    settings.setNote("sky.stars.mode", dome ? null : "Drawn only with the sky model's Dome.");
    settings.setNote("sky.moon.mode", off ? "No effect while the sky model is off." : dome ? null : "Its light only: its disc and the moonlit sky are drawn with the sky model's Dome.");
    settings.setNote("sky.groundLight.mode", off ? "No effect while the sky model is off: the fill lights stand in for it." : null);
    settings.setNote("sky.nightLights.mode", off ? "No effect while the sky model is off: imagery is shown as photographed."
      : settings.get("sky.surface.lighting") === "photograph" ? "No effect while map imagery is shown as photographed." : null);
    settings.setNote("sky.stars.daylightAltitude", settings.get("sky.exposure.mode") === "fixed" ? "No effect with a fixed exposure, which holds the stars as it holds all else." : null);
    // A compensation saved before there was a sky still applies, on top of it.
    const compensation = settings.get<number>("renderer.exposureEV");
    settings.setNote("renderer.exposureEV", off || compensation === 0 ? null
      : `On top of the sky's exposure: everything is shown ${Number((2 ** Math.abs(compensation)).toPrecision(3)).toLocaleString("en-US")}× ${compensation > 0 ? "brighter" : "darker"} than it sets.`);
  }

const NOTE_IDS = [
  "sky.exposure.mode", "sky.surface.lighting", "sky.stars.mode", "sky.moon.mode",
  "sky.groundLight.mode", "sky.nightLights.mode", "sky.stars.daylightAltitude", "renderer.exposureEV",
] as const;
const NOTE_WATCH_IDS = ["sky.model", "sky.exposure.mode", "renderer.exposureEV", "sky.surface.lighting"] as const;

/**
 * Bind one host's supplied Sky to its registered settings. The host calls the
 * returned function before replacing the binding. Readings are evaluated only
 * when the existing settings UI asks for them; this starts no timer or frame.
 * Detaching never disposes the Sky or the settings registry.
 */
export function bindSkyReadingsAndNotes(options: {
  settings: SkyReadingSettings;
  sky: Pick<SkyRuntime, "getEnvironment" | "getNightLights">;
}): () => void {
  const { settings, sky } = options;
  const remove: Array<() => void> = [];
  let detached = false;
  const detach = (): void => {
    if (detached) return;
    detached = true;
    const errors: unknown[] = [];
    for (const unsubscribe of remove.splice(0).reverse()) {
      try { unsubscribe(); } catch (error) { errors.push(error); }
    }
    for (const id of NOTE_IDS) {
      try { settings.setNote(id, null); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Sky settings binding cleanup failed");
  };
  try {
    applySkyNotes(settings);
    for (const id of NOTE_WATCH_IDS) remove.push(settings.watch(id, () => applySkyNotes(settings)));
    const readings = [
      ...skyReadings(() => sky.getEnvironment(), () => settings.get("sky.model") !== "off"),
      ...nightLightReadings(() => sky.getNightLights()),
    ];
    for (const [id, read] of readings) remove.push(settings.setReadingSource(id, read));
  } catch (error) {
    try { detach(); } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Sky settings binding failed");
    }
    throw error;
  }
  return detach;
}
