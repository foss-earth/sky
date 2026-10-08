import { DEG_TO_RAD as RAD } from "../camera/cameraMath";
import { SPA_LATITUDE_TERMS, SPA_LONGITUDE_TERMS, SPA_NUTATION_TERMS, SPA_RADIUS_TERMS } from "./solarPositionTerms";

/**
 * Where the Sun is, from the solar position algorithm of Reda and Andreas
 * (NREL/TP-560-34302, revised January 2008), which follows Meeus's
 * "Astronomical Algorithms". The report states its domain as the years -2000
 * to 6000 and its uncertainty as ±0.0003° in the zenith and azimuth angles.
 * Step numbers below are the report's. solarPosition.test.ts checks every
 * intermediate value against the report's worked example.
 *
 * The instant is UTC, taken as UT1: they differ by under 0.9 s, which moves
 * the Sun by under 0.004° in hour angle. Polar motion is left out (under
 * 0.0001°).
 */

/** The constants of the algorithm, as the report gives them. */
const SPA = {
  /** JD of the Unix epoch, 1970-01-01T00:00:00Z. */
  unixEpochJulianDay: 2440587.5,
  j2000JulianDay: 2451545,
  daysPerCentury: 36525,
  /** Step 3.6: the constant of aberration, arc seconds. */
  aberrationArcsec: 20.4898,
  /** Step 3.12.1: the Sun's equatorial horizontal parallax at 1 AU, arc seconds. */
  parallaxArcsec: 8.794,
  /** Step 3.12.2: 1 - f for the ellipsoid the report uses. */
  polarOverEquatorial: 0.99664719,
  /** Step 3.12.3: the report's equatorial radius, m. */
  equatorialRadiusMeters: 6378140,
  /** Step 3.14.2: the Sun's radius and the refraction at the horizon, degrees; below their sum the report applies no refraction. */
  sunRadiusDeg: 0.26667,
  horizonRefractionDeg: 0.5667,
  /** The sea-level standard atmosphere, for refraction where the caller gives no weather. */
  standardPressureMbar: 1013.25,
  standardTemperatureC: 15,
} as const;

/** The astronomical unit, m (IAU 2012 Resolution B2, exact). */
export const ASTRONOMICAL_UNIT_METERS = 149_597_870_700;

/**
 * TT - UTC in seconds since 2017-01-01: 32.184 s plus 37 leap seconds. The
 * algorithm wants TT - UT1, which differs from this by under 0.9 s; a whole
 * second moves the Sun by 0.00001°.
 */
export const DELTA_T_SECONDS = 69.184;

function limitDegrees(degrees: number): number {
  const limited = degrees % 360;
  return limited < 0 ? limited + 360 : limited;
}

export interface SolarPositionInput {
  /** The instant, in milliseconds of UTC since 1970-01-01T00:00:00Z. */
  utcMs: number;
  /** Geodetic latitude, degrees, north positive. */
  latDeg: number;
  /** Longitude, degrees, east positive. */
  lonDeg: number;
  /** Height above the ellipsoid, m. */
  elevationMeters?: number;
  /** TT - UT1, s. `DELTA_T_SECONDS` when omitted. */
  deltaTSeconds?: number;
  /** Local pressure in millibars and temperature in °C, for refraction; a standard sea-level atmosphere when omitted. */
  pressureMbar?: number;
  temperatureC?: number;
}

/** The sums of the report's periodic series, which its example prints as L0 to L5, B0, B1 and R0 to R4. */
export interface SolarSeriesSums {
  longitude: number[];
  latitude: number[];
  radius: number[];
}

export interface SolarPosition {
  julianDay: number;
  /** Julian ephemeris millennia from J2000 (JME). */
  julianEphemerisMillennium: number;
  series: SolarSeriesSums;
  /** Earth's heliocentric longitude L and latitude B, degrees. */
  heliocentricLongitudeDeg: number;
  heliocentricLatitudeDeg: number;
  /** The Earth-Sun distance R, AU. */
  radiusVectorAu: number;
  /** Nutation in longitude and obliquity, degrees. */
  nutationLongitudeDeg: number;
  nutationObliquityDeg: number;
  /** True obliquity of the ecliptic, degrees. */
  obliquityDeg: number;
  /** Apparent longitude of the Sun, degrees. */
  apparentLongitudeDeg: number;
  /** Apparent sidereal time at Greenwich, degrees. */
  greenwichSiderealDeg: number;
  /** Geocentric right ascension and declination, degrees. */
  rightAscensionDeg: number;
  declinationDeg: number;
  /** Observer's local hour angle, degrees west of south. */
  hourAngleDeg: number;
  /** Topocentric right ascension, declination and hour angle, degrees. */
  topocentricRightAscensionDeg: number;
  topocentricDeclinationDeg: number;
  topocentricHourAngleDeg: number;
  /** Topocentric elevation without refraction, e0, degrees. */
  elevationDeg: number;
  /** The report's refraction correction: zero once the whole disc is below the apparent horizon. */
  refractionDeg: number;
  /** Topocentric zenith angle with refraction, degrees. */
  zenithDeg: number;
  /** Topocentric azimuth, degrees east of north. */
  azimuthDeg: number;
  /**
   * Unit vector from the Earth's centre to the Sun in Earth-centred,
   * Earth-fixed axes (x through 0°N 0°E, z through the north pole), of the
   * true equator and equinox of the date.
   */
  sunEcef: [number, number, number];
  /** Where the Sun is overhead: geodetic latitude, which is its declination, and longitude, degrees. */
  subsolarLatDeg: number;
  subsolarLonDeg: number;
}

function sumSeries(terms: readonly (readonly (readonly [number, number, number])[])[], jme: number): number[] {
  return terms.map(rows => {
    let sum = 0;
    for (const [a, b, c] of rows) sum += a * Math.cos(b + c * jme);
    return sum;
  });
}

/** Steps 3.2.4 and 3.2.5 without the limit: the series' polynomial in JME, over 10^8. */
function seriesValue(sums: readonly number[], jme: number): number {
  let value = 0;
  for (let power = sums.length - 1; power >= 0; power--) value = value * jme + sums[power];
  return value / 1e8;
}

/** The elevation below which the report applies no refraction: the Sun's whole disc is under the apparent horizon. */
export const SPA_REFRACTION_CUTOFF_DEG = -(SPA.sunRadiusDeg + SPA.horizonRefractionDeg);

/** Step 3.14.2's formula for the refraction at an elevation without it, degrees, wherever the Sun is. */
export function refractionFormulaDeg(elevationDeg: number, pressureMbar: number, temperatureC: number): number {
  return (pressureMbar / 1010) * (283 / (273 + temperatureC))
    * (1.02 / (60 * Math.tan((elevationDeg + 10.3 / (elevationDeg + 5.11)) * RAD)));
}

/** Step 3.14.2: the report's refraction correction, which is zero once the disc is below the horizon. */
export function spaRefractionDeg(elevationDeg: number, pressureMbar: number, temperatureC: number): number {
  return elevationDeg < SPA_REFRACTION_CUTOFF_DEG ? 0 : refractionFormulaDeg(elevationDeg, pressureMbar, temperatureC);
}

export function julianDayFromUtcMs(utcMs: number): number {
  return utcMs / 86_400_000 + SPA.unixEpochJulianDay;
}

export function solarPosition(input: SolarPositionInput): SolarPosition {
  const elevationMeters = input.elevationMeters ?? 0;
  const deltaT = input.deltaTSeconds ?? DELTA_T_SECONDS;
  // 3.1: Julian day, century and ephemeris millennium.
  const julianDay = julianDayFromUtcMs(input.utcMs);
  const jde = julianDay + deltaT / 86400;
  const jc = (julianDay - SPA.j2000JulianDay) / SPA.daysPerCentury;
  const jce = (jde - SPA.j2000JulianDay) / SPA.daysPerCentury;
  const jme = jce / 10;

  // 3.2: Earth's heliocentric longitude, latitude and radius vector.
  const series: SolarSeriesSums = {
    longitude: sumSeries(SPA_LONGITUDE_TERMS, jme),
    latitude: sumSeries(SPA_LATITUDE_TERMS, jme),
    radius: sumSeries(SPA_RADIUS_TERMS, jme),
  };
  const heliocentricLongitudeDeg = limitDegrees(seriesValue(series.longitude, jme) / RAD);
  const heliocentricLatitudeDeg = seriesValue(series.latitude, jme) / RAD;
  const radiusVectorAu = seriesValue(series.radius, jme);

  // 3.3: geocentric longitude and latitude.
  const theta = limitDegrees(heliocentricLongitudeDeg + 180);
  const beta = -heliocentricLatitudeDeg * RAD;

  // 3.4: nutation in longitude and obliquity.
  const x = [
    297.85036 + 445267.111480 * jce - 0.0019142 * jce * jce + (jce * jce * jce) / 189474,
    357.52772 + 35999.050340 * jce - 0.0001603 * jce * jce - (jce * jce * jce) / 300000,
    134.96298 + 477198.867398 * jce + 0.0086972 * jce * jce + (jce * jce * jce) / 56250,
    93.27191 + 483202.017538 * jce - 0.0036825 * jce * jce + (jce * jce * jce) / 327270,
    125.04452 - 1934.136261 * jce + 0.0020708 * jce * jce + (jce * jce * jce) / 450000,
  ];
  let psi = 0;
  let epsilon = 0;
  for (const row of SPA_NUTATION_TERMS) {
    const argument = (x[0] * row[0] + x[1] * row[1] + x[2] * row[2] + x[3] * row[3] + x[4] * row[4]) * RAD;
    psi += (row[5] + row[6] * jce) * Math.sin(argument);
    epsilon += (row[7] + row[8] * jce) * Math.cos(argument);
  }
  const nutationLongitudeDeg = psi / 36_000_000;
  const nutationObliquityDeg = epsilon / 36_000_000;

  // 3.5: true obliquity of the ecliptic.
  const u = jme / 10;
  const meanObliquityArcsec = 84381.448 + u * (-4680.93 + u * (-1.55 + u * (1999.25 + u * (-51.38 + u * (-249.67
    + u * (-39.05 + u * (7.12 + u * (27.87 + u * (5.79 + u * 2.45)))))))));
  const obliquityDeg = meanObliquityArcsec / 3600 + nutationObliquityDeg;
  const obliquity = obliquityDeg * RAD;

  // 3.6 and 3.7: aberration, and the apparent longitude.
  const aberrationDeg = -SPA.aberrationArcsec / (3600 * radiusVectorAu);
  const apparentLongitudeDeg = theta + nutationLongitudeDeg + aberrationDeg;
  const lambda = apparentLongitudeDeg * RAD;

  // 3.8: apparent sidereal time at Greenwich.
  const meanSidereal = limitDegrees(280.46061837 + 360.98564736629 * (julianDay - SPA.j2000JulianDay)
    + 0.000387933 * jc * jc - (jc * jc * jc) / 38710000);
  const greenwichSiderealDeg = meanSidereal + nutationLongitudeDeg * Math.cos(obliquity);

  // 3.9 and 3.10: geocentric right ascension and declination.
  const rightAscensionDeg = limitDegrees(Math.atan2(
    Math.sin(lambda) * Math.cos(obliquity) - Math.tan(beta) * Math.sin(obliquity), Math.cos(lambda)) / RAD);
  const declination = Math.asin(Math.sin(beta) * Math.cos(obliquity) + Math.cos(beta) * Math.sin(obliquity) * Math.sin(lambda));

  // 3.11: observer's local hour angle.
  const hourAngleDeg = limitDegrees(greenwichSiderealDeg + input.lonDeg - rightAscensionDeg);
  const hourAngle = hourAngleDeg * RAD;

  // 3.12 and 3.13: topocentric right ascension, declination and hour angle.
  const latitude = input.latDeg * RAD;
  const parallax = (SPA.parallaxArcsec / (3600 * radiusVectorAu)) * RAD;
  const reduced = Math.atan(SPA.polarOverEquatorial * Math.tan(latitude));
  const observerX = Math.cos(reduced) + (elevationMeters / SPA.equatorialRadiusMeters) * Math.cos(latitude);
  const observerY = SPA.polarOverEquatorial * Math.sin(reduced) + (elevationMeters / SPA.equatorialRadiusMeters) * Math.sin(latitude);
  const denominator = Math.cos(declination) - observerX * Math.sin(parallax) * Math.cos(hourAngle);
  const deltaAlpha = Math.atan2(-observerX * Math.sin(parallax) * Math.sin(hourAngle), denominator);
  const topocentricDeclination = Math.atan2((Math.sin(declination) - observerY * Math.sin(parallax)) * Math.cos(deltaAlpha), denominator);
  const topocentricHourAngleDeg = hourAngleDeg - deltaAlpha / RAD;
  const topocentricHourAngle = topocentricHourAngleDeg * RAD;

  // 3.14: topocentric elevation, refraction and zenith angle.
  const elevationDeg = Math.asin(Math.sin(latitude) * Math.sin(topocentricDeclination)
    + Math.cos(latitude) * Math.cos(topocentricDeclination) * Math.cos(topocentricHourAngle)) / RAD;
  const refractionDeg = spaRefractionDeg(elevationDeg, input.pressureMbar ?? SPA.standardPressureMbar, input.temperatureC ?? SPA.standardTemperatureC);
  const zenithDeg = 90 - (elevationDeg + refractionDeg);

  // 3.15: azimuth, eastward from north.
  const astronomersAzimuth = limitDegrees(Math.atan2(Math.sin(topocentricHourAngle),
    Math.cos(topocentricHourAngle) * Math.sin(latitude) - Math.tan(topocentricDeclination) * Math.cos(latitude)) / RAD);
  const azimuthDeg = limitDegrees(astronomersAzimuth + 180);

  // The Sun's direction from the Earth's centre, in axes fixed to the Earth:
  // it is overhead at latitude δ, at the longitude where the hour angle is zero.
  const subsolarLon = (rightAscensionDeg - greenwichSiderealDeg) * RAD;
  const cosDeclination = Math.cos(declination);
  const subsolarLonDeg = limitDegrees(rightAscensionDeg - greenwichSiderealDeg + 180) - 180;

  return {
    julianDay,
    julianEphemerisMillennium: jme,
    series,
    heliocentricLongitudeDeg,
    heliocentricLatitudeDeg,
    radiusVectorAu,
    nutationLongitudeDeg,
    nutationObliquityDeg,
    obliquityDeg,
    apparentLongitudeDeg,
    greenwichSiderealDeg,
    rightAscensionDeg,
    declinationDeg: declination / RAD,
    hourAngleDeg,
    topocentricRightAscensionDeg: rightAscensionDeg + deltaAlpha / RAD,
    topocentricDeclinationDeg: topocentricDeclination / RAD,
    topocentricHourAngleDeg,
    elevationDeg,
    refractionDeg,
    zenithDeg,
    azimuthDeg,
    sunEcef: [cosDeclination * Math.cos(subsolarLon), cosDeclination * Math.sin(subsolarLon), Math.sin(declination)],
    subsolarLatDeg: declination / RAD,
    subsolarLonDeg,
  };
}

/**
 * The Sun's place for anywhere on Earth at one instant: its direction from the
 * Earth's centre and its distance. One evaluation serves every observer, with
 * `sunDirectionFrom` for the parallax of each.
 */
export interface SolarEphemeris {
  utcMs: number;
  /** Unit vector from the Earth's centre to the Sun, Earth-centred, Earth-fixed. */
  sunEcef: [number, number, number];
  distanceMeters: number;
  radiusVectorAu: number;
  declinationDeg: number;
  subsolarLonDeg: number;
}

export function solarEphemeris(utcMs: number, deltaTSeconds: number = DELTA_T_SECONDS): SolarEphemeris {
  const position = solarPosition({ utcMs, latDeg: 0, lonDeg: 0, deltaTSeconds });
  return {
    utcMs,
    sunEcef: position.sunEcef,
    distanceMeters: position.radiusVectorAu * ASTRONOMICAL_UNIT_METERS,
    radiusVectorAu: position.radiusVectorAu,
    declinationDeg: position.declinationDeg,
    subsolarLonDeg: position.subsolarLonDeg,
  };
}

/**
 * Unit vector from a point, in Earth-centred, Earth-fixed metres, to the Sun,
 * along a straight line: without refraction, with the point's parallax.
 */
export function sunDirectionFrom(ephemeris: SolarEphemeris, x: number, y: number, z: number): [number, number, number] {
  const dx = ephemeris.sunEcef[0] * ephemeris.distanceMeters - x;
  const dy = ephemeris.sunEcef[1] * ephemeris.distanceMeters - y;
  const dz = ephemeris.sunEcef[2] * ephemeris.distanceMeters - z;
  const length = Math.hypot(dx, dy, dz);
  return [dx / length, dy / length, dz / length];
}
