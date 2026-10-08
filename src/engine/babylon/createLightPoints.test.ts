// @vitest-environment jsdom
import { FreeCamera, NullEngine, Scene, StandardMaterial, TransformNode, Vector3, VertexBuffer, type Mesh } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createLightPoints, type LightPoint } from "./createLightPoints";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function setup(white: number | null) {
  const engine = new NullEngine({ renderWidth: 1000, renderHeight: 1000, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 1 });
  engines.push(engine);
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -20), scene);
  camera.fov = 1;
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  const points = createLightPoints(scene, {
    getWhiteLuminance: () => white,
    referenceWhiteLuminance: () => 1000,
    sizePx: () => 32,
    liftMeters: () => 0.3,
  });
  return { scene, camera, points, mesh: () => scene.getMeshByName("light-points") as Mesh };
}

/** A light shining one way only: along its node's +Z, or -Z, 40 cd within 60° of it. */
const forwardLight = (parent: TransformNode | null, position: Vector3, axis: 1 | -1 = 1): LightPoint => ({
  parent,
  position,
  intensityToward(toward, out) {
    const intensity = toward.z * axis > 0.5 ? 40 : 0;
    out[0] = intensity; out[1] = intensity * 0.5; out[2] = 0;
    return out;
  },
});

describe("light points", () => {
  it("shows a light's illuminance at the camera, I / d², spread over its square, against the exposure's white", () => {
    const night = setup(2.4);
    // The node turned to face the camera: its +Z looks at it.
    const node = new TransformNode("wing", night.scene);
    node.rotation.y = Math.PI;
    night.points.setPoints([forwardLight(node, new Vector3(0, 0, 0))]);
    night.points.update();
    const mesh = night.mesh();
    expect(mesh.isEnabled()).toBe(true);
    const material = mesh.material as StandardMaterial;
    expect(material.disableLighting).toBe(true);
    // An unlit standard material draws emissive × colour: black here once drew nothing at all.
    expect(material.emissiveColor.equalsFloats(1, 1, 1)).toBe(true);
    expect(material.disableDepthWrite).toBe(true);
    // At 20 m, 0.1 lux over a 32 px square of a 1 rad view on 1,000 px: thousands of times white at night.
    const peakNight = night.points.getPeak();
    expect(peakNight).toBeGreaterThan(1000);
    const colors = mesh.getVerticesData(VertexBuffer.ColorKind)!;
    expect(colors[0] ** 2.2).toBeCloseTo(peakNight, 3);
    expect(colors[1] ** 2.2 / colors[0] ** 2.2).toBeCloseTo(0.5, 6);
    // By day the same light is ten thousand times dimmer against white: a faint dot.
    const day = setup(39_000);
    const dayNode = new TransformNode("wing", day.scene);
    dayNode.rotation.y = Math.PI;
    day.points.setPoints([forwardLight(dayNode, new Vector3(0, 0, 0))]);
    day.points.update();
    expect(day.points.getPeak() / peakNight).toBeCloseTo(2.4 / 39_000, 9);
    // Twice as far, a quarter of the light.
    night.camera.position.set(0, 0, -40);
    night.points.update();
    expect(night.points.getPeak() / peakNight).toBeCloseTo(0.25, 2);
  });

  it("asks the light which way the viewer is, in its own axes, and hides a light that does not shine that way", () => {
    const h = setup(2.4);
    const node = new TransformNode("wing", h.scene);
    // Facing away from the camera: its +Z points further from it.
    h.points.setPoints([forwardLight(node, new Vector3(0, 0, 0))]);
    h.points.update();
    expect(h.points.getPeak()).toBe(0);
    expect(h.mesh().isEnabled()).toBe(false);
    node.rotation.y = Math.PI;
    h.points.update();
    expect(h.points.getPeak()).toBeGreaterThan(0);
  });

  it("faces the camera, a fixed number of pixels across, drawn a little towards it, and falls back to a reference white", () => {
    const h = setup(null);
    h.points.setPoints([forwardLight(null, new Vector3(0, 0, -10), -1), forwardLight(null, new Vector3(3, 0, -10), -1)]);
    h.points.update();
    // With no sky model, 1,000 cd/m² is white.
    expect(h.points.getPeak()).toBeGreaterThan(0);
    const positions = h.mesh().getVerticesData(VertexBuffer.PositionKind)!;
    expect(positions).toHaveLength(2 * 4 * 3);
    // The first square: centred 0.3 m nearer the camera, square in the camera's plane, 32 px of a 1,000 px, 1 rad view at 9.7 m.
    const corners = [0, 1, 2, 3].map(corner => new Vector3(positions[corner * 3], positions[corner * 3 + 1], positions[corner * 3 + 2]));
    const centre = corners.reduce((sum, corner) => sum.add(corner), Vector3.Zero()).scale(0.25);
    expect(centre.z).toBeCloseTo(-10.3, 6);
    const side = Vector3.Distance(corners[0], corners[1]);
    expect(side).toBeCloseTo(32 * ((2 * Math.tan(0.5)) / 1000) * 9.7, 6);
    for (const corner of corners) expect(corner.z).toBeCloseTo(-10.3, 6);
    h.points.dispose();
    expect(h.scene.getMeshByName("light-points")).toBeNull();
  });
});
