import { SUN_MAGNITUDE_AT_1_AU } from "./lunarPosition";
import { DELTA_T_SECONDS, solarPosition } from "./solarPosition";

/**
 * The stars: the Bright Star Catalogue's positions, brightness and colour,
 * carried from J2000 to a date by proper motion and precession, and turned
 * with the Earth. Pure TypeScript, no renderer; the catalogue's 145 KB are
 * loaded only when stars are wanted.
 */

const RAD = Math.PI / 180;
const ARCSEC = RAD / 3600;
const J2000 = 2451545;

export interface StarCatalogue {
  count: number;
  /** J2000 right ascension and declination, degrees. */
  raDeg: Float32Array;
  decDeg: Float32Array;
  /** V magnitude and B−V colour index. */
  vmag: Float32Array;
  colourIndex: Float32Array;
  /** Proper motion, arcseconds a year: in right ascension as cos δ × dα/dt, and in declination. */
  pmRaArcsec: Float32Array;
  pmDecArcsec: Float32Array;
}

/** Reads the packed records of src/sky/starCatalogue.ts. */
export function decodeStarCatalogue(base64: string, recordBytes: number): StarCatalogue {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const view = new DataView(bytes.buffer);
  const count = Math.floor(bytes.length / recordBytes);
  const catalogue: StarCatalogue = {
    count,
    raDeg: new Float32Array(count),
    decDeg: new Float32Array(count),
    vmag: new Float32Array(count),
    colourIndex: new Float32Array(count),
    pmRaArcsec: new Float32Array(count),
    pmDecArcsec: new Float32Array(count),
  };
  for (let star = 0; star < count; star++) {
    const at = star * recordBytes;
    catalogue.raDeg[star] = view.getFloat32(at, true);
    catalogue.decDeg[star] = view.getFloat32(at + 4, true);
    catalogue.vmag[star] = view.getInt16(at + 8, true) / 100;
    catalogue.colourIndex[star] = view.getInt16(at + 10, true) / 1000;
    catalogue.pmRaArcsec[star] = view.getInt16(at + 12, true) / 1000;
    catalogue.pmDecArcsec[star] = view.getInt16(at + 14, true) / 1000;
  }
  return catalogue;
}

let loading: Promise<StarCatalogue> | null = null;

/** The catalogue, decoded once; the first call fetches its module. */
export function loadStarCatalogue(): Promise<StarCatalogue> {
  loading ??= import("./starCatalogue").then(module => decodeStarCatalogue(module.STAR_RECORDS, module.STAR_RECORD_BYTES));
  return loading;
}

/** A star's illuminance above the air, lux: its magnitude against the Sun's, at the Sun's illuminance at 1 AU. */
export function starIlluminanceLux(vmag: number, solarIlluminanceAt1AuLux: number): number {
  return solarIlluminanceAt1AuLux * 10 ** (-0.4 * (vmag - SUN_MAGNITUDE_AT_1_AU));
}

/** A star's effective temperature from its B−V colour, K (Ballesteros, EPL 97, 2012). */
export function colourTemperatureK(colourIndex: number): number {
  return 4600 * (1 / (0.92 * colourIndex + 1.7) + 1 / (0.92 * colourIndex + 0.62));
}

/** The bands' wavelengths, m: the atmosphere model's red, green and blue. */
const BANDS_M = [680e-9, 550e-9, 440e-9] as const;
/** The second radiation constant, h c / k, m K. */
const PLANCK_C2 = 1.438777e-2;

function planckBands(temperatureK: number): [number, number, number] {
  return BANDS_M.map(lambda => 1 / (lambda ** 5 * Math.expm1(PLANCK_C2 / (lambda * temperatureK)))) as [number, number, number];
}

/** The Sun's B−V, the colour the model's light is white at. */
const SUN_COLOUR_INDEX = 0.65;
const SUN_BANDS = planckBands(colourTemperatureK(SUN_COLOUR_INDEX));

/**
 * The colour of a black body at a temperature in the model's three bands,
 * relative to sunlight, which the model draws white, and scaled to keep its
 * luminance: its spectrum sampled at each band's wavelength. A lamp's
 * correlated colour temperature gives its colour this way.
 */
export function blackBodyTint(temperatureK: number): [number, number, number] {
  const bands = planckBands(temperatureK);
  const raw = [bands[0] / SUN_BANDS[0], bands[1] / SUN_BANDS[1], bands[2] / SUN_BANDS[2]];
  const luminance = 0.2126 * raw[0] + 0.7152 * raw[1] + 0.0722 * raw[2];
  return [raw[0] / luminance, raw[1] / luminance, raw[2] / luminance];
}

/** A star's colour: a black body at the star's temperature (`blackBodyTint`). */
export function starTint(colourIndex: number): [number, number, number] {
  return blackBodyTint(colourTemperatureK(colourIndex));
}

/** Row-major 3 × 3. */
export type Matrix3 = [number, number, number, number, number, number, number, number, number];

const multiply = (a: Matrix3, b: Matrix3): Matrix3 => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];
/** A frame turned by an angle about its z axis: the coordinates of a fixed vector in the turned frame. */
const turnZ = (angle: number): Matrix3 => [Math.cos(angle), Math.sin(angle), 0, -Math.sin(angle), Math.cos(angle), 0, 0, 0, 1];
const turnY = (angle: number): Matrix3 => [Math.cos(angle), 0, -Math.sin(angle), 0, 1, 0, Math.sin(angle), 0, Math.cos(angle)];

/**
 * Precession from the mean equator and equinox of J2000 to those of a date,
 * by the IAU 1976 angles (Lieske 1977; Meeus 21.3), for a Julian ephemeris
 * day. Within an arcsecond for a few centuries either side of 2000.
 */
export function precessionMatrix(julianEphemerisDay: number): Matrix3 {
  const t = (julianEphemerisDay - J2000) / 36525;
  const zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t ** 3) * ARCSEC;
  const z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t ** 3) * ARCSEC;
  const theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t ** 3) * ARCSEC;
  return multiply(turnZ(-z), multiply(turnY(theta), turnZ(-zeta)));
}

/**
 * Takes directions in the J2000 equatorial frame to Earth-centred,
 * Earth-fixed ones at an instant: precession to the date, then the Earth's
 * turn by Greenwich apparent sidereal time. Nutation's own shift of the
 * stars, under 20″, is left out.
 */
export function celestialToEcefMatrix(utcMs: number, deltaTSeconds: number = DELTA_T_SECONDS): Matrix3 {
  const sun = solarPosition({ utcMs, latDeg: 0, lonDeg: 0, deltaTSeconds });
  return multiply(turnZ(sun.greenwichSiderealDeg * RAD), precessionMatrix(sun.julianDay + deltaTSeconds / 86400));
}

export function applyMatrix3(matrix: Matrix3, x: number, y: number, z: number): [number, number, number] {
  return [
    matrix[0] * x + matrix[1] * y + matrix[2] * z,
    matrix[3] * x + matrix[4] * y + matrix[5] * z,
    matrix[6] * x + matrix[7] * y + matrix[8] * z,
  ];
}

/** A star's J2000-frame right ascension and declination at a time from J2000, degrees, its proper motion applied. */
export function starPlaceDeg(catalogue: StarCatalogue, star: number, yearsFromJ2000: number): [number, number] {
  const dec = catalogue.decDeg[star] + (catalogue.pmDecArcsec[star] * yearsFromJ2000) / 3600;
  const cosine = Math.max(1e-6, Math.cos(catalogue.decDeg[star] * RAD));
  const ra = catalogue.raDeg[star] + (catalogue.pmRaArcsec[star] * yearsFromJ2000) / 3600 / cosine;
  return [ra, Math.max(-90, Math.min(90, dec))];
}

/** Unit vectors in the J2000 equatorial frame, three floats a star, for the stars up to a magnitude, which come first. */
export function starDirections(catalogue: StarCatalogue, yearsFromJ2000: number, limitingMagnitude: number): Float32Array {
  let count = 0;
  while (count < catalogue.count && catalogue.vmag[count] <= limitingMagnitude) count++;
  const directions = new Float32Array(count * 3);
  for (let star = 0; star < count; star++) {
    const [ra, dec] = starPlaceDeg(catalogue, star, yearsFromJ2000);
    const cosDec = Math.cos(dec * RAD);
    directions[star * 3] = cosDec * Math.cos(ra * RAD);
    directions[star * 3 + 1] = cosDec * Math.sin(ra * RAD);
    directions[star * 3 + 2] = Math.sin(dec * RAD);
  }
  return directions;
}

/** Years from J2000 at an instant: what proper motion is applied for. */
export function yearsFromJ2000(utcMs: number): number {
  return (utcMs / 86_400_000 + 2440587.5 - J2000) / 365.25;
}
