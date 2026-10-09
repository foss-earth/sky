import { solarPosition, solarEphemeris, observerAt, computeSkyIllumination, createAtmosphere, fixedTimeValues, type SkyEcefToGeodetic } from "@foss-earth/sky";
import { SKY_PARAMETERS, SKY_SECTION_TITLES } from "@foss-earth/sky/settings";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { bindSkyReadingsAndNotes, createSkyRuntime, createGroundLightProbe, createStarField, type SkyRuntimeOptions, type GroundLightProbeOptions } from "@foss-earth/sky/babylon";
import { createSkyPanel, createDateTimePanel, type SkyDateTimeUiPorts } from "@foss-earth/sky/panels";
const fromEcef: SkyEcefToGeodetic = () => ({ latRad: 0, lonRad: 0, altMeters: 500 });
const observer = observerAt(6378637, 0, 0, fromEcef);
const instant = Date.UTC(2026, 2, 20, 12);
solarPosition({ utcMs: instant, latDeg: 0, lonDeg: 0 });
const settings = createSettingsRegistry({ storage: null }); settings.register(SKY_PARAMETERS); for (const [tab, section, title] of SKY_SECTION_TITLES) settings.setSectionTitle(tab, section, title); settings.setMany(fixedTimeValues(instant));
computeSkyIllumination(createAtmosphere({ aerosolOpticalDepth: 0.1, groundAlbedo: 0.2 }), solarEphemeris(instant), observer, { nightLuminance: 2e-4 });
function mountPanels(ui: SkyDateTimeUiPorts, document: Document) {
  const options = { document, settings, getPlace: () => ({ latDeg: 0, lonDeg: 0 }), now: () => instant, refresh: { subscribe: () => () => {} }, ui, panelStorage: null };
  const sky = createSkyPanel(options); const time = createDateTimePanel(options); return () => { sky.destroy(); time.destroy(); };
}
function mountRuntime(options: SkyRuntimeOptions) {
  const runtime = createSkyRuntime(options);
  const detach = bindSkyReadingsAndNotes({ settings: options.settings, sky: runtime });
  return () => { detach(); runtime.dispose(); };
}
function createDrawResources(scene: SkyRuntimeOptions["scene"], clock: () => number, onReading: GroundLightProbeOptions["onReading"]) {
  const stars = createStarField(scene,{ clock });
  const probe = createGroundLightProbe({ scene,clock,isSeen: () => false,onReading });
  return () => { probe.dispose();stars.dispose(); };
}
void mountPanels; void mountRuntime;void createDrawResources;
