import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { observerAt, observerFromGeodetic, solarEphemeris, sunDirectionFrom } from "../src/index.js";
const fixture = JSON.parse(readFileSync(new URL("../fixtures/observer.json", import.meta.url), "utf8"));
describe("host coordinate contract", () => {
  it("uses the explicit host conversion and retains that place/basis without engine imports", () => {
    const convert = vi.fn(() => fixture.place); const [x, y, z] = fixture.ecef;
    const result = observerAt(x, y, z, convert);
    expect(convert).toHaveBeenCalledExactlyOnceWith(x, y, z); expect(result).toEqual(observerFromGeodetic([x, y, z], fixture.place));
    expect(result.latDeg).toBeCloseTo(39.742476, 9); expect(result.lonDeg).toBeCloseTo(-105.1786, 9); expect(result.altitudeMeters).toBe(1830.14);
    for (const direction of [result.up, result.east, result.north]) expect(Math.hypot(...direction)).toBeCloseTo(1, 12);
    expect(sunDirectionFrom(solarEphemeris(Date.UTC(2003, 9, 17, 19, 30, 30), 67), x, y, z)).toHaveLength(3);
  });
});
