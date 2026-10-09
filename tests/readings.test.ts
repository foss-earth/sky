import { describe, expect, it, vi } from "vitest";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { SKY_PARAMETERS } from "../src/settings.js";
import { bindSkyReadingsAndNotes } from "../src/babylon/readings.js";
import type { SkyNightLights } from "../src/babylon/createSkyRuntime.js";

function registry() {
  const settings = createSettingsRegistry({ storage: null });
  settings.register(SKY_PARAMETERS);
  return settings;
}

describe("supplied Sky readings and notes", () => {
  it("reads only on demand, distinguishes waiting from off and detaches without disposing the host", () => {
    const settings = registry();
    settings.set("sky.model", "dome");
    const getEnvironment = vi.fn(() => null);
    const getNightLights = vi.fn(() => null);
    const dispose = vi.fn();
    const sky = { getEnvironment, getNightLights, dispose };
    const detach = bindSkyReadingsAndNotes({ settings, sky });
    expect(getEnvironment).not.toHaveBeenCalled();
    expect(getNightLights).not.toHaveBeenCalled();
    expect(settings.getReading("sky.model")).toBe("Waiting for a viewpoint on the Earth.");
    settings.set("sky.model", "off");
    expect(settings.getReading("sky.model")).toBeNull();
    detach(); detach();
    expect(settings.hasReading("sky.model")).toBe(false);
    expect(settings.hasReading("sky.nightLights.memory")).toBe(false);
    expect(settings.inspect("sky.exposure.mode").note).toBeNull();
    expect(dispose).not.toHaveBeenCalled();
    settings.set("sky.model", "dome");
    expect(settings.inspect("sky.stars.mode").note).toBeNull();
  });

  it("updates the existing note homes for model, imagery, fixed exposure and compensation", () => {
    const settings = registry();
    settings.setMany({ "sky.model": "off", "renderer.exposureEV": 2 });
    const detach = bindSkyReadingsAndNotes({ settings, sky: { getEnvironment: () => null, getNightLights: () => null } });
    expect(settings.inspect("sky.nightLights.mode").note).toContain("sky model is off");
    settings.setMany({ "sky.model": "dome", "sky.surface.lighting": "photograph", "sky.exposure.mode": "fixed" });
    expect(settings.inspect("sky.nightLights.mode").note).toContain("imagery is shown as photographed");
    expect(settings.inspect("sky.stars.mode").note).toBeNull();
    expect(settings.inspect("sky.stars.daylightAltitude").note).toContain("fixed exposure");
    expect(settings.inspect("renderer.exposureEV").note).toContain("4× brighter");
    settings.set("renderer.exposureEV", -1);
    expect(settings.inspect("renderer.exposureEV").note).toContain("2× darker");
    detach();
    expect(settings.inspect("sky.nightLights.mode").note).toBeNull();
    expect(settings.inspect("renderer.exposureEV").note).toBeNull();
  });

  it("reports arriving night tiles and original physical units without caching stale host state", () => {
    const settings = registry();
    let night: SkyNightLights | null = {
      mode: "light",
      state: {
        window: null, pending: { zoom: 3, tiles: 3 }, here: 2, needed: 4,
        loading: 1, failed: 1, error: "missing", downloadedBytes: 2 * 1_048_576,
        gpuBytes: 0, memoryBytes: 1_048_576,
      } as SkyNightLights["state"],
      below: { radiance: 2, illuminanceLux: 0.1, luminance: 0.01 },
    };
    const detach = bindSkyReadingsAndNotes({ settings, sky: { getEnvironment: () => null, getNightLights: () => night } });
    expect(settings.getReading("sky.nightLights.mode")).toContain("Making the first window ready");
    expect(settings.getReading("sky.nightLights.mode")).toContain("2 nW/(cm² sr)");
    expect(settings.getReading("sky.nightLights.mode")).toContain("0.1 lx");
    expect(settings.getReading("sky.nightLights.memory")).toBe("1 MiB kept");
    night = null;
    expect(settings.getReading("sky.nightLights.mode")).toBeNull();
    detach();
  });

  it("releases already registered watches when binding fails part way through", () => {
    const settings = registry();
    let watches = 0;
    const unsubscribe = vi.fn();
    expect(() => bindSkyReadingsAndNotes({
      settings: {
        get: settings.get,
        setNote: settings.setNote,
        setReadingSource: settings.setReadingSource,
        watch: () => {
          if (++watches === 2) throw new Error("host stopped");
          return unsubscribe;
        },
      },
      sky: { getEnvironment: () => null, getNightLights: () => null },
    })).toThrow("host stopped");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(settings.hasReading("sky.model")).toBe(false);
    expect(settings.inspect("sky.stars.mode").note).toBeNull();
  });
});
