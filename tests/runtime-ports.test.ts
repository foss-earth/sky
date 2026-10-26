import { Matrix, FreeCamera, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsRegistry, type SettingsRegistry } from "@foss-earth/ui/settings";
import { SKY_PARAMETERS } from "../src/settings.js";
import { bindSkyReadingsAndNotes, createSkyRuntime, type GroundLightProbeOptions, type NightLightsOptions, type SkyRuntime, type SkyRuntimeOptions } from "../src/babylon/index.js";
import { adaptEv100, ev100ForIlluminance, luminance } from "../src/skyState.js";
const engines: NullEngine[] = []; const skies: SkyRuntime[] = [];
afterEach(() => { for (const sky of skies.splice(0)) sky.dispose(); for (const engine of engines.splice(0)) engine.dispose(); });
function harness(extra: Partial<SkyRuntimeOptions> = {}, beforeCreate?: (settings: SettingsRegistry) => void) {
  const engine = new NullEngine(); engines.push(engine); const scene = new Scene(engine);
  // Exercise the actual explicit world transform, including native signed-zero coordinates.
  const worldMatrix = Matrix.Identity();
  const camera = new FreeCamera("host-camera", new Vector3(6378637, 0, 0), scene); scene.activeCamera = camera; camera.getViewMatrix(true);
  const settings = createSettingsRegistry({ storage: null }); settings.register(SKY_PARAMETERS);
  settings.setMany({ "sky.model": "lights", "sky.time.mode": "fixed", "sky.time.date": "2026-03-20", "sky.time.utcHours": 12, "sky.moon.mode": "off", "sky.stars.mode": "off", "sky.nightLights.mode": "off", "sky.groundLight.mode": "uniform" });
  beforeCreate?.(settings);
  const request = vi.fn(); const setLighting = vi.fn(() => true); const setLocalLights = vi.fn(); const convert = vi.fn(() => ({ latRad: 0, lonRad: 0, altMeters: 500 }));
  const timers = new Map<number, () => void>(); let next = 1; const time = { utcMs: Date.UTC(2026, 2, 20, 12), hidden: false };
  const sky = createSkyRuntime({ scene, settings, ecefToGeodetic: convert, terrain: { setLighting, setLocalLights }, nightTilePorts: { fetchTile: async () => { throw new Error("Unexpected tile acquisition"); }, measureResponse: response => response, retryDelayMs: () => 2000, setNightLightMap: () => true }, getWorldMatrix: () => worldMatrix, requestRender: request, onLightingChange: () => {}, isGround: () => false, now: () => time.utcMs, clock: () => 0, isHidden: () => time.hidden, timers: { set: callback => { const id = next++; timers.set(id, callback); return id; }, clear: id => { timers.delete(id); } }, ...extra }); skies.push(sky);
  return { scene, settings, sky, request, setLighting, setLocalLights, convert, timers, time };
}
describe("Sky host/runtime lifecycle", () => {
  it("uses one supplied scene, lighting adapter and coordinate port and leaves a static view unchanged", () => {
    const h = harness(); h.sky.update(); expect(h.convert).toHaveBeenCalledWith(6378637, 0, 0); expect(h.sky.getEnvironment()?.model).toBe("lights"); expect(h.setLighting.mock.calls.at(-1)?.[0]).toMatchObject({ perPoint: true });
    const computed = h.sky.getEnvironment()!.cost.computations; const requested = h.request.mock.calls.length; h.sky.update(); expect(h.sky.getEnvironment()!.cost.computations).toBe(computed); expect(h.request).toHaveBeenCalledTimes(requested); expect(h.timers.size).toBe(0);
    h.sky.dispose(); expect(h.scene.lights).toHaveLength(0); const stopped = h.request.mock.calls.length; h.settings.set("sky.time.utcHours", 13); expect(h.request).toHaveBeenCalledTimes(stopped);
  });
  it("wakes only through host timers when the Sun threshold is due and stops on hidden/disposal", () => {
    const h = harness(); h.settings.set("sky.time.mode", "now"); h.sky.update(); expect(h.timers.size).toBe(1); const requested = h.request.mock.calls.length; const [id, callback] = [...h.timers][0]; h.timers.delete(id); h.time.hidden = true; callback(); expect(h.request).toHaveBeenCalledTimes(requested);
    h.time.hidden = false; h.sky.update(); expect(h.timers.size).toBe(1); h.sky.dispose(); expect(h.timers.size).toBe(0);
  });
  it("passes the same host cost clock to the ground probe and suppresses late readings and setters", () => {
    const clock = vi.fn(() => 42), dispose = vi.fn();
    const createGroundProbe = vi.fn((_options: import("../src/babylon/createGroundLightProbe.js").GroundLightProbeOptions) => { void _options; return { request: () => true,busy: () => false,dispose }; });
    const h = harness({ clock,createGroundProbe }); h.settings.set("sky.groundLight.mode","rendered");h.sky.update();
    expect(createGroundProbe).toHaveBeenCalledOnce();const options = createGroundProbe.mock.calls[0][0];expect(options.clock).toBe(clock);expect(options.clock()).toBe(42);
    h.sky.dispose();expect(dispose).toHaveBeenCalledOnce();const frames = h.request.mock.calls.length,local = h.setLocalLights.mock.calls.length;
    options.onReading({ rgb: [1,1,1],pixels: 1,latencyMs: 5 });h.sky.setGroundLights([]);h.sky.setGroundLightReceiver(() => Vector3.Zero());h.sky.update();
    expect(h.request).toHaveBeenCalledTimes(frames);expect(h.setLocalLights).toHaveBeenCalledTimes(local);expect(h.sky.getEnvironment()).toBeNull();
  });
  it("marks the actual runtime stale before cleanup and aggregates every native, host and listener failure", () => {
    const failures = Object.fromEntries(["timer", "direct", "ambient", "domeMesh", "domeMaterial", "probe", "night", "terrain", "lighting", "listener", "frame", "unsubscribe", "local", "note"].map(name => [name, new Error(name)]));
    const callbacks = new Map<number, () => void>(); let next = 1; let failing = false;
    const clear = vi.fn((id: number) => { callbacks.delete(id); if (failing) throw failures.timer; });
    const setLighting = vi.fn((value: unknown) => { if (failing && value === null) throw failures.terrain; return true; });
    const setLocalLights = vi.fn(() => { if (failing) throw failures.local; });
    const onLightingChange = vi.fn((active: boolean) => { if (failing && !active) throw failures.lighting; });
    const requestRender = vi.fn(() => { if (failing) throw failures.frame; });
    const probeDispose = vi.fn(() => { throw failures.probe; }), nightDispose = vi.fn(() => { throw failures.night; });
    const createGroundProbe = vi.fn((_options: GroundLightProbeOptions) => { void _options; return { request: () => true, busy: () => false, dispose: probeDispose }; });
    const createNightLights = vi.fn((_options: NightLightsOptions) => { void _options; return { update: () => {}, radianceAt: () => null, getState: () => ({ window: null, pending: null, needed: 0, here: 0, loading: 0, failed: 0, memoryBytes: 0, gpuBytes: 0, downloadedBytes: 0, error: null }), dispose: nightDispose }; });
    let staleSettings: Parameters<SettingsRegistry["subscribe"]>[0] = () => {};
    let detach: () => void = () => {};
    const unsubscribe = vi.fn(() => { throw failures.unsubscribe; });
    const h = harness({ requestRender, onLightingChange, terrain: { setLighting, setLocalLights }, createGroundProbe, createNightLights,
      timers: { set: callback => { const id = next++; callbacks.set(id, callback); return id; }, clear },
    }, settings => {
      const subscribe = settings.subscribe.bind(settings), setNote = settings.setNote.bind(settings);
      vi.spyOn(settings, "subscribe").mockImplementation(listener => { staleSettings = listener; detach = subscribe(listener); return unsubscribe; });
      vi.spyOn(settings, "setNote").mockImplementation((id, note) => { setNote(id, note); if (failing && id === "sky.time.date") throw failures.note; });
    });
    h.settings.setMany({ "sky.model": "dome", "sky.dome.zenithSamples": 8, "sky.dome.azimuthSamples": 8, "sky.dome.integrationSteps": 4, "sky.time.mode": "now", "sky.groundLight.mode": "rendered", "sky.nightLights.mode": "light" });
    h.sky.update(); expect(callbacks.size).toBe(1); expect(createGroundProbe).toHaveBeenCalledOnce(); expect(createNightLights).toHaveBeenCalledOnce();
    const pendingTimer = [...callbacks.values()][0], nativeReleases: Array<{ mock: { calls: unknown[] } }> = [];
    const targets: ReadonlyArray<readonly [{ dispose(): void }, Error]> = [
      [h.scene.getLightByName("sky-sun")!, failures.direct], [h.scene.getLightByName("sky-light")!, failures.ambient],
      [h.scene.getMeshByName("sky-dome")!, failures.domeMesh], [h.scene.getMaterialByName("sky-dome-material")!, failures.domeMaterial],
    ];
    for (const [resource, reason] of targets) {
      const release = resource.dispose.bind(resource);
      const spy = vi.spyOn(resource, "dispose").mockImplementation(() => {
        expect(h.sky.isLighting()).toBe(false); expect(h.sky.getEnvironment()).toBeNull();
        h.sky.update(); release(); throw reason;
      });
      nativeReleases.push(spy);
    }
    const listener = vi.fn((value: unknown) => { if (value === null) throw failures.listener; }), laterListener = vi.fn();
    h.sky.subscribe(listener); h.sky.subscribe(laterListener); failing = true;
    try {
      let caught: unknown;
      try { h.sky.dispose(); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors).toEqual(Object.values(failures));
      for (const release of nativeReleases) expect(release).toHaveBeenCalledOnce();
      expect(probeDispose).toHaveBeenCalledOnce(); expect(nightDispose).toHaveBeenCalledOnce(); expect(unsubscribe).toHaveBeenCalledOnce();
      expect(laterListener).toHaveBeenCalledExactlyOnceWith(null); expect(callbacks.size).toBe(0); expect(h.scene.lights).toHaveLength(0); expect(h.scene.getMeshByName("sky-dome")).toBeNull();
      const frames = requestRender.mock.calls.length, local = setLocalLights.mock.calls.length, lighting = setLighting.mock.calls.length;
      staleSettings(new Set(["sky.model", "sky.time.mode", "sky.exposure.ev100"])); pendingTimer();
      createGroundProbe.mock.calls[0][0].onReading({ rgb: [1, 1, 1], pixels: 1, latencyMs: 5 }); createNightLights.mock.calls[0][0].requestRender();
      h.sky.setGroundLights([]); h.sky.setGroundLightReceiver(() => Vector3.Zero()); h.sky.update(); h.sky.dispose();
      h.settings.set("sky.time.utcHours", 13);
      expect(requestRender).toHaveBeenCalledTimes(frames); expect(setLocalLights).toHaveBeenCalledTimes(local); expect(setLighting).toHaveBeenCalledTimes(lighting);
      expect(h.sky.getEnvironment()).toBeNull(); expect(h.sky.isLighting()).toBe(false); expect(h.sky.getNightLights()).toBeNull(); expect(unsubscribe).toHaveBeenCalledOnce();
    } finally { failing = false; detach(); }
  });
  it("finishes ordinary model-off cleanup after a native failure and can use a fresh resource later", () => {
    const h = harness(); h.sky.update();
    const direct = h.scene.getLightByName("sky-sun")!, release = direct.dispose.bind(direct), failure = new Error("native light release");
    const dispose = vi.spyOn(direct, "dispose").mockImplementation(() => { release(); throw failure; });
    const listener = vi.fn(); h.sky.subscribe(listener); h.settings.set("sky.model", "off");
    expect(() => h.sky.update()).toThrow(AggregateError); expect(dispose).toHaveBeenCalledOnce(); expect(h.scene.lights).toHaveLength(0); expect(h.sky.getEnvironment()).toBeNull(); expect(listener).toHaveBeenCalledExactlyOnceWith(null);
    h.sky.update(); expect(dispose).toHaveBeenCalledOnce(); h.settings.set("sky.model", "lights"); h.sky.update(); expect(h.sky.isLighting()).toBe(true); expect(h.scene.lights).toHaveLength(2);
  });
  it("switches the lamps on where the Sun is low enough, below the viewpoint and on the map, and nowhere between", () => {
    const createNightLights = vi.fn((_options: NightLightsOptions) => { void _options; return { update: () => {}, radianceAt: () => 30.5, getState: () => ({ window: null, pending: null, needed: 0, here: 0, loading: 0, failed: 0, memoryBytes: 0, gpuBytes: 0, downloadedBytes: 0, error: null }), dispose: () => {} }; });
    const h = harness({ createNightLights }, settings => settings.setMany({ "sky.nightLights.mode": "light", "sky.time.utcHours": 18.25 }));
    const show = () => {
      h.sky.update();
      const environment = h.sky.getEnvironment()!;
      const terrain = h.setLighting.mock.calls.at(-1)![0] as { night: { switchSine: number } | null };
      return { environment, night: environment.nightLights!, switchSine: terrain.night!.switchSine };
    };
    // At 0° N 0° E on the equinox the Sun sets at about 18:07 UTC: at 18:15 it is 2° down, at 18:36 about 7°.
    const dusk = show();
    expect(dusk.environment.illumination.geometricElevationDeg).toBeGreaterThan(-3);
    expect(dusk.environment.illumination.geometricElevationDeg).toBeLessThan(-1);
    // 16 lx, where a photocell switches, is twilight with the Sun 5° down; the map's shader gets that height's sine.
    expect(dusk.night.switchSunDeg).toBeCloseTo(-5, 0);
    expect(dusk.switchSine).toBeCloseTo(Math.sin((dusk.night.switchSunDeg! * Math.PI) / 180), 12);
    expect(dusk.night.below).toMatchObject({ radiance: 30.5, on: false });
    // Off, the lamps below send nothing up: the ground's light is the sky's alone.
    expect(dusk.environment.groundLight.luminance).toEqual(dusk.environment.illumination.groundLuminance);
    h.settings.set("sky.time.utcHours", 18.6);
    const night = show();
    expect(night.environment.illumination.geometricElevationDeg).toBeLessThan(-6);
    expect(night.night.below).toMatchObject({ radiance: 30.5, on: true });
    expect(night.environment.groundLight.luminance[1]).toBeGreaterThan(night.environment.illumination.groundLuminance[1] + night.night.below!.luminance * 0.5);
    // A brighter switch, as Britain's 35 lx, switches them on earlier, with the Sun higher.
    h.settings.set("sky.nightLights.switchIlluminance", 35);
    expect(show().night.switchSunDeg).toBeGreaterThan(dusk.night.switchSunDeg! + 0.5);
  });
  it("meters the ground below from orbit, so the night there shows while the viewpoint is still in sunlight", () => {
    // 0° N 0° E on the equinox at 19:00 UTC: the Sun is about 13° down.
    const at = (altMeters: number) => {
      const h = harness({ ecefToGeodetic: () => ({ latRad: 0, lonRad: 0, altMeters }) }, settings => settings.set("sky.time.utcHours", 19));
      h.sky.update();
      return h;
    };
    const orbit = at(400_000), sky = orbit.sky.getEnvironment()!;
    // From 400 km the horizon dips 20°: the viewpoint is in full sunlight, the ground below in nautical twilight.
    expect(sky.illumination.meteredLux).toBeGreaterThan(100_000);
    expect(luminance(sky.illumination.groundIlluminance)).toBeLessThan(0.1);
    expect(sky.meterGroundShare).toBe(1);
    expect(sky.meteredEv100).toBe(ev100ForIlluminance(luminance(sky.illumination.groundIlluminance)));
    // Exposed for the night below, at the metered range's dark end, where an exposure for the sunlit viewpoint was above EV 15.
    expect(sky).toMatchObject({ ev100: 1, exposureHeld: "dark" });
    expect(adaptEv100(ev100ForIlluminance(sky.illumination.meteredLux), ev100ForIlluminance(sky.illumination.zenithMeteredLux), 0.75)).toBeGreaterThan(15);
    const detach = bindSkyReadingsAndNotes({ settings: orbit.settings, sky: orbit.sky });
    expect(orbit.settings.getReading("sky.exposure.groundMeterAltitude")).toContain("At 400 km the meter reads the ground below");
    expect(orbit.settings.getReading("sky.exposure.mode")).toContain("on the ground below");
    detach();
    // Halfway up the default 20 to 100 km, halfway in stops.
    const middle = at(60_000).sky.getEnvironment()!;
    expect(middle.meterGroundShare).toBeCloseTo(0.5, 12);
    expect(middle.meteredEv100).toBeCloseTo((ev100ForIlluminance(middle.illumination.meteredLux) + ev100ForIlluminance(luminance(middle.illumination.groundIlluminance))) / 2, 12);
    // Near the ground the meter reads the viewpoint's light, as it always has; the heights are the user's, and only show it again.
    const low = at(500), near = low.sky.getEnvironment()!;
    expect(near.meterGroundShare).toBe(0);
    expect(near.meteredEv100).toBe(ev100ForIlluminance(near.illumination.meteredLux));
    const computations = near.cost.computations;
    low.settings.set("sky.exposure.groundMeterAltitude", { min: 0, max: 0 });
    low.sky.update();
    expect(low.sky.getEnvironment()).toMatchObject({ meterGroundShare: 1, meteredEv100: ev100ForIlluminance(luminance(near.illumination.groundIlluminance)) });
    expect(low.sky.getEnvironment()!.cost.computations).toBe(computations);
  });
});
