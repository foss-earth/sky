import { FreeCamera, Matrix, Mesh, NullEngine, Scene, Vector3, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { SKY_PARAMETERS } from "../src/settings.js";
import { createSkyRuntime, type SkyRuntime, type SkyRuntimeOptions } from "../src/babylon/index.js";
import { createSkyEvaluationState, type SkyEvaluationRequest, type SkyEvaluationResult } from "../src/skyEvaluation.js";
import type { SkyEvaluator, SkyEvaluatorStatus } from "../src/skyEvaluationWorker.js";
import { loadStarCatalogue, type StarCatalogue } from "../src/stars.js";

const engines: NullEngine[] = []; const skies: SkyRuntime[] = [];
afterEach(() => { for (const sky of skies.splice(0)) sky.dispose(); for (const engine of engines.splice(0)) engine.dispose(); });

/** Dusk on the equator at the prime meridian, the Moon up, drawn as a dome. */
function harness(extra: Partial<SkyRuntimeOptions> = {}) {
  const engine = new NullEngine(); engines.push(engine); const scene = new Scene(engine);
  const camera = new FreeCamera("host-camera", new Vector3(6378637, 0, 0), scene); scene.activeCamera = camera; camera.getViewMatrix(true);
  const settings = createSettingsRegistry({ storage: null }); settings.register(SKY_PARAMETERS);
  settings.setMany({ "sky.model": "dome", "sky.time.mode": "fixed", "sky.time.date": "2026-10-17", "sky.time.utcHours": 17.9, "sky.moon.mode": "sky", "sky.stars.mode": "off", "sky.nightLights.mode": "off", "sky.groundLight.mode": "uniform" });
  const requestRender = vi.fn(); const setLighting = vi.fn(() => true); const onLightingChange = vi.fn();
  const sky = createSkyRuntime({
    scene, settings, ecefToGeodetic: () => ({ latRad: 0, lonRad: 0, altMeters: 500 }), terrain: { setLighting, setLocalLights: () => {} },
    nightTilePorts: { fetchTile: async () => { throw new Error("Unexpected tile acquisition"); }, measureResponse: response => response, retryDelayMs: () => 2000, setNightLightMap: () => true },
    getWorldMatrix: () => Matrix.Identity(), requestRender, onLightingChange, isGround: () => false, now: () => 0, clock: () => 0, isHidden: () => false,
    timers: { set: () => 0, clear: () => {} }, ...extra,
  }); skies.push(sky);
  return { scene, settings, sky, requestRender, setLighting, onLightingChange };
}

/** The worker's evaluation in this realm, its messages cloned as between threads; answers wait for `answer()` when held. */
function inProcess(hold = false) {
  const state = createSkyEvaluationState({ now: () => 0 });
  const held: Array<() => void> = [];
  const sent: SkyEvaluationRequest[] = [];
  let failure: Error | null = null;
  const dispose = vi.fn(() => state.dispose());
  const status = (): SkyEvaluatorStatus => ({ placement: "worker", kernel: "typescript", state: failure ? "failed" : "idle", failure: failure?.message ?? null,
    started: true, backend: null, jobs: sent.length, lastJob: null, totals: { roundTripMs: 0, workMs: 0 } });
  const evaluator: SkyEvaluator = {
    evaluate: request => new Promise<SkyEvaluationResult>((resolve, reject) => {
      sent.push(request);
      const run = () => { if (failure) reject(failure); else resolve(structuredClone(state.evaluate(structuredClone(request)).result)); };
      if (hold) held.push(run); else queueMicrotask(run);
    }),
    status, dispose,
  };
  return { evaluator, sent, dispose, answer: () => held.shift()?.(), fail: (error: Error) => { failure = error; } };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const drawn = (scene: Scene) => {
  const dome = scene.getMeshByName("sky-dome") as Mesh | null;
  const light = (name: string) => {
    const found = scene.getLightByName(name) as unknown as Record<string, { asArray?: () => number[] } | number> | null;
    return found && Object.fromEntries(["intensity", "diffuse", "specular", "groundColor", "direction"].filter(key => key in found)
      .map(key => [key, typeof found[key] === "number" ? found[key] : (found[key] as { asArray(): number[] }).asArray()]));
  };
  return {
    positions: Array.from(dome?.getVerticesData(VertexBuffer.PositionKind) ?? []),
    colors: Array.from(dome?.getVerticesData(VertexBuffer.ColorKind) ?? []),
    rotation: dome?.rotationQuaternion?.asArray(), scalingZ: dome?.scaling.z,
    sun: light("sky-sun"), sky: light("sky-light"), clear: scene.clearColor.asArray(),
  };
};

describe("Sky runtime with its evaluation away from the page", () => {
  it("matches all 9,096 GPU star colours in fixed/metered exposure and rejects a midflight exposure/FOV stamp", async () => {
    const catalogue = await loadStarCatalogue(), loadStars = async () => catalogue;
    let world = Matrix.Identity();
    const getWorldMatrix = () => world;
    const page = harness({ loadStars, getWorldMatrix }), away = inProcess(true), worker = harness({ loadStars, getWorldMatrix, evaluator: away.evaluator });
    for (const h of [page, worker]) h.settings.setMany({ "sky.stars.mode": "catalogue", "sky.stars.limitingMagnitude": 8.1,
      "sky.exposure.mode": "fixed", "sky.exposure.ev100": -8, "sky.time.utcHours": 0 });
    const compare = () => {
      expect(worker.sky.getEnvironment()?.stars?.stars).toBe(9096);
      for (const kind of [VertexBuffer.PositionKind, VertexBuffer.ColorKind]) {
        const a = new Float32Array((page.scene.getMeshByName("sky-stars") as Mesh).getVerticesData(kind)!);
        const b = new Float32Array((worker.scene.getMeshByName("sky-stars") as Mesh).getVerticesData(kind)!);
        expect(Buffer.compare(Buffer.from(a.buffer), Buffer.from(b.buffer))).toBe(0);
      }
    };
    for (let frame = 0; frame < 6; frame++) { page.sky.update(); worker.sky.update(); away.answer(); await settle(); }
    worker.sky.update(); compare(); expect(worker.sky.getEnvironment()?.stars?.atmosphere).toBe("worker");
    const beforeRotation = new Float32Array((worker.scene.getMeshByName("sky-stars") as Mesh).getVerticesData(VertexBuffer.PositionKind)!);
    world = Matrix.RotationYawPitchRoll(0.4, -0.2, 0.1);
    page.sky.update(); worker.sky.update(); compare();
    expect(worker.sky.getEnvironment()?.stars?.atmosphere).toBe("worker");
    expect((worker.scene.getMeshByName("sky-stars") as Mesh).getVerticesData(VertexBuffer.PositionKind)).not.toEqual(beforeRotation);
    away.answer(); await settle(); worker.sky.update(); compare();
    for (const h of [page, worker]) { h.settings.set("sky.time.utcHours", 1); h.sky.update(); }
    const sent = away.sent.at(-1)!.stars!;
    expect("generation" in sent && sent.catalogue === undefined).toBe(true);
    // The reply's colors were computed for the old exposure and pixel solid angle.
    for (const h of [page, worker]) { h.settings.set("sky.exposure.ev100", -7); h.scene.activeCamera!.fov *= 1.2; h.sky.update(); }
    away.answer(); await settle(); worker.sky.update(); compare();
    expect(worker.sky.getEnvironment()?.stars?.atmosphere).toBe("page");
    for (const [index, adaptation, min, max] of [[0, 0.75, 1, 16], [1, 1, -12, 20], [2, 0.2, 12, 14]] as const) {
      for (const h of [page, worker]) { h.settings.setMany({ "sky.time.utcHours": 2 + index, "sky.exposure.mode": "metered",
        "sky.exposure.adaptation": adaptation, "sky.exposure.meterRange": { min, max } }); h.sky.update(); }
      away.answer(); await settle(); worker.sky.update(); compare();
      expect(worker.sky.getEnvironment()?.stars?.atmosphere).toBe("worker");
      const request = away.sent.at(-1)!.stars!;
      expect("generation" in request && request.catalogue === undefined).toBe(true);
    }
  });

  it("matches the star colours where the meter reads partly the ground below", async () => {
    const catalogue = await loadStarCatalogue(), loadStars = async () => catalogue;
    // 40 km up at dusk: a quarter of the way, by default, from the light at the viewpoint to that on the ground below,
    // and the stars halfway from the scene's exposure to the darkest.
    const ecefToGeodetic = () => ({ latRad: 0, lonRad: 0, altMeters: 40_000 });
    const page = harness({ loadStars, ecefToGeodetic }), away = inProcess(true), worker = harness({ loadStars, ecefToGeodetic, evaluator: away.evaluator });
    for (const h of [page, worker]) h.settings.setMany({ "sky.stars.mode": "catalogue", "sky.time.utcHours": 18 });
    for (let frame = 0; frame < 6; frame++) { page.sky.update(); worker.sky.update(); away.answer(); await settle(); }
    worker.sky.update();
    const sky = worker.sky.getEnvironment()!;
    expect(sky.meterGroundShare).toBeCloseTo(0.25, 12);
    expect(Math.abs(sky.meteredEv100 - Math.log2(0.4 * sky.illumination.meteredLux))).toBeGreaterThan(1);
    expect(sky.stars).toMatchObject({ atmosphere: "worker", visible: true });
    expect(page.sky.getEnvironment()).toMatchObject({ ev100: sky.ev100, starEv100: sky.starEv100 });
    for (const kind of [VertexBuffer.PositionKind, VertexBuffer.ColorKind]) {
      const a = new Float32Array((page.scene.getMeshByName("sky-stars") as Mesh).getVerticesData(kind)!);
      const b = new Float32Array((worker.scene.getMeshByName("sky-stars") as Mesh).getVerticesData(kind)!);
      expect(Buffer.compare(Buffer.from(a.buffer), Buffer.from(b.buffer))).toBe(0);
    }
  });

  it("uses only the current illumination's star batch and falls back exactly after selection changes or worker retirement", async () => {
    const catalogue: StarCatalogue = { count: 3, raDeg: new Float32Array([0, 90, 180]), decDeg: new Float32Array(3),
      vmag: new Float32Array([-1, 0, 1]), colourIndex: new Float32Array([0.1, 0.6, 1]), pmRaArcsec: new Float32Array(3), pmDecArcsec: new Float32Array(3) };
    const loadStars = async () => catalogue;
    let world = Matrix.Identity();
    const getWorldMatrix = () => world;
    const page = harness({ loadStars, getWorldMatrix }), away = inProcess(), worker = harness({ loadStars, getWorldMatrix, evaluator: away.evaluator });
    for (const h of [page, worker]) h.settings.setMany({ "sky.stars.mode": "catalogue", "sky.exposure.mode": "fixed", "sky.exposure.ev100": -8, "sky.time.utcHours": 0 });
    const starsDrawn = (scene: Scene) => {
      const mesh = scene.getMeshByName("sky-stars") as Mesh;
      return [mesh.isEnabled(), Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!), Array.from(mesh.getVerticesData(VertexBuffer.ColorKind)!)];
    };
    for (let frame = 0; frame < 5; frame++) { page.sky.update(); worker.sky.update(); await settle(); }
    expect(away.sent.some(request => request.stars && "generation" in request.stars && request.stars.catalogue?.directions.length === 9)).toBe(true);
    expect(worker.sky.getEnvironment()?.stars?.atmosphere).toBe("worker");
    expect(starsDrawn(worker.scene)).toEqual(starsDrawn(page.scene));
    const beforeRotation = starsDrawn(worker.scene);
    const illuminationBeforeRotation = worker.sky.getEnvironment()!.illumination;
    world = Matrix.RotationZ(0.3);
    page.sky.update(); worker.sky.update();
    const afterRotation = starsDrawn(worker.scene);
    expect(afterRotation[1]).not.toEqual(beforeRotation[1]);
    expect(afterRotation[2]).toEqual(beforeRotation[2]);
    expect(afterRotation).toEqual(starsDrawn(page.scene));
    expect(worker.sky.getEnvironment()!.illumination).toBe(illuminationBeforeRotation);
    await settle(); worker.sky.update();
    // A/B changes only the atmosphere work's placement while retaining the same sky worker.
    for (const placement of ["page", "worker"] as const) {
      worker.settings.set("sky.stars.atmosphere", placement); worker.sky.update(); await settle(); worker.sky.update();
      expect(worker.sky.getEnvironment()?.stars?.atmosphere).toBe(placement);
      expect(starsDrawn(worker.scene)).toEqual(starsDrawn(page.scene));
      expect(Boolean(away.sent.at(-1)?.stars)).toBe(placement === "worker");
    }
    // Changing a presented-only selection cannot consume the old selection's batch.
    for (const h of [page, worker]) { h.settings.set("sky.stars.limitingMagnitude", -0.5); h.sky.update(); }
    expect(worker.sky.getEnvironment()?.stars?.atmosphere).toBe("page");
    expect(starsDrawn(worker.scene)).toEqual(starsDrawn(page.scene));
    // The next sky update gets a batch for the selected star and that exact timestamp.
    for (const h of [page, worker]) { h.settings.set("sky.time.utcHours", 1); h.sky.update(); }
    await settle(); worker.sky.update();
    expect(worker.sky.getEnvironment()?.stars?.atmosphere).toBe("worker");
    expect(starsDrawn(worker.scene)).toEqual(starsDrawn(page.scene));
    away.fail(new Error("worker-timeout"));
    for (const h of [page, worker]) { h.settings.set("sky.time.utcHours", 2); h.sky.update(); }
    await settle(); worker.sky.update();
    expect(worker.sky.getEnvironment()?.stars?.atmosphere).toBe("page");
    expect(starsDrawn(worker.scene)).toEqual(starsDrawn(page.scene));
  });

  it("draws what the page's own evaluation draws", async () => {
    const page = harness();
    const away = inProcess();
    const worker = harness({ evaluator: away.evaluator });
    for (const hours of [17.9, 18.6]) {
      page.settings.set("sky.time.utcHours", hours); worker.settings.set("sky.time.utcHours", hours);
      page.sky.update();
      worker.sky.update();
      await settle();
      worker.sky.update();
      expect(worker.sky.getEnvironment()).toEqual(page.sky.getEnvironment());
      const shown = drawn(worker.scene);
      expect(shown.colors.length).toBeGreaterThan(0);
      expect(shown.sun?.intensity).toBeGreaterThan(0);
      expect(shown).toEqual(drawn(page.scene));
      expect(worker.setLighting.mock.calls.at(-1)).toEqual(page.setLighting.mock.calls.at(-1));
    }
    // The air was sent once, with the first evaluation.
    expect(away.sent).toHaveLength(2);
    expect(worker.sky.getEvaluation()).toMatchObject({ placement: "worker", retired: null });
    expect(page.sky.getEvaluation()).toEqual({ placement: "page", retired: null, evaluator: null });
    worker.sky.dispose();
    expect(away.dispose).toHaveBeenCalledOnce();
  });

  it("lights nothing until the first answer, and drops an answer asked for before the sky was turned off", async () => {
    const away = inProcess(true);
    const h = harness({ evaluator: away.evaluator });
    h.sky.update();
    expect(h.sky.isLighting()).toBe(false);
    expect(h.sky.getEnvironment()).toBeNull();
    h.settings.set("sky.model", "off");
    h.sky.update();
    away.answer();
    await settle();
    h.sky.update();
    expect(h.sky.getEnvironment()).toBeNull();
    expect(h.onLightingChange).not.toHaveBeenCalled();
    h.settings.set("sky.model", "dome");
    h.sky.update();
    expect(away.sent).toHaveLength(2);
    away.answer();
    await settle();
    h.sky.update();
    expect(h.sky.getEnvironment()?.model).toBe("dome");
    expect(h.onLightingChange).toHaveBeenCalledWith(true);
  });

  it("keeps one request outstanding and sends only the latest behind it", async () => {
    const away = inProcess(true);
    const h = harness({ evaluator: away.evaluator });
    h.sky.update();
    for (const hours of [18, 18.2, 18.4]) { h.settings.set("sky.time.utcHours", hours); h.sky.update(); }
    expect(away.sent).toHaveLength(1);
    away.answer();
    await settle();
    expect(away.sent).toHaveLength(2);
    expect(away.sent[1].ephemeris.utcMs).toBe(Date.UTC(2026, 9, 17) + 18.4 * 3_600_000);
  });

  it("retires a failed evaluator and evaluates on the page from the next frame", async () => {
    const away = inProcess(true);
    const h = harness({ evaluator: away.evaluator });
    h.sky.update();
    away.fail(new Error("worker-timeout"));
    away.answer();
    await settle();
    expect(away.dispose).toHaveBeenCalledOnce();
    expect(h.sky.getEvaluation()).toMatchObject({ placement: "page", retired: "worker-timeout", evaluator: { failure: "worker-timeout" } });
    h.sky.update();
    expect(h.sky.getEnvironment()?.model).toBe("dome");
    const reference = harness();
    reference.sky.update();
    expect(drawn(h.scene)).toEqual(drawn(reference.scene));
  });
});
