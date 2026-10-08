// @vitest-environment jsdom
import { FreeCamera, MeshBuilder, NullEngine, Scene, Vector3, type RenderTargetTexture } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGroundLightProbe, meanGroundRadiance, type GroundLightReading } from "./createGroundLightProbe";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

/** An image of one colour, display-encoded bytes. */
function uniformImage(size: number, linear: [number, number, number]): Uint8Array {
  const bytes = new Uint8Array(size * size * 4);
  for (let pixel = 0; pixel < size * size; pixel++) {
    for (let band = 0; band < 3; band++) bytes[pixel * 4 + band] = Math.round(linear[band] ** (1 / 2.2) * 255);
    bytes[pixel * 4 + 3] = 255;
  }
  return bytes;
}

describe("ground light probe", () => {
  it("averages the image as a surface facing down receives it: cos⁴ from the axis, decoded, the compensation taken off", () => {
    // A uniform ground reads as itself, whatever the field of view.
    const uniform = meanGroundRadiance(uniformImage(16, [0.2, 0.1, 0.05]), 16, 120, 1);
    expect(uniform[0]).toBeCloseTo(0.2, 2);
    expect(uniform[2]).toBeCloseTo(0.05, 2);
    // Drawn twice as bright by exposure compensation, it is the same light.
    expect(meanGroundRadiance(uniformImage(16, [0.4, 0.2, 0.1]), 16, 120, 2)[1]).toBeCloseTo(0.1, 2);
    // Straight below counts more than the edge: a bright centre outweighs a bright rim of the same area.
    const size = 16;
    const centre = new Uint8Array(size * size * 4);
    const rim = new Uint8Array(size * size * 4);
    let rimPixels = 0;
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        const at = (row * size + column) * 4;
        const edge = row === 0 || column === 0 || row === size - 1 || column === size - 1;
        if (edge) rimPixels++;
        const middle = Math.abs(row - 7.5) < 4 && Math.abs(column - 7.5) < 4;
        if (edge) rim.set([255, 255, 255, 255], at);
        if (middle) centre.set([255, 255, 255, 255], at);
      }
    }
    expect(rimPixels).toBe(60);
    expect(meanGroundRadiance(centre, size, 120, 1)[0]).toBeGreaterThan(meanGroundRadiance(rim, size, 120, 1)[0]);
  });

  it("renders the ground below once when asked, reads it back, and takes no second request while one is on its way", async () => {
    const engine = new NullEngine();
    engines.push(engine);
    const scene = new Scene(engine);
    scene.activeCamera = new FreeCamera("view", new Vector3(0, 100, 0), scene);
    scene.activeCamera.maxZ = 50_000;
    const ground = MeshBuilder.CreateGround("ground", { width: 1000, height: 1000 }, scene);
    ground.metadata = { mapSurface: true };
    const aircraft = MeshBuilder.CreateBox("aircraft", { size: 10 }, scene);
    const readings: GroundLightReading[] = [];
    let resolve: ((pixels: ArrayBufferView) => void) | null = null;
    const readPixels = vi.fn((_target: RenderTargetTexture, buffer: Uint8Array) => new Promise<ArrayBufferView>(done => {
      resolve = () => { buffer.set(uniformImage(Math.sqrt(buffer.length / 4), [0.1, 0.2, 0.05])); done(buffer); };
    }));
    let clock = 0;
    const probe = createGroundLightProbe({
      scene,
      isSeen: mesh => Boolean(mesh.metadata?.mapSurface),
      readPixels,
      onReading: reading => readings.push(reading),
      clock: () => clock,
    });
    expect(probe.request(new Vector3(0, 300, 0), Vector3.Up(), { sizePx: 8, fieldOfViewDeg: 120 }, 1)).toBe(true);
    // A render target of its own, seeing only the ground, from a camera looking straight down.
    const target = scene.customRenderTargets.find(texture => texture.name === "sky-ground-probe")!;
    expect(target.getSize()).toEqual({ width: 8, height: 8 });
    // Babylon decorates its render list's array; its meshes are what matters.
    expect([...target.renderList!]).toEqual([ground]);
    expect(target.renderList).not.toContain(aircraft);
    const camera = target.activeCamera!;
    expect(Vector3.Distance(camera.position, new Vector3(0, 300, 0))).toBeLessThan(0.01);
    expect(camera.getForwardRay().direction.y).toBeCloseTo(-1, 9);
    expect(camera.fov).toBeCloseTo((120 * Math.PI) / 180, 9);
    expect(camera.maxZ).toBe(50_000);
    expect(probe.busy()).toBe(true);
    expect(probe.request(new Vector3(0, 300, 0), Vector3.Up(), { sizePx: 8, fieldOfViewDeg: 120 }, 1)).toBe(false);
    // The frame renders it; the read-back follows when the GPU is done.
    target.onAfterUnbindObservable.notifyObservers(target);
    expect(readPixels).toHaveBeenCalledOnce();
    clock = 4;
    resolve!(new Uint8Array(0));
    await Promise.resolve();
    await Promise.resolve();
    expect(readings).toHaveLength(1);
    expect(readings[0].rgb[1]).toBeCloseTo(0.2, 2);
    expect(readings[0]).toMatchObject({ pixels: 64, latencyMs: 4 });
    expect(probe.busy()).toBe(false);
    probe.dispose();
    expect(scene.customRenderTargets).toHaveLength(0);
  });
});
