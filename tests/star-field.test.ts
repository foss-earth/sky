import { createHash } from "node:crypto";
import { FreeCamera, Matrix, NullEngine, Quaternion, Scene, Vector3, VertexBuffer, type Mesh } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import type { Atmosphere, Rgb } from "../src/atmosphere.js";
import { SKY_PARAMETERS } from "../src/settings.js";
import { observerAt, PHOTOMETRY } from "../src/skyState.js";
import { celestialToEcefMatrix, loadStarCatalogue, type StarCatalogue } from "../src/stars.js";
import { createSkyRuntime, createStarField, starsCouldShow, type SkyRuntime, type StarFieldView } from "../src/babylon/index.js";

const engines: NullEngine[] = []; const skies: SkyRuntime[] = [];
afterEach(() => { for (const sky of skies.splice(0)) sky.dispose(); for (const engine of engines.splice(0)) engine.dispose(); });

/** The runtime's star field over 0°N 0°E at midnight, in a world turned, stretched and mirrored from the Earth's axes. */
async function starsAt(utcHours: number, worldMatrix: Matrix | null) {
  const engine = new NullEngine(); engines.push(engine); const scene = new Scene(engine);
  const camera = new FreeCamera("host-camera", new Vector3(6378637, 0, 0), scene); scene.activeCamera = camera; camera.getViewMatrix(true);
  const settings = createSettingsRegistry({ storage: null }); settings.register(SKY_PARAMETERS);
  settings.setMany({ "sky.model": "dome", "sky.dome.zenithSamples": 8, "sky.dome.azimuthSamples": 8, "sky.dome.integrationSteps": 4, "sky.time.mode": "fixed", "sky.time.date": "2026-03-20", "sky.time.utcHours": utcHours, "sky.moon.mode": "off", "sky.stars.mode": "catalogue", "sky.nightLights.mode": "off", "sky.groundLight.mode": "uniform" });
  let requested = 0;
  const sky = createSkyRuntime({ scene, settings, ecefToGeodetic: () => ({ latRad: 0, lonRad: 0, altMeters: 500 }), terrain: { setLighting: () => true, setLocalLights: () => {} }, nightTilePorts: { fetchTile: async () => { throw new Error("Unexpected tile acquisition"); }, measureResponse: response => response, retryDelayMs: () => 2000, setNightLightMap: () => true }, getWorldMatrix: () => worldMatrix, requestRender: () => { requested++; }, onLightingChange: () => {}, isGround: () => false, now: () => 0, clock: () => 0, isHidden: () => false, timers: { set: () => 0, clear: () => {} }, loadStars: loadStarCatalogue }); skies.push(sky);
  sky.update();
  await loadStarCatalogue();
  await Promise.resolve();
  expect(requested).toBeGreaterThan(0);
  sky.update();
  const mesh = scene.getMeshByName("sky-stars") as Mesh;
  const hash = createHash("sha256");
  for (const kind of [VertexBuffer.PositionKind, VertexBuffer.ColorKind, VertexBuffer.UVKind]) hash.update(new Uint8Array(mesh.getVerticesData(kind, false, true)!.buffer));
  hash.update(new Uint8Array(Uint32Array.from(mesh.getIndices(false, true)!).buffer));
  return { digest: hash.digest("hex"), enabled: mesh.isEnabled(false), stars: sky.getEnvironment()?.stars?.stars ?? null };
}

/** The whole catalogue over 0°N 0°E, seen through air that dims nothing, counting what is worked out for each star. */
function starSky(catalogue: StarCatalogue) {
  const work = { scene: 0, air: 0 };
  const atmosphere = { sunTransmittance(_altitude: number, _mu: number, out: Rgb) { work.air++; out[0] = 1; out[1] = 1; out[2] = 1; return out; } } as unknown as Atmosphere;
  const observer = observerAt(6378637, 0, 0, () => ({ latRad: 0, lonRad: 0, altMeters: 500 })), toEcef = celestialToEcefMatrix(Date.UTC(2026, 2, 20));
  const toScene = (x: number, y: number, z: number) => { work.scene++; return new Vector3(x, y, z); };
  const view = (scale: number): StarFieldView => ({ catalogue, toEcef, years: 26, observer, atmosphere, solarIlluminanceAt1AuLux: PHOTOMETRY.solarIlluminanceLux,
    scale, toScene, limitingMagnitude: 99, sizePx: 3, pixelAngle: (2 * Math.tan(0.4)) / 915 });
  // The least exposure at which a star could show, and the most at which none could.
  let below = 0, least = 1;
  while (!starsCouldShow(view(least))) least *= 2;
  for (let middle = (below + least) / 2; middle !== below && middle !== least; middle = (below + least) / 2) {
    if (starsCouldShow(view(middle))) least = middle; else below = middle;
  }
  return { work, view, below, least };
}

describe("star field", () => {
  // What the field held when each star's squares were worked out with Babylon's vectors, one allocated for each step.
  it("draws each star's square and colour as before, in the Earth's axes and in a world turned, stretched and mirrored", async () => {
    const turned = Matrix.Compose(new Vector3(-2, 0.5, 3), Quaternion.RotationYawPitchRoll(-0.7, 0.4, 0.1), new Vector3(5, 6, 7));
    expect(await starsAt(0, null)).toEqual({ digest: "f59197c49a8e0130e6528358ab01fc4342f9f49c2dede0eeb865559cbf85666f", enabled: true, stars: 8404 });
    expect(await starsAt(0, turned)).toEqual({ digest: "3190131463372cbc98b5ab86dc384f2d4a849827eb69e3d8c58220abc62ce41c", enabled: true, stars: 8404 });
  });

  it("works nothing out for a star at an exposure where none could show, and none shows at the least exposure where one could", async () => {
    const sky = starSky(await loadStarCatalogue());
    const engine = new NullEngine(); engines.push(engine); const scene = new Scene(engine);
    const field = createStarField(scene, { clock: () => 0 });
    expect(field.update(sky.view(sky.below))).toEqual({ stars: 9096, updateMs: 0, visible: false, atmosphere: "page" });
    expect(sky.work).toEqual({ scene: 0, air: 0 });
    expect(scene.getMeshByName("sky-stars")!.isEnabled(false)).toBe(false);
    // Every star worked out, with no air in its way, and still none reaches the share drawn: no exposure skipped drew one.
    expect(field.update(sky.view(sky.least))).toEqual({ stars: 9096, updateMs: 0, visible: false, atmosphere: "page" });
    expect(sky.work).toEqual({ scene: 9096, air: 9096 });
    field.dispose();
  });

  it("draws the same after the exposures where no star could show as a field that never saw them", async () => {
    const sky = starSky(await loadStarCatalogue()), night = sky.least * 1000;
    const engine = new NullEngine(); engines.push(engine);
    const [skipped, fresh] = [new Scene(engine), new Scene(engine)].map(scene => ({ scene, field: createStarField(scene, { clock: () => 0 }) }));
    const drawn = (scene: Scene) => {
      const mesh = scene.getMeshByName("sky-stars") as Mesh;
      return { enabled: mesh.isEnabled(false), positions: Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!), colors: Array.from(mesh.getVerticesData(VertexBuffer.ColorKind)!) };
    };
    expect(skipped.field.update(sky.view(night)).visible).toBe(true);
    expect(skipped.field.update(sky.view(sky.below)).visible).toBe(false);
    expect(drawn(skipped.scene).enabled).toBe(false);
    // Back at the night's exposure, the colours worked out for it before are drawn again: the air is not asked again.
    const air = sky.work.air;
    expect(skipped.field.update(sky.view(night)).visible).toBe(true);
    expect(sky.work.air).toBe(air);
    expect(fresh.field.update(sky.view(night)).visible).toBe(true);
    expect(drawn(skipped.scene)).toEqual(drawn(fresh.scene));
    for (const { field } of [skipped, fresh]) field.dispose();
  });
});
