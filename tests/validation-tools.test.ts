import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { run } from "../scripts/validation/skyRenderCheck.js";
import type { SkyRenderHost } from "../scripts/validation/ports.js";
import { ownerResolutionGuard } from "../scripts/validation/toolSources.mjs";
import { fileURLToPath } from "node:url";

describe("prepared Sky validation source contracts", () => {
  it("retains the original pixel thresholds and bounded loop policy", async () => {
    const source = await readFile(new URL("../scripts/validation/skyRenderCheck.ts", import.meta.url), "utf8");
    expect(source).toContain("const NEAR_TOLERANCE = 4, PLANET_TOLERANCE = 8;");
    expect(source).toContain("attempt < 400"); expect(source).toContain("await pause(10)");
    expect(source).toContain("attempt < 100 && !reading"); expect(source).toContain("await pause(20)");
    expect(source).toContain("Math.abs(seen[index] - value) / value < 0.1");
    expect(source).toContain("[-140, -110, -80, -50, -35, -25, -20, -15, -10]");
    expect(source).not.toContain("../../src/");
  });
  it("reports an unavailable backend without pretending to have drawn or retaining its canvas", async () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    try {
      // This unit case exercises only the actual tool's unsupported-backend branch;
      // it provides no pixels, shaders, device or model qualification.
      const host = {
        document: dom.window.document, geometry: {}, terrainLighting: {},
        openBackend: async () => null,
      } as unknown as SkyRenderHost;
      const result = await run(host, "webgpu");
      expect(result.checks).toEqual([]); expect(result.shots).toEqual({});
      expect(result.errors).toEqual(["WebGPU is not available in this browser: the WGSL shaders were not drawn"]);
      expect(dom.window.document.querySelector("canvas")).toBeNull();
    } finally { dom.window.close(); }
  });
  it("keeps all numerical report branches and explicit unqualified costs", async () => {
    const source = await readFile(new URL("../scripts/validation/skyModelCheck.ts", import.meta.url), "utf8");
    expect(source).toContain("report: 50.11162"); expect(source).toContain("published: 133.162655");
    expect(source).toContain("const steps = 20_000"); expect(source).toContain("qualified: false");
    expect(source).toContain("parameters, solar, light, moon, stars, starsByHeight");
    expect(source).toContain("const { clock, geodeticToEcef, ecefToGeodetic } = host;");
    expect(source).not.toContain("../../src/");
  });
  it("rejects private source as a bundle input even inside this owner", async () => {
    const privateFile = fileURLToPath(new URL("../src/skyState.ts", import.meta.url));
    await expect(ownerResolutionGuard().load(privateFile)).rejects.toThrow("cannot load checkout/private source");
    const allowedFile = fileURLToPath(new URL("../fixtures/validation/skyModelHost.ts", import.meta.url));
    expect(await ownerResolutionGuard().load(allowedFile)).toBeNull();
  });
});
