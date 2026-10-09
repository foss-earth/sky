import { run as runModel } from "../../scripts/validation/skyModelCheck.js";
import { createSkyModelHost } from "./skyModelHost.js";
export function run() { return runModel(createSkyModelHost(() => performance.now())); }
