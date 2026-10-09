import type * as Babylon from "@babylonjs/core";
import type { SettingsRegistry } from "@foss-earth/ui/settings";
import type { SkyEcefToGeodetic } from "@foss-earth/sky";
import type { SkyRuntimeOptions } from "@foss-earth/sky/babylon";
import type { TerrainLightingAdapter } from "@foss-earth/engine/babylon";

export type SkyValidationBackend = "webgl2" | "webgl1" | "webgpu";
export interface SkyModelHost {
  /** WGS84 radians and ellipsoid metres; engine owns both conversions. */
  geodeticToEcef(latRad: number, lonRad: number, altMeters: number): { x: number; y: number; z: number };
  ecefToGeodetic: SkyEcefToGeodetic;
  /** Monotonic milliseconds; recorded costs remain explicitly unqualified. */
  clock(): number;
}
export interface SkyRenderHost extends SkyModelHost {
  document: Document;
  /** Experiment-native geometry constructors, supplied separately from Sky runtime. */
  geometry: Pick<typeof Babylon, "Color3" | "FreeCamera" | "Matrix" | "Mesh" | "MeshBuilder" | "PBRMaterial" | "RawTexture" | "StandardMaterial" | "Texture" | "Vector3" | "VertexBuffer">;
  openBackend(canvas: HTMLCanvasElement, backend: SkyValidationBackend): Promise<{
    engine: Babylon.AbstractEngine; scene: Babylon.Scene; renderer: string; errors: string[];
  } | null>;
  terrainLighting: TerrainLightingAdapter;
  createSettings(): SettingsRegistry;
  nightTilePorts(scene: Babylon.Scene): SkyRuntimeOptions["nightTilePorts"];
  now(): number;
  timers: SkyRuntimeOptions["timers"];
  pause(ms: number): Promise<void>;
  requestRender(): void;
  isHidden(): boolean;
  /** Same owner readiness authority; called after the retained bounded compile loop settles. */
  whenMeshesReady(meshes: readonly Babylon.AbstractMesh[]): Promise<void>;
}
