import { FreeCamera, Matrix, NullEngine, Scene, Vector3, VertexBuffer, type DirectionalLight, type Mesh } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { SKY_PARAMETERS } from "../src/settings.js";
import { createSkyEvaluationState, type SkyEvaluationResult } from "../src/skyEvaluation.js";
import type { SkyEvaluator, SkyEvaluatorStatus } from "../src/skyEvaluationWorker.js";
import { loadStarCatalogue, type StarCatalogue } from "../src/stars.js";
import { createSkyRuntime, type SkyRuntime } from "../src/babylon/index.js";

const engines: NullEngine[] = []; const skies: SkyRuntime[] = [];
afterEach(() => { for (const sky of skies.splice(0)) sky.dispose(); for (const engine of engines.splice(0)) engine.dispose(); });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** The worker's evaluation in this realm, its messages cloned as between threads. */
function inProcess(): SkyEvaluator {
  const state = createSkyEvaluationState({ now: () => 0 });
  const status = (): SkyEvaluatorStatus => ({ placement: "worker", kernel: "typescript", state: "idle", failure: null,
    started: true, backend: null, jobs: 0, lastJob: null, totals: { roundTripMs: 0, workMs: 0 } });
  return { evaluate: request => new Promise<SkyEvaluationResult>(resolve => queueMicrotask(() => resolve(structuredClone(state.evaluate(structuredClone(request)).result)))),
    status, dispose: () => state.dispose() };
}

/** Midnight over 0°N 0°E with the stars out, at a fixed exposure: what the dome's vertex buffers were last sent, and how often. */
function night(catalogue: StarCatalogue, evaluator: SkyEvaluator | undefined, settingsAt: Record<string, unknown> = {}) {
  const engine = new NullEngine(); engines.push(engine);
  const sent = new Map<unknown, Float32Array>(), counts = new Map<unknown, number>();
  const send = engine.updateDynamicVertexBuffer.bind(engine);
  engine.updateDynamicVertexBuffer = ((buffer: never, data: Float32Array, byteOffset?: number, byteLength?: number) => {
    send(buffer, data, byteOffset, byteLength); sent.set(buffer, Float32Array.from(data)); counts.set(buffer, (counts.get(buffer) ?? 0) + 1);
  }) as typeof engine.updateDynamicVertexBuffer;
  const scene = new Scene(engine);
  const camera = new FreeCamera("host-camera", new Vector3(6378637, 0, 0), scene); scene.activeCamera = camera; camera.getViewMatrix(true);
  const settings = createSettingsRegistry({ storage: null }); settings.register(SKY_PARAMETERS);
  settings.setMany({ "sky.model": "dome", "sky.dome.zenithSamples": 8, "sky.dome.azimuthSamples": 8, "sky.dome.integrationSteps": 4, "sky.time.mode": "fixed",
    "sky.time.date": "2026-03-20", "sky.time.utcHours": 0, "sky.moon.mode": "sky", "sky.stars.mode": "catalogue", "sky.nightLights.mode": "off",
    "sky.groundLight.mode": "uniform", "sky.exposure.mode": "fixed", "sky.exposure.ev100": -8, ...settingsAt });
  let world = Matrix.Identity();
  const sky = createSkyRuntime({ scene, settings, ecefToGeodetic: () => ({ latRad: 0, lonRad: 0, altMeters: 500 }), terrain: { setLighting: () => true, setLocalLights: () => {} },
    nightTilePorts: { fetchTile: async () => { throw new Error("Unexpected tile acquisition"); }, measureResponse: response => response, retryDelayMs: () => 2000, setNightLightMap: () => true },
    getWorldMatrix: () => world, requestRender: () => {}, onLightingChange: () => {}, isGround: () => false, now: () => 0, clock: () => 0, isHidden: () => false,
    timers: { set: () => 0, clear: () => {} }, loadStars: async () => catalogue, evaluator }); skies.push(sky);
  const buffers = () => { const mesh = scene.getMeshByName("sky-dome") as Mesh; return [VertexBuffer.PositionKind, VertexBuffer.ColorKind].map(kind => mesh.getVertexBuffer(kind)!.getBuffer()); };
  return {
    settings,
    turn(angle: number) { world = Matrix.RotationYawPitchRoll(angle, angle / 2, 0); },
    async frames(count: number) { for (let frame = 0; frame < count; frame++) { sky.update(); await settle(); } },
    dome: () => buffers().map(buffer => sent.get(buffer)),
    uploads: () => buffers().map(buffer => counts.get(buffer) ?? 0),
    sun: () => (scene.getLightByName("sky-sun") as DirectionalLight).direction.asArray(),
    stars: () => (scene.getMeshByName("sky-stars") as Mesh).getVerticesData(VertexBuffer.PositionKind)!.slice(),
  };
}

describe("The sky dome's vertices", () => {
  for (const worker of [false, true]) {
    it(`are sent again when the dome is filled again or the exposure changes, not when the world turns (${worker ? "worker" : "page"})`, async () => {
      const catalogue = await loadStarCatalogue();
      const flight = night(catalogue, worker ? inProcess() : undefined);
      await flight.frames(8);
      const first = flight.uploads();
      expect(first.every(count => count > 0)).toBe(true);
      // A moving floating origin turns the world each frame: the stars and the lights follow it, and the dome's vertices stay.
      for (let frame = 1; frame <= 5; frame++) {
        const sun = flight.sun(), stars = flight.stars();
        flight.turn(0.002 * frame); await flight.frames(1);
        expect(flight.sun()).not.toEqual(sun);
        expect(flight.stars()).not.toEqual(stars);
      }
      expect(flight.uploads()).toEqual(first);
      // A new evaluation at the same exposure, then a new exposure of the same evaluation: each sends what a new sky would.
      for (const [change, settled] of [[{ "sky.time.utcHours": 0.5 }, 3], [{ "sky.exposure.ev100": -7 }, 1]] as const) {
        const before = flight.uploads();
        flight.settings.setMany(change); await flight.frames(settled);
        expect(flight.uploads().every((count, index) => count === before[index] + 1)).toBe(true);
        const fresh = night(catalogue, worker ? inProcess() : undefined, { "sky.time.utcHours": 0.5, ...change });
        fresh.turn(0.01); await fresh.frames(8);
        expect(flight.dome()).toEqual(fresh.dome());
      }
    });
  }
});
