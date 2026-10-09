import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const workspaceRoot = path.dirname(fileURLToPath(import.meta.url)) + path.sep;
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (resolved.url.startsWith("file:") && !fileURLToPath(resolved.url).startsWith(workspaceRoot)) throw new Error(`Dependency escaped installed consumer: ${specifier}`);
  return resolved;
} });
for (const name of ["window", "document", "navigator", "localStorage"]) Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error(`Unexpected browser access: ${name}`); } });
const sky = await import("@foss-earth/sky"); const settings = await import("@foss-earth/sky/settings"); const panels = await import("@foss-earth/sky/panels");
const place = sky.observerAt(6378637, 0, 0, () => ({ latRad: 0, lonRad: 0, altMeters: 500 })); assert.equal(place.altitudeMeters, 500); assert.equal(place.latDeg, 0);
const sun = sky.solarPosition({ utcMs: Date.UTC(2026, 2, 20, 12), latDeg: 0, lonDeg: 0 }); assert.ok(sun.elevationDeg > 80);
assert.equal(sky.whiteLuminanceForEv100(15), 39321.6); assert.equal(typeof panels.createDateTimePanel, "function"); assert.equal(typeof panels.createSkyPanel, "function"); assert.ok(settings.SKY_PARAMETERS.find(item => item.id === "renderer.exposureEV" && item.home.tab === "sky"));
assert.match(readFileSync(new URL(import.meta.resolve("@foss-earth/sky/styles.css")), "utf8"), /foss-earth-date-time/);
const stars = await sky.loadStarCatalogue(); assert.equal(stars.count, 9096);
process.stdout.write("Sky installed-artifact pure/settings/panels imports, photometry, catalogue and CSS passed.\n");
