import { ecefToGeodetic, geodeticToEcef } from "@foss-earth/engine";
import type { SkyModelHost } from "../../scripts/validation/ports.js";

/** Explicit CPU experiment ports; importing this fixture does not run the model. */
export function createSkyModelHost(clock: () => number): SkyModelHost {
  return { ecefToGeodetic, geodeticToEcef, clock };
}
