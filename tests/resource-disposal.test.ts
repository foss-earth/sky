import { Mesh, NullEngine, Scene, StandardMaterial, Vector3, type BaseTexture } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGroundLightProbe, createLightPoints, createStarField } from "../src/babylon/index.js";

const engines: NullEngine[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const engine of engines.splice(0)) engine.dispose(); });
function sceneFixture(): Scene {
  const engine = new NullEngine(); engines.push(engine); return new Scene(engine);
}
function failingRelease(resource: { dispose(): void }, failure: Error) {
  const release = resource.dispose.bind(resource);
  return vi.spyOn(resource, "dispose").mockImplementation(() => { release(); throw failure; });
}

describe("Sky public Babylon resource disposal", () => {
  it("releases the probe camera after target failure and suppresses a completed readback", async () => {
    const scene = sceneFixture(), onReading = vi.fn(); let complete: (pixels: ArrayBufferView) => void = () => {};
    const probe = createGroundLightProbe({ scene, clock: () => 10, isSeen: () => false, onReading,
      readPixels: () => new Promise<ArrayBufferView>(resolve => { complete = resolve; }),
    });
    probe.request(new Vector3(0, 100, 0), Vector3.Up(), { sizePx: 2, fieldOfViewDeg: 120 }, 1);
    const target = scene.customRenderTargets[0], camera = target.activeCamera!, failure = new Error("target release");
    target.onAfterUnbindObservable.notifyObservers(target);
    const targetDispose = failingRelease(target, failure), cameraDispose = vi.spyOn(camera, "dispose");
    let caught: unknown; try { probe.dispose(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError); expect((caught as AggregateError).errors).toEqual([failure]);
    expect(targetDispose).toHaveBeenCalledOnce(); expect(cameraDispose).toHaveBeenCalledOnce(); expect(scene.customRenderTargets).toHaveLength(0); expect(probe.busy()).toBe(false);
    probe.dispose(); expect(targetDispose).toHaveBeenCalledOnce(); expect(cameraDispose).toHaveBeenCalledOnce();
    complete(new Uint8Array(16)); await Promise.resolve(); await Promise.resolve(); expect(onReading).not.toHaveBeenCalled();
    expect(probe.request(Vector3.Zero(), Vector3.Up(), { sizePx: 2, fieldOfViewDeg: 120 }, 1)).toBe(false);
  });

  it("releases star material and texture after a mesh failure exactly once", () => {
    const scene = sceneFixture(), field = createStarField(scene, { clock: () => 0 });
    const mesh = scene.getMeshByName("sky-stars") as Mesh, material = mesh.material as StandardMaterial, texture = material.diffuseTexture as BaseTexture;
    const failures = [new Error("star mesh"), new Error("star material"), new Error("star texture")];
    const disposers = [failingRelease(mesh, failures[0]), failingRelease(material, failures[1]), failingRelease(texture, failures[2])];
    let caught: unknown; try { field.dispose(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError); expect((caught as AggregateError).errors).toEqual(failures);
    for (const dispose of disposers) expect(dispose).toHaveBeenCalledOnce();
    expect(scene.getMeshByName("sky-stars")).toBeNull(); expect(scene.getMaterialByName("sky-stars-material")).toBeNull(); expect(scene.textures).not.toContain(texture);
    field.dispose(); for (const dispose of disposers) expect(dispose).toHaveBeenCalledOnce();
  });

  it("releases point resources after observer removal failure and rejects late observer and setter work", () => {
    const scene = sceneFixture(), points = createLightPoints(scene, { getWhiteLuminance: () => 1, referenceWhiteLuminance: () => 1, sizePx: () => 8, liftMeters: () => 0 });
    const mesh = scene.getMeshByName("light-points") as Mesh, material = mesh.material as StandardMaterial, texture = material.diffuseTexture as BaseTexture;
    const failure = new Error("observer removal"), remove = vi.spyOn(scene.onBeforeRenderObservable, "remove").mockImplementation(() => { throw failure; });
    const meshDispose = vi.spyOn(mesh, "dispose"), materialDispose = vi.spyOn(material, "dispose"), textureDispose = vi.spyOn(texture, "dispose");
    let caught: unknown; try { points.dispose(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError); expect((caught as AggregateError).errors).toEqual([failure]);
    expect(remove).toHaveBeenCalledOnce(); expect(meshDispose).toHaveBeenCalledOnce(); expect(materialDispose).toHaveBeenCalledOnce(); expect(textureDispose).toHaveBeenCalledOnce();
    const setEnabled = vi.spyOn(mesh, "setEnabled"), setVerticesData = vi.spyOn(mesh, "setVerticesData");
    scene.onBeforeRenderObservable.notifyObservers(scene); points.update(); points.setPoints([]); points.dispose();
    expect(setEnabled).not.toHaveBeenCalled(); expect(setVerticesData).not.toHaveBeenCalled(); expect(remove).toHaveBeenCalledOnce(); expect(points.getPeak()).toBe(0);
  });
});
