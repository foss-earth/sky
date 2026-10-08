#!/usr/bin/env node
/**
 * The sky model's numbers on this CPU: no browser, GPU, network or server.
 * Writes sky-model.json to a new dated folder under build/ and prints a summary.
 * A retained run is copied to validation/evidence/sky/.
 * Usage: node scripts/validation/sky-model.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { build } from "vite";
import { newOutputDirectory } from "../lib/outputDirectory.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = newOutputDirectory("validation", "sky-model");
await build({ configFile: false, root, logLevel: "warn", publicDir: false,
  build: { outDir: path.join(out, "bundle"), emptyOutDir: false, minify: false, lib: {
    entry: path.join(root, "scripts/validation/skyModelCheck.ts"), formats: ["es"], fileName: () => "check.mjs",
  } },
});
const sources = {};
for (const name of [
  "scripts/validation/sky-model.mjs", "scripts/validation/skyModelCheck.ts", "src/sky/atmosphere.ts", "src/sky/skyState.ts",
  "src/sky/solarPosition.ts", "src/sky/solarPositionTerms.ts", "src/sky/lunarPosition.ts", "src/sky/stars.ts", "src/sky/starCatalogue.ts",
  "src/settings/catalogue/sky.ts",
]) {
  sources[name] = createHash("sha256").update(await readFile(path.join(root, name))).digest("hex");
}
const { run } = await import(pathToFileURL(path.join(out, "bundle/check.mjs")).href);
const record = { tool: "scripts/validation/sky-model.mjs", ranAt: new Date().toISOString(), node: process.version, sources, ...run() };
await writeFile(path.join(out, "sky-model.json"), `${JSON.stringify(record, null, 2)}\n`);

console.log(`Sun, report's example: zenith ${record.solar.zenithDeg.computed.toFixed(5)}° (report ${record.solar.zenithDeg.report}), azimuth ${record.solar.azimuthDeg.computed.toFixed(5)}° (report ${record.solar.azimuthDeg.report})`);
console.log("Sun elevation   Sun lx      Sky lx    Level ground lx   Meter EV   Model / published");
for (const row of record.light) {
  console.log(`${String(row.unrefractedElevationDeg).padStart(9)}°  ${String(row.sunLux).padStart(9)}  ${String(row.skyLux).padStart(10)}  ${String(row.levelGroundLux).padStart(12)}  ${String(row.meteredEv100).padStart(9)}   ${row.modelOverPublished ? row.modelOverPublished.join(" to ") : ""}`);
}
console.log(`Transmittance table: worst ${(record.accuracy.transmittanceWorstErrorAgainstBruteForce * 100).toFixed(1)}% from brute force. Steps: ${record.accuracy.convergence.map(row => `${row.steps}: ${(row.worstErrorAgainst512Steps * 100).toFixed(1)}%`).join(", ")} from 512.`);
console.log(`Ground table: ${record.accuracy.groundTable.samples} samples; worst from the model ${[record.accuracy.groundTable.fineSteps, record.accuracy.groundTable.wideSteps].map(part => `${(part.worstErrorAgainstTheModel * 100).toFixed(1)}% at ${part.worstAtElevationDeg}° (${part.fromDeg}° to ${part.toDeg}°)`).join(", ")}.`);
console.log(`Moon, Meeus's example: longitude ${record.moon.longitudeDeg.computed.toFixed(6)}° (published ${record.moon.longitudeDeg.published}), distance ${record.moon.distanceKm.computed.toFixed(1)} km (published ${record.moon.distanceKm.published})`);
console.log(`Moon above the air at its mean distance: ${record.moon.aboveTheAirAtMeanDistance.map(row => `${row.phaseAngleDeg}°: ${row.lux} lx`).join(", ")}`);
console.log("Night                   Sun      Moon    lit   Moon lx   Moonlit sky lx   Level ground lx   Meter EV   Adapted   In range   Ground 0.3 / white");
for (const row of record.moon.nights) {
  console.log(`${row.name.padEnd(22)} ${String(row.sunElevationDeg).padStart(6)}° ${String(row.moonElevationDeg).padStart(7)}° ${String(row.moonLitFraction).padStart(5)} ${String(row.moonDirectLux).padStart(9)} ${String(row.moonlitSkyLux).padStart(15)} ${String(row.levelGroundLux).padStart(16)} ${String(row.meteredEv100).padStart(10)} ${String(row.adaptedEv100).padStart(9)} ${String(row.ev100AtDefaults).padStart(9)} ${String(row.groundOfReflectance03).padStart(12)}`);
}
console.log(`Stars: ${record.stars.count} in ${record.stars.packedBytes} bytes; ${Object.entries(record.stars.countToMagnitude).map(([magnitude, count]) => `${count} to ${magnitude}`).join(", ")}; brightest ${record.stars.brightest.lux} lx; all to 6.5, ${record.stars.allToMagnitude65AboveTheAirLux} lx.`);
console.log(`Stars by day, the Sun ${record.starsByHeight.sunElevationDeg}° up, with their exposure moved between ${record.starsByHeight.heightsKm.min} and ${record.starsByHeight.heightsKm.max} km:`);
console.log("Height    Sky cd/m²   of sea level   Scene EV   Metered on the sky   Stars' EV   Stars' white cd/m²");
for (const row of record.starsByHeight.rows) {
  console.log(`${String(row.km).padStart(4)} km  ${String(row.skyMeanCdPerM2).padStart(10)}  ${String(row.ofSeaLevel).padStart(12)}  ${String(row.sceneEv100).padStart(9)}  ${String(row.meteredOnTheSkyEv100).padStart(18)}  ${String(row.starEv100AtDefaults).padStart(10)}  ${String(row.starWhiteCdPerM2).padStart(12)}`);
}
console.log(`Exposure at the defaults (adaptation ${record.exposure.defaults.adaptation}, EV ${record.exposure.defaults.minEv100} to ${record.exposure.defaults.maxEv100}):`);
console.log("Sun elevation   Meter EV   Adapted   In range   Ground 0.3 / white   Sky / white   Ground, sky following the meter");
for (const row of record.exposure.rows) {
  console.log(`${String(row.unrefractedElevationDeg).padStart(9)}°  ${String(row.meteredEv100).padStart(9)}  ${String(row.adaptedEv100).padStart(8)}  ${String(row.ev100AtDefaults).padStart(9)}  ${String(row.groundOfReflectance03).padStart(12)}  ${String(row.skyMean).padStart(16)}   ${row.groundFollowingTheMeter}, ${row.skyMeanFollowingTheMeter}`);
}
console.log(`Cost (not qualified): tables ${record.cost.atmosphereTablesMs} ms and ${record.cost.atmosphereTableBytes} bytes; light ${record.cost.illuminationMs} ms, with the Moon ${record.cost.illuminationWithMoonMs} ms; domes ${record.cost.domes.map(dome => `${dome.samples} samples ${dome.fillMs} ms`).join(", ")}; moonlit dome ${record.cost.moonlitDome.samples} samples (${record.cost.moonlitDome.moonSamples} the Moon's) ${record.cost.moonlitDome.fillMs} ms`);
console.log(`Wrote ${path.join(out, "sky-model.json")}`);
