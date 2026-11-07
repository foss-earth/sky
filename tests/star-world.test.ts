import { FreeCamera, NullEngine, Quaternion, Scene, TransformNode, Vector3, VertexBuffer, type Mesh } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { SKY_PARAMETERS } from "../src/settings.js";
import { loadStarCatalogue, type StarCatalogue } from "../src/stars.js";
import { createSkyRuntime, type SkyRuntime } from "../src/babylon/index.js";

const engines: NullEngine[] = []; const skies: SkyRuntime[] = [];
afterEach(() => { for (const sky of skies.splice(0)) sky.dispose(); for (const engine of engines.splice(0)) engine.dispose(); });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Midnight over 0°N 0°E with the stars out. The world is a node under one that turns and moves, as a floating
 * origin's, and the sky reads its matrix as the globe gives it: built again through its parents at each read.
 */
function night(catalogue: StarCatalogue) {
  const engine = new NullEngine(); engines.push(engine);
  const scene = new Scene(engine);
  const camera = new FreeCamera("host-camera", new Vector3(6378637, 0, 0), scene); scene.activeCamera = camera; camera.getViewMatrix(true);
  const settings = createSettingsRegistry({ storage: null }); settings.register(SKY_PARAMETERS);
  settings.setMany({ "sky.model": "dome", "sky.dome.zenithSamples": 8, "sky.dome.azimuthSamples": 8, "sky.dome.integrationSteps": 4, "sky.time.mode": "fixed",
    "sky.time.date": "2026-03-20", "sky.time.utcHours": 0, "sky.moon.mode": "sky", "sky.stars.mode": "catalogue", "sky.nightLights.mode": "off",
    "sky.groundLight.mode": "uniform", "sky.exposure.mode": "fixed", "sky.exposure.ev100": -8 });
  const shift = new TransformNode("world-shift", scene), root = new TransformNode("world-root", scene);
  root.parent = shift; root.position.set(-6378137, 0, 0);
  let reads = 0;
  const sky = createSkyRuntime({ scene, settings, ecefToGeodetic: () => ({ latRad: 0, lonRad: 0, altMeters: 500 }), terrain: { setLighting: () => true, setLocalLights: () => {} },
    nightTilePorts: { fetchTile: async () => { throw new Error("Unexpected tile acquisition"); }, measureResponse: response => response, retryDelayMs: () => 2000, setNightLightMap: () => true },
    getWorldMatrix: () => { reads++; return root.computeWorldMatrix(true); }, requestRender: () => {}, onLightingChange: () => {}, isGround: () => false,
    now: () => 0, clock: () => 0, isHidden: () => false, timers: { set: () => 0, clear: () => {} }, loadStars: async () => catalogue }); skies.push(sky);
  return {
    turn(angle: number) { shift.rotationQuaternion = Quaternion.RotationYawPitchRoll(angle, angle / 2, -angle / 3); shift.position.set(100 * angle, 0, 0); },
    async frames(count: number) { reads = 0; for (let frame = 0; frame < count; frame++) { sky.update(); await settle(); } return reads; },
    stars: () => (scene.getMeshByName("sky-stars") as Mesh).getVerticesData(VertexBuffer.PositionKind)!.slice(),
    count: () => sky.getEnvironment()?.stars?.stars ?? 0,
  };
}

describe("The star field", () => {
  it("reads the world's matrix once for all its stars, and again at each update", async () => {
    const catalogue = await loadStarCatalogue();
    const flight = night(catalogue);
    await flight.frames(8);
    expect(flight.count()).toBeGreaterThan(1000);
    for (const angle of [0.01, 0.02, 0.03]) {
      flight.turn(angle);
      // The dome's turn, the lights and the star field each read it: a few reads, not one for each star.
      expect(await flight.frames(1)).toBeLessThan(20);
      const fresh = night(catalogue);
      fresh.turn(angle); await fresh.frames(8);
      expect(flight.stars()).toEqual(fresh.stars());
    }
  });
});
