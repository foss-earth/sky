import { ATMOSPHERE, type Rgb } from "../atmosphere.js";
import { luminance } from "../skyState.js";

export type LensFlareMode = "off" | "glare" | "flare";

/** A single nominal coated six-blade lens; see docs/proposals/sky.md. */
export const SUN_LENS = {
  probeSize: 32,
  imageSize: 128,
  glareHalfAngle: 9 * Math.PI / 180,
  glareShare: 0.001,
  blades: 6,
  coreWidth: 0.025,
  haloWidth: 0.12,
  rayWidth: 0.008,
  ghosts: [
    { spacing: 0.6, radius: 1.2, share: 0.000012, tint: [0.6, 0.85, 1] },
    { spacing: 1.15, radius: 2, share: 0.000008, tint: [0.65, 1, 0.75] },
    { spacing: 1.65, radius: 0.7, share: 0.000012, tint: [1, 0.7, 0.5] },
    { spacing: 2.1, radius: 1.4, share: 0.000008, tint: [0.7, 0.65, 1] },
  ],
} as const;

export interface LensFlareState {
  mode: LensFlareMode;
  /** XR and unavailable backends fail closed, with the requested mode retained. */
  status: "ready" | "pending" | "xr" | "unsupported" | "error";
  sources: Array<{
    id: "sun";
    /** Share of the whole disc surviving Earth, viewport and scene depth occlusion. */
    visibleFraction: number;
    /** log2(visible illuminance / disc solid angle / effective white); null at zero. */
    stopsOverWhite: number | null;
    /** Render pixels from the canvas's upper left; null behind the camera. */
    pixel: { x: number; y: number } | null;
  }>;
  /** No outstanding shader preparation/readback; the last drawn visibility is reported. */
  settled: boolean;
  reason?: string;
}

export const SUN_SOLID_ANGLE = 2 * Math.PI * (1 - Math.cos(ATMOSPHERE.sunAngularRadius));

/** Undo the atmosphere API's existing finite-disc horizon weight before depth
 * quadrature counts it once. This is the same smoothstep and atmosphere entry
 * used by Atmosphere.sunTransmittance, not a second brightness adjustment. */
export function sunHorizonWeight(altitudeMeters: number, muSun: number): number {
  let r = ATMOSPHERE.planetRadiusMeters + Math.max(0, altitudeMeters), mu = Math.min(1, Math.max(-1, muSun));
  const top = ATMOSPHERE.planetRadiusMeters + ATMOSPHERE.thicknessMeters;
  if (r > top) {
    const discriminant = r * r * (mu * mu - 1) + top * top;
    if (mu >= 0 || discriminant < 0) return 1;
    mu = -Math.sqrt(discriminant) / top; r = top;
  }
  const sine = Math.min(1, ATMOSPHERE.planetRadiusMeters / r);
  const horizon = -Math.sqrt(Math.max(0, 1 - sine * sine));
  const width = sine * ATMOSPHERE.sunAngularRadius;
  const t = Math.min(1, Math.max(0, (mu - horizon + width) / (2 * width)));
  return t * t * (3 - 2 * t);
}

/** Excess source light, per band, against effective display white, in steradians. */
export function lensFlareEnergy(illuminance: Readonly<Rgb>, white: number): Rgb {
  const excess = Math.max(0, 1 - SUN_SOLID_ANGLE * white / Math.max(1e-30, luminance(illuminance)));
  return illuminance.map(value => Math.max(0, value) * excess / white) as Rgb;
}

export function lensFlareStops(illuminance: Readonly<Rgb>, white: number, visibleFraction: number): number | null {
  const ratio = luminance(illuminance) * visibleFraction / (SUN_SOLID_ANGLE * white);
  return ratio > 0 ? Math.log2(ratio) : null;
}

/** Equal-area quadrature of the disc, also used by the GPU visibility reduction. */
export function sunDiscSamples(size = SUN_LENS.probeSize): Array<{ x: number; y: number; index: number }> {
  const samples: Array<{ x: number; y: number; index: number }> = [];
  for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) {
    const x = 2 * (column + 0.5) / size - 1, y = 2 * (row + 0.5) / size - 1;
    if (x * x + y * y <= 1) samples.push({ x, y, index: row * size + column });
  }
  return samples;
}

/** CPU reference for the GPU's packed-depth clear test. Clear is exactly RGBA=(1,1,1,1). */
export function visibleSunFraction(mask: ArrayLike<number>, depth: ArrayLike<number>): number {
  const samples = sunDiscSamples();
  let visible = 0;
  for (const { index } of samples) if (mask[index * 4] && [0, 1, 2, 3].every(band => depth[index * 4 + band] === 255)) visible++;
  return visible / samples.length;
}
