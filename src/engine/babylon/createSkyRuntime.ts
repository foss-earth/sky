import {
  Color3,
  Color4,
  DirectionalLight,
  HemisphericLight,
  Matrix,
  Mesh,
  Quaternion,
  StandardMaterial,
  Vector3,
  VertexBuffer,
  type AbstractMesh,
  type Scene,
} from "@babylonjs/core";
import type { SkyModel } from "../../settings/catalogue/sky";
import type { SettingsRegistry } from "../../settings/registry";
import { isNumberRange } from "../../settings/values";
import { ATMOSPHERE, createAtmosphere, type Atmosphere, type Rgb } from "../../sky/atmosphere";
import { lunarEphemeris, type LunarEphemeris } from "../../sky/lunarPosition";
import { solarEphemeris, sunDirectionFrom, type SolarEphemeris } from "../../sky/solarPosition";
import {
  adaptEv100, computeSkyIllumination, createSkyDomeGeometry, ev100ForIlluminance, fillSkyDome, groundLightTable, horizonDipDeg, luminance,
  observerAt, parseUtcDate, PHOTOMETRY, starEv100, whiteLuminanceForEv100, type SkyDomeGeometry, type SkyIllumination, type SkyObserver,
} from "../../sky/skyState";
import { illuminancePerRadiance, luminancePerRadiance, radianceAboveFloor, type NightLightPhotometry } from "../../sky/nightLights";
import { blackBodyTint, celestialToEcefMatrix, loadStarCatalogue, yearsFromJ2000, type StarCatalogue } from "../../sky/stars";
import { createGroundLightProbe, type GroundLightProbe } from "./createGroundLightProbe";
import { createNightLights, type NightLights, type NightLightsOptions, type NightLightsState } from "./createNightLights";
import { createStarField, starPixelAngleChanged, starsCouldShow, type StarField, type StarFieldCost } from "./createStarField";
import { DISPLAY_GAMMA, setTerrainLighting, setTerrainLocalLights, type TerrainLighting, type TerrainNightLighting } from "./imagery/terrainLightPlugin";

/**
 * The sky in the scene: the rungs of docs/proposals/sky.md that are built.
 * Everything physical is computed on the CPU by src/sky, only when the Sun,
 * the Moon or the viewpoint has moved past `sky.update.*`, and reaches the
 * scene as two lights, the dome's mesh with a colour per vertex, the stars'
 * mesh, and the light map imagery is shown under, with the night lights'
 * tiles where the Sun has set (createNightLights.ts).
 *
 * Luminance in cd/m² becomes the scene's linear value by one division, by the
 * luminance the exposure shows as white. Lights and colours are written
 * already divided, so nothing in the scene that is not physical, such as a
 * marker or a compass, changes brightness with the hour.
 */

/** The dome's radius, m: past every camera's far plane, which this mesh ignores, so it sits behind all else. */
const DOME_RADIUS_METERS = 1e10;
/** The Sun's fastest motion in the sky, degrees per second: a turn of the Earth a day. */
const SUN_DEGREES_PER_SECOND = 360 / 86_400;
/** The height the air's density is followed by the haze layer below, and by the air above, m. */
const HAZE_FOLLOWED_BELOW_METERS = 6_000;
/** The share of the recompute angle the Sun's and the Moon's places may be stale by before they are found again. */
const EPHEMERIS_SHARE = 0.25;
/** A viewpoint nearer the Earth's centre than this, m, is a camera not yet placed. */
const LEAST_VIEWPOINT_RADIUS_METERS = 1e6;
/**
 * A reading of the ground's light asks for a frame only when it differs from
 * the light shown by more than this share: a still view settles, and a change
 * smaller than this is not seen on a surface lit by it.
 */
const GROUND_READING_CHANGE = 0.02;

export interface SkyCost {
  /** Building the atmosphere's tables, the last time its parameters changed. */
  tablesMs: number;
  tableBytes: number;
  /** The last computation of the Sun's and the sky's light, and of the dome. */
  illuminationMs: number;
  domeMs: number;
  /** Samples of the model the dome's last computation took, of them the moonlit sky's, and its vertices. */
  domeSamples: number;
  moonSamples: number;
  domeVertices: number;
  /** Times the sky has been computed since it was turned on. */
  computations: number;
}

export type GroundLightSource = "off" | "uniform" | "rendered";

/** How the night lights show: as lamps' light on the imagery, as the satellite's picture, or not at all. */
export type NightLightsMode = "off" | "light" | "picture";

export interface SkyNightLights {
  mode: Exclude<NightLightsMode, "off">;
  /** Their tiles and window: what is downloaded, kept and shown. */
  state: NightLightsState;
  /**
   * Below the viewpoint: the radiance a tile here holds, nW/(cm² sr); above
   * the floor, the lamps' light on the ground, lux, and the luminance the
   * satellite saw, cd/m². Null where no tile here holds the place.
   */
  below: { radiance: number; illuminanceLux: number; luminance: number } | null;
}

export interface SkyEnvironment {
  model: Exclude<SkyModel, "off">;
  /** The Sun's, the Moon's and the sky's light at the viewpoint, in lux and cd/m². */
  illumination: SkyIllumination;
  /** Which body the scene's directional light carries: the brighter of the two, or none below the horizon. */
  direct: "sun" | "moon" | null;
  /** The exposure in use at ISO 100. */
  ev100: number;
  /** What the meter reads for the light at the viewpoint, whether or not it is followed, and what adaptation makes of it. */
  meteredEv100: number;
  adaptedEv100: number;
  /** Set when metering stopped at an end of its range: the scene is darker, or brighter, than the meter would make it. */
  exposureHeld: "dark" | "bright" | null;
  /**
   * The luminance shown as the display's white before exposure compensation,
   * cd/m². An emitter of luminance L writes L / whiteLuminance to the scene.
   */
  whiteLuminance: number;
  /** The factor on map imagery's linear value below the viewpoint, or null where it is shown as photographed. */
  surfaceFactor: Rgb | null;
  /** Where the light from the ground comes from, and its luminance, cd/m² in each band. */
  groundLight: { source: GroundLightSource; luminance: Rgb; latencyMs: number | null };
  /** The stars drawn, or null with stars off or their catalogue not here. */
  stars: StarFieldCost | null;
  /** The exposure the stars are shown at: the scene's near the ground, darker towards the top of the air by `sky.stars.daylightAltitude`. */
  starEv100: number;
  /**
   * The stars' catalogue: not asked for while no star could show at the
   * exposure in use, as by day; on its way; or here. Null with stars off.
   */
  starCatalogue: "not needed" | "loading" | "loaded" | null;
  /** The night lights, or null while they are off or the imagery is not lit. */
  nightLights: SkyNightLights | null;
  cost: SkyCost;
}

/** A light that reaches the ground, such as a landing light, in the scene's coordinates. */
export interface SkyGroundLight {
  position: Vector3;
  /** Unit vector along the beam's axis. */
  direction: Vector3;
  /** Luminous intensity on the axis, cd, in each band. */
  intensityCd: Rgb;
  /** Cosines of the beam's half-angles: full within the inner, none beyond the outer; -1 and -1 for every way. */
  cosInner: number;
  cosOuter: number;
}

export interface SkyRuntime {
  /** Brings the sky up to date for the frame about to be drawn. Does nothing while nothing has moved. */
  update(): void;
  /** The sky as last computed, or null while the model is off or no viewpoint is known. */
  getEnvironment(): SkyEnvironment | null;
  /** Called after each computation and when the model is turned off. Returns a function that stops it. */
  subscribe(listener: (environment: SkyEnvironment | null) => void): () => void;
  /** Whether the sky's lights light the scene, in place of the runtime's fill lights. */
  isLighting(): boolean;
  /** Lights the ground is lit by besides the sky, such as an aircraft's landing lights, at most four. Call it as they move. */
  setGroundLights(lights: readonly SkyGroundLight[]): void;
  /** Where the light from the ground is measured from, in the scene, such as an aircraft; the camera when null. */
  setGroundLightReceiver(receiver: (() => Vector3 | null) | null): void;
  /** The night lights as they are now, tiles arriving included, or null while they are off or the imagery is not lit. */
  getNightLights(): SkyNightLights | null;
  dispose(): void;
}

export interface SkyTimers {
  set(callback: () => void, delayMs: number): number;
  clear(id: number): void;
}

export interface SkyRuntimeOptions {
  scene: Scene;
  settings: SettingsRegistry;
  /** Takes Earth-centred, Earth-fixed metres into the scene; null where the scene's own axes are those. */
  getWorldMatrix(): Matrix | null;
  requestRender(): void;
  /** Called when the sky's lights start or stop lighting the scene. */
  onLightingChange(active: boolean): void;
  /** The ground's meshes, which the light from the ground is rendered from. Terrain lit by the sky when omitted. */
  isGround?(mesh: AbstractMesh): boolean;
  /** The device's clock, in ms of UTC since 1970; `Date.now` when omitted. */
  now?: () => number;
  /** A clock for costs, in ms; `performance.now` when omitted. */
  clock?: () => number;
  timers?: SkyTimers;
  isHidden?: () => boolean;
  /** Stars' catalogue; `loadStarCatalogue` when omitted. */
  loadStars?: () => Promise<StarCatalogue>;
  /** The ground probe, replaceable for tests. */
  createGroundProbe?: typeof createGroundLightProbe;
  /** Called with each chunk of a night light tile's bytes as it arrives, for the download meter. */
  onDownloadBytes?: (bytes: number) => void;
  /** The night lights' tiles, replaceable for tests. */
  createNightLights?: (options: NightLightsOptions) => NightLights;
}

/** Settings whose change needs the model evaluated again, and those that only change how it is shown. */
const EVALUATED_IDS = [
  "sky.model", "sky.time.mode", "sky.time.date", "sky.time.utcHours", "sky.atmosphere.aerosolOpticalDepth",
  "sky.atmosphere.groundAlbedo", "sky.night.luminance", "sky.dome.zenithSamples", "sky.dome.azimuthSamples",
  "sky.dome.integrationSteps", "sky.moon.mode",
] as const;
const PRESENTED_IDS = [
  "sky.exposure.mode", "sky.exposure.meterRange", "sky.exposure.ev100", "sky.exposure.adaptation", "sky.surface.lighting",
  "sky.surface.albedoScale", "renderer.exposureEV", "sky.stars.mode", "sky.stars.limitingMagnitude", "sky.stars.sizePx",
  "sky.stars.daylightAltitude", "sky.groundLight.mode", "sky.nightLights.mode", "sky.nightLights.colourTemperature",
  "sky.nightLights.floor", "sky.nightLights.radiancePerEmittance", "sky.nightLights.groundReflectance",
] as const;
/** Settings the night lights' tiles follow at the next frame: which are downloaded, kept and shown. */
const NIGHT_LOADING_IDS = [
  "sky.nightLights.date", "sky.nightLights.satellite", "sky.nightLights.maxZoom", "sky.nightLights.windowTiles",
  "sky.nightLights.memory", "sky.nightLights.sunBelow", "map.imagery.concurrentRequests",
] as const;

/** Display-encodes a linear value as Babylon's materials do. */
function encode(linear: number): number {
  return Math.min(1, Math.max(0, linear)) ** (1 / DISPLAY_GAMMA);
}

const localDirection = (direction: readonly number[], observer: SkyObserver): [number, number, number] => [
  direction[0] * observer.east[0] + direction[1] * observer.east[1] + direction[2] * observer.east[2],
  direction[0] * observer.north[0] + direction[1] * observer.north[1] + direction[2] * observer.north[2],
  direction[0] * observer.up[0] + direction[1] * observer.up[1] + direction[2] * observer.up[2],
];
const angleDeg = (a: readonly number[], b: readonly number[]): number =>
  Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * (180 / Math.PI);

export function createSkyRuntime(options: SkyRuntimeOptions): SkyRuntime {
  const { scene, settings } = options;
  const now = options.now ?? (() => Date.now());
  const clock = options.clock ?? (() => performance.now());
  const timers: SkyTimers = options.timers ?? {
    set: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clear: id => window.clearTimeout(id),
  };
  const isHidden = options.isHidden ?? (() => typeof document !== "undefined" && document.hidden);
  const number = (id: string): number => settings.get<number>(id);
  const model = (): SkyModel => {
    const value = settings.get("sky.model");
    return value === "lights" || value === "dome" ? value : "off";
  };
  const moonMode = (): "off" | "light" | "sky" => {
    const value = settings.get("sky.moon.mode");
    return value === "off" || value === "light" ? value : "sky";
  };
  const groundLightMode = (): GroundLightSource => {
    const value = settings.get("sky.groundLight.mode");
    return value === "off" || value === "rendered" ? value : "uniform";
  };
  const nightLightsMode = (): NightLightsMode => {
    const value = settings.get("sky.nightLights.mode");
    return value === "off" || value === "picture" ? value : "light";
  };
  const nightPhotometry = (): NightLightPhotometry => ({
    radiancePerEmittance: number("sky.nightLights.radiancePerEmittance"),
    groundReflectance: number("sky.nightLights.groundReflectance"),
    floor: number("sky.nightLights.floor"),
  });

  const listeners = new Set<(environment: SkyEnvironment | null) => void>();
  let environment: SkyEnvironment | null = null;
  let lighting = false;
  let evaluate = true;
  let present = false;
  let disposed = false;

  let atmosphere: Atmosphere | null = null;
  let atmosphereKey = "";
  let groundTable: Float32Array | null = null;
  let ephemeris: SolarEphemeris | null = null;
  let lunar: LunarEphemeris | null = null;
  let illumination: SkyIllumination | null = null;
  /** The Sun's and the Moon's directions in the viewpoint's east, north and up when last computed, the air's density measure there, and the horizon's dip. */
  let lastSunLocal: [number, number, number] | null = null;
  let lastMoonLocal: [number, number, number] | null = null;
  let lastDensity = 0;
  let lastDipDeg = 0;
  const cost: SkyCost = { tablesMs: 0, tableBytes: 0, illuminationMs: 0, domeMs: 0, domeSamples: 0, moonSamples: 0, domeVertices: 0, computations: 0 };

  let directLight: DirectionalLight | null = null;
  let skyLight: HemisphericLight | null = null;
  let dome: { mesh: Mesh; material: StandardMaterial; geometry: SkyDomeGeometry; positions: Float32Array; colors: Float32Array; key: string } | null = null;
  /** The background the scene had, kept while the sky's own colour is shown, and the one the sky set. */
  let backgroundBefore: Color4 | null = null;
  let backgroundSet: Color4 | null = null;
  /** The sky's mean luminance over the white luminance: the background's linear value before compensation. */
  let backgroundLinear: Rgb = [0, 0, 0];
  let timer: number | null = null;
  const fromScene = new Matrix();

  let catalogue: StarCatalogue | null = null;
  let catalogueLoading = false;
  /** What the last look at the stars found of their catalogue. */
  let catalogueState: SkyEnvironment["starCatalogue"] = null;
  let stars: StarField | null = null;
  let starCost: StarFieldCost | null = null;
  let starPixelAngle = 0;
  let starKey = "";

  let probe: GroundLightProbe | null = null;
  /** The last reading of the light from the ground: its luminance, cd/m², and how long it took. */
  let groundReading: { luminance: Rgb; latencyMs: number } | null = null;
  let lastProbeAt = -Infinity;
  /** The white luminance the reading on its way was rendered at: one reading is in flight at a time. */
  let probeWhite = 1;
  let receiver: (() => Vector3 | null) | null = null;
  let groundLights: readonly SkyGroundLight[] = [];

  let nightLights: NightLights | null = null;
  /** The place below the viewpoint the night lights were last looked up at. */
  let nightPlace: SkyObserver | null = null;

  const stopTimer = (): void => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  /** With the clock running, one frame is asked for each time the Sun has moved the recompute angle. */
  const scheduleClock = (): void => {
    if (timer !== null || disposed || model() === "off" || settings.get("sky.time.mode") !== "now" || isHidden()) return;
    const seconds = number("sky.update.sunAngle") / SUN_DEGREES_PER_SECOND;
    timer = timers.set(() => {
      timer = null;
      // A hidden page draws nothing; its return draws a frame, which starts the clock again.
      if (disposed || isHidden()) return;
      evaluate = true;
      options.requestRender();
    }, seconds * 1000);
  };

  function instant(): number {
    if (settings.get("sky.time.mode") !== "fixed") {
      settings.setNote("sky.time.date", null);
      return now();
    }
    const day = parseUtcDate(String(settings.get("sky.time.date")));
    if (day === null) {
      settings.setNote("sky.time.date", "Not a date: write it as year-month-day, such as 2026-06-21. The clock's time is used meanwhile.");
      return now();
    }
    settings.setNote("sky.time.date", null);
    return day + number("sky.time.utcHours") * 3_600_000;
  }

  /** A point of the scene as an observer on the Earth, or null where it is no place on it. */
  function observerAtScene(position: Vector3): SkyObserver | null {
    const world = options.getWorldMatrix();
    const ecef = world ? Vector3.TransformCoordinates(position, world.invertToRef(fromScene)) : position;
    if (![ecef.x, ecef.y, ecef.z].every(Number.isFinite) || ecef.length() < LEAST_VIEWPOINT_RADIUS_METERS) return null;
    return observerAt(ecef.x, ecef.y, ecef.z);
  }

  function viewpoint(): SkyObserver | null {
    const camera = scene.activeCamera;
    return camera ? observerAtScene(camera.globalPosition) : null;
  }

  /** Takes a direction of the Earth's axes into the scene's, normalized: the world matrix may turn, scale or mirror them. */
  function toScene(x: number, y: number, z: number): Vector3 {
    const world = options.getWorldMatrix();
    const vector = new Vector3(x, y, z);
    return (world ? Vector3.TransformNormal(vector, world) : vector).normalize();
  }

  /** A measure of the air's density at a height that changes by about one for each e-fold, up to the top of the air: above it there is none to thin. */
  const densityMeasure = (altitudeMeters: number): number => {
    const h = Math.min(ATMOSPHERE.thicknessMeters, Math.max(0, altitudeMeters));
    return h < HAZE_FOLLOWED_BELOW_METERS
      ? h / ATMOSPHERE.mieScaleHeightMeters
      : HAZE_FOLLOWED_BELOW_METERS / ATMOSPHERE.mieScaleHeightMeters + (h - HAZE_FOLLOWED_BELOW_METERS) / ATMOSPHERE.rayleighScaleHeightMeters;
  };

  function ensureLights(): void {
    if (directLight && skyLight) return;
    // The Sun's light, or the Moon's when it is the brighter: one light, so the night costs no more than the day.
    directLight = new DirectionalLight("sky-sun", new Vector3(0, -1, 0), scene);
    skyLight = new HemisphericLight("sky-light", new Vector3(0, 1, 0), scene);
    // A sky has no single highlight; the Sun's or the Moon's is the directional light's.
    skyLight.specular = Color3.Black();
    directLight.intensity = 0;
    skyLight.intensity = 0;
  }

  function disposeDome(): void {
    dome?.mesh.dispose();
    dome?.material.dispose();
    dome = null;
  }

  function ensureDome(): NonNullable<typeof dome> {
    const layout = {
      zenithSamples: number("sky.dome.zenithSamples"),
      azimuthSamples: number("sky.dome.azimuthSamples"),
      integrationSteps: number("sky.dome.integrationSteps"),
    };
    const key = `${layout.zenithSamples}/${layout.azimuthSamples}`;
    if (dome && dome.key === key) {
      dome.geometry.layout.integrationSteps = Math.max(2, Math.round(layout.integrationSteps));
      return dome;
    }
    disposeDome();
    const geometry = createSkyDomeGeometry(layout);
    const positions = new Float32Array(geometry.vertexCount * 3);
    const colors = new Float32Array(geometry.vertexCount * 4).fill(1);
    // The plainest material there is, as the map's own imagery uses: unlit, its
    // colour the vertex's, with no texture and no light in its shader.
    const material = new StandardMaterial("sky-dome-material", scene);
    material.disableLighting = true;
    material.emissiveColor = Color3.White();
    material.specularColor = Color3.Black();
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    material.fogEnabled = false;
    const mesh = new Mesh("sky-dome", scene);
    mesh.setVerticesData(VertexBuffer.PositionKind, positions, true);
    mesh.setVerticesData(VertexBuffer.ColorKind, colors, true, 4);
    mesh.setIndices(geometry.indices, geometry.vertexCount);
    mesh.hasVertexAlpha = false;
    mesh.material = material;
    // Centred on whichever camera draws it, behind everything, and never culled or picked.
    mesh.infiniteDistance = true;
    mesh.ignoreCameraMaxZ = true;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    mesh.isPickable = false;
    mesh.applyFog = false;
    mesh.rotationQuaternion = Quaternion.Identity();
    dome = { mesh, material, geometry, positions, colors, key };
    return dome;
  }

  function disposeStars(): void {
    stars?.dispose();
    stars = null;
    starCost = null;
    starPixelAngle = 0;
    starKey = "";
  }

  function disposeProbe(): void {
    probe?.dispose();
    probe = null;
    groundReading = null;
    lastProbeAt = -Infinity;
  }

  function disposeNightLights(): void {
    nightLights?.dispose();
    nightLights = null;
    nightPlace = null;
  }

  /** The lamps below the viewpoint: the radiance a tile here holds, and above the floor their light and the luminance the satellite saw. */
  function nightBelow(): SkyNightLights["below"] {
    const radiance = nightLights && nightPlace ? nightLights.radianceAt(nightPlace.latDeg, nightPlace.lonDeg) : null;
    if (radiance === null) return null;
    const photometry = nightPhotometry();
    const above = radianceAboveFloor(radiance, photometry);
    return { radiance, illuminanceLux: above * illuminancePerRadiance(photometry), luminance: above * luminancePerRadiance(photometry) };
  }

  /** The night lights as they are now: their tiles, and the lamps below the viewpoint. */
  function readNightLights(): SkyNightLights | null {
    const mode = nightLightsMode();
    if (!nightLights || mode === "off") return null;
    return { mode, state: nightLights.getState(), below: nightBelow() };
  }

  /**
   * Keeps the night lights' tiles for the viewpoint while lit imagery shows
   * them. The lamps below light surfaces from beneath as the ground does: a
   * change there shows the sky again.
   */
  function updateNightLights(observer: SkyObserver, sun: readonly [number, number, number]): void {
    if (nightLightsMode() === "off" || settings.get("sky.surface.lighting") === "photograph") {
      if (nightLights) {
        disposeNightLights();
        present = true;
      }
      return;
    }
    nightLights ??= (options.createNightLights ?? createNightLights)({
      scene,
      settings,
      requestRender: () => options.requestRender(),
      onDownloadBytes: options.onDownloadBytes,
      now: clock,
      timers,
    });
    nightLights.update({ latDeg: observer.latDeg, lonDeg: observer.lonDeg, altitudeMeters: observer.altitudeMeters, sun });
    nightPlace = observer;
    const shown = environment?.nightLights?.below?.luminance ?? null;
    const below = nightBelow()?.luminance ?? null;
    if ((shown === null) !== (below === null) || (shown !== null && below !== null && Math.abs(below - shown) > GROUND_READING_CHANGE * Math.max(below, shown))) present = true;
  }

  /** Takes the sky out of the scene. Inside a frame's preparation that frame shows it; outside one, a frame is asked for. */
  function turnOff(inFrame: boolean): void {
    stopTimer();
    const wasOn = lighting || environment !== null;
    directLight?.dispose();
    skyLight?.dispose();
    directLight = null;
    skyLight = null;
    disposeDome();
    disposeStars();
    disposeProbe();
    disposeNightLights();
    illumination = null;
    lastSunLocal = null;
    lastMoonLocal = null;
    cost.computations = 0;
    if (backgroundSet && scene.clearColor === backgroundSet && backgroundBefore) scene.clearColor = backgroundBefore;
    backgroundSet = null;
    backgroundBefore = null;
    const surfaceChanged = setTerrainLighting(scene, null);
    if (lighting) {
      lighting = false;
      options.onLightingChange(false);
    }
    environment = null;
    if (wasOn || surfaceChanged) {
      for (const listener of [...listeners]) listener(null);
      if (!inFrame) options.requestRender();
    }
  }

  /**
   * The exposure the settings give for a metered reading. Below the light of a
   * high Sun, exposure follows the meter by `sky.exposure.adaptation` stops a
   * stop: all of the way as a camera does, or part of it, so that dusk and
   * night stay darker than day as eyes see them.
   */
  function exposure(meteredEv100: number, zenithEv100: number): Pick<SkyEnvironment, "ev100" | "exposureHeld" | "adaptedEv100"> {
    if (settings.get("sky.exposure.mode") === "fixed") return { ev100: number("sky.exposure.ev100"), exposureHeld: null, adaptedEv100: meteredEv100 };
    const adaptedEv100 = adaptEv100(meteredEv100, zenithEv100, number("sky.exposure.adaptation"));
    const range = settings.get("sky.exposure.meterRange");
    if (!isNumberRange(range)) return { ev100: adaptedEv100, exposureHeld: null, adaptedEv100 };
    if (adaptedEv100 < range.min) return { ev100: range.min, exposureHeld: "dark", adaptedEv100 };
    if (adaptedEv100 > range.max) return { ev100: range.max, exposureHeld: "bright", adaptedEv100 };
    return { ev100: adaptedEv100, exposureHeld: null, adaptedEv100 };
  }

  function applyBackground(): void {
    const compensation = 2 ** number("renderer.exposureEV");
    // Someone else set a background meanwhile, such as a map switch: that is the one to return to.
    if (!backgroundSet || scene.clearColor !== backgroundSet) backgroundBefore = scene.clearColor;
    backgroundSet = new Color4(encode(backgroundLinear[0] * compensation), encode(backgroundLinear[1] * compensation), encode(backgroundLinear[2] * compensation), 1);
    scene.clearColor = backgroundSet;
  }

  /**
   * The exposure the stars are shown at: the scene's, moved towards the
   * darkest the metered range allows as the viewpoint rises through
   * `sky.stars.daylightAltitude`. A fixed exposure is for comparing pictures,
   * and holds the stars as it holds all else.
   */
  function starExposure(altitudeMeters: number, ev100: number): number {
    if (settings.get("sky.exposure.mode") === "fixed") return ev100;
    const range = settings.get("sky.exposure.meterRange");
    const heights = settings.get("sky.stars.daylightAltitude");
    if (!isNumberRange(range) || !isNumberRange(heights)) return ev100;
    return starEv100(ev100, range.min, altitudeMeters, heights.min * 1000, heights.max * 1000);
  }

  /** The reflectance one unit of imagery's linear colour stands for, over π, over white: a factor per lux. */
  const imageryReflect = (scale: number): number => (number("sky.surface.albedoScale") / Math.PI) * scale;

  /**
   * The night lights' part of the terrain light, per nW/(cm² sr) above the
   * floor in the lamps' colour: their light on the ground as a factor on
   * imagery, or the luminance the satellite saw as a linear value.
   */
  function nightLighting(mode: Exclude<NightLightsMode, "off">, reflect: number, scale: number, tint: Rgb): TerrainNightLighting {
    const photometry = nightPhotometry();
    const light = mode === "light" ? illuminancePerRadiance(photometry) * reflect : 0;
    const picture = mode === "picture" ? luminancePerRadiance(photometry) * scale : 0;
    const axis = (x: number, y: number, z: number): [number, number, number] => {
      const direction = toScene(x, y, z);
      return [direction.x, direction.y, direction.z];
    };
    return {
      axes: [axis(1, 0, 0), axis(0, 1, 0), axis(0, 0, 1)],
      light: [tint[0] * light, tint[1] * light, tint[2] * light],
      picture: [tint[0] * picture, tint[1] * picture, tint[2] * picture],
      floor: photometry.floor,
    };
  }

  function applyGroundLights(scale: number): void {
    const reflect = imageryReflect(scale);
    setTerrainLocalLights(scene, groundLights.map(light => ({
      position: [light.position.x, light.position.y, light.position.z],
      direction: [light.direction.x, light.direction.y, light.direction.z],
      cosInner: light.cosInner,
      cosOuter: light.cosOuter,
      factor: [light.intensityCd[0] * reflect, light.intensityCd[1] * reflect, light.intensityCd[2] * reflect],
    })));
  }

  /** Writes the computed light to the scene at the exposure in use. Cheap: nothing of the model is evaluated. */
  function show(kind: Exclude<SkyModel, "off">): void {
    const state = illumination;
    if (!state || !directLight || !skyLight) return;
    const meteredEv100 = ev100ForIlluminance(state.meteredLux);
    const { ev100, exposureHeld, adaptedEv100 } = exposure(meteredEv100, ev100ForIlluminance(state.zenithMeteredLux));
    const whiteLuminance = whiteLuminanceForEv100(ev100);
    const scale = 1 / whiteLuminance;

    const up = toScene(...state.observer.up);
    const sun = toScene(...state.sunDirection);

    // A surface facing the Sun, or the Moon when it gives more: L = ρ E / π, which Babylon's PBR materials compute from an intensity of E.
    const moon = state.moon;
    const sunLight = luminance(state.sunIlluminance);
    const moonLight = moon ? luminance(moon.directIlluminance) : 0;
    const direct = moon && moonLight > sunLight ? "moon" : sunLight > 0 ? "sun" : null;
    const body = direct === "moon" && moon ? { illuminance: moon.directIlluminance, direction: toScene(...moon.direction) } : { illuminance: state.sunIlluminance, direction: sun };
    const peak = Math.max(body.illuminance[0], body.illuminance[1], body.illuminance[2]);
    directLight.direction.copyFrom(body.direction).scaleInPlace(-1);
    directLight.diffuse.set(peak > 0 ? body.illuminance[0] / peak : 1, peak > 0 ? body.illuminance[1] / peak : 1, peak > 0 ? body.illuminance[2] / peak : 1);
    directLight.specular.copyFrom(directLight.diffuse);
    directLight.intensity = peak * scale;

    // A hemispheric light's colour is the radiance a white surface facing it returns: E / π for the sky, and the ground's own luminance from below.
    skyLight.direction.copyFrom(up);
    skyLight.diffuse.set((state.skyIlluminance[0] / Math.PI) * scale, (state.skyIlluminance[1] / Math.PI) * scale, (state.skyIlluminance[2] / Math.PI) * scale);
    const groundSource = groundLightMode();
    const night = readNightLights();
    const lampTint = blackBodyTint(number("sky.nightLights.colourTemperature"));
    // Uniform ground sends up, besides the sky's light, the lamps' below as the satellite saw them; a rendered reading sees them drawn.
    const lamps = night?.below?.luminance ?? 0;
    const ground: Rgb = groundSource === "off" ? [0, 0, 0]
      : groundSource === "rendered" && groundReading ? groundReading.luminance
        : [state.groundLuminance[0] + lamps * lampTint[0], state.groundLuminance[1] + lamps * lampTint[1], state.groundLuminance[2] + lamps * lampTint[2]];
    skyLight.groundColor.set(ground[0] * scale, ground[1] * scale, ground[2] * scale);
    skyLight.intensity = 1;

    // Map imagery: by the Sun's and the Moon's height at each pixel's place, by the light below the viewpoint, or as photographed.
    let surfaceFactor: Rgb | null = null;
    const surface = settings.get("sky.surface.lighting");
    const world = options.getWorldMatrix();
    if (surface !== "photograph" && groundTable) {
      const reflect = imageryReflect(scale);
      surfaceFactor = [state.groundIlluminance[0] * reflect, state.groundIlluminance[1] * reflect, state.groundIlluminance[2] * reflect];
      const perPoint = surface !== "viewpoint";
      const centre = world ? Vector3.TransformCoordinates(Vector3.Zero(), world) : Vector3.Zero();
      const moonScene = moon ? toScene(...moon.direction) : sun;
      const nightLight = Math.PI * state.nightLuminance * reflect;
      const terrain: TerrainLighting = {
        perPoint,
        centre: [centre.x, centre.y, centre.z],
        sunDirection: [sun.x, sun.y, sun.z],
        moonDirection: [moonScene.x, moonScene.y, moonScene.z],
        sunScale: [state.solarIlluminanceLux * reflect, state.solarIlluminanceLux * reflect, state.solarIlluminanceLux * reflect],
        moonScale: moon ? [moon.extraterrestrial[0] * reflect, moon.extraterrestrial[1] * reflect, moon.extraterrestrial[2] * reflect] : [0, 0, 0],
        ambient: perPoint ? [nightLight, nightLight, nightLight] : surfaceFactor,
        table: groundTable,
        night: night ? nightLighting(night.mode, reflect, scale, lampTint) : null,
      };
      setTerrainLighting(scene, terrain);
    } else {
      setTerrainLighting(scene, null);
    }
    applyGroundLights(scale);

    if (kind === "dome" && dome) {
      const { geometry, positions, colors, mesh } = dome;
      // The standard material holds colour display-encoded, and decodes it before exposure; values above white stay above it.
      for (let vertex = 0; vertex < geometry.vertexCount; vertex++) {
        colors[vertex * 4] = (geometry.luminances[vertex * 3] * scale) ** (1 / DISPLAY_GAMMA);
        colors[vertex * 4 + 1] = (geometry.luminances[vertex * 3 + 1] * scale) ** (1 / DISPLAY_GAMMA);
        colors[vertex * 4 + 2] = (geometry.luminances[vertex * 3 + 2] * scale) ** (1 / DISPLAY_GAMMA);
      }
      for (let index = 0; index < positions.length; index++) positions[index] = geometry.directions[index] * DOME_RADIUS_METERS;
      mesh.updateVerticesData(VertexBuffer.PositionKind, positions, false, false);
      mesh.updateVerticesData(VertexBuffer.ColorKind, colors, false, false);
      // The dome's own axes: +X towards the Sun's bearing, +Y up, +Z = X × Y in the Earth's axes.
      const forward = toScene(...state.sunHorizontal);
      const side = Vector3.Cross(forward, up).normalize();
      const level = Vector3.Cross(up, side).normalize();
      Quaternion.FromRotationMatrixToRef(Matrix.FromXYZAxesToRef(level, up, side, new Matrix()), mesh.rotationQuaternion!);
      // A world that mirrors the Earth's axes flips the third: the Moon's side of the dome follows it.
      const h = state.sunHorizontal, u = state.observer.up;
      const third = toScene(h[1] * u[2] - h[2] * u[1], h[2] * u[0] - h[0] * u[2], h[0] * u[1] - h[1] * u[0]);
      mesh.scaling.z = Vector3.Dot(third, side) < 0 ? -1 : 1;
    }

    const starsEv100 = starExposure(state.observer.altitudeMeters, ev100);
    showStars(state, 1 / whiteLuminanceForEv100(starsEv100));

    backgroundLinear = [(state.skyIlluminance[0] / Math.PI) * scale, (state.skyIlluminance[1] / Math.PI) * scale, (state.skyIlluminance[2] / Math.PI) * scale];
    applyBackground();

    environment = {
      model: kind,
      illumination: state,
      direct,
      ev100,
      meteredEv100,
      adaptedEv100,
      exposureHeld,
      whiteLuminance,
      surfaceFactor,
      groundLight: { source: groundSource, luminance: ground, latencyMs: groundSource === "rendered" ? groundReading?.latencyMs ?? null : null },
      stars: starCost,
      starEv100: starsEv100,
      starCatalogue: catalogueState,
      nightLights: night,
      cost: { ...cost },
    };
    for (const listener of [...listeners]) listener(environment);
  }

  /** The angle a pixel spans at the view's centre, radians. */
  function pixelAngle(): number {
    const camera = scene.activeCamera;
    const height = scene.getEngine().getRenderHeight();
    return camera && height > 0 ? (2 * Math.tan(camera.fov / 2)) / height : 0;
  }

  /** Draws the stars against their own white: `scale` is one over it. */
  function showStars(state: SkyIllumination, scale: number): void {
    if (model() !== "dome" || settings.get("sky.stars.mode") === "off") {
      disposeStars();
      catalogueState = null;
      return;
    }
    const angle = pixelAngle();
    if (!catalogue) {
      // Fetched once a star could show: by day none can, and nothing is loaded for them.
      const wanted = catalogueLoading
        || starsCouldShow({ solarIlluminanceAt1AuLux: PHOTOMETRY.solarIlluminanceLux, scale, sizePx: number("sky.stars.sizePx"), pixelAngle: angle });
      catalogueState = wanted ? "loading" : "not needed";
      if (wanted && !catalogueLoading) {
        catalogueLoading = true;
        (options.loadStars ?? loadStarCatalogue)().then(loaded => {
          catalogue = loaded;
          if (disposed) return;
          present = true;
          options.requestRender();
        }, () => { catalogueLoading = false; });
      }
      return;
    }
    catalogueState = "loaded";
    if (!atmosphere) return;
    // Drawn again only when the sky, the exposure or the view has changed: a reading of the ground's light changes none.
    const key = `${state.utcMs}|${state.observer.ecef.join(",")}|${scale}|${angle}|${number("sky.stars.limitingMagnitude")}|${number("sky.stars.sizePx")}`;
    if (stars && key === starKey) return;
    starKey = key;
    stars ??= createStarField(scene);
    starPixelAngle = angle;
    starCost = stars.update({
      catalogue,
      toEcef: celestialToEcefMatrix(state.utcMs),
      years: yearsFromJ2000(state.utcMs),
      observer: state.observer,
      atmosphere,
      solarIlluminanceAt1AuLux: PHOTOMETRY.solarIlluminanceLux,
      scale,
      toScene,
      limitingMagnitude: number("sky.stars.limitingMagnitude"),
      sizePx: number("sky.stars.sizePx"),
      pixelAngle: starPixelAngle,
    });
  }

  /** Renders the ground below the receiver for the light it sends up, when a reading is due. */
  function measureGroundLight(): void {
    if (groundLightMode() !== "rendered" || !environment) {
      if (probe) disposeProbe();
      return;
    }
    const intervalMs = number("sky.groundLight.probeInterval") * 1000;
    const at = clock();
    if (at - lastProbeAt < intervalMs) return;
    const position = receiver?.() ?? scene.activeCamera?.globalPosition ?? null;
    if (!position) return;
    const place = observerAtScene(position);
    if (!place) return;
    probe ??= (options.createGroundProbe ?? createGroundLightProbe)({
      scene,
      isSeen: mesh => mesh === dome?.mesh || (options.isGround ? options.isGround(mesh) : !!mesh.material?.pluginManager?.getPlugin("TerrainLight")),
      onReading: reading => {
        const next: Rgb = [reading.rgb[0] * probeWhite, reading.rgb[1] * probeWhite, reading.rgb[2] * probeWhite];
        const shown = environment?.groundLight.luminance ?? null;
        groundReading = { luminance: next, latencyMs: reading.latencyMs };
        const change = shown ? Math.abs(luminance(next) - luminance(shown)) / Math.max(1e-12, luminance(shown)) : 1;
        if (change > GROUND_READING_CHANGE && !disposed) {
          present = true;
          options.requestRender();
        }
      },
    });
    const white = environment.whiteLuminance;
    if (probe.request(position, toScene(...place.up), {
      sizePx: number("sky.groundLight.probeSize"),
      fieldOfViewDeg: number("sky.groundLight.probeFieldOfView"),
    }, 2 ** number("renderer.exposureEV"))) {
      lastProbeAt = at;
      probeWhite = white;
    }
  }

  function update(): void {
    if (disposed) return;
    const kind = model();
    if (kind === "off") {
      if (lighting || environment || directLight) turnOff(true);
      evaluate = true;
      return;
    }
    const observer = viewpoint();
    if (!observer) return;
    const utcMs = instant();
    const angle = number("sky.update.sunAngle");
    const withMoon = moonMode() !== "off";
    if (!ephemeris || Math.abs(utcMs - ephemeris.utcMs) > ((angle * EPHEMERIS_SHARE) / SUN_DEGREES_PER_SECOND) * 1000) {
      ephemeris = solarEphemeris(utcMs);
      lunar = withMoon ? lunarEphemeris(utcMs, ephemeris) : null;
    } else if (withMoon && !lunar) {
      lunar = lunarEphemeris(ephemeris.utcMs, ephemeris);
    }
    // Has the Sun or the Moon moved in this viewpoint's sky, by the clock or by travel, or the air thinned?
    const sunEcef = sunDirectionFrom(ephemeris, observer.ecef[0], observer.ecef[1], observer.ecef[2]);
    const sunLocal = localDirection(sunEcef, observer);
    const moonLocal = withMoon && lunar
      ? localDirection((() => {
        const [mx, my, mz] = lunar.moonEcefMeters;
        const d = [mx - observer.ecef[0], my - observer.ecef[1], mz - observer.ecef[2]];
        const length = Math.hypot(d[0], d[1], d[2]);
        return [d[0] / length, d[1] / length, d[2] / length];
      })(), observer)
      : null;
    const density = densityMeasure(observer.altitudeMeters);
    // Above the air, height changes only where the horizon is, which the dome's rows follow: its dip is watched there
    // as the Sun's place is. Within the air the density's step is finer than that at its default, and the user's to coarsen.
    const dipDeg = horizonDipDeg(observer.altitudeMeters);
    const dipMoved = observer.altitudeMeters > ATMOSPHERE.thicknessMeters ? Math.abs(dipDeg - lastDipDeg) : 0;
    if (!evaluate && lastSunLocal) {
      const moved = Math.max(angleDeg(sunLocal, lastSunLocal), moonLocal && lastMoonLocal ? angleDeg(moonLocal, lastMoonLocal) : 0, dipMoved);
      if (moved > angle || Math.abs(density - lastDensity) > number("sky.update.densityChange")) evaluate = true;
    }
    if (evaluate || !illumination) {
      const key = `${number("sky.atmosphere.aerosolOpticalDepth")}/${number("sky.atmosphere.groundAlbedo")}`;
      if (!atmosphere || key !== atmosphereKey) {
        atmosphere = createAtmosphere({
          aerosolOpticalDepth: number("sky.atmosphere.aerosolOpticalDepth"),
          groundAlbedo: number("sky.atmosphere.groundAlbedo"),
        }, clock);
        atmosphereKey = key;
        groundTable = groundLightTable(atmosphere);
        cost.tablesMs = atmosphere.build.buildMs;
        cost.tableBytes = atmosphere.build.tableBytes + groundTable.byteLength;
      }
      const lit = clock();
      illumination = computeSkyIllumination(atmosphere, ephemeris, observer, { nightLuminance: number("sky.night.luminance"), lunar: withMoon ? lunar : null });
      const sampled = clock();
      cost.illuminationMs = sampled - lit;
      ensureLights();
      if (kind === "dome") {
        const target = ensureDome();
        fillSkyDome(target.geometry, atmosphere, illumination, { moonlitSky: moonMode() === "sky" });
        cost.domeMs = clock() - sampled;
        cost.domeSamples = target.geometry.evaluations;
        cost.moonSamples = target.geometry.moonEvaluations;
        cost.domeVertices = target.geometry.vertexCount;
      } else {
        disposeDome();
        cost.domeMs = 0;
        cost.domeSamples = 0;
        cost.moonSamples = 0;
        cost.domeVertices = 0;
      }
      cost.computations += 1;
      lastSunLocal = sunLocal;
      lastMoonLocal = moonLocal;
      lastDensity = density;
      lastDipDeg = dipDeg;
      evaluate = false;
      present = true;
    }
    // A new field of view or render height changes the stars' squares.
    if (stars && starPixelAngleChanged(starPixelAngle, pixelAngle())) present = true;
    updateNightLights(observer, [sunEcef[0], sunEcef[1], sunEcef[2]]);
    if (present) {
      present = false;
      show(kind);
    } else if (backgroundSet && scene.clearColor !== backgroundSet) {
      // A map switch set its own background: the sky's goes back over it.
      applyBackground();
    }
    if (!lighting) {
      lighting = true;
      options.onLightingChange(true);
    }
    measureGroundLight();
    scheduleClock();
  }

  const stopWatching = settings.subscribe(changed => {
    let wanted = false;
    for (const id of EVALUATED_IDS) if (changed.has(id)) { evaluate = true; wanted = true; }
    for (const id of PRESENTED_IDS) if (changed.has(id)) { present = true; wanted = true; }
    for (const id of NIGHT_LOADING_IDS) if (changed.has(id) && nightLights) wanted = true;
    if (changed.has("sky.time.mode") || changed.has("sky.update.sunAngle") || changed.has("sky.model")) stopTimer();
    if (changed.has("sky.moon.mode")) lunar = null;
    // With the model off, only turning it on is seen; the frame asked for does the work.
    if (wanted && (model() !== "off" || lighting || environment)) options.requestRender();
  });

  return {
    update,
    getEnvironment: () => environment,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    isLighting: () => lighting,
    setGroundLights(lights) {
      groundLights = lights.slice(0, 4);
      if (environment) applyGroundLights(1 / environment.whiteLuminance);
      else setTerrainLocalLights(scene, []);
    },
    setGroundLightReceiver(next) {
      receiver = next;
    },
    getNightLights: readNightLights,
    dispose() {
      if (disposed) return;
      turnOff(false);
      disposed = true;
      stopWatching();
      listeners.clear();
      setTerrainLocalLights(scene, []);
      settings.setNote("sky.time.date", null);
    },
  };
}
