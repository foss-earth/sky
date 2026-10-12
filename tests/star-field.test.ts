import { createHash } from "node:crypto";
import { FreeCamera, Matrix, NullEngine, Quaternion, Scene, Vector3, VertexBuffer, type Mesh } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { SKY_PARAMETERS } from "../src/settings.js";
import { loadStarCatalogue } from "../src/stars.js";
import { createSkyRuntime, type SkyRuntime } from "../src/babylon/index.js";

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

describe("star field", () => {
  // What the field held when each star's squares were worked out with Babylon's vectors, one allocated for each step.
  it("draws each star's square and colour as before, in the Earth's axes and in a world turned, stretched and mirrored", async () => {
    const turned = Matrix.Compose(new Vector3(-2, 0.5, 3), Quaternion.RotationYawPitchRoll(-0.7, 0.4, 0.1), new Vector3(5, 6, 7));
    expect(await starsAt(0, null)).toEqual({ digest: "f59197c49a8e0130e6528358ab01fc4342f9f49c2dede0eeb865559cbf85666f", enabled: true, stars: 8404 });
    expect(await starsAt(0, turned)).toEqual({ digest: "3190131463372cbc98b5ab86dc384f2d4a849827eb69e3d8c58220abc62ce41c", enabled: true, stars: 8404 });
  });
});
