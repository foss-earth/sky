/**
 * A clear atmosphere of air molecules, haze and ozone around a spherical
 * Earth, and the light of the Sun scattered through it: the one physical
 * model every rung of the sky ladder samples (docs/proposals/sky.md).
 *
 * Everything here is per unit of the Sun's illuminance above the atmosphere,
 * for three bands taken as the display's red, green and blue: a luminance is in
 * cd/m² per lux (sr⁻¹), an illuminance is a ratio. skyState.ts gives them
 * their units. Nothing here touches the renderer; it runs in a test or a worker.
 *
 * The medium is Bruneton and Neyret's ("Precomputed Atmospheric Scattering",
 * 2008, with the 2017 reference implementation's ozone layer). Light scattered
 * more than once is Hillaire's isotropic estimate ("A Scalable and Production
 * Ready Sky and Atmosphere Rendering Technique", 2020). Rays are straight:
 * refraction only moves the Sun (skyState.ts).
 *
 * Not modelled: clouds, water vapour and other absorbers than ozone, haze that
 * varies with wavelength or place, terrain shadows in the air, polarization,
 * and any light that is not the Sun's.
 */

/** The medium and the planet. Lengths in m, coefficients in 1/m at sea level for the red, green and blue bands (680, 550 and 440 nm). */
export const ATMOSPHERE = {
  /** The Earth's mean radius: the model's sphere, with heights taken above the ellipsoid. */
  planetRadiusMeters: 6_371_000,
  /** Above this the air is taken as empty. */
  thicknessMeters: 100_000,
  rayleighScaleHeightMeters: 8_000,
  rayleighScattering: [5.802e-6, 13.558e-6, 33.1e-6],
  mieScaleHeightMeters: 1_200,
  /** The share of light haze scatters rather than absorbs. */
  mieSingleScatteringAlbedo: 0.9,
  /** Haze scatters forward: the asymmetry of its Cornette-Shanks phase function. */
  mieAsymmetry: 0.8,
  ozoneAbsorption: [0.65e-6, 1.881e-6, 0.085e-6],
  /** Ozone's density is a tent centred here, reaching zero this far above and below. */
  ozoneCenterMeters: 25_000,
  ozoneHalfWidthMeters: 15_000,
  /** The Sun's angular radius, radians (0.26667°, as the solar position report takes it). */
  sunAngularRadius: 0.0046542,
} as const;

/** How finely the tables below are kept, and how they are integrated. atmosphere.test.ts bounds the error these leave. */
const TABLES = {
  /** Transmittance to the top of the air, by direction and height. */
  transmittanceWidth: 128,
  transmittanceHeight: 64,
  transmittanceSteps: 64,
  /**
   * Light scattered more than once, by the Sun's height in the sky and the
   * height above the ground. It falls away by orders of magnitude as the Sun
   * sets, so most of the Sun's axis is spent between `twilightMinCosine`
   * (27° below the horizon) and `twilightMaxCosine` (9° above).
   */
  multipleScatteringHeights: 24,
  multipleScatteringTwilightSuns: 25,
  multipleScatteringDaySuns: 8,
  twilightMinCosine: -0.45,
  twilightMaxCosine: 0.15,
  /** Directions the multiple-scattering estimate gathers light from: heights, and bearings from the Sun on one side. */
  multipleScatteringZeniths: 8,
  multipleScatteringAzimuths: 4,
  multipleScatteringSteps: 12,
  /**
   * The sky's light on level ground, by the Sun's height in the sky from
   * `groundIrradianceMinCosine` (20.5° below the horizon) to the zenith, most
   * samples again spent through twilight.
   */
  groundIrradianceTwilightSuns: 36,
  groundIrradianceDaySuns: 12,
  groundIrradianceMinCosine: -0.35,
  /**
   * Light that falls by orders of magnitude between samples is kept as its
   * logarithm, which interpolates along the curve where the light itself would
   * bow above it. Where no light arrives at all the logarithm is held at this,
   * far below any night sky's.
   */
  logFloor: 1e-30,
  /** Directions the sky's light on a level surface is gathered from: heights, and bearings from the Sun on one side. */
  irradianceZenithSamples: 12,
  irradianceAzimuthSamples: 16,
  irradianceSteps: 16,
} as const;

export interface AtmosphereParameters {
  /** Haze: the vertical optical depth of aerosols at 550 nm, from sea level to space. 0.1 is a clear day over land. */
  aerosolOpticalDepth: number;
  /** The share of light the ground reflects, for the light it sends back into the air. */
  groundAlbedo: number;
}

export interface AtmosphereBuildInfo {
  /** Milliseconds the tables took, by the clock given. */
  buildMs: number;
  /** Bytes the tables hold. */
  tableBytes: number;
}

export type Rgb = [number, number, number];

export interface Atmosphere {
  readonly parameters: AtmosphereParameters;
  readonly build: AtmosphereBuildInfo;
  /**
   * The share of the Sun's light that reaches a height, for the Sun `muSun`
   * (cosine of its zenith angle) there: transmittance through the air, times
   * the part of its disc above the horizon.
   */
  sunTransmittance(altitudeMeters: number, muSun: number, out: Rgb): Rgb;
  /**
   * The sky's luminance from a height, per unit of the Sun's illuminance above
   * the atmosphere, in sr⁻¹: looking along a direction whose zenith angle has
   * cosine `mu`, with the Sun at `muSun` and `nu` the cosine of the angle
   * between the two. A direction that meets the ground includes the lit
   * ground seen through the air. The Sun's own disc is not included.
   */
  radiance(altitudeMeters: number, mu: number, muSun: number, nu: number, steps: number, out: Rgb): Rgb;
  /** The sky's light on a level surface at a height, as a share of the Sun's illuminance above the atmosphere. */
  skyIrradiance(altitudeMeters: number, muSun: number, out: Rgb): Rgb;
  /** The same on level ground at sea level, from a table: cheap enough for every direction that meets the ground. */
  groundSkyIrradiance(muSun: number, out: Rgb): Rgb;
}

const RG = ATMOSPHERE.planetRadiusMeters;
const RT = ATMOSPHERE.planetRadiusMeters + ATMOSPHERE.thicknessMeters;
/** Distance from the horizon at sea level to the top of the air. */
const HORIZON_TO_TOP = Math.sqrt(RT * RT - RG * RG);

/** The integral of a density that varies exponentially between two values over a length: exact for an exponential atmosphere along a vertical path. */
function logMean(a: number, b: number, length: number): number {
  if (a <= 0 || b <= 0) return 0.5 * (a + b) * length;
  const ratio = Math.log(b / a);
  return Math.abs(ratio) < 1e-5 ? 0.5 * (a + b) * length : ((b - a) / ratio) * length;
}

function ozoneDensity(height: number): number {
  return Math.max(0, 1 - Math.abs(height - ATMOSPHERE.ozoneCenterMeters) / ATMOSPHERE.ozoneHalfWidthMeters);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

interface SunAxis {
  samples: number;
  /** The Sun's cosine at a sample. */
  cosine(index: number): number;
  /** Where a cosine falls among the samples, as a fractional index, held to the axis's ends. */
  position(muSun: number): number;
}

/** A table's axis of the Sun's cosine: `twilight` samples evenly from `least` to `TABLES.twilightMaxCosine`, then `day` more evenly to the zenith. */
function sunAxis(least: number, twilight: number, day: number): SunAxis {
  const top = TABLES.twilightMaxCosine;
  return {
    samples: twilight + day,
    cosine: index => index < twilight
      ? least + (index / (twilight - 1)) * (top - least)
      : top + ((index - twilight + 1) / day) * (1 - top),
    position: muSun => muSun <= top
      ? Math.max(0, (muSun - least) / (top - least)) * (twilight - 1)
      : twilight - 1 + Math.min(1, (muSun - top) / (1 - top)) * day,
  };
}

/** Rayleigh's phase function, sr⁻¹. */
export function rayleighPhase(nu: number): number {
  return (3 / (16 * Math.PI)) * (1 + nu * nu);
}

/** Cornette and Shanks's phase function for haze, sr⁻¹. */
export function miePhase(nu: number, g: number = ATMOSPHERE.mieAsymmetry): number {
  const g2 = g * g;
  return (3 / (8 * Math.PI)) * ((1 - g2) * (1 + nu * nu)) / ((2 + g2) * Math.pow(1 + g2 - 2 * g * nu, 1.5));
}

export function createAtmosphere(parameters: AtmosphereParameters, now: () => number = () => 0): Atmosphere {
  const started = now();
  const aerosol = Math.max(0, parameters.aerosolOpticalDepth);
  const albedo = Math.min(1, Math.max(0, parameters.groundAlbedo));
  const mieExtinction = aerosol / ATMOSPHERE.mieScaleHeightMeters;
  const mieScattering = mieExtinction * ATMOSPHERE.mieSingleScatteringAlbedo;
  const rayleigh = ATMOSPHERE.rayleighScattering;
  const ozone = ATMOSPHERE.ozoneAbsorption;
  const invRayleighHeight = 1 / ATMOSPHERE.rayleighScaleHeightMeters;
  const invMieHeight = 1 / ATMOSPHERE.mieScaleHeightMeters;

  // ─── Transmittance to the top of the air ────────────────────────────
  // Bruneton's mapping: one axis is the height, as the distance to the sea
  // horizon; the other the direction, as the distance to the top of the air
  // between its least (straight up) and greatest (along the horizon). The
  // table holds optical depth, which interpolates well where transmittance
  // itself falls by orders of magnitude between neighbours: towards a low Sun.
  const tw = TABLES.transmittanceWidth;
  const th = TABLES.transmittanceHeight;
  const transmittance = new Float32Array(tw * th * 3);
  for (let v = 0; v < th; v++) {
    const rho = HORIZON_TO_TOP * (v / (th - 1));
    const r = Math.sqrt(rho * rho + RG * RG);
    const dMin = RT - r;
    const dMax = rho + HORIZON_TO_TOP;
    for (let u = 0; u < tw; u++) {
      const d = dMin + (u / (tw - 1)) * (dMax - dMin);
      const mu = d <= 0 ? 1 : Math.min(1, Math.max(-1, (HORIZON_TO_TOP * HORIZON_TO_TOP - rho * rho - d * d) / (2 * r * d)));
      let pathRayleigh = 0, pathMie = 0, pathOzone = 0;
      // As in a march: a ray that climbs takes short steps first, through the dense air.
      const climbing = mu >= 0;
      let h = r - RG;
      let densityRayleigh = Math.exp(-h * invRayleighHeight);
      let densityMie = Math.exp(-h * invMieHeight);
      let densityOzone = ozoneDensity(h);
      let from = 0;
      for (let i = 1; i <= TABLES.transmittanceSteps; i++) {
        const fraction = i / TABLES.transmittanceSteps;
        const s = d * (climbing ? fraction * fraction : fraction);
        const step = s - from;
        from = s;
        h = Math.max(0, Math.sqrt(r * r + s * s + 2 * r * mu * s) - RG);
        const nextRayleigh = Math.exp(-h * invRayleighHeight);
        const nextMie = Math.exp(-h * invMieHeight);
        const nextOzone = ozoneDensity(h);
        pathRayleigh += logMean(densityRayleigh, nextRayleigh, step);
        pathMie += logMean(densityMie, nextMie, step);
        pathOzone += 0.5 * (densityOzone + nextOzone) * step;
        densityRayleigh = nextRayleigh; densityMie = nextMie; densityOzone = nextOzone;
      }
      const index = (v * tw + u) * 3;
      for (let c = 0; c < 3; c++) {
        transmittance[index + c] = rayleigh[c] * pathRayleigh + mieExtinction * pathMie + ozone[c] * pathOzone;
      }
    }
  }

  const scratch: Rgb = [0, 0, 0];
  /** Transmittance from radius `r` to the top of the air along `mu`, for a ray that clears the ground. */
  function transmittanceToTop(r: number, mu: number, out: Rgb): void {
    const rho = Math.sqrt(Math.max(0, r * r - RG * RG));
    const d = Math.max(0, -r * mu + Math.sqrt(Math.max(0, r * r * (mu * mu - 1) + RT * RT)));
    const dMin = RT - r;
    const dMax = rho + HORIZON_TO_TOP;
    const x = dMax > dMin ? Math.min(1, Math.max(0, (d - dMin) / (dMax - dMin))) * (tw - 1) : 0;
    const y = Math.min(1, rho / HORIZON_TO_TOP) * (th - 1);
    const x0 = Math.min(tw - 2, Math.floor(x));
    const y0 = Math.min(th - 2, Math.floor(y));
    const fx = x - x0;
    const fy = y - y0;
    const a = (y0 * tw + x0) * 3;
    const b = a + tw * 3;
    for (let c = 0; c < 3; c++) {
      const top = transmittance[a + c] + (transmittance[a + 3 + c] - transmittance[a + c]) * fx;
      const bottom = transmittance[b + c] + (transmittance[b + 3 + c] - transmittance[b + c]) * fx;
      out[c] = Math.exp(-(top + (bottom - top) * fy));
    }
  }

  /** The part of the Sun's disc above the horizon of radius `r`, from 0 to 1. */
  function sunVisibility(r: number, muSun: number): number {
    const sinHorizon = Math.min(1, RG / r);
    const cosHorizon = -Math.sqrt(Math.max(0, 1 - sinHorizon * sinHorizon));
    const width = sinHorizon * ATMOSPHERE.sunAngularRadius;
    return smoothstep(-width, width, muSun - cosHorizon);
  }

  function sunTransmittanceAt(r: number, muSun: number, out: Rgb): void {
    const visible = sunVisibility(r, muSun);
    if (visible <= 0) {
      out[0] = 0; out[1] = 0; out[2] = 0;
      return;
    }
    transmittanceToTop(r, muSun, out);
    out[0] *= visible; out[1] *= visible; out[2] *= visible;
  }

  // ─── Light scattered more than once ─────────────────────────────────
  const msHeights = TABLES.multipleScatteringHeights;
  const msAxis = sunAxis(TABLES.twilightMinCosine, TABLES.multipleScatteringTwilightSuns, TABLES.multipleScatteringDaySuns);
  const msSuns = msAxis.samples;
  const multipleScattering = new Float32Array(msSuns * msHeights * 3);
  let multipleScatteringReady = false;
  const psi: Rgb = [0, 0, 0];
  function multipleScatteringAt(r: number, muSun: number, out: Rgb): void {
    if (!multipleScatteringReady || muSun <= TABLES.twilightMinCosine) {
      out[0] = 0; out[1] = 0; out[2] = 0;
      return;
    }
    const x = msAxis.position(muSun);
    const y = Math.min(1, Math.max(0, (r - RG) / (RT - RG))) * (msHeights - 1);
    const x0 = Math.min(msSuns - 2, Math.floor(x));
    const y0 = Math.min(msHeights - 2, Math.floor(y));
    const fx = x - x0;
    const fy = y - y0;
    const a = (y0 * msSuns + x0) * 3;
    const b = a + msSuns * 3;
    // The table holds logarithms (TABLES.logFloor).
    for (let c = 0; c < 3; c++) {
      const top = multipleScattering[a + c] + (multipleScattering[a + 3 + c] - multipleScattering[a + c]) * fx;
      const bottom = multipleScattering[b + c] + (multipleScattering[b + 3 + c] - multipleScattering[b + c]) * fx;
      out[c] = Math.exp(top + (bottom - top) * fy);
    }
  }

  // ─── One ray through the air ────────────────────────────────────────
  // The sky's light on level ground, from a table of logarithms (TABLES.logFloor).
  const groundAxis = sunAxis(TABLES.groundIrradianceMinCosine, TABLES.groundIrradianceTwilightSuns, TABLES.groundIrradianceDaySuns);
  const groundIrradiance = new Float32Array(groundAxis.samples * 3);
  let groundIrradianceReady = false;
  function groundSkyIrradiance(muSun: number, out: Rgb): Rgb {
    if (!groundIrradianceReady) {
      out[0] = 0; out[1] = 0; out[2] = 0;
      return out;
    }
    const x = groundAxis.position(muSun);
    const x0 = Math.min(groundAxis.samples - 2, Math.floor(x));
    const f = x - x0;
    for (let c = 0; c < 3; c++) out[c] = Math.exp(groundIrradiance[x0 * 3 + c] + (groundIrradiance[x0 * 3 + 3 + c] - groundIrradiance[x0 * 3 + c]) * f);
    return out;
  }

  const sunT: Rgb = [0, 0, 0];
  const groundSky: Rgb = [0, 0, 0];
  const tau: Rgb = [0, 0, 0];
  /**
   * Marches one ray. `isotropic` gathers what the multiple-scattering
   * estimate needs instead of the sky's luminance: light scattered once with
   * no preferred direction into `out`, and the share of light scattered from
   * the ray that reaches its start into `transfer`.
   */
  function march(r0: number, mu0: number, muSun0: number, nu: number, steps: number, out: Rgb, isotropic: boolean, transfer: Rgb | null): void {
    out[0] = 0; out[1] = 0; out[2] = 0;
    let r = r0;
    let mu = mu0;
    let muSun = muSun0;
    // From outside the air, start where the ray enters it; a ray that misses it sees nothing.
    if (r > RT) {
      const discriminant = r * r * (mu * mu - 1) + RT * RT;
      if (mu >= 0 || discriminant < 0) return;
      const enter = -r * mu - Math.sqrt(discriminant);
      const muSunAtEntry = (r * muSun + enter * nu) / RT;
      mu = (r * mu + enter) / RT;
      muSun = muSunAtEntry;
      r = RT;
    }
    r = Math.max(r, RG);
    const groundDiscriminant = r * r * (mu * mu - 1) + RG * RG;
    const hitsGround = mu < 0 && groundDiscriminant >= 0;
    const length = hitsGround
      ? Math.max(0, -r * mu - Math.sqrt(groundDiscriminant))
      : Math.max(0, -r * mu + Math.sqrt(Math.max(0, r * r * (mu * mu - 1) + RT * RT)));
    const phaseRayleigh = isotropic ? 1 / (4 * Math.PI) : rayleighPhase(nu);
    const phaseMie = isotropic ? 1 / (4 * Math.PI) : miePhase(nu);
    tau[0] = 0; tau[1] = 0; tau[2] = 0;
    // A ray that climbs leaves the dense air behind, so its steps start short
    // and lengthen; one that descends or grazes meets it later, and steps evenly.
    const climbing = mu >= 0;
    let h = r - RG;
    let densityRayleigh = Math.exp(-h * invRayleighHeight);
    let densityMie = Math.exp(-h * invMieHeight);
    let densityOzone = ozoneDensity(h);
    let from = 0;
    for (let i = 1; i <= steps && length > 0; i++) {
      const fraction = i / steps;
      const s = length * (climbing ? fraction * fraction : fraction);
      const step = s - from;
      const radius = Math.max(RG, Math.sqrt(r * r + s * s + 2 * r * mu * s));
      h = radius - RG;
      const nextRayleigh = Math.exp(-h * invRayleighHeight);
      const nextMie = Math.exp(-h * invMieHeight);
      const nextOzone = ozoneDensity(h);
      const pathRayleigh = logMean(densityRayleigh, nextRayleigh, step);
      const pathMie = logMean(densityMie, nextMie, step);
      const pathOzone = 0.5 * (densityOzone + nextOzone) * step;
      // The Sun and the scattered light are taken where the step's scattering
      // is centred: towards its denser end, for a density that falls away.
      const before = rayleigh[1] * densityRayleigh + mieScattering * densityMie;
      const after = rayleigh[1] * nextRayleigh + mieScattering * nextMie;
      const slope = before > 0 && after > 0 ? Math.log(before / after) : 0;
      const centre = Math.abs(slope) < 1e-3 ? 0.5 : 1 / slope - 1 / (Math.exp(slope) - 1);
      densityRayleigh = nextRayleigh; densityMie = nextMie; densityOzone = nextOzone;
      const middle = from + centre * step;
      from = s;
      const middleRadius = Math.max(RG, Math.sqrt(r * r + middle * middle + 2 * r * mu * middle));
      const middleMuSun = Math.min(1, Math.max(-1, (r * muSun + middle * nu) / middleRadius));
      sunTransmittanceAt(middleRadius, middleMuSun, sunT);
      multipleScatteringAt(middleRadius, middleMuSun, psi);
      const scatteredMie = mieScattering * pathMie;
      for (let c = 0; c < 3; c++) {
        const scatteredRayleigh = rayleigh[c] * pathRayleigh;
        const depth = scatteredRayleigh + mieExtinction * pathMie + ozone[c] * pathOzone;
        // The share of what the step scatters that leaves it towards the ray's start.
        const reaching = Math.exp(-tau[c]) * (depth > 1e-9 ? (1 - Math.exp(-depth)) / depth : 1);
        const scattered = scatteredRayleigh + scatteredMie;
        out[c] += ((scatteredRayleigh * phaseRayleigh + scatteredMie * phaseMie) * sunT[c] + scattered * psi[c]) * reaching;
        if (transfer) transfer[c] += scattered * reaching;
        tau[c] += depth;
      }
    }
    if (hitsGround) {
      const groundMuSun = Math.min(1, Math.max(-1, (r * muSun + length * nu) / RG));
      sunTransmittanceAt(RG, groundMuSun, sunT);
      groundSkyIrradiance(groundMuSun, groundSky);
      const direct = Math.max(0, groundMuSun);
      for (let c = 0; c < 3; c++) {
        out[c] += Math.exp(-tau[c]) * (albedo / Math.PI) * (sunT[c] * direct + (isotropic ? 0 : groundSky[c]));
      }
    }
  }

  // Hillaire's estimate: light scattered twice, gathered from every direction
  // with no preferred direction, and the series of every later scattering
  // summed as 1 / (1 - share scattered again).
  const gathered: Rgb = [0, 0, 0];
  const transferred: Rgb = [0, 0, 0];
  const second: Rgb = [0, 0, 0];
  const pending = new Float32Array(multipleScattering.length);
  const zeniths = TABLES.multipleScatteringZeniths;
  const azimuths = TABLES.multipleScatteringAzimuths;
  for (let v = 0; v < msHeights; v++) {
    const r = RG + (RT - RG) * (v / (msHeights - 1));
    for (let u = 0; u < msSuns; u++) {
      const muSun = msAxis.cosine(u);
      second[0] = 0; second[1] = 0; second[2] = 0;
      transferred[0] = 0; transferred[1] = 0; transferred[2] = 0;
      const sinSun = Math.sqrt(Math.max(0, 1 - muSun * muSun));
      for (let i = 0; i < zeniths; i++) {
        const mu = ((i + 0.5) / zeniths) * 2 - 1;
        const sinView = Math.sqrt(1 - mu * mu);
        for (let j = 0; j < azimuths; j++) {
          // The other half of the bearings mirrors this one about the Sun.
          const phi = ((j + 0.5) / azimuths) * Math.PI;
          march(r, mu, muSun, mu * muSun + sinView * sinSun * Math.cos(phi), TABLES.multipleScatteringSteps, gathered, true, transferred);
          second[0] += gathered[0]; second[1] += gathered[1]; second[2] += gathered[2];
        }
      }
      const count = zeniths * azimuths;
      const index = (v * msSuns + u) * 3;
      for (let c = 0; c < 3; c++) {
        // Means over the sphere: the isotropic phase function is 1/4π of it.
        const again = Math.min(0.999, transferred[c] / count);
        pending[index + c] = Math.log(Math.max(TABLES.logFloor, (second[c] / count) / (1 - again)));
      }
    }
  }
  multipleScattering.set(pending);
  multipleScatteringReady = true;

  function radianceAt(altitudeMeters: number, mu: number, muSun: number, nu: number, steps: number, out: Rgb): Rgb {
    march(RG + Math.max(0, altitudeMeters), Math.min(1, Math.max(-1, mu)), Math.min(1, Math.max(-1, muSun)), Math.min(1, Math.max(-1, nu)), Math.max(1, Math.round(steps)), out, false, null);
    return out;
  }

  const sample: Rgb = [0, 0, 0];
  function skyIrradiance(altitudeMeters: number, muSun: number, out: Rgb): Rgb {
    out[0] = 0; out[1] = 0; out[2] = 0;
    const zeniths = TABLES.irradianceZenithSamples;
    const azimuths = TABLES.irradianceAzimuthSamples;
    const sinSun = Math.sqrt(Math.max(0, 1 - muSun * muSun));
    // ∫ L cos θ dω over the upper half, in equal steps of θ and with one side
    // of the Sun doubled. Equal steps of cos θ would leave the first ring 17°
    // from the zenith, outside the haze's glow round a Sun overhead.
    const step = (Math.PI / 2) / zeniths;
    for (let i = 0; i < zeniths; i++) {
      const theta = (i + 0.5) * step;
      const mu = Math.cos(theta);
      const sinView = Math.sin(theta);
      const weight = mu * sinView * step * (2 * Math.PI / azimuths);
      for (let j = 0; j < azimuths; j++) {
        const phi = ((j + 0.5) / azimuths) * Math.PI;
        radianceAt(altitudeMeters, mu, muSun, mu * muSun + sinView * sinSun * Math.cos(phi), TABLES.irradianceSteps, sample);
        out[0] += sample[0] * weight; out[1] += sample[1] * weight; out[2] += sample[2] * weight;
      }
    }
    return out;
  }

  for (let i = 0; i < groundAxis.samples; i++) {
    skyIrradiance(0, groundAxis.cosine(i), scratch);
    for (let c = 0; c < 3; c++) groundIrradiance[i * 3 + c] = Math.log(Math.max(TABLES.logFloor, scratch[c]));
  }
  groundIrradianceReady = true;

  return {
    parameters: { aerosolOpticalDepth: aerosol, groundAlbedo: albedo },
    build: {
      buildMs: now() - started,
      tableBytes: transmittance.byteLength + multipleScattering.byteLength + groundIrradiance.byteLength,
    },
    sunTransmittance(altitudeMeters, muSun, out) {
      const r = RG + Math.max(0, altitudeMeters);
      const mu = Math.min(1, Math.max(-1, muSun));
      if (r <= RT) {
        sunTransmittanceAt(r, mu, out);
        return out;
      }
      // From above the air: the Sun's ray misses it, or crosses it from where it enters.
      const discriminant = r * r * (mu * mu - 1) + RT * RT;
      if (mu >= 0 || discriminant < 0) {
        out[0] = 1; out[1] = 1; out[2] = 1;
        return out;
      }
      sunTransmittanceAt(RT, (r * mu - r * mu - Math.sqrt(discriminant)) / RT, out);
      return out;
    },
    radiance: radianceAt,
    skyIrradiance,
    groundSkyIrradiance,
  };
}
