import type { BaseTexture } from "@babylonjs/core";
import type { Rgb } from "../atmosphere.js";
type Vec3 = readonly [number, number, number];

/**
 * The light map imagery is shown under, for one scene. Every quantity is
 * already over the luminance the exposure shows as white, and times the
 * reflectance one unit of linear imagery colour stands for, over π: a factor
 * on linear colour.
 *
 * Per point, the shader finds the Sun's and the Moon's height at each
 * pixel's place and reads their light on level ground there from the table,
 * so the planet seen from afar has its day, twilight and night where they
 * are. Otherwise the whole map is shown under `ambient` alone: the light
 * below the viewpoint, right near it and cheaper, for a low flight on a slow
 * device.
 */
export interface TerrainLighting {
  perPoint: boolean;
  /** The Earth's centre in the scene's coordinates, m: a pixel's up is its direction from here. */
  centre: Vec3;
  /** Unit vectors in the scene towards the Sun and the Moon. */
  sunDirection: Vec3;
  moonDirection: Vec3;
  /** Multiplies the table for the Sun: its illuminance above the air in each band, over white, × reflectance / π. */
  sunScale: Readonly<Rgb>;
  /** The same for the Moon; zero where it is not modelled. */
  moonScale: Readonly<Rgb>;
  /** Added everywhere: the night sky's light on the ground, or, when not per point, the whole factor. */
  ambient: Readonly<Rgb>;
  /**
   * The natural logarithm of the light on level ground at sea level, the
   * body's own and the sky's, per unit of its illuminance above the air and
   * over `groundLightWeight` of its height: four floats a sample (red,
   * green, blue and one unused), at `groundLightTableElevationDeg` of each
   * index (src/sky/skyState.ts).
   */
  table: Float32Array;
  /** The night lights, read from the map `setTerrainNightLightMap` sets; none when null or absent. */
  night?: TerrainNightLighting | null;
}

/**
 * How the radiance a satellite saw at a pixel's place, above a floor, shows
 * there (src/sky/nightLights.ts): as lamps' light on the imagery, added to
 * the factor, or as the satellite's own picture, added to the colour.
 */
export interface TerrainNightLighting {
  /** Unit vectors in the scene along the Earth's x, y and z axes, which place a pixel on the map. */
  axes: readonly [Vec3, Vec3, Vec3];
  /** Added to the factor on linear colour per nW/(cm² sr): the lamps' illuminance per unit, over white, × reflectance / π, in each band. */
  light: Readonly<Rgb>;
  /** Added to the linear colour per nW/(cm² sr): the luminance the satellite saw per unit, over white, in each band. */
  picture: Readonly<Rgb>;
  /** Radiance taken as no lamp's, nW/(cm² sr). */
  floor: number;
}

/**
 * The night lights' map: radiance in a texture that wraps, holding a square
 * of `tiles` × `tiles` Web Mercator tiles of one zoom from column `x` and row
 * `y`, tile (x, y) in slot (x mod tiles, y mod tiles); red and green hold the
 * high and low bytes of radiance in `NIGHT_RADIANCE_UNITS`.
 */
export interface TerrainNightLightMap {
  texture: BaseTexture;
  zoom: number;
  x: number;
  y: number;
  tiles: number;
}

/** A light that reaches the ground, such as a landing light: a beam with a soft edge, or every way when both cosines are -1. */
export interface TerrainLocalLight {
  /** In the scene's coordinates, m. */
  position: Vec3;
  /** Unit vector along the beam's axis, in the scene. */
  direction: Vec3;
  /** Full intensity within the inner half-angle, none beyond the outer: their cosines. */
  cosInner: number;
  cosOuter: number;
  /** Intensity on the axis in each band, cd, over white, × reflectance / π: a factor on linear colour at one metre. */
  factor: Readonly<Rgb>;
}

/** The host engine implements these against its one terrain/material authority. */
export interface SkyTerrainPorts {
  setLighting(value: TerrainLighting | null): boolean;
  setLocalLights(value: readonly TerrainLocalLight[]): void;
}
export interface NightTilePorts {
  fetchTile(url: string, init: RequestInit): Promise<Response>;
  measureResponse(response: Response, onBytes: (bytes: number) => void): Response;
  retryDelayMs(failures: number, range: { min: number; max: number }): number;
  setNightLightMap(value: TerrainNightLightMap | null): boolean;
}
