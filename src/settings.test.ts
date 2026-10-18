import { describe, expect, it } from "vitest";
import { SKY_PARAMETERS } from "./settings.js";
import { utcForSolarClockMs } from "./solarDay.js";
import { fixedTimeValues } from "./time.js";

/** Where the globe starts, and where the flight starts. */
const MINNEAPOLIS_LON_DEG = -93.265011;

describe("the default time", () => {
  it("is 16:20 solar time on 2026-04-20 in Minneapolis, when the Sun lines up with the shadows in its Google 3D Tiles", () => {
    const defaults = Object.fromEntries(SKY_PARAMETERS.filter(spec => spec.id.startsWith("sky.time.")).map(spec => [spec.id, spec.default]));
    expect(defaults).toEqual(fixedTimeValues(utcForSolarClockMs(Date.UTC(2026, 3, 20, 16, 20), MINNEAPOLIS_LON_DEG)));
  });
});
