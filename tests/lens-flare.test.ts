import { FreeCamera, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { lensFlareEnergy, lensFlareStops, sunDiscSamples, sunHorizonWeight, visibleSunFraction } from "../src/babylon/lensFlareModel.js";
import { createSkyRuntime } from "../src/babylon/createSkyRuntime.js";
import { SKY_PARAMETERS } from "../src/settings.js";
import { whiteLuminanceForEv100 } from "../src/skyState.js";

describe("the nominal Sun lens", () => {
  it("derives strength and stops from illuminance and effective exposure", () => {
    const sun: [number, number, number] = [133334, 133334, 133334];
    const white = whiteLuminanceForEv100(12);
    expect(lensFlareStops(sun, white, 1)).toBeCloseTo(18.6, 0);
    expect(lensFlareStops(sun, white / 2, 1)! - lensFlareStops(sun, white, 1)!).toBeCloseTo(1, 12);
    expect(lensFlareEnergy(sun, white / 2)[0]).toBeGreaterThan(lensFlareEnergy(sun, white)[0] * 2);
    expect(lensFlareEnergy([0.00001, 0.00001, 0.00001], white)).toEqual([0, 0, 0]);
    expect(lensFlareStops(sun, white, 0)).toBeNull();
  });

  it("keeps atmospheric reddening and dims with air rather than scene-specific constants", () => {
    const white = whiteLuminanceForEv100(12);
    const red: [number, number, number] = [4000, 1000, 200];
    const energy = lensFlareEnergy(red, white);
    expect(energy[0] / energy[1]).toBeCloseTo(4, 12);
    expect(energy[1] / energy[2]).toBeCloseTo(5, 12);
    expect(energy[0]).toBeLessThan(lensFlareEnergy([133334, 133334, 133334], white)[0]);
  });

  it("counts partial depth occlusion, the viewport and the Earth against the whole disc", () => {
    const mask = new Uint8Array(32 * 32 * 4), depth = new Uint8Array(mask.length).fill(255);
    for (const { index } of sunDiscSamples()) mask[index * 4] = 255;
    expect(visibleSunFraction(mask, depth)).toBe(1);
    for (const { x, index } of sunDiscSamples()) if (x < 0) depth[index * 4] = 0;
    expect(visibleSunFraction(mask, depth)).toBe(0.5);
    for (const { y, index } of sunDiscSamples()) if (y < 0) mask[index * 4] = 0;
    expect(visibleSunFraction(mask, depth)).toBe(0.25);
    mask.fill(0);
    expect(visibleSunFraction(mask, depth)).toBe(0);
    expect(lensFlareStops([1000, 1000, 1000], 10, 0.5)! - lensFlareStops([1000, 1000, 1000], 10, 1)!).toBeCloseTo(-1, 12);
  });

  it("removes the atmosphere's horizon weighting before applying visibility once", () => {
    expect(sunHorizonWeight(0, 0)).toBe(0.5);
    expect(sunHorizonWeight(0, 0.1)).toBe(1);
    expect(sunHorizonWeight(0, -0.1)).toBe(0);
    expect(sunHorizonWeight(400000, 0)).toBe(1);
    const weighted = 1000 * sunHorizonWeight(0, 0);
    expect(weighted / sunHorizonWeight(0, 0) * 0.5).toBe(500);
  });

  it("adds no scene resources or compile work at the default Off setting", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const camera = new FreeCamera("host", new Vector3(6378637, 0, 0), scene);
    scene.activeCamera = camera;
    camera.getViewMatrix(true);
    const settings = createSettingsRegistry({ storage: null }); settings.register(SKY_PARAMETERS);
    settings.setMany({ "sky.model": "dome", "sky.dome.zenithSamples": 8, "sky.dome.azimuthSamples": 8,
      "sky.dome.integrationSteps": 4, "sky.time.mode": "fixed", "sky.moon.mode": "off", "sky.stars.mode": "off",
      "sky.nightLights.mode": "off", "sky.groundLight.mode": "uniform" });
    const request = vi.fn(), setTimer = vi.fn(() => 0);
    const sky = createSkyRuntime({
      scene, settings, getWorldMatrix: () => null, requestRender: request, now: () => 0, clock: () => 0,
      ecefToGeodetic: () => ({ latRad: 0, lonRad: 0, altMeters: 500 }),
      terrain: { setLighting: () => true, setLocalLights: () => {} },
      nightTilePorts: { fetchTile: async () => { throw new Error("Unexpected download"); }, measureResponse: r => r,
        retryDelayMs: () => 2000, setNightLightMap: () => true },
      onLightingChange: () => {}, isGround: () => false, isHidden: () => false, timers: { set: setTimer, clear: () => {} },
    });
    try {
      sky.update();
      expect(settings.get("sky.exposure.lensFlare")).toBe("off");
      expect(sky.getEnvironment()?.lensFlare).toEqual({ mode: "off", status: "ready", sources: [], settled: true });
      expect(scene.meshes.map(m => m.name)).toEqual(["sky-dome"]);
      expect(scene.materials.filter(m => /flare/.test(m.name))).toHaveLength(0);
      expect(scene.cameras).toHaveLength(1);
      expect(scene.customRenderTargets).toHaveLength(0);
      expect(scene.textures).toHaveLength(0);
      expect(setTimer).not.toHaveBeenCalled();
      const before = request.mock.calls.length;
      sky.update();
      expect(request).toHaveBeenCalledTimes(before);
    } finally { sky.dispose(); engine.dispose(); }
  });
});
