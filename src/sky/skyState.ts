import { DEG_TO_RAD, RAD_TO_DEG, ecefToGeodetic } from "../camera/cameraMath";
import { ATMOSPHERE, type Atmosphere, type Rgb } from "./atmosphere";
import { MOONLIGHT_TINT, moonIlluminanceLux, moonViewFrom, type LunarEphemeris, type MoonView } from "./lunarPosition";
import { refractionFormulaDeg, SPA_REFRACTION_CUTOFF_DEG, sunDirectionFrom, type SolarEphemeris } from "./solarPosition";

/**
 * The light of the Sun and the sky at one place and instant, in photometric
 * units: illuminance in lux, luminance in cd/m². This is where the atmosphere
 * model's ratios get their scale, and where display exposure is defined.
 * docs/proposals/sky.md states each unit and how it reaches the renderer.
 */

export const PHOTOMETRY = {
  /**
   * The Sun's illuminance above the atmosphere at 1 AU, lux: the reference
   * luminous solar constant of Darula, Kittler and Gueymard (Solar Energy 79,
   * 2005). Published values run from 127,500 (IES) to 133,800 (CIE 85): ±2.5%.
   */
  solarIlluminanceLux: 133_334,
  /** Luminance of linear red, green and blue with sRGB's primaries (ITU-R BT.709). */
  luminanceWeights: [0.2126, 0.7152, 0.0722],
  /**
   * Saturation-based exposure at ISO 100 (ISO 12232): a luminance of
   * `saturation * 2^EV` cd/m² is the display's white.
   */
  saturation: 1.2,
  /** An incident-light meter's calibration at ISO 100 (ISO 2720, C = 250): EV = log2(lux * this). */
  incidentMeter: 0.4,
} as const;

/** The standard atmosphere's sea-level state and lapse (ISO 2533), for refraction at the observer's height. */
const STANDARD_ATMOSPHERE = {
  seaLevelPressureMbar: 1013.25,
  seaLevelTemperatureK: 288.15,
  lapseKPerMeter: 0.0065,
  tropopauseMeters: 11_000,
  tropopausePressureMbar: 226.32,
  tropopauseTemperatureK: 216.65,
  /** The scale height of the isothermal layer above the tropopause, m. */
  stratosphereScaleMeters: 6341.62,
  pressureExponent: 5.25588,
  zeroCelsiusK: 273.15,
} as const;

/**
 * Below the horizon the report's refraction stops at once, which would make
 * the Sun jump by more than its own width. Drawing needs it continuous: from
 * its last value, where the disc's top meets the horizon, it fades to nothing
 * by this elevation. A device for continuity, not a model of refraction.
 */
const REFRACTION_FADE_TO_DEG = -6;

export function luminance(rgb: Readonly<Rgb>): number {
  const w = PHOTOMETRY.luminanceWeights;
  return w[0] * rgb[0] + w[1] * rgb[1] + w[2] * rgb[2];
}

/** The luminance, in cd/m², that an exposure at ISO 100 shows as the display's white. */
export function whiteLuminanceForEv100(ev100: number): number {
  return PHOTOMETRY.saturation * 2 ** ev100;
}

/** The exposure at ISO 100 that shows this luminance, in cd/m², as the display's white. */
export function ev100ForWhiteLuminance(whiteLuminance: number): number {
  return Math.log2(whiteLuminance / PHOTOMETRY.saturation);
}

/** What an incident-light meter reads for an illuminance in lux, as an exposure at ISO 100. */
export function ev100ForIlluminance(lux: number): number {
  return Math.log2(Math.max(lux, 1e-12) * PHOTOMETRY.incidentMeter);
}

/**
 * The exposure for a metered reading when exposure follows the light down
 * from a high Sun's only part of the way: `adaptation` stops of exposure for
 * each stop of light. One follows the meter all of the way, as a camera does,
 * and dusk shows as bright as noon; less leaves dusk and night darker than
 * day, as eyes see them. A reading above the high Sun's is followed whole.
 */
export function adaptEv100(meteredEv100: number, zenithEv100: number, adaptation: number): number {
  const share = Math.min(1, Math.max(0, adaptation));
  return meteredEv100 >= zenithEv100 ? meteredEv100 : zenithEv100 - share * (zenithEv100 - meteredEv100);
}

/**
 * The exposure the stars are shown at. By day the scene's exposure shows no
 * star, at any height. Near the ground that is as it looks: the sky there is
 * far brighter than any star. But the sky thins with height, its brightness
 * halving with each 5 km or so, and above the air it is black beside a sunlit
 * planet. So between two heights the stars' exposure moves from the scene's,
 * at the lower, to the darkest exposure allowed, at the upper: a stop for
 * each equal step of height, which is what metering on the sky behind them
 * gives. Never brighter than the scene's exposure makes them below the lower
 * height, and at night, when the scene's is the darkest already, the same at
 * every height. Two equal heights make a step at that height.
 */
export function starEv100(sceneEv100: number, darkestEv100: number, altitudeMeters: number, fromMeters: number, toMeters: number): number {
  const dark = Math.min(sceneEv100, darkestEv100);
  const share = toMeters > fromMeters
    ? Math.min(1, Math.max(0, (altitudeMeters - fromMeters) / (toMeters - fromMeters)))
    : altitudeMeters >= toMeters ? 1 : 0;
  return sceneEv100 + share * (dark - sceneEv100);
}

/** How far the horizon lies below the level seen from a height, degrees: none at the ground, 20° from 400 km. */
export function horizonDipDeg(altitudeMeters: number): number {
  return Math.acos(ATMOSPHERE.planetRadiusMeters / (ATMOSPHERE.planetRadiusMeters + Math.max(0, altitudeMeters))) * RAD_TO_DEG;
}

/** Pressure in millibars and temperature in °C at a height, in the standard atmosphere. */
export function standardAtmosphere(altitudeMeters: number): { pressureMbar: number; temperatureC: number } {
  const a = STANDARD_ATMOSPHERE;
  const h = Math.max(0, altitudeMeters);
  if (h <= a.tropopauseMeters) {
    const temperature = a.seaLevelTemperatureK - a.lapseKPerMeter * h;
    return { pressureMbar: a.seaLevelPressureMbar * (temperature / a.seaLevelTemperatureK) ** a.pressureExponent, temperatureC: temperature - a.zeroCelsiusK };
  }
  return {
    pressureMbar: a.tropopausePressureMbar * Math.exp(-(h - a.tropopauseMeters) / a.stratosphereScaleMeters),
    temperatureC: a.tropopauseTemperatureK - a.zeroCelsiusK,
  };
}

/** How far refraction lifts the Sun for drawing, in degrees: the report's correction, made continuous below the horizon. */
export function drawnRefractionDeg(elevationDeg: number, altitudeMeters: number): number {
  const { pressureMbar, temperatureC } = standardAtmosphere(altitudeMeters);
  if (elevationDeg >= SPA_REFRACTION_CUTOFF_DEG) return refractionFormulaDeg(elevationDeg, pressureMbar, temperatureC);
  const fade = (elevationDeg - REFRACTION_FADE_TO_DEG) / (SPA_REFRACTION_CUTOFF_DEG - REFRACTION_FADE_TO_DEG);
  return fade <= 0 ? 0 : refractionFormulaDeg(SPA_REFRACTION_CUTOFF_DEG, pressureMbar, temperatureC) * fade;
}

/** A date written as year-month-day, as ms of UTC at its midnight, or null if it is not one. */
export function parseUtcDate(text: string): number | null {
  const match = /^\s*(-?\d{1,6})-(\d{1,2})-(\d{1,2})\s*$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime();
}

export type Vec3 = [number, number, number];

export interface SkyObserver {
  /** Earth-centred, Earth-fixed metres. */
  ecef: Vec3;
  latDeg: number;
  lonDeg: number;
  /** Height above the ellipsoid, m. */
  altitudeMeters: number;
  /** The ellipsoid's normal there: straight up. */
  up: Vec3;
  east: Vec3;
  north: Vec3;
}

export function observerAt(x: number, y: number, z: number): SkyObserver {
  const { latRad, lonRad, altMeters } = ecefToGeodetic(x, y, z);
  const cosLat = Math.cos(latRad), sinLat = Math.sin(latRad), cosLon = Math.cos(lonRad), sinLon = Math.sin(lonRad);
  return {
    ecef: [x, y, z],
    latDeg: latRad * RAD_TO_DEG,
    lonDeg: lonRad * RAD_TO_DEG,
    altitudeMeters: altMeters,
    up: [cosLat * cosLon, cosLat * sinLon, sinLat],
    east: [-sinLon, cosLon, 0],
    north: [-sinLat * cosLon, -sinLat * sinLon, cosLat],
  };
}

const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Where a body is drawn from an observer: lifted by refraction, keeping its bearing. */
export interface SkyPlacement {
  /** Unit vector to the body as drawn, Earth-centred and Earth-fixed. */
  direction: Vec3;
  /** Its bearing along the ground, a unit vector; the observer's north when it is overhead. */
  horizontal: Vec3;
  /** Elevation as drawn, and without refraction, degrees. */
  elevationDeg: number;
  geometricElevationDeg: number;
  /** Degrees east of north. */
  azimuthDeg: number;
}

/** Places a body seen along a straight line from the observer as it is drawn. */
export function placeInSky(geometric: Readonly<Vec3>, observer: SkyObserver): SkyPlacement {
  const sine = Math.min(1, Math.max(-1, dot(geometric, observer.up)));
  const geometricElevationDeg = Math.asin(sine) * RAD_TO_DEG;
  const elevationDeg = geometricElevationDeg + drawnRefractionDeg(geometricElevationDeg, observer.altitudeMeters);
  let horizontal: Vec3 = [geometric[0] - sine * observer.up[0], geometric[1] - sine * observer.up[1], geometric[2] - sine * observer.up[2]];
  const horizontalLength = Math.hypot(horizontal[0], horizontal[1], horizontal[2]);
  horizontal = horizontalLength > 1e-9
    ? [horizontal[0] / horizontalLength, horizontal[1] / horizontalLength, horizontal[2] / horizontalLength]
    : [...observer.north];
  const elevation = elevationDeg * DEG_TO_RAD;
  const cosine = Math.cos(elevation);
  const mu = Math.sin(elevation);
  return {
    direction: [cosine * horizontal[0] + mu * observer.up[0], cosine * horizontal[1] + mu * observer.up[1], cosine * horizontal[2] + mu * observer.up[2]],
    horizontal,
    elevationDeg,
    geometricElevationDeg,
    azimuthDeg: (Math.atan2(dot(horizontal, observer.east), dot(horizontal, observer.north)) * RAD_TO_DEG + 360) % 360,
  };
}

/** The Moon at the observer: where it is, its phase, and its light. */
export interface SkyMoon extends SkyPlacement {
  view: MoonView;
  /** Its illuminance above the air at the observer's distance from it, lux, before its colour. */
  illuminanceLux: number;
  /** Its light above the air in each band: moonlight is redder than sunlight. */
  extraterrestrial: Rgb;
  /** On a surface facing the Moon at the observer, lux in each band. */
  directIlluminance: Rgb;
  /** The moonlit sky's light on a level surface at the observer, lux in each band; part of the sky's. */
  skyIlluminance: Rgb;
}

export interface SkyIllumination {
  utcMs: number;
  observer: SkyObserver;
  /** Unit vector to the Sun as drawn, Earth-centred and Earth-fixed: lifted by refraction. */
  sunDirection: Vec3;
  /** The Sun's bearing along the ground, a unit vector; the observer's north when the Sun is overhead. */
  sunHorizontal: Vec3;
  /** The Sun's elevation as drawn, and without refraction, degrees. */
  sunElevationDeg: number;
  geometricElevationDeg: number;
  /** Degrees east of north. */
  sunAzimuthDeg: number;
  /** The Sun's illuminance above the atmosphere at its distance today, lux. */
  solarIlluminanceLux: number;
  /** On a surface facing the Sun at the observer, lux in each band; their luminance is the illuminance in lux. */
  sunIlluminance: Rgb;
  /** The Moon, or null where it is not modelled. */
  moon: SkyMoon | null;
  /** The sky's light on a level surface at the observer, lux in each band: the sunlit and moonlit sky's, and the night sky's. */
  skyIlluminance: Rgb;
  /** The Sun's, the Moon's and the sky's light on level ground at sea level below the observer. */
  groundIlluminance: Rgb;
  /** The luminance of ground of the atmosphere's albedo under that light, cd/m² in each band. */
  groundLuminance: Rgb;
  /** What the exposure meter reads: surfaces facing the Sun and the Moon, plus the sky's light on a level one, lux. */
  meteredLux: number;
  /** What the meter would read here with the Sun overhead: the light exposure adapts down from. */
  zenithMeteredLux: number;
  /** The night sky's own luminance, added above the horizon, cd/m². */
  nightLuminance: number;
}

export interface SkyIlluminationOptions {
  /** A uniform luminance for the night sky: starlight and airglow, cd/m². */
  nightLuminance: number;
  /** The Moon's place at the same instant, or null to leave it out. */
  lunar?: LunarEphemeris | null;
}

/** The light of a body above the air, in each band, reaching level ground at sea level under it: its own and the sky's, per unit. */
function groundLightPerUnit(atmosphere: Atmosphere, mu: number, out: Rgb): Rgb {
  const sky: Rgb = [0, 0, 0];
  atmosphere.sunTransmittance(0, mu, out);
  atmosphere.groundSkyIrradiance(mu, sky);
  const direct = Math.max(0, mu);
  for (let band = 0; band < 3; band++) out[band] = out[band] * direct + sky[band];
  return out;
}

export function computeSkyIllumination(atmosphere: Atmosphere, ephemeris: SolarEphemeris, observer: SkyObserver, options: SkyIlluminationOptions): SkyIllumination {
  const sun = placeInSky(sunDirectionFrom(ephemeris, observer.ecef[0], observer.ecef[1], observer.ecef[2]), observer);
  const muSun = Math.sin(sun.elevationDeg * DEG_TO_RAD);
  const solarIlluminanceLux = PHOTOMETRY.solarIlluminanceLux / (ephemeris.radiusVectorAu * ephemeris.radiusVectorAu);
  const night = Math.max(0, options.nightLuminance);
  const scratch: Rgb = [0, 0, 0];
  const altitude = Math.max(0, observer.altitudeMeters);
  atmosphere.sunTransmittance(altitude, muSun, scratch);
  const sunIlluminance: Rgb = [scratch[0] * solarIlluminanceLux, scratch[1] * solarIlluminanceLux, scratch[2] * solarIlluminanceLux];
  atmosphere.skyIrradiance(altitude, muSun, scratch);
  // A uniform sky of luminance L lights a level surface with π L.
  const nightLux = Math.PI * night;
  const skyIlluminance: Rgb = [scratch[0] * solarIlluminanceLux + nightLux, scratch[1] * solarIlluminanceLux + nightLux, scratch[2] * solarIlluminanceLux + nightLux];
  groundLightPerUnit(atmosphere, muSun, scratch);
  const groundIlluminance: Rgb = [scratch[0] * solarIlluminanceLux + nightLux, scratch[1] * solarIlluminanceLux + nightLux, scratch[2] * solarIlluminanceLux + nightLux];

  // The Moon lights the Earth as a dim, redder Sun: its light passes the same air.
  let moon: SkyMoon | null = null;
  if (options.lunar) {
    const view = moonViewFrom(options.lunar, observer.ecef[0], observer.ecef[1], observer.ecef[2]);
    const placement = placeInSky(view.direction, observer);
    const muMoon = Math.sin(placement.elevationDeg * DEG_TO_RAD);
    // Sunlight reaches the Moon from the Sun's distance, which is the Earth's within a fraction of a percent.
    const illuminanceLux = moonIlluminanceLux(view, PHOTOMETRY.solarIlluminanceLux) / (ephemeris.radiusVectorAu * ephemeris.radiusVectorAu);
    const extraterrestrial: Rgb = [illuminanceLux * MOONLIGHT_TINT[0], illuminanceLux * MOONLIGHT_TINT[1], illuminanceLux * MOONLIGHT_TINT[2]];
    const directIlluminance: Rgb = [0, 0, 0];
    const moonSky: Rgb = [0, 0, 0];
    atmosphere.sunTransmittance(altitude, muMoon, scratch);
    for (let band = 0; band < 3; band++) directIlluminance[band] = scratch[band] * extraterrestrial[band];
    atmosphere.skyIrradiance(altitude, muMoon, scratch);
    for (let band = 0; band < 3; band++) moonSky[band] = scratch[band] * extraterrestrial[band];
    groundLightPerUnit(atmosphere, muMoon, scratch);
    for (let band = 0; band < 3; band++) {
      skyIlluminance[band] += moonSky[band];
      groundIlluminance[band] += scratch[band] * extraterrestrial[band];
    }
    moon = { ...placement, view, illuminanceLux, extraterrestrial, directIlluminance, skyIlluminance: moonSky };
  }

  atmosphere.sunTransmittance(altitude, 1, scratch);
  const zenithDirect = luminance(scratch);
  atmosphere.skyIrradiance(altitude, 1, scratch);
  const zenithMeteredLux = (zenithDirect + luminance(scratch)) * solarIlluminanceLux;
  const reflect = atmosphere.parameters.groundAlbedo / Math.PI;
  return {
    utcMs: ephemeris.utcMs,
    observer,
    sunDirection: sun.direction,
    sunHorizontal: sun.horizontal,
    sunElevationDeg: sun.elevationDeg,
    geometricElevationDeg: sun.geometricElevationDeg,
    sunAzimuthDeg: sun.azimuthDeg,
    solarIlluminanceLux,
    sunIlluminance,
    moon,
    skyIlluminance,
    groundIlluminance,
    groundLuminance: [groundIlluminance[0] * reflect, groundIlluminance[1] * reflect, groundIlluminance[2] * reflect],
    meteredLux: luminance(sunIlluminance) + luminance(skyIlluminance) + (moon ? luminance(moon.directIlluminance) : 0),
    zenithMeteredLux,
    nightLuminance: night,
  };
}

// ─── Light on level ground, by the height of the Sun or the Moon ───────

/**
 * Where the table of light on level ground is sampled, by the height of the
 * Sun or the Moon in degrees: every 1.5° through twilight and the low Sun,
 * where the light changes by orders of magnitude, then every 13° to the
 * zenith. Below the first sample the light fades to none over `fadeDeg`.
 * A terrain shader reads it for each pixel's own Sun and Moon.
 */
export const GROUND_LIGHT_TABLE = {
  fromDeg: -18,
  fineToDeg: 12,
  fineStepDeg: 1.5,
  coarseStepDeg: 13,
  fadeDeg: 2,
} as const;

const GROUND_FINE_INTERVALS = (GROUND_LIGHT_TABLE.fineToDeg - GROUND_LIGHT_TABLE.fromDeg) / GROUND_LIGHT_TABLE.fineStepDeg;
/** Samples in the table: 27. */
export const GROUND_LIGHT_SAMPLES = GROUND_FINE_INTERVALS + (90 - GROUND_LIGHT_TABLE.fineToDeg) / GROUND_LIGHT_TABLE.coarseStepDeg + 1;
/** Where no light arrives, the table's logarithm is held at that of this. */
const GROUND_LIGHT_FLOOR = 1e-30;
/** The sine of the height the table's wide steps start at: the least the light is held over. */
export const GROUND_LIGHT_LEAST_SINE = Math.sin(GROUND_LIGHT_TABLE.fineToDeg * DEG_TO_RAD);

/** The elevation, in degrees, of a sample of the table. */
export function groundLightTableElevationDeg(index: number): number {
  const t = GROUND_LIGHT_TABLE;
  return index <= GROUND_FINE_INTERVALS ? t.fromDeg + index * t.fineStepDeg : t.fineToDeg + (index - GROUND_FINE_INTERVALS) * t.coarseStepDeg;
}

/**
 * What the table holds its light over, for a body at height `mu` (the sine
 * of its elevation): that sine, above the table's fine steps. There most of
 * the light is the body's own on a level surface, which goes as the sine;
 * with it divided out, what is left changes slowly with height, and the
 * table's wide steps follow it within a few percent where they would leave
 * the light itself a tenth out. Constant below, where the fine steps are.
 */
export function groundLightWeight(mu: number): number {
  return Math.max(mu, GROUND_LIGHT_LEAST_SINE);
}

/**
 * The table: the natural logarithm of a body's light on level ground at sea
 * level, its own and the sky's, per unit of its illuminance above the air
 * and over `groundLightWeight` of its height, four floats a sample (red,
 * green, blue and one unused). It depends only on the atmosphere, so it is
 * built when the atmosphere is.
 */
export function groundLightTable(atmosphere: Atmosphere): Float32Array {
  const table = new Float32Array(GROUND_LIGHT_SAMPLES * 4);
  const light: Rgb = [0, 0, 0];
  for (let index = 0; index < GROUND_LIGHT_SAMPLES; index++) {
    const mu = Math.sin(groundLightTableElevationDeg(index) * DEG_TO_RAD);
    groundLightPerUnit(atmosphere, mu, light);
    for (let band = 0; band < 3; band++) table[index * 4 + band] = Math.log(Math.max(GROUND_LIGHT_FLOOR, light[band] / groundLightWeight(mu)));
  }
  return table;
}

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** The table's light for a body at height `mu` (the sine of its elevation), per unit of its illuminance above the air: what a terrain shader computes. */
export function groundLightAt(table: Float32Array, mu: number, out: Rgb = [0, 0, 0]): Rgb {
  const t = GROUND_LIGHT_TABLE;
  const e = Math.asin(Math.min(1, Math.max(-1, mu))) * RAD_TO_DEG;
  const raw = e <= t.fineToDeg ? (e - t.fromDeg) / t.fineStepDeg : GROUND_FINE_INTERVALS + (e - t.fineToDeg) / t.coarseStepDeg;
  const x = Math.min(GROUND_LIGHT_SAMPLES - 1, Math.max(0, raw));
  const base = Math.min(GROUND_LIGHT_SAMPLES - 2, Math.floor(x));
  const f = Math.min(1, x - base);
  const scale = smoothstep(t.fromDeg - t.fadeDeg, t.fromDeg, e) * groundLightWeight(mu);
  for (let band = 0; band < 3; band++) out[band] = Math.exp(table[base * 4 + band] * (1 - f) + table[(base + 1) * 4 + band] * f) * scale;
  return out;
}

// ─── The sky dome ──────────────────────────────────────────────────────

/** Rows added around the Sun's height, as offsets in degrees, so its glow is not left to the horizon's rows. */
const SUN_ROW_OFFSETS_DEG = [-12, -6, -3, -1.2, 0, 1.2, 3, 6, 12] as const;
/** Triangles of the Sun's disc. */
const SUN_DISC_SEGMENTS = 20;
/**
 * The Moon's disc: rings and segments of vertices, each coloured by the
 * light its part of the Moon reflects, so the phase's terminator falls
 * between vertices a sixth of the radius apart.
 */
const MOON_DISC = { rings: 6, segments: 24 } as const;
const MOON_DISC_VERTICES = 1 + MOON_DISC.rings * MOON_DISC.segments;
/** Samples across the Moon's disc for its mean brightness, by radius and by angle. */
const MOON_MEAN_SAMPLES = { radii: 16, angles: 48 } as const;
/**
 * The moonlit sky is drawn when its light on a level surface is at least
 * this share of the sunlit sky's: below it, adding it changes no colour by
 * more than a percent, and its samples would be spent for nothing.
 */
export const MOONLIT_SKY_SHARE = 0.01;

export interface SkyDomeLayout {
  /** Rows of samples from the zenith to the nadir, besides those around the Sun. */
  zenithSamples: number;
  /** Columns of samples from the Sun's bearing round to the opposite one; the other side mirrors them. */
  azimuthSamples: number;
  /** Steps of the integration along each sample's line of sight. */
  integrationSteps: number;
}

export interface SkyDomeGeometry {
  layout: SkyDomeLayout;
  /** Rows in all, the Sun's included. */
  rows: number;
  /** Columns round the whole circle. */
  columns: number;
  vertexCount: number;
  /** The first of the Moon's disc's vertices. */
  moonDiscStart: number;
  /**
   * Unit directions, three per vertex, in the dome's axes: +X towards the
   * Sun's bearing, +Y up, and +Z their cross product, X × Y, in the Earth's
   * axes (to the right of the Sun seen from above).
   */
  directions: Float32Array;
  /** Luminance in cd/m², three per vertex. */
  luminances: Float32Array;
  indices: Uint32Array;
  /** Samples of the model the last fill evaluated, and of those the moonlit sky's. */
  evaluations: number;
  moonEvaluations: number;
}

export function createSkyDomeGeometry(layout: SkyDomeLayout): SkyDomeGeometry {
  const zenithSamples = Math.max(4, Math.round(layout.zenithSamples));
  const azimuthSamples = Math.max(4, Math.round(layout.azimuthSamples));
  const rows = zenithSamples + 1 + SUN_ROW_OFFSETS_DEG.length;
  const columns = azimuthSamples * 2;
  const gridVertices = rows * columns;
  const moonDiscStart = gridVertices + SUN_DISC_SEGMENTS + 1;
  const vertexCount = moonDiscStart + MOON_DISC_VERTICES;
  const moonTriangles = MOON_DISC.segments * (1 + 2 * (MOON_DISC.rings - 1));
  const indices = new Uint32Array((rows - 1) * columns * 6 + SUN_DISC_SEGMENTS * 3 + moonTriangles * 3);
  let at = 0;
  for (let row = 0; row < rows - 1; row++) {
    for (let column = 0; column < columns; column++) {
      const a = row * columns + column;
      const b = row * columns + ((column + 1) % columns);
      const c = a + columns;
      const d = b + columns;
      indices[at++] = a; indices[at++] = c; indices[at++] = b;
      indices[at++] = b; indices[at++] = c; indices[at++] = d;
    }
  }
  // The Sun's disc, then the Moon's, so each is drawn over the sky behind it.
  for (let segment = 0; segment < SUN_DISC_SEGMENTS; segment++) {
    indices[at++] = gridVertices;
    indices[at++] = gridVertices + 1 + segment;
    indices[at++] = gridVertices + 1 + ((segment + 1) % SUN_DISC_SEGMENTS);
  }
  const ring = (index: number, segment: number): number => moonDiscStart + 1 + (index - 1) * MOON_DISC.segments + (segment % MOON_DISC.segments);
  for (let segment = 0; segment < MOON_DISC.segments; segment++) {
    indices[at++] = moonDiscStart;
    indices[at++] = ring(1, segment);
    indices[at++] = ring(1, segment + 1);
    for (let index = 1; index < MOON_DISC.rings; index++) {
      indices[at++] = ring(index, segment); indices[at++] = ring(index + 1, segment); indices[at++] = ring(index, segment + 1);
      indices[at++] = ring(index, segment + 1); indices[at++] = ring(index + 1, segment); indices[at++] = ring(index + 1, segment + 1);
    }
  }
  return {
    layout: { zenithSamples, azimuthSamples, integrationSteps: Math.max(2, Math.round(layout.integrationSteps)) },
    rows,
    columns,
    vertexCount,
    moonDiscStart,
    directions: new Float32Array(vertexCount * 3),
    luminances: new Float32Array(vertexCount * 3),
    indices,
    evaluations: 0,
    moonEvaluations: 0,
  };
}

/** A direction of the Earth's axes in the dome's: X the Sun's bearing, Y up, Z = X × Y. */
export function toDomeAxes(illumination: Pick<SkyIllumination, "sunHorizontal" | "observer">, v: Readonly<Vec3>): Vec3 {
  const x = illumination.sunHorizontal, y = illumination.observer.up;
  const z: Vec3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return [dot(v, x), dot(v, y), dot(v, z)];
}

/** Lommel-Seeliger reflection, the Moon's: bright to its limb, dark beyond the terminator. */
function lunarReflection(cosIncidence: number, cosEmergence: number): number {
  const i = Math.max(0, cosIncidence);
  return i <= 0 ? 0 : i / (i + Math.max(0, cosEmergence));
}

export interface SkyDomeFillOptions {
  /** Whether the moonlit sky is drawn when it is bright enough to matter. */
  moonlitSky: boolean;
}

/**
 * Samples the sky for a dome: where each vertex looks, and the luminance
 * there. Rows crowd towards the horizon as seen from the observer's height,
 * where the sky changes fastest, and around the Sun's height; columns crowd
 * towards the Sun's bearing. One side of the Sun is evaluated and mirrored.
 * The moonlit sky, when drawn, has no such symmetry and is evaluated at every
 * vertex; the Moon's disc shows its phase.
 */
export function fillSkyDome(dome: SkyDomeGeometry, atmosphere: Atmosphere, illumination: SkyIllumination, options: SkyDomeFillOptions = { moonlitSky: true }): void {
  const { rows, columns } = dome;
  const half = columns / 2;
  const altitude = Math.max(0, illumination.observer.altitudeMeters);
  const radius = ATMOSPHERE.planetRadiusMeters + altitude;
  // The horizon's zenith angle: a right angle at the ground, more from a height.
  const beta = Math.asin(Math.min(1, ATMOSPHERE.planetRadiusMeters / radius));
  const horizon = Math.PI - beta;
  const muSun = Math.sin(illumination.sunElevationDeg * DEG_TO_RAD);
  const sinSun = Math.sqrt(Math.max(0, 1 - muSun * muSun));
  const sunZenith = Math.acos(Math.min(1, Math.max(-1, muSun)));
  const scale = illumination.solarIlluminanceLux;
  const night = illumination.nightLuminance;
  const albedo = atmosphere.parameters.groundAlbedo;

  // Row angles: three quarters of the horizon's rows above it, a quarter below.
  const horizonRows = rows - SUN_ROW_OFFSETS_DEG.length;
  const above = Math.max(2, Math.round((horizonRows - 1) * 0.75));
  const below = horizonRows - 1 - above;
  const angles: number[] = [];
  for (let i = 0; i <= above; i++) {
    const t = 1 - i / above;
    angles.push(horizon * (1 - t * t));
  }
  for (let i = 1; i <= below; i++) {
    const t = i / below;
    angles.push(horizon + beta * t * t);
  }
  for (const offset of SUN_ROW_OFFSETS_DEG) angles.push(Math.min(Math.PI, Math.max(0, sunZenith + offset * DEG_TO_RAD)));
  angles.sort((a, b) => a - b);

  const sample: Rgb = [0, 0, 0];
  const steps = dome.layout.integrationSteps;
  let evaluations = 0;
  for (let row = 0; row < rows; row++) {
    const theta = angles[row];
    const mu = Math.cos(theta);
    const sinView = Math.sin(theta);
    const aboveHorizon = theta <= horizon;
    for (let column = 0; column <= half; column++) {
      // Columns crowd towards the Sun's bearing, where haze glows.
      const t = column / half;
      const phi = Math.PI * t * t;
      const cosPhi = Math.cos(phi);
      atmosphere.radiance(altitude, mu, muSun, mu * muSun + sinView * sinSun * cosPhi, steps, sample);
      evaluations++;
      const extra = aboveHorizon ? night : night * albedo;
      const x = sinView * cosPhi;
      const z = sinView * Math.sin(phi);
      for (const mirrored of column === 0 || column === half ? [column] : [column, columns - column]) {
        const index = (row * columns + mirrored) * 3;
        dome.directions[index] = x;
        dome.directions[index + 1] = mu;
        dome.directions[index + 2] = mirrored === column ? z : -z;
        dome.luminances[index] = sample[0] * scale + extra;
        dome.luminances[index + 1] = sample[1] * scale + extra;
        dome.luminances[index + 2] = sample[2] * scale + extra;
      }
    }
  }

  // The moonlit sky: the same model lit by the Moon, where it is bright enough to show.
  const moon = illumination.moon;
  const sunlitSky = luminance(illumination.skyIlluminance) - (moon ? luminance(moon.skyIlluminance) : 0) - Math.PI * night;
  const moonlit = moon !== null && options.moonlitSky && luminance(moon.skyIlluminance) >= MOONLIT_SKY_SHARE * Math.max(0, sunlitSky);
  let moonEvaluations = 0;
  const moonAxes = moon ? toDomeAxes(illumination, moon.direction) : null;
  const muMoon = moon ? Math.sin(moon.elevationDeg * DEG_TO_RAD) : 0;
  if (moonlit && moon && moonAxes) {
    for (let vertex = 0; vertex < rows * columns; vertex++) {
      const index = vertex * 3;
      const dx = dome.directions[index], dy = dome.directions[index + 1], dz = dome.directions[index + 2];
      atmosphere.radiance(altitude, dy, muMoon, dx * moonAxes[0] + dy * moonAxes[1] + dz * moonAxes[2], steps, sample);
      moonEvaluations++;
      dome.luminances[index] += sample[0] * moon.extraterrestrial[0];
      dome.luminances[index + 1] += sample[1] * moon.extraterrestrial[1];
      dome.luminances[index + 2] += sample[2] * moon.extraterrestrial[2];
    }
  }

  // The Sun's disc: its own luminance over the sky behind it. Its light is
  // spread evenly over the disc; a disc partly below the horizon is dimmer, not cut.
  const discStart = rows * columns;
  const solidAngle = Math.PI * ATMOSPHERE.sunAngularRadius * ATMOSPHERE.sunAngularRadius;
  atmosphere.radiance(altitude, muSun, muSun, 1, steps, sample);
  evaluations++;
  const disc: Rgb = [
    illumination.sunIlluminance[0] / solidAngle + sample[0] * scale,
    illumination.sunIlluminance[1] / solidAngle + sample[1] * scale,
    illumination.sunIlluminance[2] / solidAngle + sample[2] * scale,
  ];
  const tangent = Math.tan(ATMOSPHERE.sunAngularRadius);
  for (let vertex = 0; vertex <= SUN_DISC_SEGMENTS; vertex++) {
    // The centre, then the rim: the Sun's direction is (sinSun, muSun, 0) here.
    let x = sinSun, y = muSun, z = 0;
    if (vertex > 0) {
      const around = ((vertex - 1) / SUN_DISC_SEGMENTS) * 2 * Math.PI;
      // Two directions across the line of sight: sideways, and upwards along the meridian.
      const side = Math.sin(around) * tangent;
      const lift = Math.cos(around) * tangent;
      x += lift * -muSun;
      y += lift * sinSun;
      z += side;
      const length = Math.hypot(x, y, z);
      x /= length; y /= length; z /= length;
    }
    const index = (discStart + vertex) * 3;
    dome.directions[index] = x; dome.directions[index + 1] = y; dome.directions[index + 2] = z;
    dome.luminances[index] = disc[0]; dome.luminances[index + 1] = disc[1]; dome.luminances[index + 2] = disc[2];
  }

  fillMoonDisc(dome, atmosphere, illumination, moonlit, steps, () => { evaluations++; });
  dome.evaluations = evaluations + moonEvaluations;
  dome.moonEvaluations = moonEvaluations;
}

/**
 * The Moon's disc, each vertex the light its part of the Moon sends towards
 * the observer, by Lommel-Seeliger reflection of the Sun's light from that
 * part's slope, scaled so the disc's light is the Moon's direct light here;
 * over the sky's light in front of it. Its dark part shows that sky alone,
 * and hides the stars behind it. Without a Moon the disc is folded to a point.
 */
function fillMoonDisc(dome: SkyDomeGeometry, atmosphere: Atmosphere, illumination: SkyIllumination, moonlit: boolean, steps: number, evaluated: () => void): void {
  const start = dome.moonDiscStart;
  const moon = illumination.moon;
  if (!moon) {
    for (let vertex = 0; vertex < MOON_DISC_VERTICES; vertex++) {
      const index = (start + vertex) * 3;
      dome.directions[index] = 0; dome.directions[index + 1] = -1; dome.directions[index + 2] = 0;
      dome.luminances[index] = 0; dome.luminances[index + 1] = 0; dome.luminances[index + 2] = 0;
    }
    return;
  }
  const altitude = Math.max(0, illumination.observer.altitudeMeters);
  const m = toDomeAxes(illumination, moon.direction);
  const sun = toDomeAxes(illumination, moon.view.sunFromMoon);
  // Two directions across the line of sight, and the one back to the observer.
  let a: Vec3 = [-m[2], 0, m[0]];
  const length = Math.hypot(a[0], a[1], a[2]);
  a = length > 1e-6 ? [a[0] / length, a[1] / length, a[2] / length] : [1, 0, 0];
  const b: Vec3 = [m[1] * a[2] - m[2] * a[1], m[2] * a[0] - m[0] * a[2], m[0] * a[1] - m[1] * a[0]];
  const facing: Vec3 = [-m[0], -m[1], -m[2]];
  const sa = dot(sun, a), sb = dot(sun, b), sc = dot(sun, facing);
  const reflection = (u: number, v: number): number => {
    const c = Math.sqrt(Math.max(0, 1 - u * u - v * v));
    return lunarReflection(u * sa + v * sb + c * sc, c);
  };
  // The disc's mean reflection, by area, for the scale that makes its light the Moon's.
  let sum = 0, weight = 0;
  for (let i = 0; i < MOON_MEAN_SAMPLES.radii; i++) {
    const r = (i + 0.5) / MOON_MEAN_SAMPLES.radii;
    for (let j = 0; j < MOON_MEAN_SAMPLES.angles; j++) {
      const angle = ((j + 0.5) / MOON_MEAN_SAMPLES.angles) * 2 * Math.PI;
      sum += r * reflection(r * Math.cos(angle), r * Math.sin(angle));
      weight += r;
    }
  }
  const mean = sum / weight;
  const solidAngle = Math.PI * moon.view.angularRadius * moon.view.angularRadius;
  const peak: Rgb = mean > 1e-9
    ? [moon.directIlluminance[0] / (solidAngle * mean), moon.directIlluminance[1] / (solidAngle * mean), moon.directIlluminance[2] / (solidAngle * mean)]
    : [0, 0, 0];
  // The sky in front of the Moon: sunlit, and moonlit when that is drawn.
  const behind: Rgb = [0, 0, 0];
  const sample: Rgb = [0, 0, 0];
  const muSun = Math.sin(illumination.sunElevationDeg * DEG_TO_RAD);
  const muMoon = m[1];
  const sunAxes = toDomeAxes(illumination, illumination.sunDirection);
  atmosphere.radiance(altitude, muMoon, muSun, dot(m, sunAxes), steps, sample);
  evaluated();
  for (let band = 0; band < 3; band++) behind[band] = sample[band] * illumination.solarIlluminanceLux + illumination.nightLuminance;
  if (moonlit) {
    atmosphere.radiance(altitude, muMoon, muMoon, 1, steps, sample);
    evaluated();
    for (let band = 0; band < 3; band++) behind[band] += sample[band] * moon.extraterrestrial[band];
  }
  const tangent = Math.tan(moon.view.angularRadius);
  for (let vertex = 0; vertex < MOON_DISC_VERTICES; vertex++) {
    let u = 0, v = 0;
    if (vertex > 0) {
      const ringIndex = Math.floor((vertex - 1) / MOON_DISC.segments) + 1;
      const angle = (((vertex - 1) % MOON_DISC.segments) / MOON_DISC.segments) * 2 * Math.PI;
      const r = ringIndex / MOON_DISC.rings;
      u = r * Math.cos(angle);
      v = r * Math.sin(angle);
    }
    let x = m[0] + tangent * (u * a[0] + v * b[0]);
    let y = m[1] + tangent * (u * a[1] + v * b[1]);
    let z = m[2] + tangent * (u * a[2] + v * b[2]);
    const norm = Math.hypot(x, y, z);
    x /= norm; y /= norm; z /= norm;
    const index = (start + vertex) * 3;
    dome.directions[index] = x; dome.directions[index + 1] = y; dome.directions[index + 2] = z;
    const reflected = reflection(u, v);
    for (let band = 0; band < 3; band++) dome.luminances[index + band] = peak[band] * reflected + behind[band];
  }
}
