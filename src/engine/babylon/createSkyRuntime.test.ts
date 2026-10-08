// @vitest-environment jsdom

import { FreeCamera, Matrix, NullEngine, Scene, StandardMaterial, Vector3, VertexBuffer, type DirectionalLight, type HemisphericLight, type Mesh } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEG_TO_RAD, geodeticToEcef } from "../../camera/cameraMath";
import { FOSS_EARTH_PARAMETERS } from "../../settings/catalogue";
import { createSettingsRegistry, type SettingsRegistry } from "../../settings/registry";
import { ev100ForIlluminance, luminance, whiteLuminanceForEv100 } from "../../sky/skyState";
import { solarPosition } from "../../sky/solarPosition";
import { blackBodyTint, type StarCatalogue } from "../../sky/stars";
import type { GroundLightProbe, GroundLightProbeOptions } from "./createGroundLightProbe";
import type { NightLights, NightLightsOptions, NightLightsState, NightLightsView } from "./createNightLights";
import { createSkyRuntime, type SkyRuntime, type SkyTimers } from "./createSkyRuntime";
import { getTerrainLighting, getTerrainLocalLights, terrainLightFactor, TerrainLightMaterialPlugin } from "./imagery/terrainLightPlugin";

const MINNEAPOLIS = { latDeg: 44.977753, lonDeg: -93.265011 };
/** Early afternoon and the middle of the night in Minneapolis on 7 October 2026. */
const AFTERNOON = { "sky.time.mode": "fixed", "sky.time.date": "2026-10-07", "sky.time.utcHours": 19 } as const;
const NIGHT = { "sky.time.mode": "fixed", "sky.time.date": "2026-10-08", "sky.time.utcHours": 6 } as const;
/** A full Moon 62° up over Minneapolis, the Sun 57° down. */
const FULL_MOON = { "sky.time.mode": "fixed", "sky.time.date": "2026-10-26", "sky.time.utcHours": 6 } as const;
/** Civil twilight, the Sun 2° down, and a first-quarter Moon 20° up. */
const DUSK = { "sky.time.mode": "fixed", "sky.time.date": "2026-10-18", "sky.time.utcHours": 23.5 } as const;
/**
 * The sky as it was before the Moon, the stars and adaptation, which the
 * first tests keep so their numbers stay the model's alone; later tests turn
 * each on.
 */
const PLAIN = { "sky.moon.mode": "off", "sky.stars.mode": "off", "sky.exposure.adaptation": 1, "sky.groundLight.mode": "uniform", "sky.nightLights.mode": "off" } as const;
/** The Moon's disc's vertices, after the Sun's 21. */
const MOON_DISC_VERTICES = 1 + 6 * 24;

interface HarnessOptions {
  world?: Matrix | null;
  loadStars?: () => Promise<StarCatalogue>;
  probe?: (options: GroundLightProbeOptions) => GroundLightProbe;
  nightLights?: (options: NightLightsOptions) => NightLights;
}

/** Night lights that hold one radiance everywhere, nW/(cm² sr), and record what they are asked. */
function fakeNightLights(radiance: { value: number | null }) {
  const made: Array<{ options: NightLightsOptions; views: NightLightsView[]; disposed: boolean }> = [];
  const state: NightLightsState = {
    window: { zoom: 8, x: 61, y: 92, tiles: 8 }, pending: null, needed: 12, here: 12, loading: 0, failed: 0,
    memoryBytes: 12 * 65_536, gpuBytes: 16 * 1_048_576, downloadedBytes: 300_000, error: null,
  };
  const create = (options: NightLightsOptions): NightLights => {
    const record = { options, views: [] as NightLightsView[], disposed: false };
    made.push(record);
    return {
      update: view => { record.views.push(view); },
      radianceAt: () => radiance.value,
      getState: () => state,
      dispose: () => { record.disposed = true; },
    };
  };
  return { made, state, create };
}

interface Harness {
  scene: Scene;
  camera: FreeCamera;
  settings: SettingsRegistry;
  sky: SkyRuntime;
  requestRender: ReturnType<typeof vi.fn>;
  onLightingChange: ReturnType<typeof vi.fn>;
  timers: Array<{ id: number; callback: () => void; delayMs: number }>;
  /** The clock's UTC, whether the page is hidden, and the clock costs and intervals are measured with, ms. */
  clock: { utcMs: number; hidden: boolean; ms: number };
  /** Puts the camera at a place, in the scene's coordinates. */
  place(latDeg: number, lonDeg: number, altitudeMeters: number): void;
  sun(): DirectionalLight;
  fill(): HemisphericLight;
  dome(): Mesh;
}

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function harness(values: Record<string, string | number | boolean | { min: number; max: number }>, world: Matrix | null = null, extra: HarnessOptions = {}): Harness {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", Vector3.Zero(), scene);
  scene.activeCamera = camera;
  const settings = createSettingsRegistry({ storage: null });
  settings.register(FOSS_EARTH_PARAMETERS);
  settings.setMany({ ...PLAIN, ...values });
  const requestRender = vi.fn();
  const onLightingChange = vi.fn();
  const timers: Harness["timers"] = [];
  const clock = { utcMs: Date.UTC(2026, 9, 7, 19, 0), hidden: false, ms: 0 };
  let nextTimer = 1;
  const skyTimers: SkyTimers = {
    set: (callback, delayMs) => { timers.push({ id: nextTimer, callback, delayMs }); return nextTimer++; },
    clear: id => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); },
  };
  const sky = createSkyRuntime({
    scene, settings, getWorldMatrix: () => world, requestRender, onLightingChange,
    now: () => clock.utcMs, clock: () => clock.ms, timers: skyTimers, isHidden: () => clock.hidden,
    loadStars: extra.loadStars, createGroundProbe: extra.probe, createNightLights: extra.nightLights,
  });
  return {
    scene, camera, settings, sky, requestRender, onLightingChange, timers, clock,
    place(latDeg, lonDeg, altitudeMeters) {
      const { x, y, z } = geodeticToEcef(latDeg * DEG_TO_RAD, lonDeg * DEG_TO_RAD, altitudeMeters);
      const ecef = new Vector3(x, y, z);
      camera.position.copyFrom(world ? Vector3.TransformCoordinates(ecef, world) : ecef);
      camera.getViewMatrix(true);
    },
    sun: () => scene.getLightByName("sky-sun") as DirectionalLight,
    fill: () => scene.getLightByName("sky-light") as HemisphericLight,
    dome: () => scene.getMeshByName("sky-dome") as Mesh,
  };
}

describe("sky runtime", () => {
  it("is on unless turned off, and off is nothing in the scene, nothing computed, no frame requested", () => {
    expect(FOSS_EARTH_PARAMETERS.find(spec => spec.id === "sky.model")!.default).toBe("dome");
    const h = harness({ "sky.model": "off" });
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    const background = h.scene.clearColor;
    h.sky.update();
    expect(h.sky.getEnvironment()).toBeNull();
    expect(h.sky.isLighting()).toBe(false);
    expect(h.scene.lights).toHaveLength(0);
    expect(h.scene.meshes).toHaveLength(0);
    expect(h.scene.clearColor).toBe(background);
    expect(h.onLightingChange).not.toHaveBeenCalled();
    expect(h.requestRender).not.toHaveBeenCalled();
    expect(h.timers).toHaveLength(0);
    // A setting of the sky changed while it is off draws nothing.
    h.settings.set("sky.atmosphere.aerosolOpticalDepth", 0.3);
    expect(h.requestRender).not.toHaveBeenCalled();
  });

  it("lights the scene with the Sun and the sky in photometric units, at the exposure in use", () => {
    const h = harness({ ...AFTERNOON, "sky.model": "lights" });
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    h.sky.update();
    const sky = h.sky.getEnvironment()!;
    expect(sky.model).toBe("lights");
    expect(h.onLightingChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.scene.meshes).toHaveLength(0);

    // The Sun stands where the solar position algorithm puts it for this place and instant.
    const expected = solarPosition({ utcMs: Date.UTC(2026, 9, 7, 19, 0), ...MINNEAPOLIS, elevationMeters: 300 });
    expect(sky.illumination.geometricElevationDeg).toBeCloseTo(expected.elevationDeg, 3);
    expect(sky.illumination.sunAzimuthDeg).toBeCloseTo(expected.azimuthDeg, 2);
    const direction = h.sun().direction;
    expect(direction.length()).toBeCloseTo(1, 9);
    for (const [index, axis] of (["x", "y", "z"] as const).entries()) expect(direction[axis]).toBeCloseTo(-sky.illumination.sunDirection[index], 9);

    // Metered: EV = log2(0.4 E) for the light at the viewpoint, and white is 1.2 × 2^EV cd/m².
    expect(sky.exposureHeld).toBeNull();
    expect(sky.ev100).toBeCloseTo(Math.log2(0.4 * sky.illumination.meteredLux), 9);
    expect(sky.ev100).toBeGreaterThan(14);
    expect(sky.whiteLuminance).toBeCloseTo(whiteLuminanceForEv100(sky.ev100), 6);

    // The Sun's intensity is its illuminance over the white luminance: a white matt surface facing it,
    // which a PBR material shows at intensity / π, has the luminance ρ E / π.
    const sun = h.sun();
    const peak = Math.max(...sky.illumination.sunIlluminance);
    expect(sun.intensity * sky.whiteLuminance).toBeCloseTo(peak, 6);
    expect(sun.diffuse.g * peak).toBeCloseTo(sky.illumination.sunIlluminance[1], 6);
    expect(luminance(sky.illumination.sunIlluminance)).toBeGreaterThan(70_000);
    // The sky's light on a level surface, E, as the radiance E / π a hemispheric light's colour is; none of it a highlight.
    const fill = h.fill();
    expect(fill.intensity).toBe(1);
    expect(fill.diffuse.b * sky.whiteLuminance * Math.PI).toBeCloseTo(sky.illumination.skyIlluminance[2], 6);
    expect(fill.groundColor.g * sky.whiteLuminance).toBeCloseTo(sky.illumination.groundLuminance[1], 6);
    expect(fill.specular.equalsFloats(0, 0, 0)).toBe(true);
    const up = sky.illumination.observer.up;
    expect(fill.direction.x).toBeCloseTo(up[0], 9);
    expect(fill.direction.z).toBeCloseTo(up[2], 9);
    // With nothing drawn, the background is the sky's mean luminance, display-encoded.
    expect(h.scene.clearColor.b).toBeCloseTo(Math.min(1, fill.diffuse.b) ** (1 / 2.2), 9);
    expect(h.scene.clearColor.b).toBeGreaterThan(h.scene.clearColor.r);
  });

  it("draws the sky as one unlit mesh behind everything, its colours the sky's luminance over white", () => {
    const h = harness({ ...AFTERNOON, "sky.model": "dome", "sky.dome.zenithSamples": 16, "sky.dome.azimuthSamples": 12 });
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    h.sky.update();
    const sky = h.sky.getEnvironment()!;
    const dome = h.dome();
    expect(h.scene.meshes).toEqual([dome]);
    expect(dome.infiniteDistance).toBe(true);
    expect(dome.ignoreCameraMaxZ).toBe(true);
    expect(dome.alwaysSelectAsActiveMesh).toBe(true);
    expect(dome.isPickable).toBe(false);
    // Unlit, with no texture: the map imagery's own kind of material, and nothing a PBR material brings with it.
    const material = dome.material as StandardMaterial;
    expect(material).toBeInstanceOf(StandardMaterial);
    expect(material.disableLighting).toBe(true);
    expect(material.emissiveColor.equalsFloats(1, 1, 1)).toBe(true);
    expect(material.disableDepthWrite).toBe(true);
    expect(material.backFaceCulling).toBe(false);
    expect(h.scene.textures).toHaveLength(0);

    const rows = 16 + 1 + 9;
    const vertices = rows * 24 + 21 + MOON_DISC_VERTICES;
    expect(dome.getTotalVertices()).toBe(vertices);
    expect(sky.cost.domeVertices).toBe(vertices);
    expect(sky.cost.domeSamples).toBe(rows * 13 + 1);
    const colors = dome.getVerticesData(VertexBuffer.ColorKind)!;
    const positions = dome.getVerticesData(VertexBuffer.PositionKind)!;
    expect(colors).toHaveLength(vertices * 4);
    // The first vertex is the zenith: blue, and under white at this exposure.
    expect(Math.hypot(positions[0], positions[1], positions[2])).toBeCloseTo(1e10, -4);
    expect(positions[1]).toBeGreaterThan(0.999e10);
    expect(colors[2]).toBeGreaterThan(colors[0]);
    expect(colors[2]).toBeLessThan(1);
    expect(colors[3]).toBe(1);
    // Colours are display-encoded, as the material holds them: the zenith's is its luminance over white.
    expect(colors[1] ** 2.2 * sky.whiteLuminance).toBeGreaterThan(500);
    expect(colors[1] ** 2.2 * sky.whiteLuminance).toBeLessThan(5_000);
    // The Sun's disc follows the sky's grid: tens of thousands of times white.
    expect(colors[(rows * 24 + 20) * 4 + 1] ** 2.2).toBeGreaterThan(10_000);
    // With the Moon off its disc is folded to a point straight down, and dark.
    expect(positions[(vertices - 1) * 3 + 1]).toBeCloseTo(-1e10, -4);
    expect(colors[(vertices - 1) * 4 + 1]).toBe(0);
    // The dome's up is the place's up, and its +X the Sun's bearing along the ground.
    const world = dome.computeWorldMatrix(true);
    const up = Vector3.TransformNormal(new Vector3(0, 1, 0), world);
    const forward = Vector3.TransformNormal(new Vector3(1, 0, 0), world);
    const expectedUp = sky.illumination.observer.up;
    const expectedForward = sky.illumination.sunHorizontal;
    for (const [index, axis] of (["x", "y", "z"] as const).entries()) {
      expect(up[axis]).toBeCloseTo(expectedUp[index], 6);
      expect(forward[axis]).toBeCloseTo(expectedForward[index], 6);
    }
  });

  it("computes once and then nothing while nothing has moved", () => {
    const h = harness({ ...AFTERNOON, "sky.model": "dome" });
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    const listener = vi.fn();
    h.sky.subscribe(listener);
    for (let frame = 0; frame < 20; frame++) h.sky.update();
    expect(h.sky.getEnvironment()!.cost.computations).toBe(1);
    expect(listener).toHaveBeenCalledOnce();
    expect(h.onLightingChange).toHaveBeenCalledOnce();
    // A set time has no clock to follow: the scene settles.
    expect(h.timers).toHaveLength(0);
    expect(h.requestRender).not.toHaveBeenCalled();
  });

  it("follows travel and height past the declared steps, and no sooner", () => {
    const h = harness({ ...AFTERNOON, "sky.model": "lights" });
    const computations = (): number => h.sky.getEnvironment()!.cost.computations;
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    h.sky.update();
    // 0.02° of longitude moves the Sun 0.014° in this sky: under the 0.05° step.
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg + 0.02, 300);
    h.sky.update();
    expect(computations()).toBe(1);
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg + 0.2, 300);
    h.sky.update();
    expect(computations()).toBe(2);
    // 10 m of climb thins the haze by 0.8%; 100 m by 8%, past the 2% step.
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg + 0.2, 310);
    h.sky.update();
    expect(computations()).toBe(2);
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg + 0.2, 400);
    h.sky.update();
    expect(computations()).toBe(3);
    // A coarser step is a parameter.
    h.settings.set("sky.update.densityChange", 0.5);
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg + 0.2, 700);
    h.sky.update();
    expect(computations()).toBe(3);
  });

  it("follows the clock at the declared step, asks for one frame each time, and stops when hidden, set or off", () => {
    const h = harness({ "sky.time.mode": "now", "sky.model": "lights" });
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    h.sky.update();
    // The Sun crosses the 0.05° step in twelve seconds.
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].delayMs).toBeCloseTo(12_000, 6);
    expect(h.requestRender).not.toHaveBeenCalled();
    // Frames drawn meanwhile for other reasons compute nothing.
    h.clock.utcMs += 5_000;
    h.sky.update();
    expect(h.sky.getEnvironment()!.cost.computations).toBe(1);
    expect(h.timers).toHaveLength(1);
    h.clock.utcMs += 7_000;
    h.timers.shift()!.callback();
    expect(h.requestRender).toHaveBeenCalledOnce();
    const before = h.sky.getEnvironment()!.illumination.sunAzimuthDeg;
    h.sky.update();
    expect(h.sky.getEnvironment()!.cost.computations).toBe(2);
    expect(h.sky.getEnvironment()!.illumination.sunAzimuthDeg).not.toBe(before);
    expect(h.timers).toHaveLength(1);
    // A hidden page is not drawn for: the timer ends, and the frame its return draws starts it again.
    h.clock.hidden = true;
    h.requestRender.mockClear();
    h.timers.shift()!.callback();
    expect(h.requestRender).not.toHaveBeenCalled();
    h.sky.update();
    expect(h.timers).toHaveLength(0);
    h.clock.hidden = false;
    h.sky.update();
    expect(h.timers).toHaveLength(1);
    // A coarser step is a slower clock; a set time and a sky turned off have none.
    h.settings.set("sky.update.sunAngle", 0.5);
    h.sky.update();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].delayMs).toBeCloseTo(120_000, 6);
    h.settings.set("sky.time.mode", "fixed");
    expect(h.timers).toHaveLength(0);
    h.sky.update();
    expect(h.timers).toHaveLength(0);
    h.settings.setMany({ "sky.time.mode": "now" });
    h.sky.update();
    expect(h.timers).toHaveLength(1);
    h.settings.set("sky.model", "off");
    expect(h.timers).toHaveLength(0);
  });

  it("is the same sky through a floating origin: the scene's axes turned and moved change nothing but directions", () => {
    const direct = harness({ ...AFTERNOON, "sky.model": "dome", "sky.dome.zenithSamples": 12, "sky.dome.azimuthSamples": 8 });
    direct.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 9_000);
    direct.sky.update();
    // A scene whose origin rides with an aircraft and whose axes are not the Earth's, mirrored as Babylon's are.
    const origin = geodeticToEcef(MINNEAPOLIS.latDeg * DEG_TO_RAD, MINNEAPOLIS.lonDeg * DEG_TO_RAD, 8_950);
    const world = Matrix.Translation(-origin.x, -origin.y, -origin.z)
      .multiply(Matrix.RotationYawPitchRoll(0.7, -1.1, 2.3))
      .multiply(Matrix.Scaling(1, 1, -1));
    const moved = harness({ ...AFTERNOON, "sky.model": "dome", "sky.dome.zenithSamples": 12, "sky.dome.azimuthSamples": 8 }, world);
    moved.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 9_000);
    expect(moved.camera.position.length()).toBeLessThan(100);
    moved.sky.update();
    const a = direct.sky.getEnvironment()!;
    const b = moved.sky.getEnvironment()!;
    expect(b.illumination.sunElevationDeg).toBeCloseTo(a.illumination.sunElevationDeg, 4);
    expect(b.illumination.meteredLux / a.illumination.meteredLux).toBeCloseTo(1, 4);
    expect(b.ev100).toBeCloseTo(a.ev100, 4);
    expect(moved.sun().intensity / direct.sun().intensity).toBeCloseTo(1, 4);
    // Directions follow the scene's axes.
    const expected = Vector3.TransformNormal(direct.sun().direction, world);
    expect(Vector3.Dot(moved.sun().direction, expected)).toBeCloseTo(1, 6);
    const up = Vector3.TransformNormal(new Vector3(...a.illumination.observer.up), world);
    expect(Vector3.Dot(moved.fill().direction, up)).toBeCloseTo(1, 6);
    const domeUp = Vector3.TransformNormal(new Vector3(0, 1, 0), moved.dome().computeWorldMatrix(true));
    expect(Vector3.Dot(domeUp, up)).toBeCloseTo(1, 6);
    // The Sun's disc on the dome points at the Sun, in either scene.
    for (const h of [direct, moved]) {
      const dome = h.dome();
      const positions = dome.getVerticesData(VertexBuffer.PositionKind)!;
      const centre = (dome.getTotalVertices() - MOON_DISC_VERTICES - 21) * 3;
      const local = new Vector3(positions[centre], positions[centre + 1], positions[centre + 2]).normalize();
      const toSun = Vector3.TransformNormal(local, dome.computeWorldMatrix(true)).normalize();
      expect(Vector3.Dot(toSun, h.sun().direction.scale(-1))).toBeCloseTo(1, 5);
    }
  });

  it("changes exposure without touching the light: the same lux, shown against another white", () => {
    const h = harness({ ...AFTERNOON, "sky.model": "dome", "sky.dome.zenithSamples": 12, "sky.dome.azimuthSamples": 8 });
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    h.sky.update();
    const metered = h.sky.getEnvironment()!;
    const intensity = h.sun().intensity;
    const zenith = h.dome().getVerticesData(VertexBuffer.ColorKind)![1];
    h.settings.setMany({ "sky.exposure.mode": "fixed", "sky.exposure.ev100": 9.7 });
    expect(h.requestRender).toHaveBeenCalledOnce();
    h.sky.update();
    const fixed = h.sky.getEnvironment()!;
    // White at 1,000 cd/m², the reference used before exposure was calibrated.
    expect(fixed.whiteLuminance).toBeCloseTo(998.1, 0);
    expect(fixed.meteredEv100).toBe(metered.meteredEv100);
    expect(fixed.illumination).toBe(metered.illumination);
    expect(fixed.cost.computations).toBe(1);
    const brighter = metered.whiteLuminance / fixed.whiteLuminance;
    expect(h.sun().intensity / intensity).toBeCloseTo(brighter, 6);
    expect((h.dome().getVerticesData(VertexBuffer.ColorKind)![1] / zenith) ** 2.2 / brighter).toBeCloseTo(1, 5);
    // Compensation is the shared image processing's: the lights are as they were, the background follows.
    const background = h.scene.clearColor.clone();
    const sun = h.sun().intensity;
    h.settings.setMany({ "sky.exposure.mode": "metered", "renderer.exposureEV": -3 });
    h.sky.update();
    expect(h.sky.getEnvironment()!.ev100).toBe(metered.ev100);
    expect(h.sun().intensity).toBeCloseTo(intensity, 9);
    expect(sun).not.toBe(intensity);
    expect(h.scene.clearColor.g).toBeLessThan(background.g);
    expect(h.sky.getEnvironment()!.cost.computations).toBe(1);
  });

  it("is night at night: no Sun, the meter held at its darkest, the ground black and a dull red glow still in range", () => {
    const h = harness({ ...NIGHT, "sky.model": "dome", "sky.dome.zenithSamples": 12, "sky.dome.azimuthSamples": 8 });
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    new TerrainLightMaterialPlugin(new StandardMaterial("terrain", h.scene));
    h.sky.update();
    const sky = h.sky.getEnvironment()!;
    expect(sky.illumination.sunElevationDeg).toBeLessThan(-40);
    expect(h.sun().intensity).toBe(0);
    expect(h.sun().isEnabled()).toBe(true);
    // 0.0006 lux from the night sky alone: far below the range, so the exposure stays at its lower end.
    expect(sky.illumination.meteredLux).toBeCloseTo(Math.PI * 2e-4, 9);
    expect(sky.exposureHeld).toBe("dark");
    expect(sky.ev100).toBe(1);
    expect(sky.whiteLuminance).toBeCloseTo(2.4, 9);
    // The ground, as 2D imagery, is shown at about a ten-thousandth of its own value: black.
    expect(luminance(sky.surfaceFactor!)).toBeLessThan(2e-4);
    const terrain = getTerrainLighting(h.scene)!;
    expect(terrain.perPoint).toBe(true);
    // Per point the Sun 50° down gives nothing; the model's own table keeps a trace of twilight there, a few thousandths of the night sky's.
    expect(terrainLightFactor(terrain, [], [h.camera.position.x, h.camera.position.y, h.camera.position.z])[1] / sky.surfaceFactor![1]).toBeCloseTo(1, 2);
    expect(h.fill().diffuse.g).toBeLessThan(1e-4);
    expect(Math.max(h.scene.clearColor.r, h.scene.clearColor.g, h.scene.clearColor.b)).toBeLessThan(0.03);
    // An emitter of 1 cd/m², such as metal glowing dull red near 1,000 K, writes 0.42: plainly visible.
    expect(1 / sky.whiteLuminance).toBeCloseTo(0.4167, 4);
    // The setting found by hand before there was a sky, +8.8 EV on a 1,000 cd/m² reference, is the same exposure to within a stop.
    expect(Math.abs(Math.log2(sky.whiteLuminance / (1000 / 2 ** 8.8)))).toBeLessThan(0.2);
    // No night sky at all is darker still, and stays finite.
    h.settings.set("sky.night.luminance", 0.00001);
    h.sky.update();
    expect(h.sky.getEnvironment()!.illumination.meteredLux).toBeCloseTo(Math.PI * 1e-5, 12);
  });

  it("shows 2D imagery by daylight, by the light below the viewpoint, or as photographed, and never when the sky is off", () => {
    const h = harness({ ...AFTERNOON, "sky.model": "lights" });
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    h.sky.update();
    const sky = h.sky.getEnvironment()!;
    // Reflectance 1.5 × the image, under the light on level ground: L = ρ E / π, over white.
    const expected = (1.5 * sky.illumination.groundIlluminance[1]) / Math.PI / sky.whiteLuminance;
    expect(sky.surfaceFactor![1]).toBeCloseTo(expected, 9);
    // Early afternoon in October, metered for a surface facing the Sun: level ground is somewhat under its own value.
    expect(luminance(sky.surfaceFactor!)).toBeGreaterThan(0.4);
    expect(luminance(sky.surfaceFactor!)).toBeLessThan(1);
    // Per point, the shader's table gives the same light below the viewpoint, within its interpolation.
    const here: [number, number, number] = [h.camera.position.x, h.camera.position.y, h.camera.position.z];
    const terrain = getTerrainLighting(h.scene)!;
    expect(terrain.perPoint).toBe(true);
    expect(terrainLightFactor(terrain, [], here)[1] / expected).toBeCloseTo(1, 2);
    h.settings.set("sky.surface.albedoScale", 3);
    h.sky.update();
    expect(h.sky.getEnvironment()!.surfaceFactor![1]).toBeCloseTo(expected * 2, 9);
    expect(h.sky.getEnvironment()!.cost.computations).toBe(1);
    // As at the viewpoint, which an application may offer: one factor everywhere.
    h.settings.setChoices("sky.surface.lighting", [
      ...FOSS_EARTH_PARAMETERS.find(spec => spec.id === "sky.surface.lighting")!.choices!, { id: "viewpoint", label: "As at the viewpoint" },
    ]);
    h.settings.set("sky.surface.lighting", "viewpoint");
    h.sky.update();
    const single = getTerrainLighting(h.scene)!;
    expect(single.perPoint).toBe(false);
    expect(single.ambient[1]).toBeCloseTo(expected * 2, 9);
    h.settings.set("sky.surface.lighting", "photograph");
    h.sky.update();
    expect(h.sky.getEnvironment()!.surfaceFactor).toBeNull();
    expect(getTerrainLighting(h.scene)).toBeNull();
    h.settings.set("sky.surface.lighting", "daylight");
    h.sky.update();
    expect(getTerrainLighting(h.scene)).not.toBeNull();
    h.settings.set("sky.model", "off");
    h.sky.update();
    expect(getTerrainLighting(h.scene)).toBeNull();
  });

  it("lights each point of the planet by its own Sun: day, twilight and night where they are", () => {
    const h = harness({ ...AFTERNOON, "sky.model": "lights" });
    // From 20,000 km over Minneapolis the whole of one side of the Earth is in view.
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 20_000_000);
    h.sky.update();
    const terrain = getTerrainLighting(h.scene)!;
    const at = (latDeg: number, lonDeg: number): number => {
      const { x, y, z } = geodeticToEcef(latDeg * DEG_TO_RAD, lonDeg * DEG_TO_RAD, 0);
      return luminance(terrainLightFactor(terrain, [], [x, y, z]));
    };
    const sun = h.sky.getEnvironment()!.illumination;
    // Under the Sun: full daylight. On the far side of the Earth: the night sky alone, a ten-thousandth of it.
    const noon = at(sun.observer.latDeg - 30, sun.observer.lonDeg + 30);
    expect(noon).toBeGreaterThan(0.5);
    expect(at(-MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg + 180) / noon).toBeLessThan(1e-4);
    // Across the terminator the light falls by orders of magnitude, smoothly: no step bigger than the twilight's own.
    const samples = Array.from({ length: 61 }, (_, index) => at(0, MINNEAPOLIS.lonDeg + 60 + index));
    expect(samples[0]).toBeGreaterThan(samples[60] * 1e3);
    for (let index = 1; index < samples.length; index++) expect(samples[index] / samples[index - 1]).toBeGreaterThan(0.2);
    // As at the viewpoint, it would all be one: this view's own.
    h.settings.setChoices("sky.surface.lighting", [{ id: "daylight", label: "By daylight" }, { id: "viewpoint", label: "As at the viewpoint" }]);
    h.settings.set("sky.surface.lighting", "viewpoint");
    h.sky.update();
    const single = getTerrainLighting(h.scene)!;
    expect(terrainLightFactor(single, [], [0, 0, 6.4e6])).toEqual(terrainLightFactor(single, [], [6.4e6, 0, 0]));
  });

  it("lights a full-Moon night with the Moon: its light, its disc with its phase, and the moonlit sky", () => {
    const h = harness({ ...FULL_MOON, "sky.model": "dome", "sky.dome.zenithSamples": 12, "sky.dome.azimuthSamples": 8, "sky.moon.mode": "sky" });
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    h.sky.update();
    const sky = h.sky.getEnvironment()!;
    const moon = sky.illumination.moon!;
    expect(moon.elevationDeg).toBeGreaterThan(60);
    expect(moon.view.illuminatedFraction).toBeGreaterThan(0.99);
    // About a quarter of a lux through the air: a few hundred times the night sky's, and it lights the scene.
    expect(luminance(moon.directIlluminance)).toBeGreaterThan(0.2);
    expect(luminance(moon.directIlluminance)).toBeLessThan(0.35);
    expect(sky.direct).toBe("moon");
    const light = h.sun();
    expect(light.intensity * sky.whiteLuminance).toBeCloseTo(Math.max(...moon.directIlluminance), 6);
    for (const [index, axis] of (["x", "y", "z"] as const).entries()) expect(light.direction[axis]).toBeCloseTo(-moon.direction[index], 9);
    // Moonlight is redder than sunlight.
    expect(light.diffuse.r).toBeGreaterThan(light.diffuse.b);
    // The meter reads it, and the moonlit sky adds to the sky's light.
    expect(sky.illumination.meteredLux).toBeGreaterThan(0.2);
    expect(luminance(sky.illumination.skyIlluminance)).toBeGreaterThan(Math.PI * 2e-4 * 10);
    expect(sky.cost.moonSamples).toBe((12 + 1 + 9) * 16);
    // The ground under it, per point: the Moon's scale on the table.
    const terrain = getTerrainLighting(h.scene)!;
    expect(luminance(terrain.moonScale)).toBeGreaterThan(0);
    expect(terrainLightFactor(terrain, [], [h.camera.position.x, h.camera.position.y, h.camera.position.z])[1] / sky.surfaceFactor![1]).toBeCloseTo(1, 1);
    // Its disc on the dome points at it, and is thousands of times white at this exposure.
    const dome = h.dome();
    const positions = dome.getVerticesData(VertexBuffer.PositionKind)!;
    const colors = dome.getVerticesData(VertexBuffer.ColorKind)!;
    const centre = dome.getTotalVertices() - MOON_DISC_VERTICES;
    const toMoon = Vector3.TransformNormal(new Vector3(positions[centre * 3], positions[centre * 3 + 1], positions[centre * 3 + 2]).normalize(), dome.computeWorldMatrix(true));
    expect(Vector3.Dot(toMoon, new Vector3(...moon.direction))).toBeCloseTo(1, 6);
    expect(colors[centre * 4 + 1] ** 2.2).toBeGreaterThan(100);
    // Off, it is the night as before.
    h.settings.set("sky.moon.mode", "off");
    h.sky.update();
    expect(h.sky.getEnvironment()!.illumination.moon).toBeNull();
    expect(h.sky.getEnvironment()!.direct).toBeNull();
    expect(h.sky.getEnvironment()!.illumination.meteredLux).toBeCloseTo(Math.PI * 2e-4, 9);
  });

  it("draws the Moon's phase and the moonlit sky only when it matters, in a mirrored world as well", () => {
    const origin = geodeticToEcef(MINNEAPOLIS.latDeg * DEG_TO_RAD, MINNEAPOLIS.lonDeg * DEG_TO_RAD, 250);
    const world = Matrix.Translation(-origin.x, -origin.y, -origin.z).multiply(Matrix.RotationYawPitchRoll(0.7, -1.1, 2.3)).multiply(Matrix.Scaling(1, 1, -1));
    for (const scene of [null, world]) {
      const h = harness({ ...DUSK, "sky.model": "dome", "sky.dome.zenithSamples": 12, "sky.dome.azimuthSamples": 8, "sky.moon.mode": "sky" }, scene);
      h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
      h.sky.update();
      const sky = h.sky.getEnvironment()!;
      const moon = sky.illumination.moon!;
      // A first quarter in civil twilight: the sunlit sky is far brighter than the moonlit, which is left out.
      expect(moon.view.illuminatedFraction).toBeGreaterThan(0.45);
      expect(moon.view.illuminatedFraction).toBeLessThan(0.6);
      expect(sky.cost.moonSamples).toBe(0);
      expect(sky.direct).toBe("moon");
      // The disc points at the Moon through any world, and its lit half faces the Sun.
      const dome = h.dome();
      const positions = dome.getVerticesData(VertexBuffer.PositionKind)!;
      const colors = dome.getVerticesData(VertexBuffer.ColorKind)!;
      const worldMatrix = dome.computeWorldMatrix(true);
      const start = dome.getTotalVertices() - MOON_DISC_VERTICES;
      const direction = (vertex: number): Vector3 => Vector3.TransformNormal(new Vector3(positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]), worldMatrix).normalize();
      const toScene = (v: readonly number[]): Vector3 => (scene ? Vector3.TransformNormal(new Vector3(v[0], v[1], v[2]), scene) : new Vector3(v[0], v[1], v[2])).normalize();
      expect(Vector3.Dot(direction(start), toScene(moon.direction))).toBeCloseTo(1, 6);
      const sun = toScene(sky.illumination.sunDirection);
      const rim = Array.from({ length: 24 }, (_, index) => start + 1 + 5 * 24 + index);
      const towardsSun = rim.reduce((best, vertex) => (Vector3.Dot(direction(vertex), sun) > Vector3.Dot(direction(best), sun) ? vertex : best));
      const awayFromSun = rim.reduce((best, vertex) => (Vector3.Dot(direction(vertex), sun) < Vector3.Dot(direction(best), sun) ? vertex : best));
      expect(colors[towardsSun * 4 + 1]).toBeGreaterThan(colors[awayFromSun * 4 + 1] * 3);
    }
  });

  it("keeps dusk darker than noon by the adaptation, within the meter's range", () => {
    const noon = harness({ ...AFTERNOON, "sky.model": "lights", "sky.exposure.adaptation": 0.75 });
    noon.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    noon.sky.update();
    const day = noon.sky.getEnvironment()!;
    const zenith = ev100ForIlluminance(day.illumination.zenithMeteredLux);
    // A high Sun's light is the anchor: within a stop of it the adaptation barely shows.
    expect(zenith).toBeGreaterThan(day.meteredEv100);
    expect(day.ev100 - day.meteredEv100).toBeLessThan(0.5);
    const h = harness({ ...DUSK, "sky.model": "lights", "sky.exposure.adaptation": 1 });
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    h.sky.update();
    const full = h.sky.getEnvironment()!;
    expect(full.ev100).toBeCloseTo(full.meteredEv100, 9);
    h.settings.set("sky.exposure.adaptation", 0.75);
    h.sky.update();
    const adapted = h.sky.getEnvironment()!;
    const anchor = ev100ForIlluminance(adapted.illumination.zenithMeteredLux);
    expect(adapted.adaptedEv100).toBeCloseTo(anchor - 0.75 * (anchor - adapted.meteredEv100), 9);
    expect(adapted.ev100).toBe(adapted.adaptedEv100);
    // The same light is shown darker: the whole scene by the same factor, nothing recomputed.
    expect(adapted.whiteLuminance / full.whiteLuminance).toBeCloseTo(2 ** (adapted.ev100 - full.ev100), 9);
    expect(adapted.ev100 - full.ev100).toBeGreaterThan(2);
    expect(adapted.cost.computations).toBe(1);
    // None at all holds a high Sun's exposure, and the range's top still bounds it.
    h.settings.setMany({ "sky.exposure.adaptation": 0, "sky.exposure.meterRange": { min: 1, max: 12 } });
    h.sky.update();
    expect(h.sky.getEnvironment()!.ev100).toBe(12);
    expect(h.sky.getEnvironment()!.exposureHeld).toBe("bright");
  });

  it("draws the stars where the sky is dark, by their light against white, and none by day", async () => {
    const catalogue: StarCatalogue = {
      count: 2,
      // Sirius, and a bright star near the north celestial pole, always up in Minneapolis.
      raDeg: new Float32Array([101.287, 37.95]),
      decDeg: new Float32Array([-16.716, 89.264]),
      vmag: new Float32Array([-1.46, -1]),
      colourIndex: new Float32Array([0, 0.6]),
      pmRaArcsec: new Float32Array([0, 0]),
      pmDecArcsec: new Float32Array([0, 0]),
    };
    const loadStars = vi.fn(() => Promise.resolve(catalogue));
    const h = harness({ ...NIGHT, "sky.model": "dome", "sky.dome.zenithSamples": 12, "sky.dome.azimuthSamples": 8, "sky.stars.mode": "catalogue" }, null, { loadStars });
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    h.sky.update();
    expect(loadStars).toHaveBeenCalledOnce();
    expect(h.sky.getEnvironment()!.stars).toBeNull();
    expect(h.sky.getEnvironment()!.starCatalogue).toBe("loading");
    // The catalogue's arrival asks for one frame, which draws the stars.
    await Promise.resolve();
    await Promise.resolve();
    expect(h.requestRender).toHaveBeenCalled();
    h.sky.update();
    const stars = h.scene.getMeshByName("sky-stars") as Mesh;
    expect(stars.isEnabled()).toBe(true);
    expect(h.sky.getEnvironment()!.stars).toMatchObject({ stars: 2, visible: true });
    expect(h.sky.getEnvironment()!.starCatalogue).toBe("loaded");
    const material = stars.material as StandardMaterial;
    expect(material.disableLighting).toBe(true);
    // An unlit standard material draws emissive × colour: black here once drew no star at all.
    expect(material.emissiveColor.equalsFloats(1, 1, 1)).toBe(true);
    expect(material.disableDepthWrite).toBe(true);
    const colors = stars.getVerticesData(VertexBuffer.ColorKind)!;
    // The pole star is up and seen; at 06 UTC in October Sirius is below Minneapolis's horizon, and dark.
    expect(colors[16 + 1]).toBeGreaterThan(0);
    expect(colors[1]).toBe(0);
    // By day no star shows: the field is not drawn.
    h.settings.setMany(AFTERNOON);
    h.sky.update();
    expect(stars.isEnabled()).toBe(false);
    expect(h.sky.getEnvironment()!.stars!.visible).toBe(false);
    h.settings.set("sky.stars.mode", "off");
    h.sky.update();
    expect(h.scene.getMeshByName("sky-stars")).toBeNull();
    expect(h.sky.getEnvironment()!.starCatalogue).toBeNull();
    expect(loadStars).toHaveBeenCalledOnce();
  });

  it("does not fetch the stars' catalogue by day, when none could show, and fetches it as the sky darkens", async () => {
    const loadStars = vi.fn(() => new Promise<StarCatalogue>(() => {}));
    const h = harness({ ...AFTERNOON, "sky.model": "dome", "sky.dome.zenithSamples": 12, "sky.dome.azimuthSamples": 8, "sky.stars.mode": "catalogue" }, null, { loadStars });
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    h.sky.update();
    // Sirius itself, with no air in its way, would be under a thousandth of white against a daylight exposure.
    expect(loadStars).not.toHaveBeenCalled();
    expect(h.sky.getEnvironment()).toMatchObject({ stars: null, starCatalogue: "not needed" });
    expect(h.scene.getMeshByName("sky-stars")).toBeNull();
    // Dusk, the Sun 2° down: the exposure has come far enough down for the brightest stars.
    h.settings.setMany(DUSK);
    h.sky.update();
    expect(loadStars).toHaveBeenCalledOnce();
    expect(h.sky.getEnvironment()!.starCatalogue).toBe("loading");
    // Still on its way: it is not asked for again, by day or by night.
    h.settings.setMany(NIGHT);
    h.sky.update();
    h.settings.setMany(AFTERNOON);
    h.sky.update();
    expect(loadStars).toHaveBeenCalledOnce();
    expect(h.sky.getEnvironment()!.starCatalogue).toBe("loading");
  });

  it("shows the stars from above the air by day, at an exposure of their own that leaves the planet's as it is", async () => {
    const catalogue: StarCatalogue = {
      count: 1,
      // A star of the second magnitude near the north celestial pole, always up in Minneapolis.
      raDeg: new Float32Array([37.95]), decDeg: new Float32Array([89.264]), vmag: new Float32Array([2]), colourIndex: new Float32Array([0.6]),
      pmRaArcsec: new Float32Array([0]), pmDecArcsec: new Float32Array([0]),
    };
    const loadStars = vi.fn(() => Promise.resolve(catalogue));
    const h = harness({ ...AFTERNOON, "sky.model": "dome", "sky.dome.zenithSamples": 12, "sky.dome.azimuthSamples": 8, "sky.stars.mode": "catalogue" }, null, { loadStars });
    // Near the ground the daytime sky hides them: the scene's exposure, and no catalogue.
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    h.sky.update();
    const scene = h.sky.getEnvironment()!.ev100;
    expect(scene).toBeGreaterThan(15);
    expect(h.sky.getEnvironment()!.starEv100).toBeCloseTo(scene - (0.3 / 80) * (scene - 1), 3);
    expect(loadStars).not.toHaveBeenCalled();
    // At 40 km, half of the way up the default 0 to 80 km, half of the way in stops to the range's floor of EV 1.
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 40_000);
    h.sky.update();
    const half = h.sky.getEnvironment()!;
    expect(half.starEv100).toBeCloseTo(half.ev100 - 0.5 * (half.ev100 - 1), 3);
    // From 400 km the sky is black beside a sunlit planet: the stars as on the darkest night, the planet as it was.
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 400_000);
    h.sky.update();
    expect(loadStars).toHaveBeenCalledOnce();
    await Promise.resolve();
    await Promise.resolve();
    h.sky.update();
    const space = h.sky.getEnvironment()!;
    expect(space.starEv100).toBe(1);
    expect(space.ev100).toBeGreaterThan(15);
    expect(space.stars).toMatchObject({ stars: 1, visible: true });
    expect(space.whiteLuminance).toBeCloseTo(1.2 * 2 ** space.ev100, 6);
    const stars = h.scene.getMeshByName("sky-stars") as Mesh;
    expect(stars.isEnabled()).toBe(true);
    // The heights are the user's: with the stars' rise put off to a step at 200 km, none show from 150 km by day.
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 150_000);
    h.sky.update();
    expect(h.sky.getEnvironment()!.starEv100).toBe(1);
    h.settings.set("sky.stars.daylightAltitude", { min: 200, max: 200 });
    h.sky.update();
    expect(h.sky.getEnvironment()!.starEv100).toBe(h.sky.getEnvironment()!.ev100);
    expect(stars.isEnabled()).toBe(false);
    h.settings.set("sky.stars.daylightAltitude", { min: 0, max: 80 });
    h.sky.update();
    expect(stars.isEnabled()).toBe(true);
    // A fixed exposure holds the stars as it holds all else.
    h.settings.setMany({ "sky.exposure.mode": "fixed", "sky.exposure.ev100": 15 });
    h.sky.update();
    expect(h.sky.getEnvironment()).toMatchObject({ ev100: 15, starEv100: 15 });
    expect(stars.isEnabled()).toBe(false);
  });

  it("computes the sky again above the air only as the horizon moves, not for each stretch of height", () => {
    const h = harness({ ...AFTERNOON, "sky.model": "lights" });
    const computations = (): number => h.sky.getEnvironment()!.cost.computations;
    // 20,000 km up, where there is no air to thin: a kilometre nearer or farther changes nothing seen.
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 20_000_000);
    h.sky.update();
    expect(computations()).toBe(1);
    for (const altitude of [20_001_000, 20_010_000, 19_990_000]) {
      h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, altitude);
      h.sky.update();
    }
    expect(computations()).toBe(1);
    // 200 km nearer the horizon has risen 0.1°, past the 0.05° step.
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 19_800_000);
    h.sky.update();
    expect(computations()).toBe(2);
    // Just above the air, 300 m is nothing; within it, the same climb thins the air past the step.
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 150_000);
    h.sky.update();
    const above = computations();
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 150_300);
    h.sky.update();
    expect(computations()).toBe(above);
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 50_000);
    h.sky.update();
    const within = computations();
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 50_300);
    h.sky.update();
    expect(computations()).toBe(within + 1);
  });

  it("takes the light from the ground off, uniform, or rendered from below, and asks for a frame only when it changes", () => {
    let reading: ((value: { rgb: [number, number, number]; pixels: number; latencyMs: number }) => void) | null = null;
    const requests: Array<{ position: Vector3; up: Vector3 }> = [];
    let seen: ((mesh: never) => boolean) | null = null;
    const probe = (options: GroundLightProbeOptions): GroundLightProbe => {
      reading = options.onReading;
      seen = options.isSeen as never;
      return { request: (position, up) => { requests.push({ position: position.clone(), up: up.clone() }); return true; }, busy: () => false, dispose: vi.fn() };
    };
    const h = harness({ ...AFTERNOON, "sky.model": "dome", "sky.dome.zenithSamples": 12, "sky.dome.azimuthSamples": 8, "sky.groundLight.mode": "off" }, null, { probe });
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    h.sky.update();
    expect(h.fill().groundColor.equalsFloats(0, 0, 0)).toBe(true);
    h.settings.set("sky.groundLight.mode", "uniform");
    h.sky.update();
    const sky = h.sky.getEnvironment()!;
    expect(h.fill().groundColor.g * sky.whiteLuminance).toBeCloseTo(sky.illumination.groundLuminance[1], 6);
    expect(requests).toHaveLength(0);
    // Rendered: a request from the receiver, looking down its own up; the dome is part of what it sees.
    h.settings.set("sky.groundLight.mode", "rendered");
    h.sky.update();
    expect(requests).toHaveLength(1);
    expect(Vector3.Dot(requests[0].up, new Vector3(...sky.illumination.observer.up))).toBeCloseTo(1, 9);
    expect(seen!(h.dome() as never)).toBe(true);
    // Until it reads, the uniform ground stands in.
    expect(h.fill().groundColor.g * sky.whiteLuminance).toBeCloseTo(sky.illumination.groundLuminance[1], 6);
    h.requestRender.mockClear();
    reading!({ rgb: [0.05, 0.1, 0.02], pixels: 256, latencyMs: 3 });
    expect(h.requestRender).toHaveBeenCalledOnce();
    h.sky.update();
    expect(h.fill().groundColor.g).toBeCloseTo(0.1, 9);
    expect(h.sky.getEnvironment()!.groundLight).toMatchObject({ source: "rendered", latencyMs: 3 });
    // The same light again asks for nothing: a still view settles.
    h.requestRender.mockClear();
    reading!({ rgb: [0.05, 0.1005, 0.02], pixels: 256, latencyMs: 3 });
    expect(h.requestRender).not.toHaveBeenCalled();
    // A receiver of the application's own, such as an aircraft.
    const aircraft = h.camera.position.add(new Vector3(0, -50, 0));
    h.sky.setGroundLightReceiver(() => aircraft);
    h.settings.set("sky.groundLight.probeInterval", 0.05);
    h.clock.ms += 100;
    h.sky.update();
    expect(requests.at(-1)!.position.equals(aircraft)).toBe(true);
  });

  it("lights the ground with an application's local lights, their candelas over white", () => {
    const h = harness({ ...NIGHT, "sky.model": "lights" });
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    h.sky.update();
    const white = h.sky.getEnvironment()!.whiteLuminance;
    h.sky.setGroundLights([{ position: new Vector3(1, 2, 3), direction: new Vector3(0, -1, 0), intensityCd: [100_000, 90_000, 80_000], cosInner: 0.99, cosOuter: 0.95 }]);
    const [light] = getTerrainLocalLights(h.scene);
    expect(light.position).toEqual([1, 2, 3]);
    expect(light.factor[0]).toBeCloseTo((100_000 * 1.5) / Math.PI / white, 6);
    expect(light.cosOuter).toBe(0.95);
    h.sky.setGroundLights([]);
    expect(getTerrainLocalLights(h.scene)).toHaveLength(0);
  });

  it("lights imagery at night by the lamps the satellite saw, shows its picture only when asked, and drops the tiles when neither shows", () => {
    const radiance = { value: 20.5 as number | null };
    const night = fakeNightLights(radiance);
    const h = harness({ ...NIGHT, "sky.model": "lights", "sky.nightLights.mode": "light" }, null, { nightLights: night.create });
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    h.sky.update();
    expect(night.made).toHaveLength(1);
    const [made] = night.made;
    expect(made.options.scene).toBe(h.scene);
    // The view below the camera, and the Sun in the Earth's axes: at night, far below Minneapolis's horizon.
    const view = made.views.at(-1)!;
    expect(view.latDeg).toBeCloseTo(MINNEAPOLIS.latDeg, 5);
    expect(view.lonDeg).toBeCloseTo(MINNEAPOLIS.lonDeg, 5);
    expect(view.altitudeMeters).toBeCloseTo(300, 0);
    const up = [
      Math.cos(MINNEAPOLIS.latDeg * DEG_TO_RAD) * Math.cos(MINNEAPOLIS.lonDeg * DEG_TO_RAD),
      Math.cos(MINNEAPOLIS.latDeg * DEG_TO_RAD) * Math.sin(MINNEAPOLIS.lonDeg * DEG_TO_RAD),
      Math.sin(MINNEAPOLIS.latDeg * DEG_TO_RAD),
    ];
    expect(Math.hypot(...view.sun)).toBeCloseTo(1, 9);
    expect(view.sun[0] * up[0] + view.sun[1] * up[1] + view.sun[2] * up[2]).toBeLessThan(-0.6);

    // 20 nW/(cm² sr) above the floor: lamps' light of π × 20 / (431 × 0.15) lx on the ground, seen from above at 20 / 431 cd/m².
    const sky = h.sky.getEnvironment()!;
    expect(sky.nightLights).toEqual({
      mode: "light", state: night.state,
      below: { radiance: 20.5, illuminanceLux: expect.closeTo((Math.PI * 20) / (431 * 0.15), 9), luminance: expect.closeTo(20 / 431, 12) },
    });
    // Each unit of radiance lights the imagery in the lamps' colour as their lux do, reflected 1.5 × over π, over white.
    const tint = blackBodyTint(3000);
    const terrain = getTerrainLighting(h.scene)!;
    const perRadiance = (Math.PI / (431 * 0.15)) * (1.5 / Math.PI) / sky.whiteLuminance;
    for (const band of [0, 1, 2]) expect(terrain.night!.light[band]).toBeCloseTo(tint[band] * perRadiance, 12);
    expect(terrain.night!.picture).toEqual([0, 0, 0]);
    expect(terrain.night!.floor).toBe(0.5);
    expect(terrain.night!.axes).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    // Light from the ground, as uniform, carries the lamps below as the satellite saw them.
    const ground = h.fill().groundColor;
    expect(luminance([ground.r, ground.g, ground.b]) * sky.whiteLuminance).toBeCloseTo(luminance(sky.illumination.groundLuminance) + 20 / 431, 9);

    // The satellite's picture instead: what it saw, over white, added to the colour.
    h.settings.set("sky.nightLights.mode", "picture");
    h.sky.update();
    const picture = getTerrainLighting(h.scene)!.night!;
    expect(picture.light).toEqual([0, 0, 0]);
    for (const band of [0, 1, 2]) expect(picture.picture[band]).toBeCloseTo(tint[band] / 431 / h.sky.getEnvironment()!.whiteLuminance, 12);
    expect(night.made).toHaveLength(1);

    // The lamps below changing shows the sky again by itself; a setting of what is downloaded asks for a frame.
    radiance.value = 30.5;
    h.sky.update();
    expect(h.sky.getEnvironment()!.nightLights!.below!.radiance).toBe(30.5);
    h.requestRender.mockClear();
    h.settings.set("sky.nightLights.date", "2025-09-22");
    expect(h.requestRender).toHaveBeenCalledTimes(1);

    // Off, or imagery as photographed, drops the tiles; the sky turned off does too.
    h.settings.set("sky.nightLights.mode", "off");
    h.sky.update();
    expect(made.disposed).toBe(true);
    expect(h.sky.getEnvironment()!.nightLights).toBeNull();
    expect(getTerrainLighting(h.scene)!.night).toBeNull();
    h.settings.setMany({ "sky.nightLights.mode": "light", "sky.surface.lighting": "photograph" });
    h.sky.update();
    expect(night.made).toHaveLength(1);
    expect(getTerrainLighting(h.scene)).toBeNull();
    h.settings.set("sky.surface.lighting", "daylight");
    h.sky.update();
    expect(night.made).toHaveLength(2);
    h.settings.set("sky.model", "off");
    h.sky.update();
    expect(night.made[1].disposed).toBe(true);
  });

  it("gives the scene back as it was when turned off, and keeps a background set meanwhile", () => {
    const h = harness({ ...AFTERNOON, "sky.model": "dome", "sky.dome.zenithSamples": 12, "sky.dome.azimuthSamples": 8 });
    const before = h.scene.clearColor;
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    const listener = vi.fn();
    h.sky.subscribe(listener);
    h.sky.update();
    expect(h.scene.clearColor).not.toBe(before);
    // A map switch sets its own background: the sky's goes back over it, and that one is kept to return to.
    const switched = before.clone();
    switched.r = 0.5;
    h.scene.clearColor = switched;
    h.sky.update();
    expect(h.scene.clearColor).not.toBe(switched);
    expect(h.sky.getEnvironment()!.cost.computations).toBe(1);
    h.requestRender.mockClear();
    h.settings.set("sky.model", "off");
    expect(h.requestRender).toHaveBeenCalledOnce();
    // The frame asked for takes the sky away as it is prepared, and so shows it gone: no second frame.
    h.sky.update();
    expect(h.requestRender).toHaveBeenCalledOnce();
    expect(h.sky.getEnvironment()).toBeNull();
    expect(h.sky.isLighting()).toBe(false);
    expect(h.onLightingChange).toHaveBeenLastCalledWith(false);
    expect(listener).toHaveBeenLastCalledWith(null);
    expect(h.scene.lights).toHaveLength(0);
    expect(h.scene.meshes).toHaveLength(0);
    expect(h.scene.materials.filter(material => material.name === "sky-dome-material")).toHaveLength(0);
    expect(h.scene.clearColor).toBe(switched);
    // On again starts afresh.
    h.settings.set("sky.model", "lights");
    h.sky.update();
    expect(h.sky.getEnvironment()!.cost.computations).toBe(1);
    // Disposed between frames, it asks for one to show the scene without it.
    h.requestRender.mockClear();
    h.sky.dispose();
    expect(h.requestRender).toHaveBeenCalledOnce();
    expect(h.scene.lights).toHaveLength(0);
    expect(h.scene.clearColor).toBe(switched);
    h.sky.update();
    expect(h.scene.lights).toHaveLength(0);
  });

  it("waits for a viewpoint on the Earth, and says when a set date is not one", () => {
    const h = harness({ ...AFTERNOON, "sky.model": "lights" });
    // A camera not yet placed is at the scene's origin, which is the Earth's centre here.
    h.sky.update();
    expect(h.sky.getEnvironment()).toBeNull();
    expect(h.sky.isLighting()).toBe(false);
    expect(h.scene.lights).toHaveLength(0);
    h.place(MINNEAPOLIS.latDeg, MINNEAPOLIS.lonDeg, 300);
    h.settings.set("sky.time.date", "7 October");
    h.sky.update();
    expect(h.settings.inspect("sky.time.date").note).toContain("Not a date");
    // The clock's time is used meanwhile.
    expect(h.sky.getEnvironment()!.illumination.utcMs).toBe(h.clock.utcMs);
    h.settings.set("sky.time.date", "2026-12-21");
    h.sky.update();
    expect(h.settings.inspect("sky.time.date").note).toBeNull();
    expect(new Date(h.sky.getEnvironment()!.illumination.utcMs).toISOString()).toBe("2026-12-21T19:00:00.000Z");
  });
});
