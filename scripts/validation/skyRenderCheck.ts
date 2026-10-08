/**
 * The sky's shaders drawn in a real context, and their pixels against what the
 * model says they should be; driven by sky-render.mjs without a server. Each
 * backend gets the app's own engine options: large-world rendering and a
 * reversed depth buffer. docs/proposals/sky.md says what each check is of.
 */
import {
  Color3, Engine, FreeCamera, Matrix, Mesh, MeshBuilder, PBRMaterial, RawTexture, Scene, StandardMaterial, Texture, Vector3,
  VertexBuffer, WebGPUEngine, type AbstractEngine,
} from "@babylonjs/core";
import { DEG_TO_RAD, geodeticToEcef } from "../../src/camera/cameraMath";
import { createLightPoints } from "../../src/engine/babylon/createLightPoints";
import { createSkyRuntime } from "../../src/engine/babylon/createSkyRuntime";
import {
  DISPLAY_GAMMA, followTerrainLight, getTerrainLighting, getTerrainLocalLights, terrainLightFactor, TerrainLightMaterialPlugin,
} from "../../src/engine/babylon/imagery/terrainLightPlugin";
import { FOSS_EARTH_PARAMETERS } from "../../src/settings/catalogue";
import { VIEWPOINT_SURFACE_LIGHTING_CHOICE } from "../../src/settings/catalogue/sky";
import { createSettingsRegistry } from "../../src/settings/registry";
import { STAR_RECORD_BYTES, STAR_RECORDS } from "../../src/sky/starCatalogue";
import { applyMatrix3, celestialToEcefMatrix, decodeStarCatalogue, starDirections, yearsFromJ2000 } from "../../src/sky/stars";

const WIDTH = 512, HEIGHT = 384;
const MINNEAPOLIS = { latDeg: 44.977753, lonDeg: -93.265011 };
/** The ground's imagery: one grey, as a texture's byte, as the standard material holds it and as linear albedo. */
const ALBEDO_BYTE = 188;
const ALBEDO_ENCODED = ALBEDO_BYTE / 255;
const ALBEDO_LINEAR = ALBEDO_ENCODED ** DISPLAY_GAMMA;
/** How far a drawn byte may be from the model's, on the ground near the camera and across the planet from afar. */
const NEAR_TOLERANCE = 4, PLANET_TOLERANCE = 8;

interface Check { name: string; expected: number[]; actual: number[]; tolerance: number; ok: boolean }
interface Result { backend: string; renderer: string; checks: Check[]; errors: string[]; shots: Record<string, string>; notes: string[] }

/** Instants over Minneapolis: a high Sun; the Sun 2° down with a quarter Moon up; a full Moon 62° up; and neither. */
const TIMES = {
  afternoon: { "sky.time.mode": "fixed", "sky.time.date": "2026-10-07", "sky.time.utcHours": 19 },
  dusk: { "sky.time.mode": "fixed", "sky.time.date": "2026-10-18", "sky.time.utcHours": 23.5 },
  fullMoon: { "sky.time.mode": "fixed", "sky.time.date": "2026-10-26", "sky.time.utcHours": 6 },
  moonless: { "sky.time.mode": "fixed", "sky.time.date": "2026-10-08", "sky.time.utcHours": 6 },
} as const;

type Backend = "webgl2" | "webgl1" | "webgpu";

const encode = (linear: number): number => 255 * Math.min(1, Math.max(0, linear)) ** (1 / DISPLAY_GAMMA);

async function run(backend: Backend): Promise<Result> {
  const result: Result = { backend, renderer: "", checks: [], errors: [], shots: {}, notes: [] };
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  canvas.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px`;
  document.body.append(canvas);
  let engine: AbstractEngine;
  if (backend === "webgpu") {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) {
      result.errors.push("WebGPU is not available in this browser: the WGSL shaders were not drawn");
      canvas.remove();
      return result;
    }
    const gpu = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: false, useLargeWorldRendering: true });
    await gpu.initAsync();
    engine = gpu;
    result.renderer = `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}`.trim();
  } else {
    const gl = new Engine(canvas, false, { disableWebGL2Support: backend === "webgl1", preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true }, false);
    engine = gl;
    result.renderer = `WebGL ${gl.webGLVersion}: ${gl.getGlInfo().renderer}`;
    if (gl.webGLVersion !== (backend === "webgl1" ? 1 : 2)) result.errors.push(`Asked for ${backend} and got WebGL ${gl.webGLVersion}`);
  }
  engine.useReverseDepthBuffer = true;
  // Pixels are read from a 2D copy of each frame, the same way on every backend.
  const copy = document.createElement("canvas");
  copy.width = WIDTH;
  copy.height = HEIGHT;
  const context = copy.getContext("2d", { willReadFrequently: true })!;
  let snapshot = context.getImageData(0, 0, WIDTH, HEIGHT);
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.skipPointerMovePicking = true;

  // A scene whose origin is the ground at Minneapolis and whose axes are the Earth's: as a floating origin gives.
  const lat = MINNEAPOLIS.latDeg * DEG_TO_RAD, lon = MINNEAPOLIS.lonDeg * DEG_TO_RAD;
  const ground = geodeticToEcef(lat, lon, 0);
  const world = Matrix.Translation(-ground.x, -ground.y, -ground.z);
  const up = new Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
  const east = new Vector3(-Math.sin(lon), Math.cos(lon), 0);
  const north = new Vector3(-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat));
  const local = (e: number, n: number, u: number): Vector3 => east.scale(e).add(north.scale(n)).add(up.scale(u));

  const texture = RawTexture.CreateRGBATexture(new Uint8Array([ALBEDO_BYTE, ALBEDO_BYTE, ALBEDO_BYTE, 255]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
  /** As a 2D map tile's material: unlit, its imagery a diffuse texture, under the terrain light. */
  const rasterMaterial = (name: string): StandardMaterial => {
    const material = new StandardMaterial(name, scene);
    material.specularColor = Color3.Black();
    material.emissiveColor = Color3.White();
    material.disableLighting = true;
    material.backFaceCulling = false;
    material.diffuseTexture = texture;
    new TerrainLightMaterialPlugin(material);
    return material;
  };
  /** Two kilometres of level ground north to south, between two distances east. */
  const patch = (name: string, fromEast: number, toEast: number): Mesh => {
    const mesh = new Mesh(name, scene);
    const corners = [local(fromEast, -1000, 0), local(toEast, -1000, 0), local(toEast, 1000, 0), local(fromEast, 1000, 0)];
    mesh.setVerticesData(VertexBuffer.PositionKind, corners.flatMap(corner => [corner.x, corner.y, corner.z]));
    mesh.setVerticesData(VertexBuffer.UVKind, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    mesh.setIndices([0, 1, 2, 0, 2, 3]);
    mesh.alwaysSelectAsActiveMesh = true;
    return mesh;
  };
  const raster = patch("raster-tile", -1000, 0);
  raster.material = rasterMaterial("raster");
  // As a Google 3D Tile whose glTF material comes unlit.
  const tile = patch("google-tile", 0, 1000);
  const unlit = new PBRMaterial("unlit-tile", scene);
  unlit.unlit = true;
  unlit.albedoColor = new Color3(ALBEDO_LINEAR, ALBEDO_LINEAR, ALBEDO_LINEAR);
  unlit.backFaceCulling = false;
  if (!followTerrainLight(unlit)) result.errors.push("followTerrainLight did not attach to the unlit PBR material");
  tile.material = unlit;

  const camera = new FreeCamera("view", local(0, -600, 300), scene);
  const lowView = (): void => {
    camera.position.copyFrom(local(0, -600, 300));
    camera.fov = 0.8;
    camera.minZ = 1;
    camera.maxZ = 1e8;
    camera.setTarget(local(0, 300, 0));
  };
  camera.upVector = up.clone();
  lowView();
  scene.activeCamera = camera;

  const settings = createSettingsRegistry({ storage: null });
  settings.register(FOSS_EARTH_PARAMETERS);
  settings.setMany({ "sky.model": "dome", "sky.dome.zenithSamples": 16, "sky.dome.azimuthSamples": 12, "sky.groundLight.mode": "uniform", ...TIMES.afternoon });
  const catalogue = decodeStarCatalogue(STAR_RECORDS, STAR_RECORD_BYTES);
  const sky = createSkyRuntime({
    scene, settings, getWorldMatrix: () => world, requestRender: () => {}, onLightingChange: () => {},
    loadStars: () => Promise.resolve(catalogue),
  });

  const draw = (): void => {
    engine.beginFrame();
    sky.update();
    scene.render();
    engine.endFrame();
  };
  const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  /** Draws until every shader has compiled, then once more for the picture, and keeps its pixels. */
  const frame = async (): Promise<void> => {
    for (let attempt = 0; attempt < 400; attempt++) {
      draw();
      if (attempt > 2 && scene.meshes.every(mesh => !mesh.isEnabled() || mesh.isReady(true))) break;
      await pause(10);
    }
    draw();
    // In the task that drew it, the canvas still holds the frame on every backend.
    context.clearRect(0, 0, WIDTH, HEIGHT);
    context.drawImage(canvas, 0, 0);
    snapshot = context.getImageData(0, 0, WIDTH, HEIGHT);
  };
  const project = (point: Vector3): { x: number; y: number } => {
    const projected = Vector3.Project(point, Matrix.Identity(), camera.getViewMatrix(true).multiply(camera.getProjectionMatrix(true)), camera.viewport.toGlobal(WIDTH, HEIGHT));
    return { x: Math.round(projected.x), y: Math.round(projected.y) };
  };
  const read = (x: number, y: number): number[] => {
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return [0, 0, 0];
    const at = (y * WIDTH + x) * 4;
    return [snapshot.data[at], snapshot.data[at + 1], snapshot.data[at + 2]];
  };
  const pixelAt = (point: Vector3): number[] => {
    const { x, y } = project(point);
    return read(x, y);
  };
  /** The brightest pixel within a few px of a point. */
  const brightestNear = (point: Vector3, radius: number): number[] => {
    const { x, y } = project(point);
    let best = [0, 0, 0];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const pixel = read(x + dx, y + dy);
        if (pixel[0] + pixel[1] + pixel[2] > best[0] + best[1] + best[2]) best = pixel;
      }
    }
    return best;
  };
  const check = (name: string, expected: number[], actual: number[], tolerance: number): void => {
    result.checks.push({ name, expected: expected.map(Math.round), actual, tolerance, ok: expected.every((value, index) => Math.abs(value - actual[index]) <= tolerance) });
  };
  /** A check with a rule of its own: `expected` then says what the rule asks for. */
  const rule = (name: string, expected: number[], actual: number[], ok: boolean): void => {
    result.checks.push({ name, expected: expected.map(Math.round), actual: actual.map(Math.round), tolerance: 0, ok });
  };
  const shot = (name: string): void => { result.shots[name] = copy.toDataURL("image/png"); };
  /** What a pixel of the ground should be, as bytes: the standard material scales its encoded colour, the PBR one its linear albedo. */
  const expectedGround = (point: Vector3): { raster: number[]; tile: number[]; factor: number[] } => {
    const lighting = getTerrainLighting(scene);
    if (!lighting) return { raster: [ALBEDO_BYTE, ALBEDO_BYTE, ALBEDO_BYTE], tile: [ALBEDO_BYTE, ALBEDO_BYTE, ALBEDO_BYTE], factor: [1, 1, 1] };
    const factor = terrainLightFactor(lighting, getTerrainLocalLights(scene), [point.x, point.y, point.z]);
    return {
      raster: factor.map(f => 255 * Math.min(1, ALBEDO_ENCODED * f ** (1 / DISPLAY_GAMMA))),
      tile: factor.map(f => encode(ALBEDO_LINEAR * f)),
      factor,
    };
  };
  const onRaster = local(-300, 200, 0), onTile = local(300, 200, 0);
  const groundChecks = async (label: string): Promise<void> => {
    await frame();
    const a = expectedGround(onRaster), b = expectedGround(onTile);
    check(`${label}: 2D map tile (standard material)`, a.raster, pixelAt(onRaster), NEAR_TOLERANCE);
    check(`${label}: unlit glTF tile (PBR material)`, b.tile, pixelAt(onTile), NEAR_TOLERANCE);
    result.notes.push(`${label}: factor ${a.factor.map(value => value.toPrecision(3)).join(", ")}; EV ${sky.getEnvironment()?.ev100.toFixed(2) ?? "none"}`);
    shot(label);
  };

  try {
    // The ground by day, at dusk, under a full Moon and under the night sky alone, each point by its own Sun and Moon.
    await groundChecks("afternoon");
    settings.setMany(TIMES.dusk);
    await groundChecks("dusk");
    settings.setMany(TIMES.fullMoon);
    await groundChecks("full-moon night");
    settings.setMany(TIMES.moonless);
    await groundChecks("moonless night");

    // A lamp's beam on the ground at night: 1,000 cd from 30 m above the 2D tile's point, wide enough that the
    // pixel read, whose footprint on the ground is metres long, lies well inside it.
    settings.setMany(TIMES.fullMoon);
    sky.update();
    sky.setGroundLights([{ position: onRaster.add(up.scale(30)), direction: up.scale(-1), intensityCd: [1000, 1000, 1000], cosInner: Math.cos(30 * DEG_TO_RAD), cosOuter: Math.cos(45 * DEG_TO_RAD) }]);
    await groundChecks("full-moon night with a beam on the 2D tile");
    sky.setGroundLights([]);

    // One factor for all imagery, as an application may offer; as photographed; and the sky off.
    settings.setMany(TIMES.afternoon);
    const own = FOSS_EARTH_PARAMETERS.find(spec => spec.id === "sky.surface.lighting")?.choices ?? [];
    settings.setChoices("sky.surface.lighting", [...own, VIEWPOINT_SURFACE_LIGHTING_CHOICE]);
    settings.set("sky.surface.lighting", VIEWPOINT_SURFACE_LIGHTING_CHOICE.id);
    await groundChecks("afternoon, as at the viewpoint");
    settings.set("sky.surface.lighting", "photograph");
    await groundChecks("afternoon, as photographed");
    settings.setMany({ "sky.surface.lighting": "daylight", "sky.model": "off" });
    await groundChecks("sky off");
    settings.set("sky.model", "dome");

    // The planet from 20,000 km: day, twilight and night where they are.
    raster.setEnabled(false);
    tile.setEnabled(false);
    const centre = new Vector3(-ground.x, -ground.y, -ground.z);
    const radius = 6_371_000;
    const globe = MeshBuilder.CreateSphere("globe", { diameter: radius * 2, segments: 96 }, scene);
    globe.position.copyFrom(centre);
    globe.material = rasterMaterial("globe");
    globe.alwaysSelectAsActiveMesh = true;
    camera.position.copyFrom(up.scale(20_000_000));
    camera.maxZ = 1e9;
    camera.minZ = 1000;
    camera.fov = 0.55;
    camera.setTarget(centre);
    settings.setMany(TIMES.afternoon);
    await frame();
    shot("planet, afternoon over Minneapolis");
    const spherePoint = (latDeg: number, lonDeg: number): Vector3 => centre.add(new Vector3(
      Math.cos(latDeg * DEG_TO_RAD) * Math.cos(lonDeg * DEG_TO_RAD), Math.cos(latDeg * DEG_TO_RAD) * Math.sin(lonDeg * DEG_TO_RAD), Math.sin(latDeg * DEG_TO_RAD)).scale(radius));
    // Along the 30th parallel from the Pacific's afternoon to the Atlantic's night, across the terminator.
    for (const lonDeg of [-140, -110, -80, -50, -35, -25, -20, -15, -10]) {
      const point = spherePoint(30, lonDeg);
      const expected = expectedGround(point);
      check(`planet at 30°N ${Math.abs(lonDeg)}°W (factor ${expected.factor[1].toPrecision(2)})`, expected.raster, pixelAt(point), PLANET_TOLERANCE);
    }
    globe.setEnabled(false);
    raster.setEnabled(true);
    tile.setEnabled(true);

    // The full Moon's disc on the dome, far above white. A frame first, so the sky is computed from where the
    // camera now is: the Moon's parallax from 20,000 km up is degrees.
    lowView();
    settings.setMany(TIMES.fullMoon);
    await frame();
    const moon = sky.getEnvironment()?.illumination.moon;
    if (!moon) result.errors.push("no Moon in the sky's state on the full-Moon night");
    else {
      const towardMoon = camera.position.add(new Vector3(...moon.direction).scale(1000));
      camera.setTarget(towardMoon);
      await frame();
      check("the full Moon's disc", [255, 255, 255], pixelAt(towardMoon), 2);
      // Ten degrees from it the moonlit sky is there and far under white.
      const beside = pixelAt(towardMoon.add(camera.getDirection(new Vector3(1, 0, 0)).scale(170)));
      rule("the moonlit sky 10° from the Moon: lit, and under 120", [1, 1, 1], beside, Math.max(...beside) < 120 && Math.max(...beside) > 0);
      shot("full Moon");
    }

    /** The brightest star more than 30° above the viewpoint's horizon and more than 30° from the Sun, as a direction of the scene. */
    const brightStar = (): Vector3 | null => {
      const state = sky.getEnvironment()?.illumination;
      if (!state) return null;
      const toEcef = celestialToEcefMatrix(state.utcMs);
      const directions = starDirections(catalogue, Math.round(yearsFromJ2000(state.utcMs)), 2);
      for (let index = 0; index < directions.length / 3; index++) {
        const [x, y, z] = applyMatrix3(toEcef, directions[index * 3], directions[index * 3 + 1], directions[index * 3 + 2]);
        const high = x * state.observer.up[0] + y * state.observer.up[1] + z * state.observer.up[2] > 0.5;
        const fromSun = x * state.sunDirection[0] + y * state.sunDirection[1] + z * state.sunDirection[2] < Math.cos(30 * DEG_TO_RAD);
        if (high && fromSun) return new Vector3(x, y, z);
      }
      return null;
    };
    /** Looks at a star and checks it stands out from the sky 60 px beside it. */
    const starCheck = async (name: string, also: () => boolean): Promise<void> => {
      await frame();
      const star = brightStar();
      if (!star) {
        result.errors.push(`${name}: no bright star more than 30° up to look at`);
        return;
      }
      const towardStar = camera.position.add(star.scale(1000));
      camera.setTarget(towardStar);
      await frame();
      const at = brightestNear(towardStar, 3);
      const beside = pixelAt(towardStar.add(camera.getDirection(new Vector3(1, 0, 0)).scale(60)));
      const drawn = sky.getEnvironment()?.stars;
      rule(`${name}, of ${drawn?.stars ?? 0} drawn: at least 30 above the sky beside it`, beside.map(value => value + 30), at, at[1] > beside[1] + 30 && drawn?.visible === true && also());
    };

    // The stars on a moonless night: the brightest one more than 30° up is a point brighter than the sky beside it.
    settings.setMany(TIMES.moonless);
    sky.update();
    await pause(0);
    await starCheck("a bright star at night", () => true);
    shot("stars");

    // By day the sky near the ground hides them: none is drawn at the scene's exposure.
    settings.setMany(TIMES.afternoon);
    lowView();
    await frame();
    const low = sky.getEnvironment();
    rule("by day near the ground no star is drawn: the stars' exposure within a tenth of a stop of the scene's", [0], [low?.stars?.visible ? 1 : 0], low?.stars?.visible === false && Math.abs(low.ev100 - low.starEv100) < 0.1);
    // From 400 km the sky is black beside the sunlit planet: the stars show at an exposure of their own, the planet's as it was.
    camera.position.copyFrom(up.scale(400_000));
    camera.minZ = 100;
    camera.maxZ = 1e9;
    camera.setTarget(camera.position.add(up.scale(1000)));
    await starCheck("a bright star from 400 km by day", () => {
      const high = sky.getEnvironment();
      return !!high && high.starEv100 === 1 && high.ev100 > 15;
    });
    const high = sky.getEnvironment();
    result.notes.push(`from 400 km by day: the scene at EV ${high?.ev100.toFixed(2)}, the stars at EV ${high?.starEv100.toFixed(2)}`);
    shot("stars from 400 km by day");

    // A 40 cd red lamp 20 m ahead, at night: a glare, saturated at its core. By day it adds its light to the ground's.
    settings.setMany(TIMES.moonless);
    lowView();
    camera.getViewMatrix(true);
    const ahead = camera.position.add(camera.getForwardRay(1).direction.scale(20));
    const points = createLightPoints(scene, { getWhiteLuminance: () => sky.getEnvironment()?.whiteLuminance ?? null, referenceWhiteLuminance: () => 1000, sizePx: () => 32, liftMeters: () => 0.3 });
    // 40 cd of red alone: its luminance weight taken off, so the band holds 40 cd of luminance.
    points.setPoints([{ parent: null, position: ahead, intensityToward: (_toward, out) => { out[0] = 40 / 0.2126; out[1] = 0; out[2] = 0; return out; } }]);
    await frame();
    const glare = pixelAt(ahead);
    rule(`a 40 cd red lamp at 20 m at night, ${points.getPeak().toPrecision(3)} × white at its core: red at 255, green under 40`, [255, 0, 0], glare, glare[0] === 255 && glare[1] < 40);
    shot("light point at night");
    settings.setMany(TIMES.afternoon);
    await frame();
    const byDay = pixelAt(ahead);
    const peakByDay = points.getPeak();
    points.setPoints([]);
    await frame();
    const background = pixelAt(ahead);
    // The linear sum of the two, encoded; the screen blend that draws it is within a few steps of that.
    const sum = encode((background[0] / 255) ** DISPLAY_GAMMA + peakByDay);
    check(`the same lamp by day, ${peakByDay.toPrecision(3)} × white, added to the ground's light`, [sum, background[1], background[2]], byDay, 12);
    points.dispose();

    // The light from the ground, rendered from below the camera and read back.
    settings.setMany({ ...TIMES.afternoon, "sky.groundLight.mode": "rendered", "sky.groundLight.probeInterval": 0.05 });
    let reading: number[] | null = null;
    let latencyMs = 0;
    for (let attempt = 0; attempt < 100 && !reading; attempt++) {
      draw();
      await pause(20);
      const groundLight = sky.getEnvironment()?.groundLight;
      if (groundLight?.source === "rendered" && groundLight.latencyMs !== null) {
        reading = [...groundLight.luminance];
        latencyMs = groundLight.latencyMs;
      }
    }
    if (!reading) result.errors.push("no reading of the ground's light arrived");
    else {
      const white = sky.getEnvironment()?.whiteLuminance ?? 1;
      const expected = expectedGround(local(0, -600, 0)).factor.map(f => ALBEDO_LINEAR * f * white);
      const seen = reading;
      rule(`the ground's light read back in ${latencyMs.toFixed(0)} ms, cd/m²: within a tenth`, expected, seen, expected.every((value, index) => Math.abs(seen[index] - value) / value < 0.1));
    }
  } catch (error) {
    result.errors.push(String((error as Error)?.stack ?? error));
  }
  sky.dispose();
  engine.dispose();
  canvas.remove();
  copy.remove();
  return result;
}

async function main(): Promise<void> {
  const results: Result[] = [];
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); original(...args); };
  for (const backend of ["webgl2", "webgl1", "webgpu"] as const) {
    const result = await run(backend).catch((error: unknown): Result => ({ backend, renderer: "", checks: [], errors: [String((error as Error)?.stack ?? error)], shots: {}, notes: [] }));
    result.errors.push(...errors.splice(0));
    results.push(result);
  }
  (window as unknown as { skyRenderCheck: { done: boolean; results: Result[] } }).skyRenderCheck = { done: true, results };
}
void main();
