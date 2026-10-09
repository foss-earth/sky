import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const workspaceRoot = path.dirname(fileURLToPath(import.meta.url)) + path.sep;
registerHooks({ resolve(specifier, context, nextResolve) { const resolved = nextResolve(specifier, context); if (resolved.url.startsWith("file:") && !fileURLToPath(resolved.url).startsWith(workspaceRoot)) throw new Error(`Dependency escaped consumer: ${specifier}`); return resolved; } });
const { NullEngine, Scene } = await import("@babylonjs/core"); const { createSettingsRegistry } = await import("@foss-earth/ui/settings"); const { SKY_PARAMETERS } = await import("@foss-earth/sky/settings"); const { bindSkyReadingsAndNotes, createSkyRuntime } = await import("@foss-earth/sky/babylon");
const engine = new NullEngine(); const scene = new Scene(engine); let runtime, detach;
try {
  const settings = createSettingsRegistry({ storage: null }); settings.register(SKY_PARAMETERS); settings.set("sky.model", "off"); let frames = 0;
  runtime = createSkyRuntime({ scene, settings, ecefToGeodetic: () => ({ latRad: 0, lonRad: 0, altMeters: 500 }), getWorldMatrix: () => null, terrain: { setLighting: () => false, setLocalLights: () => {} }, nightTilePorts: { fetchTile: async () => { throw new Error("Unexpected acquisition"); }, measureResponse: response => response, retryDelayMs: () => 2000, setNightLightMap: () => false }, requestRender: () => { frames++; }, onLightingChange: () => {}, isGround: () => false, now: () => 0, clock: () => 0, isHidden: () => false, timers: { set: () => { throw new Error("Off Sky must not schedule"); }, clear: () => {} } });
  runtime.update(); assert.equal(runtime.getEnvironment(), null); assert.equal(frames, 0);
  detach = bindSkyReadingsAndNotes({ settings, sky: runtime });
  assert.equal(settings.getReading("sky.model"), null);
  assert.match(settings.inspect("sky.exposure.mode").note, /sky model is off/);
  detach(); detach = null;
  assert.equal(settings.hasReading("sky.model"), false);
  assert.equal(settings.inspect("sky.nightLights.mode").note, null);
  process.stdout.write("Sky installed-artifact optional Babylon supplied-scene lifecycle passed (NullEngine; no GPU claim).\n");
} finally { detach?.(); runtime?.dispose(); scene.dispose(); engine.dispose(); }
