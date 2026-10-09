import { runSkyRenderCheck } from "../../scripts/validation/skyRenderCheck.js";
import { createSkyRenderHost } from "./skyRenderHost.js";
// This is the explicit experiment entry point, not a library import or server.
void runSkyRenderCheck(createSkyRenderHost(document, window, () => {})).then(result => {
  (window as unknown as { skyRenderCheck: typeof result }).skyRenderCheck = result;
});
