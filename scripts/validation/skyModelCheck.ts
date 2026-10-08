import { DEG_TO_RAD, geodeticToEcef } from "../../src/camera/cameraMath";
import { SKY_PARAMETERS } from "../../src/settings/catalogue/sky";
import { ATMOSPHERE, createAtmosphere, type Rgb } from "../../src/sky/atmosphere";
import { lunarEphemeris, lunarPosition, moonIlluminanceLux, moonMagnitude } from "../../src/sky/lunarPosition";
import { solarEphemeris, solarPosition } from "../../src/sky/solarPosition";
import {
  adaptEv100, computeSkyIllumination, createSkyDomeGeometry, ev100ForIlluminance, fillSkyDome, GROUND_LIGHT_SAMPLES, GROUND_LIGHT_TABLE,
  groundLightAt, groundLightTable, luminance, observerAt, PHOTOMETRY, starEv100, whiteLuminanceForEv100,
} from "../../src/sky/skyState";
import { STAR_RECORD_BYTES, STAR_RECORDS } from "../../src/sky/starCatalogue";
import { applyMatrix3, decodeStarCatalogue, precessionMatrix, starDirections, starIlluminanceLux, starPlaceDeg } from "../../src/sky/stars";

/**
 * The sky model's numbers, for scripts/validation/sky-model.mjs: the Sun's
 * and the Moon's places against their sources' worked examples, light
 * against the published illuminances of day, twilight and moonlit night, what
 * the tables and step counts leave in error, the stars' catalogue, exposure
 * through a day and a night at the default settings, and what each
 * computation costs on this CPU. No renderer.
 */

/** The catalogue's defaults for how exposure follows the meter: `sky.exposure.adaptation` and `sky.exposure.meterRange`. */
const defaultOf = <T>(id: string): T => SKY_PARAMETERS.find(spec => spec.id === id)!.default as T;
const DEFAULT_EXPOSURE = {
  adaptation: defaultOf<number>("sky.exposure.adaptation"),
  minEv100: defaultOf<{ min: number; max: number }>("sky.exposure.meterRange").min,
  maxEv100: defaultOf<{ min: number; max: number }>("sky.exposure.meterRange").max,
};

const sinDeg = (degrees: number): number => Math.sin(degrees * DEG_TO_RAD);
const cosDeg = (degrees: number): number => Math.cos(degrees * DEG_TO_RAD);
const round = (value: number, digits = 4): number => Number(value.toPrecision(digits));

/** Level illuminance the American Meteorological Society's Glossary of Meteorology gives for a clear sky, lux, by the Sun's unrefracted elevation. */
const PUBLISHED_LUX: Record<string, { lux: [number, number]; source: string }> = {
  "-6": { lux: [2, 3.5], source: "AMS Glossary, civil and nautical twilight: about 3.5 to 2 lux where civil twilight ends" },
  "-12": { lux: [0.008, 0.008], source: "AMS Glossary, nautical and astronomical twilight: about 0.008 lux where nautical twilight ends" },
  "-18": { lux: [6e-4, 6e-4], source: "AMS Glossary, astronomical twilight: about 0.0006 lux where it ends" },
};

function instantForElevation(elevationDeg: number): number {
  let low = Date.UTC(2026, 2, 20, 0, 0);
  let high = Date.UTC(2026, 2, 20, 12, 0);
  for (let i = 0; i < 60; i++) {
    const middle = (low + high) / 2;
    if (solarPosition({ utcMs: middle, latDeg: 0, lonDeg: 0 }).elevationDeg < elevationDeg) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

export function run(): Record<string, unknown> {
  const clock = (): number => performance.now();
  const parameters = { aerosolOpticalDepth: 0.1, groundAlbedo: 0.2 };
  const atmosphere = createAtmosphere(parameters, clock);
  const out: Rgb = [0, 0, 0];
  const reference: Rgb = [0, 0, 0];

  // The solar position report's worked example.
  const example = solarPosition({
    utcMs: Date.UTC(2003, 9, 17, 19, 30, 30), latDeg: 39.742476, lonDeg: -105.1786, elevationMeters: 1830.14,
    pressureMbar: 820, temperatureC: 11, deltaTSeconds: 67,
  });
  const solar = {
    report: "NREL/TP-560-34302 (revised January 2008), Table A5.1",
    zenithDeg: { computed: example.zenithDeg, report: 50.11162 },
    azimuthDeg: { computed: example.azimuthDeg, report: 194.34024 },
    apparentLongitudeDeg: { computed: example.apparentLongitudeDeg, report: 204.0085519281 },
    radiusVectorAu: { computed: example.radiusVectorAu, report: 0.9965422974 },
  };

  // Light on level ground at the equator on an equinox, by the Sun's unrefracted elevation.
  const light = [90, 60, 45, 30, 20, 10, 5, 2, 0, -0.833, -2, -4, -6, -9, -12, -15, -18, -30].map(elevation => {
    const requested = Math.min(elevation, 89.4);
    const { x, y, z } = geodeticToEcef(0, 0, 0);
    const state = computeSkyIllumination(atmosphere, solarEphemeris(instantForElevation(requested)), observerAt(x, y, z), { nightLuminance: 2e-4 });
    const level = luminance(state.groundIlluminance);
    const published = PUBLISHED_LUX[String(elevation)];
    const ev100 = ev100ForIlluminance(state.meteredLux);
    return {
      unrefractedElevationDeg: round(state.geometricElevationDeg, 4),
      drawnElevationDeg: round(state.sunElevationDeg, 4),
      sunLux: round(luminance(state.sunIlluminance)),
      skyLux: round(luminance(state.skyIlluminance)),
      levelGroundLux: round(level),
      meteredEv100: round(ev100, 4),
      ...(published ? { publishedLux: published.lux, modelOverPublished: [round(level / published.lux[1], 3), round(level / published.lux[0], 3)], source: published.source } : {}),
    };
  });

  // The table of transmittance against brute force, and step counts against many steps.
  let transmittanceWorst = 0;
  for (const altitude of [0, 500, 3_000, 12_000, 40_000]) {
    for (const elevation of [80, 30, 10, 4, 1.5]) {
      const mu = sinDeg(elevation);
      const r = ATMOSPHERE.planetRadiusMeters + altitude;
      const top = ATMOSPHERE.planetRadiusMeters + ATMOSPHERE.thicknessMeters;
      const length = -r * mu + Math.sqrt(r * r * (mu * mu - 1) + top * top);
      const steps = 20_000;
      const depth: Rgb = [0, 0, 0];
      for (let i = 0; i < steps; i++) {
        const s = ((i + 0.5) / steps) * length;
        const h = Math.sqrt(r * r + s * s + 2 * r * mu * s) - ATMOSPHERE.planetRadiusMeters;
        const air = Math.exp(-h / ATMOSPHERE.rayleighScaleHeightMeters);
        const haze = Math.exp(-h / ATMOSPHERE.mieScaleHeightMeters) * (parameters.aerosolOpticalDepth / ATMOSPHERE.mieScaleHeightMeters);
        const ozone = Math.max(0, 1 - Math.abs(h - ATMOSPHERE.ozoneCenterMeters) / ATMOSPHERE.ozoneHalfWidthMeters);
        for (let c = 0; c < 3; c++) depth[c] += (ATMOSPHERE.rayleighScattering[c] * air + haze + ATMOSPHERE.ozoneAbsorption[c] * ozone) * (length / steps);
      }
      atmosphere.sunTransmittance(altitude, mu, out);
      for (let c = 0; c < 3; c++) transmittanceWorst = Math.max(transmittanceWorst, Math.abs(out[c] / Math.exp(-depth[c]) - 1));
    }
  }
  const convergence = [8, 16, 32, 64].map(steps => {
    let worst = 0;
    for (const sun of [60, 10, 0, -4]) {
      for (const view of [90, 45, 10, 2, 0.2]) {
        for (const bearing of [0, 90, 180]) {
          const muSun = sinDeg(sun), mu = sinDeg(view);
          const nu = mu * muSun + cosDeg(view) * cosDeg(sun) * cosDeg(bearing);
          atmosphere.radiance(0, mu, muSun, nu, 512, reference);
          atmosphere.radiance(0, mu, muSun, nu, steps, out);
          worst = Math.max(worst, Math.abs(luminance(out) / luminance(reference) - 1));
        }
      }
    }
    return { steps, worstErrorAgainst512Steps: round(worst, 3) };
  });

  // The Moon: Meeus's worked example, its light above the air by phase, and three nights over Minneapolis.
  const meeus = lunarPosition(Date.UTC(1992, 3, 12), 0);
  const place = geodeticToEcef(45 * DEG_TO_RAD, -93 * DEG_TO_RAD, 300);
  const moonNights = [
    ["full Moon high", Date.UTC(2026, 9, 26, 6, 0)],
    ["quarter Moon at dusk", Date.UTC(2026, 9, 18, 23, 30)],
    ["no Moon up", Date.UTC(2026, 9, 8, 6, 0)],
  ].map(([name, utcMs]) => {
    const sun = solarEphemeris(utcMs as number);
    const at = computeSkyIllumination(atmosphere, sun, observerAt(place.x, place.y, place.z), { nightLuminance: 2e-4, lunar: lunarEphemeris(utcMs as number, sun) });
    const metered = ev100ForIlluminance(at.meteredLux);
    const adapted = adaptEv100(metered, ev100ForIlluminance(at.zenithMeteredLux), DEFAULT_EXPOSURE.adaptation);
    const ev100 = Math.min(DEFAULT_EXPOSURE.maxEv100, Math.max(DEFAULT_EXPOSURE.minEv100, adapted));
    const white = whiteLuminanceForEv100(ev100);
    return {
      name,
      utc: new Date(utcMs as number).toISOString(),
      sunElevationDeg: round(at.sunElevationDeg, 4),
      moonElevationDeg: round(at.moon!.elevationDeg, 4),
      moonPhaseAngleDeg: round(at.moon!.view.phaseAngleDeg, 4),
      moonLitFraction: round(at.moon!.view.illuminatedFraction, 3),
      moonAboveTheAirLux: round(at.moon!.illuminanceLux),
      moonDirectLux: round(luminance(at.moon!.directIlluminance)),
      moonlitSkyLux: round(luminance(at.moon!.skyIlluminance)),
      levelGroundLux: round(luminance(at.groundIlluminance)),
      meteredEv100: round(metered, 4),
      adaptedEv100: round(adapted, 4),
      ev100AtDefaults: round(ev100, 4),
      groundOfReflectance03: round((0.3 * luminance(at.groundIlluminance)) / Math.PI / white, 3),
    };
  });
  const moon = {
    theory: "J. Meeus, Astronomical Algorithms, 2nd edition (1998), chapter 47, example 47.a: 1992 April 12, 0h TD",
    longitudeDeg: { computed: meeus.longitudeDeg, published: 133.162655 },
    latitudeDeg: { computed: meeus.latitudeDeg, published: -3.229126 },
    distanceKm: { computed: meeus.distanceKm, published: 368409.7 },
    parallaxDeg: { computed: meeus.parallaxDeg, published: 0.99199 },
    rightAscensionDeg: { computed: meeus.rightAscensionDeg, published: 134.68847 },
    declinationDeg: { computed: meeus.declinationDeg, published: 13.768368 },
    published: "A full Moon on a clear night lights the ground with 0.05 to 0.3 lux, by its height and distance (C. Kyba, A. Mohar and T. Posch, How bright is moonlight?, Astronomy & Geophysics 58, 2017)",
    aboveTheAirAtMeanDistance: [0, 30, 60, 90, 120, 150].map(phaseAngleDeg => ({
      phaseAngleDeg,
      magnitude: round(moonMagnitude(phaseAngleDeg), 5),
      lux: round(moonIlluminanceLux({ phaseAngleDeg, distanceMeters: 384_400_000 }, PHOTOMETRY.solarIlluminanceLux)),
    })),
    nights: moonNights,
  };

  // The table a terrain shader reads, against the model it samples: a body's light on level ground by its height.
  const table = groundLightTable(atmosphere);
  const sky: Rgb = [0, 0, 0];
  // Through twilight and the low Sun, where its steps are fine, and above, where they are wide.
  const tableWorst = [[GROUND_LIGHT_TABLE.fromDeg, GROUND_LIGHT_TABLE.fineToDeg], [GROUND_LIGHT_TABLE.fineToDeg, 90]].map(([from, to]) => {
    let worst = 0;
    let worstAtDeg = from;
    for (let elevation = from; elevation <= to; elevation += 0.05) {
      const mu = sinDeg(elevation);
      atmosphere.sunTransmittance(0, mu, reference);
      atmosphere.groundSkyIrradiance(mu, sky);
      const direct = luminance(reference) * Math.max(0, mu) + luminance(sky);
      const error = Math.abs(luminance(groundLightAt(table, mu, out)) / direct - 1);
      if (error > worst) { worst = error; worstAtDeg = elevation; }
    }
    return { fromDeg: from, toDeg: to, worstErrorAgainstTheModel: round(worst, 3), worstAtElevationDeg: round(worstAtDeg, 4) };
  });
  const groundTable = {
    samples: GROUND_LIGHT_SAMPLES,
    bytes: table.byteLength,
    layout: GROUND_LIGHT_TABLE,
    fineSteps: tableWorst[0],
    wideSteps: tableWorst[1],
  };

  // The stars: the catalogue, each one's light, and Meeus's worked example of precession.
  const catalogue = decodeStarCatalogue(STAR_RECORDS, STAR_RECORD_BYTES);
  const thetaPersei = {
    count: 1,
    raDeg: new Float32Array([(2 + 44 / 60 + 11.986 / 3600) * 15]),
    decDeg: new Float32Array([49 + 13 / 60 + 42.48 / 3600]),
    vmag: new Float32Array([4.1]),
    colourIndex: new Float32Array([0.49]),
    pmRaArcsec: new Float32Array([0.03425 * 15 * cosDeg(49 + 13 / 60 + 42.48 / 3600)]),
    pmDecArcsec: new Float32Array([-0.0895]),
  };
  const jde = 2462088.69;
  const [ra, dec] = starPlaceDeg(thetaPersei, 0, (jde - 2451545) / 365.25);
  const precessed = applyMatrix3(precessionMatrix(jde), cosDeg(dec) * cosDeg(ra), cosDeg(dec) * sinDeg(ra), sinDeg(dec));
  const countTo = (magnitude: number): number => starDirections(catalogue, 0, magnitude).length / 3;
  let starlight = 0;
  for (let star = 0; star < catalogue.count && catalogue.vmag[star] <= 6.5; star++) starlight += starIlluminanceLux(catalogue.vmag[star], PHOTOMETRY.solarIlluminanceLux);
  const stars = {
    catalogue: "Bright Star Catalogue, 5th revised edition (D. Hoffleit and W. H. Warren Jr., 1991; CDS V/50)",
    count: catalogue.count,
    packedBytes: catalogue.count * STAR_RECORD_BYTES,
    countToMagnitude: { 2: countTo(2), 4: countTo(4), 6: countTo(6), 6.5: countTo(6.5), 8.1: countTo(8.1) },
    brightest: { magnitude: round(catalogue.vmag[0], 4), lux: round(starIlluminanceLux(catalogue.vmag[0], PHOTOMETRY.solarIlluminanceLux)) },
    faintestDrawnByDefault: { magnitude: 6.5, lux: round(starIlluminanceLux(6.5, PHOTOMETRY.solarIlluminanceLux)) },
    allToMagnitude65AboveTheAirLux: round(starlight),
    precession: {
      example: "Meeus, example 21.b: θ Persei at 2028 November 13.19 TD",
      rightAscensionDeg: { computed: ((Math.atan2(precessed[1], precessed[0]) / DEG_TO_RAD) + 360) % 360, published: 41.547214 },
      declinationDeg: { computed: Math.asin(precessed[2]) / DEG_TO_RAD, published: 49.348483 },
    },
  };

  // The daytime sky by the viewpoint's height, the Sun 60° up, and the exposure the stars are shown at there.
  // Metering on the sky behind them, as a reflected-light meter does (ISO 2720, K = 12.5: EV = log2(8 L)), is what
  // `sky.stars.daylightAltitude` stands in for with a straight line between its two heights.
  const starHeights = defaultOf<{ min: number; max: number }>("sky.stars.daylightAltitude");
  const overhead = (altitude: number, mu: number): number => {
    atmosphere.sunTransmittance(altitude, mu, reference);
    atmosphere.skyIrradiance(altitude, mu, out);
    return (luminance(reference) + luminance(out)) * PHOTOMETRY.solarIlluminanceLux;
  };
  const skyMean = (altitude: number): number => {
    atmosphere.skyIrradiance(altitude, sinDeg(60), out);
    return (luminance(out) * PHOTOMETRY.solarIlluminanceLux) / Math.PI + 2e-4;
  };
  const starsByHeight = [0, 10, 20, 30, 40, 50, 60, 70, 80, 100, 400].map(km => {
    const altitude = km * 1000;
    const sky = skyMean(altitude);
    const inRange = (ev: number): number => Math.min(DEFAULT_EXPOSURE.maxEv100, Math.max(DEFAULT_EXPOSURE.minEv100, ev));
    const scene = inRange(adaptEv100(ev100ForIlluminance(overhead(altitude, sinDeg(60))), ev100ForIlluminance(overhead(altitude, 1)), DEFAULT_EXPOSURE.adaptation));
    const stars = starEv100(scene, DEFAULT_EXPOSURE.minEv100, altitude, starHeights.min * 1000, starHeights.max * 1000);
    return {
      km,
      skyMeanCdPerM2: round(sky),
      ofSeaLevel: round(sky / skyMean(0), 3),
      sceneEv100: round(scene, 4),
      meteredOnTheSkyEv100: round(Math.min(scene, Math.max(DEFAULT_EXPOSURE.minEv100, Math.log2(8 * sky))), 4),
      starEv100AtDefaults: round(stars, 4),
      starWhiteCdPerM2: round(whiteLuminanceForEv100(stars)),
    };
  });

  // What each computation costs here. Timings on a machine in use are not qualified measurements.
  const time = (work: () => void, repeats: number): number => {
    const started = clock();
    for (let i = 0; i < repeats; i++) work();
    return (clock() - started) / repeats;
  };
  const tablesMs = time(() => { createAtmosphere(parameters); }, 5);
  const { x, y, z } = geodeticToEcef(45 * DEG_TO_RAD, -93 * DEG_TO_RAD, 300);
  const observer = observerAt(x, y, z);
  const ephemeris = solarEphemeris(Date.UTC(2026, 9, 7, 19, 0));
  const state = computeSkyIllumination(atmosphere, ephemeris, observer, { nightLuminance: 2e-4 });
  const domes = [[16, 16, 16], [32, 32, 16], [64, 64, 32]].map(([zenithSamples, azimuthSamples, integrationSteps]) => {
    const dome = createSkyDomeGeometry({ zenithSamples, azimuthSamples, integrationSteps });
    const ms = time(() => fillSkyDome(dome, atmosphere, state), 20);
    return { zenithSamples, azimuthSamples, integrationSteps, samples: dome.evaluations, vertices: dome.vertexCount, triangles: dome.indices.length / 3, vertexBytes: dome.vertexCount * 28, fillMs: round(ms, 3) };
  });
  // A night with the full Moon up: the dome also samples the sky the Moon lights, at every vertex.
  const moonInstant = Date.UTC(2026, 9, 26, 6, 0);
  const moonSun = solarEphemeris(moonInstant);
  const moonlit = computeSkyIllumination(atmosphere, moonSun, observer, { nightLuminance: 2e-4, lunar: lunarEphemeris(moonInstant, moonSun) });
  const moonDome = createSkyDomeGeometry({ zenithSamples: 32, azimuthSamples: 32, integrationSteps: 16 });
  const moonDomeMs = time(() => fillSkyDome(moonDome, atmosphere, moonlit, { moonlitSky: true }), 20);
  const cost = {
    qualified: false,
    note: "Single-threaded JavaScript on a machine in use: read as orders of magnitude, not as measurements.",
    atmosphereTablesMs: round(tablesMs, 3),
    atmosphereTableBytes: atmosphere.build.tableBytes,
    solarEphemerisMicroseconds: round(time(() => { solarEphemeris(Date.UTC(2026, 9, 7, 19, 0)); }, 2000) * 1000, 3),
    illuminationMs: round(time(() => { computeSkyIllumination(atmosphere, ephemeris, observer, { nightLuminance: 2e-4 }); }, 50), 3),
    lunarEphemerisMicroseconds: round(time(() => { lunarEphemeris(moonInstant, moonSun); }, 2000) * 1000, 3),
    illuminationWithMoonMs: round(time(() => { computeSkyIllumination(atmosphere, moonSun, observer, { nightLuminance: 2e-4, lunar: lunarEphemeris(moonInstant, moonSun) }); }, 50), 3),
    groundTableMs: round(time(() => { groundLightTable(atmosphere); }, 50), 3),
    starDirectionsMs: round(time(() => { starDirections(catalogue, 26.8, 6.5); }, 20), 3),
    domes,
    moonlitDome: { zenithSamples: 32, azimuthSamples: 32, integrationSteps: 16, samples: moonDome.evaluations, moonSamples: moonDome.moonEvaluations, vertices: moonDome.vertexCount, fillMs: round(moonDomeMs, 3) },
  };

  // Exposure through a day with no Moon: what the meter reads, what the default adaptation makes of it, and what shows as white.
  const exposure = [60, 30, 10, 5, 2, 0, -2, -4, -6, -18].map(elevation => {
    const origin = geodeticToEcef(0, 0, 0);
    const at = computeSkyIllumination(atmosphere, solarEphemeris(instantForElevation(elevation)), observerAt(origin.x, origin.y, origin.z), { nightLuminance: 2e-4 });
    const metered = ev100ForIlluminance(at.meteredLux);
    const adapted = adaptEv100(metered, ev100ForIlluminance(at.zenithMeteredLux), DEFAULT_EXPOSURE.adaptation);
    const inRange = (ev: number): number => Math.min(DEFAULT_EXPOSURE.maxEv100, Math.max(DEFAULT_EXPOSURE.minEv100, ev));
    const ev100 = inRange(adapted);
    const white = whiteLuminanceForEv100(ev100);
    const ground = (0.3 * luminance(at.groundIlluminance)) / Math.PI;
    return {
      unrefractedElevationDeg: elevation,
      meteredEv100: round(metered, 4),
      adaptedEv100: round(adapted, 4),
      ev100AtDefaults: round(ev100, 4),
      whiteCdPerM2: round(white),
      // Ground of reflectance 0.3, the sky's mean luminance and an emitter of 1 cd/m², as shares of white.
      groundOfReflectance03: round(ground / white, 3),
      skyMean: round(luminance(at.skyIlluminance) / Math.PI / white, 3),
      emitterOf1CdPerM2: round(1 / white, 3),
      // The same ground with exposure following the meter all of the way, as before adaptation.
      groundFollowingTheMeter: round(ground / whiteLuminanceForEv100(inRange(metered)), 3),
      skyMeanFollowingTheMeter: round(luminance(at.skyIlluminance) / Math.PI / whiteLuminanceForEv100(inRange(metered)), 3),
    };
  });

  return {
    parameters, solar, light, moon, stars, starsByHeight: { heightsKm: starHeights, sunElevationDeg: 60, rows: starsByHeight },
    accuracy: { transmittanceWorstErrorAgainstBruteForce: round(transmittanceWorst, 3), convergence, groundTable },
    cost, exposure: { defaults: DEFAULT_EXPOSURE, rows: exposure },
  };
}
