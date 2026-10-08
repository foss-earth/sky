import { DELTA_T_SECONDS, solarPosition, type SolarEphemeris } from "./solarPosition";

/**
 * The Moon's place, from chapter 47 of J. Meeus, Astronomical Algorithms
 * (2nd edition, 1998): the main terms of the ELP-2000/82 lunar theory,
 * within about 10″ in longitude and 4″ in latitude. Its nutation, obliquity
 * and sidereal time are the solar position algorithm's, so the Moon and the
 * Sun share one clock and one frame. Pure TypeScript, no renderer.
 */

const RAD = Math.PI / 180;

/** The Earth's equatorial radius, km, for the horizontal parallax, as Meeus takes it. */
const EARTH_EQUATORIAL_RADIUS_KM = 6378.14;
/** The Moon's mean radius, km (IAU). */
export const MOON_RADIUS_KM = 1737.4;
/** The Moon's mean distance, km: the distance its brightness below is given at. */
export const MOON_MEAN_DISTANCE_KM = 384_400;

/** Meeus's fundamental arguments and the Earth's eccentricity factor (47.1 to 47.6), in degrees, for T in Julian centuries of TT from J2000. */
function fundamentals(t: number) {
  const t2 = t * t, t3 = t2 * t, t4 = t3 * t;
  return {
    meanLongitude: 218.3164477 + 481267.88123421 * t - 0.0015786 * t2 + t3 / 538841 - t4 / 65194000,
    elongation: 297.8501921 + 445267.1114034 * t - 0.0018819 * t2 + t3 / 545868 - t4 / 113065000,
    sunAnomaly: 357.5291092 + 35999.0502909 * t - 0.0001536 * t2 + t3 / 24490000,
    moonAnomaly: 134.9633964 + 477198.8675055 * t + 0.0087414 * t2 + t3 / 69699 - t4 / 14712000,
    latitudeArgument: 93.2720950 + 483202.0175233 * t - 0.0036539 * t2 - t3 / 3526000 + t4 / 863310000,
    a1: 119.75 + 131.849 * t,
    a2: 53.09 + 479264.290 * t,
    a3: 313.45 + 481266.484 * t,
    eccentricity: 1 - 0.002516 * t - 0.0000074 * t2,
  };
}

/**
 * Table 47.A: multiples of D, M, M′ and F, then the terms of the longitude
 * (10⁻⁶ degree, sine) and of the distance (10⁻³ km, cosine).
 */
const LONGITUDE_DISTANCE_TERMS: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [0, 0, 1, 0, 6288774, -20905355],
  [2, 0, -1, 0, 1274027, -3699111],
  [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888],
  [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158],
  [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586],
  [0, 1, -1, 0, -40923, -129620],
  [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755],
  [2, 0, 0, -2, 15327, 10321],
  [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782],
  [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636],
  [2, 1, -1, 0, -7888, 24208],
  [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379],
  [1, 1, 0, 0, 4987, -16675],
  [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445],
  [4, 0, 0, 0, 3861, -11650],
  [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003],
  [2, 0, -1, 2, -2602, 0],
  [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322],
  [2, -2, 0, 0, 2236, -9884],
  [0, 1, 2, 0, -2120, 5751],
  [0, 2, 0, 0, -2069, 0],
  [2, -2, -1, 0, 2048, -4950],
  [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0],
  [4, -1, -1, 0, 1215, -3958],
  [0, 0, 2, 2, -1110, 0],
  [3, 0, -1, 0, -892, 3258],
  [2, 1, 1, 0, -810, 2616],
  [4, -1, -2, 0, 759, -1897],
  [0, 2, -1, 0, -713, -2117],
  [2, 2, -1, 0, -700, 2354],
  [2, 1, -2, 0, 691, 0],
  [2, -1, 0, -2, 596, 0],
  [4, 0, 1, 0, 549, -1423],
  [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571],
  [1, 0, -2, 0, -487, -1739],
  [2, 1, 0, -2, -399, 0],
  [0, 0, 2, -2, -381, -4421],
  [1, 1, 1, 0, 351, 0],
  [3, 0, -2, 0, -340, 0],
  [4, 0, -3, 0, 330, 0],
  [2, -1, 2, 0, 327, 0],
  [0, 2, 1, 0, -323, 1165],
  [1, 1, -1, 0, 299, 0],
  [2, 0, 3, 0, 294, 0],
  [2, 0, -1, -2, 0, 8752],
];

/** Table 47.B: multiples of D, M, M′ and F, then the terms of the latitude (10⁻⁶ degree, sine). */
const LATITUDE_TERMS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0, 0, 0, 1, 5128122],
  [0, 0, 1, 1, 280602],
  [0, 0, 1, -1, 277693],
  [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413],
  [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573],
  [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266],
  [0, 0, 2, -1, 8822],
  [2, -1, 0, -1, 8216],
  [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200],
  [2, 1, 0, -1, -3359],
  [2, -1, -1, 1, 2463],
  [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065],
  [0, 1, -1, -1, -1870],
  [4, 0, -1, -1, 1828],
  [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749],
  [0, 1, -1, 1, -1565],
  [1, 0, 0, 1, -1491],
  [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410],
  [0, 1, 0, -1, -1344],
  [1, 0, 0, -1, -1335],
  [0, 0, 3, 1, 1107],
  [4, 0, 0, -1, 1021],
  [4, 0, -1, 1, 833],
  [0, 0, 1, -3, 777],
  [4, 0, -2, 1, 671],
  [2, 0, 0, -3, 607],
  [2, 0, 2, -1, 596],
  [2, -1, 1, -1, 491],
  [2, 0, -2, 1, -451],
  [0, 0, 3, -1, 439],
  [2, 0, 2, 1, 422],
  [2, 0, -3, -1, 421],
  [2, 1, -1, 1, -366],
  [2, 1, 0, 1, -351],
  [4, 0, 0, 1, 331],
  [2, -1, 1, 1, 315],
  [2, -2, 0, -1, 302],
  [0, 0, 1, 3, -283],
  [2, 1, 1, -1, -229],
  [1, 1, 0, -1, 223],
  [1, 1, 0, 1, 223],
  [0, 1, -2, -1, -220],
  [2, 1, -1, -1, -220],
  [1, 0, 1, 1, -185],
  [2, -1, -2, -1, 181],
  [0, 1, 2, 1, -177],
  [4, 0, -2, -1, 176],
  [4, -1, -1, -1, 166],
  [1, 0, 1, -1, -164],
  [4, 0, 1, -1, 132],
  [1, 0, -1, -1, -119],
  [4, -1, 0, -1, 115],
  [2, -2, 0, 1, 107],
];

export interface LunarSums {
  /** Σl and Σb in 10⁻⁶ degree, Σr in 10⁻³ km: Meeus's intermediate values. */
  longitude: number;
  latitude: number;
  distance: number;
}

export interface LunarPosition {
  julianEphemerisDay: number;
  sums: LunarSums;
  /** Geocentric ecliptic longitude and latitude, for the mean equinox of the date, degrees. */
  longitudeDeg: number;
  latitudeDeg: number;
  /** From the Earth's centre to the Moon's, km. */
  distanceKm: number;
  /** The equatorial horizontal parallax, degrees. */
  parallaxDeg: number;
  /** Longitude with nutation: the apparent longitude. */
  apparentLongitudeDeg: number;
  /** Apparent geocentric right ascension and declination, degrees. */
  rightAscensionDeg: number;
  declinationDeg: number;
  /** The Sun's apparent longitude at the same instant, degrees: their difference is the phase in longitude. */
  sunApparentLongitudeDeg: number;
  /** The Moon's centre, Earth-centred and Earth-fixed, m. */
  moonEcefMeters: [number, number, number];
}

const limitDegrees = (degrees: number): number => ((degrees % 360) + 360) % 360;

/** The Moon's geocentric place at an instant of UTC, taken as UT1, with ΔT as the solar position algorithm takes it. */
export function lunarPosition(utcMs: number, deltaTSeconds: number = DELTA_T_SECONDS): LunarPosition {
  const sun = solarPosition({ utcMs, latDeg: 0, lonDeg: 0, deltaTSeconds });
  const julianEphemerisDay = sun.julianDay + deltaTSeconds / 86400;
  const t = (julianEphemerisDay - 2451545) / 36525;
  const f = fundamentals(t);
  const d = f.elongation * RAD, m = f.sunAnomaly * RAD, mp = f.moonAnomaly * RAD, lf = f.latitudeArgument * RAD;
  const e = f.eccentricity;
  let longitude = 0, distance = 0, latitude = 0;
  for (const [cd, cm, cmp, cf, sl, sr] of LONGITUDE_DISTANCE_TERMS) {
    const argument = cd * d + cm * m + cmp * mp + cf * lf;
    const factor = cm === 0 ? 1 : Math.abs(cm) === 1 ? e : e * e;
    longitude += sl * factor * Math.sin(argument);
    distance += sr * factor * Math.cos(argument);
  }
  for (const [cd, cm, cmp, cf, sb] of LATITUDE_TERMS) {
    const factor = cm === 0 ? 1 : Math.abs(cm) === 1 ? e : e * e;
    latitude += sb * factor * Math.sin(cd * d + cm * m + cmp * mp + cf * lf);
  }
  const meanLongitude = f.meanLongitude * RAD;
  longitude += 3958 * Math.sin(f.a1 * RAD) + 1962 * Math.sin(meanLongitude - lf) + 318 * Math.sin(f.a2 * RAD);
  latitude += -2235 * Math.sin(meanLongitude) + 382 * Math.sin(f.a3 * RAD) + 175 * Math.sin(f.a1 * RAD - lf)
    + 175 * Math.sin(f.a1 * RAD + lf) + 127 * Math.sin(meanLongitude - mp) - 115 * Math.sin(meanLongitude + mp);

  const longitudeDeg = limitDegrees(f.meanLongitude + longitude / 1e6);
  const latitudeDeg = latitude / 1e6;
  const distanceKm = 385000.56 + distance / 1000;
  const apparentLongitudeDeg = longitudeDeg + sun.nutationLongitudeDeg;

  // Ecliptic to equator with the true obliquity (Meeus 13.3 and 13.4).
  const lambda = apparentLongitudeDeg * RAD, beta = latitudeDeg * RAD, epsilon = sun.obliquityDeg * RAD;
  const rightAscensionDeg = limitDegrees(Math.atan2(Math.sin(lambda) * Math.cos(epsilon) - Math.tan(beta) * Math.sin(epsilon), Math.cos(lambda)) / RAD);
  const declination = Math.asin(Math.sin(beta) * Math.cos(epsilon) + Math.cos(beta) * Math.sin(epsilon) * Math.sin(lambda));
  // Turned with the Earth: the longitude under the Moon is its right ascension less Greenwich's sidereal time.
  const under = (rightAscensionDeg - sun.greenwichSiderealDeg) * RAD;
  const meters = distanceKm * 1000;
  return {
    julianEphemerisDay,
    sums: { longitude, latitude, distance },
    longitudeDeg,
    latitudeDeg,
    distanceKm,
    parallaxDeg: Math.asin(EARTH_EQUATORIAL_RADIUS_KM / distanceKm) / RAD,
    apparentLongitudeDeg,
    rightAscensionDeg,
    declinationDeg: declination / RAD,
    sunApparentLongitudeDeg: sun.apparentLongitudeDeg,
    moonEcefMeters: [
      meters * Math.cos(declination) * Math.cos(under),
      meters * Math.cos(declination) * Math.sin(under),
      meters * Math.sin(declination),
    ],
  };
}

/**
 * The Moon's place for anywhere on Earth at one instant, with the Sun's for
 * its phase. One evaluation serves every observer, with `moonDirectionFrom`
 * for the parallax of each, which reaches a degree.
 */
export interface LunarEphemeris {
  utcMs: number;
  moonEcefMeters: [number, number, number];
  /** The Sun's centre, Earth-centred and Earth-fixed, m. */
  sunEcefMeters: [number, number, number];
}

export function lunarEphemeris(utcMs: number, sun: SolarEphemeris, deltaTSeconds: number = DELTA_T_SECONDS): LunarEphemeris {
  return {
    utcMs,
    moonEcefMeters: lunarPosition(utcMs, deltaTSeconds).moonEcefMeters,
    sunEcefMeters: [sun.sunEcef[0] * sun.distanceMeters, sun.sunEcef[1] * sun.distanceMeters, sun.sunEcef[2] * sun.distanceMeters],
  };
}

/** The Moon as seen from a point in Earth-centred, Earth-fixed metres. */
export interface MoonView {
  /** Unit vector from the point to the Moon's centre, along a straight line. */
  direction: [number, number, number];
  distanceMeters: number;
  /** The disc's angular radius, radians. */
  angularRadius: number;
  /** The Sun–Moon–observer angle, degrees: 0 at full Moon, 180 at new. */
  phaseAngleDeg: number;
  /** The share of the disc lit, 0 to 1. */
  illuminatedFraction: number;
  /** Unit vector from the Moon's centre towards the Sun. */
  sunFromMoon: [number, number, number];
}

export function moonViewFrom(ephemeris: LunarEphemeris, x: number, y: number, z: number): MoonView {
  const [mx, my, mz] = ephemeris.moonEcefMeters;
  const [sx, sy, sz] = ephemeris.sunEcefMeters;
  const toMoon = [mx - x, my - y, mz - z];
  const distanceMeters = Math.hypot(toMoon[0], toMoon[1], toMoon[2]);
  const direction: [number, number, number] = [toMoon[0] / distanceMeters, toMoon[1] / distanceMeters, toMoon[2] / distanceMeters];
  const toSun = [sx - mx, sy - my, sz - mz];
  const sunDistance = Math.hypot(toSun[0], toSun[1], toSun[2]);
  const sunFromMoon: [number, number, number] = [toSun[0] / sunDistance, toSun[1] / sunDistance, toSun[2] / sunDistance];
  // The angle at the Moon between the Sun and the observer.
  const cosine = Math.min(1, Math.max(-1, -(sunFromMoon[0] * direction[0] + sunFromMoon[1] * direction[1] + sunFromMoon[2] * direction[2])));
  const phaseAngleDeg = Math.acos(cosine) / RAD;
  return {
    direction,
    distanceMeters,
    angularRadius: Math.asin(Math.min(1, (MOON_RADIUS_KM * 1000) / distanceMeters)),
    phaseAngleDeg,
    illuminatedFraction: (1 + cosine) / 2,
    sunFromMoon,
  };
}

/**
 * The Moon's visual magnitude at its mean distance, by its phase angle in
 * degrees: Allen's fit, as Krisciunas and Schaefer (1991) use it, which
 * includes the brightening towards full.
 */
export function moonMagnitude(phaseAngleDeg: number): number {
  const angle = Math.abs(phaseAngleDeg);
  return -12.73 + 0.026 * angle + 4e-9 * angle ** 4;
}

/** The Sun's visual magnitude at 1 AU: the reference the Moon's and the stars' magnitudes become lux against. */
export const SUN_MAGNITUDE_AT_1_AU = -26.74;

/**
 * The Moon's illuminance above the air at a distance from it, lux: its
 * magnitude against the Sun's, at the Sun's illuminance at 1 AU, and the
 * inverse square of the distance from the mean.
 */
export function moonIlluminanceLux(view: Pick<MoonView, "phaseAngleDeg" | "distanceMeters">, solarIlluminanceAt1AuLux: number): number {
  const ratio = 10 ** (-0.4 * (moonMagnitude(view.phaseAngleDeg) - SUN_MAGNITUDE_AT_1_AU));
  const distance = (MOON_MEAN_DISTANCE_KM * 1000) / view.distanceMeters;
  return solarIlluminanceAt1AuLux * ratio * distance * distance;
}

/**
 * Moonlight's colour against sunlight's, red, green and blue (680, 550 and
 * 440 nm): the Moon's colour indices (B−V 0.92, V−R 0.46) against the Sun's
 * (0.65, 0.35) make its light 0.27 magnitudes fainter in blue and 0.11
 * brighter in red than sunlight of the same green, scaled here to keep the
 * luminance.
 */
export const MOONLIGHT_TINT: readonly [number, number, number] = (() => {
  const raw = [10 ** (0.4 * 0.11), 1, 10 ** (-0.4 * 0.27)];
  const luminance = 0.2126 * raw[0] + 0.7152 * raw[1] + 0.0722 * raw[2];
  return [raw[0] / luminance, raw[1] / luminance, raw[2] / luminance] as const;
})();
