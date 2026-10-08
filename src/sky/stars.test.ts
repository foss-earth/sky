import { describe, expect, it } from "vitest";
import { PHOTOMETRY } from "./skyState";
import { STAR_RECORD_BYTES, STAR_RECORDS } from "./starCatalogue";
import {
  applyMatrix3, celestialToEcefMatrix, colourTemperatureK, decodeStarCatalogue, precessionMatrix, starDirections,
  starIlluminanceLux, starPlaceDeg, starTint,
} from "./stars";

const RAD = Math.PI / 180;
const catalogue = decodeStarCatalogue(STAR_RECORDS, STAR_RECORD_BYTES);

describe("the stars", () => {
  it("holds the Bright Star Catalogue's stars, brightest first, as it gives them", () => {
    expect(catalogue.count).toBe(9096);
    // Sirius, α CMa: 06h45m08.9s, −16°42′58″, V −1.46, B−V 0.00.
    expect(catalogue.raDeg[0]).toBeCloseTo((6 + 45 / 60 + 8.9 / 3600) * 15, 4);
    expect(catalogue.decDeg[0]).toBeCloseTo(-(16 + 42 / 60 + 58 / 3600), 4);
    expect(catalogue.vmag[0]).toBeCloseTo(-1.46, 6);
    expect(catalogue.colourIndex[0]).toBe(0);
    for (let star = 1; star < catalogue.count; star++) expect(catalogue.vmag[star]).toBeGreaterThanOrEqual(catalogue.vmag[star - 1]);
    expect(catalogue.vmag[catalogue.count - 1]).toBeLessThan(8.1);
    // The limit on magnitude is a prefix: about 5,000 stars to 6, every one to 8.
    expect(starDirections(catalogue, 0, 6).length / 3).toBeGreaterThan(4500);
    expect(starDirections(catalogue, 0, 6).length / 3).toBeLessThan(5500);
    expect(starDirections(catalogue, 0, 99).length / 3).toBe(9096);
  });

  it("precesses as Meeus's example 21.b, θ Persei to 2028 November 13.19 TD", () => {
    // J2000 2h44m11.986s, +49°13′42.48″; proper motion +0.03425 s and −0.0895″ a year.
    const star = {
      count: 1,
      raDeg: new Float32Array([(2 + 44 / 60 + 11.986 / 3600) * 15]),
      decDeg: new Float32Array([49 + 13 / 60 + 42.48 / 3600]),
      vmag: new Float32Array([4.1]),
      colourIndex: new Float32Array([0.49]),
      pmRaArcsec: new Float32Array([0.03425 * 15 * Math.cos((49 + 13 / 60 + 42.48 / 3600) * RAD)]),
      pmDecArcsec: new Float32Array([-0.0895]),
    };
    const jde = 2462088.69;
    const [ra, dec] = starPlaceDeg(star, 0, (jde - 2451545) / 365.25);
    const v = applyMatrix3(precessionMatrix(jde), Math.cos(dec * RAD) * Math.cos(ra * RAD), Math.cos(dec * RAD) * Math.sin(ra * RAD), Math.sin(dec * RAD));
    // Meeus: 2h46m11.331s, +49°20′54.54″; float32 holds the J2000 place to 0.1″.
    expect(((Math.atan2(v[1], v[0]) / RAD) + 360) % 360).toBeCloseTo(41.547214, 4);
    expect(Math.asin(v[2]) / RAD).toBeCloseTo(49.348483, 4);
  });

  it("turns with the Earth: Polaris near the pole, and a star crossing the meridian at its right ascension", () => {
    const utc = Date.UTC(2026, 9, 7, 20);
    const toEcef = celestialToEcefMatrix(utc);
    // Polaris, HR 424: about 0.63° from the pole in 2026.
    const polaris = [...Array(catalogue.count).keys()].find(star => catalogue.decDeg[star] > 89)!;
    const [ra, dec] = starPlaceDeg(catalogue, polaris, 26.8);
    const v = applyMatrix3(toEcef, Math.cos(dec * RAD) * Math.cos(ra * RAD), Math.cos(dec * RAD) * Math.sin(ra * RAD), Math.sin(dec * RAD));
    expect(Math.acos(v[2]) / RAD).toBeGreaterThan(0.55);
    expect(Math.acos(v[2]) / RAD).toBeLessThan(0.7);
    // A sidereal day later the sky has turned once with the Earth.
    const later = celestialToEcefMatrix(utc + 86_164_091);
    const sirius = applyMatrix3(toEcef, 0.3, -0.9, -0.3);
    const again = applyMatrix3(later, 0.3, -0.9, -0.3);
    expect(Math.hypot(sirius[0] - again[0], sirius[1] - again[1], sirius[2] - again[2])).toBeLessThan(1e-4);
  });

  it("gives each star its light and colour", () => {
    // Sirius gives about 1e-5 lux; six magnitudes fainter is 251 times less.
    expect(starIlluminanceLux(-1.46, PHOTOMETRY.solarIlluminanceLux)).toBeCloseTo(1.03e-5, 7);
    expect(starIlluminanceLux(4.54, PHOTOMETRY.solarIlluminanceLux) / starIlluminanceLux(-1.46, PHOTOMETRY.solarIlluminanceLux)).toBeCloseTo(10 ** -2.4, 6);
    // The Sun's colour is white in the model; Rigel (−0.03) is blue, Betelgeuse (1.85) red.
    expect(colourTemperatureK(0.65)).toBeGreaterThan(5700);
    expect(colourTemperatureK(0.65)).toBeLessThan(5900);
    for (const band of starTint(0.65)) expect(band).toBeCloseTo(1, 9);
    const rigel = starTint(-0.03);
    const betelgeuse = starTint(1.85);
    expect(rigel[2]).toBeGreaterThan(rigel[1]);
    expect(rigel[1]).toBeGreaterThan(rigel[0]);
    expect(betelgeuse[0]).toBeGreaterThan(betelgeuse[1]);
    expect(betelgeuse[1]).toBeGreaterThan(betelgeuse[2]);
    for (const tint of [rigel, betelgeuse]) expect(0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2]).toBeCloseTo(1, 12);
  });
});
