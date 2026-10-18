import { Matrix, Mesh, NullEngine, Scene, Vector3, VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAtmosphere, type Rgb } from "../src/atmosphere.js";
import { createStarField, starImageMean, type StarFieldView } from "../src/babylon/createStarField.js";
import { computeSkyIllumination, observerFromGeodetic, whiteLuminanceForEv100 } from "../src/skyState.js";
import { createStarColorEvaluationState, evaluateStarAtmosphere, type StarEvaluationRequest } from "../src/starAtmosphere.js";
import { solarEphemeris } from "../src/solarPosition.js";
import { celestialToEcefMatrix, loadStarCatalogue, starDirections } from "../src/stars.js";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });
const bytes = (array: Float32Array | Float64Array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
const equalBits = (a: Float32Array | Float64Array, b: Float32Array | Float64Array) => expect(Buffer.compare(Buffer.from(bytes(a)), Buffer.from(bytes(b)))).toBe(0);

describe("heading-independent star atmosphere batches", () => {
  it("retains the full catalogue and returns final GPU colours exactly, with page fallback for changed exposure or FOV", async () => {
    const catalogue = await loadStarCatalogue(), directions = starDirections(catalogue, 27, 8.1), state = createStarColorEvaluationState();
    const atmosphere = createAtmosphere({ aerosolOpticalDepth: 0.1, groundAlbedo: 0.3 });
    const engine = new NullEngine(); engines.push(engine);
    const pageScene = new Scene(engine), workerScene = new Scene(engine);
    const page = createStarField(pageScene, { clock: () => 0 }), worker = createStarField(workerScene, { clock: () => 0 });
    const compare = () => {
      for (const kind of [VertexBuffer.PositionKind, VertexBuffer.ColorKind]) {
        const original = (pageScene.getMeshByName("sky-stars") as Mesh).getVerticesData(kind)!;
        const result = (workerScene.getMeshByName("sky-stars") as Mesh).getVerticesData(kind)!;
        equalBits(new Float32Array(result), new Float32Array(original));
      }
    };
    let supplied = false;
    for (const altitude of [0, 40_000, 150_000]) {
      const observer = observerFromGeodetic([6378137 + altitude, 0, 0], { latRad: 0, lonRad: 0, altMeters: altitude });
      const utcMs = Date.UTC(2026, 9, 17, 23) + altitude, toEcef = celestialToEcefMatrix(utcMs);
      const illumination = computeSkyIllumination(atmosphere, solarEphemeris(utcMs), observer, { nightLuminance: 0.001 });
      const request: StarEvaluationRequest = { generation: 1, toEcef,
        catalogue: supplied ? undefined : { directions, vmag: catalogue.vmag, colourIndex: catalogue.colourIndex, solarIlluminanceAt1AuLux: 128_000 },
        presentation: { mode: "fixed", ev100: -8, adaptation: 0.75, meterRange: { min: 1, max: 16 }, daylightAltitude: { min: 15, max: 80 },
          sizePx: 2, pixelAngle: 0.001, imageMean: starImageMean() } };
      const batch = state.evaluate(structuredClone(request), illumination, atmosphere); supplied = true;
      expect(batch.transmittance.byteLength).toBe(0);
      expect(batch.ecef.byteLength).toBe(0);
      expect(batch.colors!.rgb.byteLength).toBe(catalogue.count * 12);
      for (const [scale, pixelAngle, accepted] of [[1 / whiteLuminanceForEv100(-8), 0.001, true],
        [1 / whiteLuminanceForEv100(-6), 0.001, false], [1 / whiteLuminanceForEv100(-8), 0.0013, false]] as const) {
        for (const [heading, rotation] of [Matrix.Identity(), Matrix.RotationYawPitchRoll(1.1, -0.5, 0.4)].entries()) {
          const view: StarFieldView = { catalogue, years: 27, toEcef, observer, atmosphere, solarIlluminanceAt1AuLux: 128_000, scale,
            sizePx: 2, pixelAngle, limitingMagnitude: 8.1,
            toScene: (x, y, z) => Vector3.TransformNormal(new Vector3(x, y, z), rotation).normalize() };
          page.update(view);
          const sample = vi.spyOn(atmosphere, "sunTransmittance");
          const cost = worker.update({ ...view, atmosphereBatch: batch });
          expect(sample).toHaveBeenCalledTimes(accepted || heading > 0 ? 0 : catalogue.count); sample.mockRestore();
          expect(cost.atmosphere).toBe(accepted ? "worker" : "page"); compare();
        }
      }
    }
    state.dispose(); page.dispose(); worker.dispose();
    expect(() => state.evaluate({ generation: 1, toEcef: celestialToEcefMatrix(0), presentation: { mode: "fixed", ev100: 0, adaptation: 1,
      meterRange: null, daylightAltitude: null, sizePx: 2, pixelAngle: 0.001, imageMean: starImageMean() } },
    computeSkyIllumination(atmosphere, solarEphemeris(0), observerFromGeodetic([6378137, 0, 0], { latRad: 0, lonRad: 0, altMeters: 0 }), { nightLuminance: 0 }), atmosphere)).toThrow("disposed");
  });

  it("keeps all catalogue matrix products, atmosphere samples and rendered buffers bit-identical", async () => {
    const catalogue = await loadStarCatalogue();
    const directions = starDirections(catalogue, 27, 8.1);
    const atmosphere = createAtmosphere({ aerosolOpticalDepth: 0.1, groundAlbedo: 0.3 });
    const engine = new NullEngine(); engines.push(engine);
    const referenceScene = new Scene(engine), batchScene = new Scene(engine);
    const reference = createStarField(referenceScene, { clock: () => 0 }), batched = createStarField(batchScene, { clock: () => 0 });
    for (const altitude of [0, 40_000, 150_000]) {
      const observer = observerFromGeodetic([6378137 + altitude, 0, 0], { latRad: 0, lonRad: 0, altMeters: altitude });
      const toEcef = celestialToEcefMatrix(Date.UTC(2026, 9, 17, 23) + altitude);
      const batch = evaluateStarAtmosphere({ directions, toEcef }, observer, atmosphere);
      const originalEcef = new Float64Array(directions.length), originalTransmittance = new Float64Array(directions.length);
      const sample: Rgb = [0, 0, 0];
      for (let at = 0; at < directions.length; at += 3) {
        const sx = directions[at], sy = directions[at + 1], sz = directions[at + 2], m = toEcef;
        const x = m[0] * sx + m[1] * sy + m[2] * sz;
        const y = m[3] * sx + m[4] * sy + m[5] * sz;
        const z = m[6] * sx + m[7] * sy + m[8] * sz;
        originalEcef.set([x, y, z], at);
        atmosphere.sunTransmittance(Math.max(0, observer.altitudeMeters), x * observer.up[0] + y * observer.up[1] + z * observer.up[2], sample);
        originalTransmittance.set(sample, at);
      }
      equalBits(batch.ecef, originalEcef);
      equalBits(batch.transmittance, originalTransmittance);
      const transferred = structuredClone(batch);
      for (const [heading, rotation] of [Matrix.Identity(), Matrix.RotationYawPitchRoll(1.1, -0.5, 0.4)].entries()) {
        const view: StarFieldView = { catalogue, years: 27, toEcef, observer, atmosphere,
          solarIlluminanceAt1AuLux: 128_000, scale: 1000, sizePx: 2, pixelAngle: 0.001, limitingMagnitude: 8.1,
          toScene: (x, y, z) => Vector3.TransformNormal(new Vector3(x, y, z), rotation).normalize() };
        const pageSample = vi.spyOn(atmosphere, "sunTransmittance");
        const pageCost = reference.update(view);
        expect(pageSample).toHaveBeenCalledTimes(heading === 0 ? directions.length / 3 : 0); pageSample.mockRestore();
        const sample = vi.spyOn(atmosphere, "sunTransmittance");
        const upload = vi.spyOn(batchScene.getMeshByName("sky-stars") as Mesh, "updateVerticesData");
        const workerCost = batched.update({ ...view, atmosphereBatch: transferred });
        expect(sample).not.toHaveBeenCalled(); sample.mockRestore();
        expect(upload.mock.calls.filter(([kind]) => kind === VertexBuffer.ColorKind)).toHaveLength(heading === 0 ? 1 : 0); upload.mockRestore();
        expect(workerCost).toEqual({ ...pageCost, atmosphere: "worker" });
        expect(workerCost.visible).toBe(true);
        for (const kind of [VertexBuffer.PositionKind, VertexBuffer.ColorKind]) {
          const original = (referenceScene.getMeshByName("sky-stars") as Mesh).getVerticesData(kind)!;
          const fromBatch = (batchScene.getMeshByName("sky-stars") as Mesh).getVerticesData(kind)!;
          equalBits(new Float32Array(fromBatch), new Float32Array(original));
        }
      }
    }
    reference.dispose(); batched.dispose();
  });

  it("bounds malformed batches before allocating output", () => {
    const atmosphere = createAtmosphere({ aerosolOpticalDepth: 0.1, groundAlbedo: 0.3 });
    const observer = observerFromGeodetic([6378137, 0, 0], { latRad: 0, lonRad: 0, altMeters: 0 });
    const toEcef = celestialToEcefMatrix(Date.UTC(2026, 9, 17));
    for (const directions of [new Float32Array(2), new Float32Array(300_003)]) {
      expect(() => evaluateStarAtmosphere({ directions, toEcef }, observer, atmosphere)).toThrow(RangeError);
    }
  });
});
