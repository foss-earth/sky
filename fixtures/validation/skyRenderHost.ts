import {
  Color3, Engine, FreeCamera, Matrix, Mesh, MeshBuilder, PBRMaterial, RawTexture, Scene,
  StandardMaterial, Texture, Vector3, VertexBuffer, WebGPUEngine, type AbstractEngine,
} from "@babylonjs/core";
import { ecefToGeodetic, geodeticToEcef } from "@foss-earth/engine";
import { createTerrainLightingAdapter } from "@foss-earth/engine/babylon";
import { MAP_LOADING_PARAMETERS } from "@foss-earth/engine/settings";
import { whenMeshesReady } from "@foss-earth/renderer/babylon";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import {
  GROUND_LIGHT_TABLE, GROUND_LIGHT_SAMPLES, GROUND_LIGHT_LEAST_SINE,
  MERCATOR_MAX_LAT_DEG, NIGHT_RADIANCE_UNITS, groundLightAt,
} from "@foss-earth/sky";
import { SKY_PARAMETERS } from "@foss-earth/sky/settings";
import type { SkyRenderHost } from "../../scripts/validation/ports.js";

/**
 * Existing standalone pixel experiment's explicit host. This is not the app
 * bootstrap: forced WebGL 1 and preserved buffers are deliberate original tool
 * options. No run, canvas, backend, timer or scene is initialized on import.
 */
export function createSkyRenderHost(document: Document, view: Window, requestRender: () => void): SkyRenderHost {
  const terrainLighting = createTerrainLightingAdapter({
    GROUND_LIGHT_TABLE, GROUND_LIGHT_SAMPLES, GROUND_LIGHT_LEAST_SINE,
    MERCATOR_MAX_LAT_DEG, NIGHT_RADIANCE_UNITS, groundLightAt,
  });
  return {
    document, ecefToGeodetic, geodeticToEcef, terrainLighting, requestRender,
    geometry: { Color3, FreeCamera, Matrix, Mesh, MeshBuilder, PBRMaterial, RawTexture, StandardMaterial, Texture, Vector3, VertexBuffer },
    now: () => Date.now(), clock: () => view.performance.now(), isHidden: () => document.hidden,
    timers: { set: (callback, ms) => view.setTimeout(callback, ms), clear: id => view.clearTimeout(id) },
    pause: ms => new Promise(resolve => view.setTimeout(resolve, ms)),
    whenMeshesReady: meshes => whenMeshesReady(meshes, {
      timers: { setTimeout: (callback, ms) => view.setTimeout(callback, ms), clearTimeout: id => view.clearTimeout(id as number) },
    }),
    createSettings() {
      const settings = createSettingsRegistry({ storage: null });
      settings.register([...SKY_PARAMETERS, ...MAP_LOADING_PARAMETERS]);
      return settings;
    },
    nightTilePorts: scene => ({
      // This original experiment exercises no night-map transport. Never silently
      // download a NASA tile if a future fixture turns that capability on.
      fetchTile: async () => { throw new Error("Night-map acquisition is outside the retained Sky pixel fixture; supply an admitted host transport before enabling it."); },
      measureResponse: response => response,
      retryDelayMs: (_failures, range) => range.min,
      setNightLightMap: value => terrainLighting.setTerrainNightLightMap(scene, value),
    }),
    async openBackend(canvas, backend) {
      let engine: AbstractEngine;
      let renderer: string;
      const errors: string[] = [];
      if (backend === "webgpu") {
        const adapter = await view.navigator.gpu?.requestAdapter();
        if (!adapter) return null;
        const gpu = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: false, useLargeWorldRendering: true });
        try { await gpu.initAsync(); } catch (error) {
          try { gpu.dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Sky validation backend startup and cleanup failed."); }
          throw error;
        }
        engine = gpu;
        renderer = `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}`.trim();
      } else {
        const gl = new Engine(canvas, false, { disableWebGL2Support: backend === "webgl1", preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true }, false);
        engine = gl;
        renderer = `WebGL ${gl.webGLVersion}: ${gl.getGlInfo().renderer}`;
        if (gl.webGLVersion !== (backend === "webgl1" ? 1 : 2)) errors.push(`Asked for ${backend} and got WebGL ${gl.webGLVersion}`);
      }
      engine.useReverseDepthBuffer = true;
      try {
        const scene = new Scene(engine);
        scene.useRightHandedSystem = true;
        scene.skipPointerMovePicking = true;
        return { engine, scene, renderer, errors };
      } catch (error) {
        try { engine.dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Sky validation scene startup and cleanup failed."); }
        throw error;
      }
    },
  };
}
