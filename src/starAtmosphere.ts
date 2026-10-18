import type { Atmosphere, Rgb } from "./atmosphere.js";
import { adaptEv100, ev100ForIlluminance, starEv100, whiteLuminanceForEv100, type SkyIllumination, type SkyObserver } from "./skyState.js";
import { starIlluminanceLux, starTint, type Matrix3 } from "./stars.js";
import { DISPLAY_GAMMA } from "./units.js";

/** Heading-independent star work. Positions are still transformed into the scene during drawing. */
export interface StarAtmosphereRequest {
  /** J2000 directions, three f32 values per star, in catalogue order. */
  directions: Float32Array;
  toEcef: Matrix3;
}

export interface StarAtmosphereResult {
  /** Unrounded matrix products for transmittance-only results; empty with final `colors`. */
  ecef: Float64Array;
  /** Unrounded RGB transmittance for the transmittance-only API; empty with final `colors`. */
  transmittance: Float64Array;
  generation?: number;
  colors?: { rgb: Float32Array; toValue: number; brightest: number };
}

export interface StarColorPresentation {
  mode: "fixed" | "metered";
  ev100: number;
  adaptation: number;
  meterRange: { min: number; max: number } | null;
  daylightAltitude: { min: number; max: number } | null;
  sizePx: number;
  pixelAngle: number;
  imageMean: number;
}
export interface StarEvaluationRequest {
  generation: number;
  /** Sent until this generation is acknowledged; the worker retains exactly one. */
  catalogue?: { directions: Float32Array; vmag: Float32Array; colourIndex: Float32Array; solarIlluminanceAt1AuLux: number };
  toEcef: Matrix3;
  presentation: StarColorPresentation;
}

/** The runtime's exposure arithmetic, with a snapshot of its presentation settings. No time-step state. */
export function starColorToValue(illumination: SkyIllumination, presentation: StarColorPresentation): number {
  const p = presentation;
  let ev100 = p.ev100;
  if (p.mode !== "fixed") {
    ev100 = adaptEv100(ev100ForIlluminance(illumination.meteredLux), ev100ForIlluminance(illumination.zenithMeteredLux), p.adaptation);
    if (p.meterRange) ev100 = ev100 < p.meterRange.min ? p.meterRange.min : ev100 > p.meterRange.max ? p.meterRange.max : ev100;
    if (p.meterRange && p.daylightAltitude) ev100 = starEv100(ev100, p.meterRange.min, illumination.observer.altitudeMeters,
      p.daylightAltitude.min * 1000, p.daylightAltitude.max * 1000);
  }
  const scale = 1 / whiteLuminanceForEv100(ev100);
  const half = (p.sizePx / 2) * p.pixelAngle;
  return scale / ((2 * half) ** 2 * p.imageMean);
}

/** Retains only one bounded catalogue generation, never renderer-owned buffers. */
export function createStarColorEvaluationState() {
  let retained: { generation: number; directions: Float32Array; lux: Float64Array; tints: Float64Array } | null = null;
  let disposed = false;
  return {
    evaluate(request: StarEvaluationRequest, illumination: SkyIllumination, atmosphere: Atmosphere): StarAtmosphereResult {
      if (disposed) throw new Error("Star colour evaluation disposed.");
      if (!Number.isSafeInteger(request.generation) || request.generation < 1) throw new RangeError("Invalid star generation.");
      if (retained && request.generation < retained.generation) throw new Error("Stale star catalogue generation.");
      if (request.catalogue) {
        const { directions, vmag, colourIndex, solarIlluminanceAt1AuLux } = request.catalogue, count = directions.length / 3;
        if (!Number.isInteger(count) || count > 100_000 || vmag.length !== count || colourIndex.length !== count) throw new RangeError("Invalid star colour catalogue.");
        const lux = new Float64Array(count), tints = new Float64Array(directions.length);
        for (let star = 0; star < count; star++) { lux[star] = starIlluminanceLux(vmag[star], solarIlluminanceAt1AuLux); tints.set(starTint(colourIndex[star]), star * 3); }
        retained = { generation: request.generation, directions, lux, tints };
      }
      if (!retained || retained.generation !== request.generation) throw new Error("Unknown star catalogue generation.");
      const { directions, lux, tints } = retained, m = request.toEcef, up = illumination.observer.up;
      const altitude = Math.max(0, illumination.observer.altitudeMeters), toValue = starColorToValue(illumination, request.presentation);
      const rgb = new Float32Array(directions.length), sample: Rgb = [0, 0, 0];
      let brightest = 0;
      for (let at = 0; at < directions.length; at += 3) {
        const sx = directions[at], sy = directions[at + 1], sz = directions[at + 2];
        const x = m[0] * sx + m[1] * sy + m[2] * sz, y = m[3] * sx + m[4] * sy + m[5] * sz, z = m[6] * sx + m[7] * sy + m[8] * sz;
        atmosphere.sunTransmittance(altitude, x * up[0] + y * up[1] + z * up[2], sample);
        const light = lux[at / 3] * toValue;
        const v0 = light * tints[at] * sample[0], v1 = light * tints[at + 1] * sample[1], v2 = light * tints[at + 2] * sample[2];
        brightest = Math.max(brightest, v0, v1, v2);
        rgb[at] = v0 ** (1 / DISPLAY_GAMMA); rgb[at + 1] = v1 ** (1 / DISPLAY_GAMMA); rgb[at + 2] = v2 ** (1 / DISPLAY_GAMMA);
      }
      // Drawing computes the original matrix products synchronously; only colors cross the worker boundary.
      return { generation: request.generation, ecef: new Float64Array(0), transmittance: new Float64Array(0), colors: { rgb, toValue, brightest } };
    },
    dispose() { disposed = true; retained = null; },
  };
}

/** The same matrix products and atmosphere samples as the synchronous star field, in one job. */
export function evaluateStarAtmosphere(request: StarAtmosphereRequest, observer: SkyObserver, atmosphere: Atmosphere): StarAtmosphereResult {
  const { directions, toEcef: m } = request;
  // The shipped catalogue has fewer than 10,000 stars. Bound worker allocations for malformed requests too.
  if (directions.length % 3 !== 0 || directions.length > 100_000 * 3) throw new RangeError("Invalid star atmosphere batch size.");
  const ecef = new Float64Array(directions.length);
  const transmittance = new Float64Array(directions.length);
  const sample: Rgb = [0, 0, 0];
  const altitude = Math.max(0, observer.altitudeMeters), up = observer.up;
  for (let at = 0; at < directions.length; at += 3) {
    const sx = directions[at], sy = directions[at + 1], sz = directions[at + 2];
    const x = m[0] * sx + m[1] * sy + m[2] * sz;
    const y = m[3] * sx + m[4] * sy + m[5] * sz;
    const z = m[6] * sx + m[7] * sy + m[8] * sz;
    ecef[at] = x; ecef[at + 1] = y; ecef[at + 2] = z;
    atmosphere.sunTransmittance(altitude, x * up[0] + y * up[1] + z * up[2], sample);
    transmittance[at] = sample[0]; transmittance[at + 1] = sample[1]; transmittance[at + 2] = sample[2];
  }
  return { ecef, transmittance };
}
