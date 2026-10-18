import { atmosphereTables, createAtmosphere, type Atmosphere, type AtmosphereParameters } from "./atmosphere.js";
import { atmosphereNumericStatusOf, type AtmosphereNumericPorts, type AtmosphereNumericSnapshot, type AtmosphereNumericStatus } from "./atmosphereNumericKernel.js";
import type { LunarEphemeris } from "./lunarPosition.js";
import type { SolarEphemeris } from "./solarPosition.js";
import { createStarColorEvaluationState, evaluateStarAtmosphere, type StarAtmosphereRequest, type StarAtmosphereResult, type StarEvaluationRequest } from "./starAtmosphere.js";
import {
  computeSkyIllumination, createSkyDomeGeometry, fillSkyDome, groundLightTable,
  type SkyDomeGeometry, type SkyDomeLayout, type SkyIllumination, type SkyObserver,
} from "./skyState.js";

/**
 * What the sky runtime evaluates when the Sun, the Moon, the viewpoint or the
 * air has changed: plain data, so a worker can evaluate it as the page would.
 */
export interface SkyEvaluationRequest {
  /** The settings' values; the atmosphere clamps them as it always does. */
  parameters: AtmosphereParameters;
  ephemeris: SolarEphemeris;
  lunar: LunarEphemeris | null;
  observer: SkyObserver;
  nightLuminance: number;
  /** The dome to fill, when the sky is drawn as one. */
  dome: { layout: SkyDomeLayout; moonlitSky: boolean } | null;
  /** Optional heading-independent star samples, evaluated for this same observer and atmosphere. */
  stars?: StarAtmosphereRequest | StarEvaluationRequest | null;
}

export interface SkyEvaluationDome {
  layout: SkyDomeLayout;
  rows: number;
  columns: number;
  vertexCount: number;
  directions: Float32Array;
  luminances: Float32Array;
  evaluations: number;
  moonEvaluations: number;
}

export interface SkyEvaluationResult {
  illumination: SkyIllumination;
  /** The atmosphere's tables, when this evaluation built a new atmosphere. */
  tables: AtmosphereNumericSnapshot | null;
  /** `groundLightTable` of that atmosphere, with the tables. */
  groundTable: Float32Array | null;
  dome: SkyEvaluationDome | null;
  stars?: StarAtmosphereResult | null;
  timing: {
    /** Building the tables, when they were built: 0 otherwise. */
    tablesMs: number;
    tableBytes: number;
    illuminationMs: number;
    domeMs: number;
    starsMs?: number;
    /** The whole evaluation, tables included. */
    workMs: number;
  };
  /** The numeric kernel's state for the atmosphere evaluated; null without one. */
  numeric: AtmosphereNumericStatus | null;
}

export interface SkyEvaluationStateOptions {
  now: () => number;
  /** Worker-only numeric ports; reuse one object so later tables can skip the reference precompute. */
  numericPorts?: AtmosphereNumericPorts;
}

export interface SkyEvaluationState {
  /** Evaluates as `createSkyRuntime` does on the page, and lists the buffers a transfer may move. */
  evaluate(request: SkyEvaluationRequest): { result: SkyEvaluationResult; transfer: ArrayBuffer[] };
  dispose(): void;
}

/**
 * The sky's evaluation, kept between requests the way the page's runtime
 * keeps it: one atmosphere per parameter pair and one dome per layout. The
 * same functions run in the same order, so a worker running this answers with
 * the values the page would have computed.
 */
export function createSkyEvaluationState(options: SkyEvaluationStateOptions): SkyEvaluationState {
  let atmosphere: Atmosphere | null = null;
  let atmosphereKey = "";
  let dome: { key: string; geometry: SkyDomeGeometry } | null = null;
  let disposed = false;
  const starColors = createStarColorEvaluationState();
  const release = (): void => {
    const current = atmosphere;
    atmosphere = null;
    current?.dispose?.();
  };
  return {
    evaluate(request) {
      if (disposed) throw new Error("Sky evaluation state is disposed.");
      const started = options.now();
      const key = `${request.parameters.aerosolOpticalDepth}/${request.parameters.groundAlbedo}`;
      let tables: AtmosphereNumericSnapshot | null = null;
      let groundTable: Float32Array | null = null;
      let tablesMs = 0, tableBytes = 0;
      if (!atmosphere || key !== atmosphereKey) {
        release();
        atmosphere = createAtmosphere({
          aerosolOpticalDepth: request.parameters.aerosolOpticalDepth,
          groundAlbedo: request.parameters.groundAlbedo,
        }, options.now, options.numericPorts);
        atmosphereKey = key;
        groundTable = groundLightTable(atmosphere);
        tables = atmosphereTables(atmosphere)!;
        tablesMs = atmosphere.build.buildMs;
        tableBytes = atmosphere.build.tableBytes + groundTable.byteLength;
      }
      const lit = options.now();
      const illumination = computeSkyIllumination(atmosphere, request.ephemeris, request.observer, {
        nightLuminance: request.nightLuminance, lunar: request.lunar,
      });
      const sampled = options.now();
      let filled: SkyEvaluationDome | null = null;
      if (request.dome) {
        const layout = request.dome.layout;
        const layoutKey = `${layout.zenithSamples}/${layout.azimuthSamples}`;
        if (!dome || dome.key !== layoutKey) dome = { key: layoutKey, geometry: createSkyDomeGeometry(layout) };
        // As the page's ensureDome: a new step count keeps the geometry.
        dome.geometry.layout.integrationSteps = Math.max(2, Math.round(layout.integrationSteps));
        const geometry = dome.geometry;
        fillSkyDome(geometry, atmosphere, illumination, { moonlitSky: request.dome.moonlitSky });
        filled = {
          layout: { ...geometry.layout }, rows: geometry.rows, columns: geometry.columns, vertexCount: geometry.vertexCount,
          directions: geometry.directions.slice(), luminances: geometry.luminances.slice(),
          evaluations: geometry.evaluations, moonEvaluations: geometry.moonEvaluations,
        };
      }
      const domeFinished = options.now();
      const stars = request.stars ? "generation" in request.stars ? starColors.evaluate(request.stars, illumination, atmosphere)
        : evaluateStarAtmosphere(request.stars, request.observer, atmosphere) : null;
      const finished = options.now();
      const result: SkyEvaluationResult = {
        illumination, tables, groundTable, dome: filled, stars,
        timing: { tablesMs, tableBytes, illuminationMs: sampled - lit, domeMs: filled ? domeFinished - sampled : 0,
          starsMs: stars ? finished - domeFinished : 0, workMs: finished - started },
        numeric: atmosphereNumericStatusOf(atmosphere) ?? null,
      };
      const transfer: ArrayBuffer[] = [];
      for (const array of [tables?.transmittance, tables?.multipleScattering, tables?.groundIrradiance, groundTable, filled?.directions, filled?.luminances, stars?.ecef, stars?.transmittance, stars?.colors?.rgb]) {
        if (array?.byteLength) transfer.push(array.buffer as ArrayBuffer);
      }
      return { result, transfer };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      dome = null;
      starColors.dispose();
      release();
    },
  };
}
