#!/usr/bin/env node
/**
 * Draws the sky's shaders and checks their pixels against the model, through WebGL 2, WebGL 1 and
 * WebGPU, with no server: map imagery lit by each point's own Sun and Moon by day, at dusk and by
 * night, as a 2D tile's material and as an unlit glTF one; a lamp's beam on the ground; the planet's
 * terminator from afar; the Moon's disc, a star and a point of light; and the light from the ground
 * read back. Writes report.json and a picture of each case to a new dated folder under build/.
 *
 * On this machine's GPU by default, and then a software renderer is not counted as a result.
 * `--software` draws with Chrome's own software renderer (SwiftShader) instead: the same shaders and
 * the same pixels to check, for when a GPU run is not wanted. Its report says so, and it says nothing
 * of a GPU's drivers.
 * Usage: node scripts/validation/sky-render.mjs [--software]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "vite";
import { openHeadlessChrome, evaluate, waitForExpression } from "../lib/headlessChrome.mjs";
import { newOutputDirectory } from "../lib/outputDirectory.mjs";

const software = process.argv.includes("--software");
const root = fileURLToPath(new URL("../../", import.meta.url));
const out = newOutputDirectory("validation", "sky-render");
await mkdir(out, { recursive: true });
process.env.TMPDIR = out;
await build({
  configFile: false, root, logLevel: "warn", publicDir: false,
  build: { outDir: path.join(out, "bundle"), emptyOutDir: false, lib: {
    entry: path.join(root, "scripts/validation/skyRenderCheck.ts"), formats: ["iife"], name: "SkyRenderCheck", fileName: () => "check.js",
  } },
});
const bundle = await readFile(path.join(out, "bundle/check.js"));
const sources = {};
for (const name of [
  "scripts/validation/sky-render.mjs", "scripts/validation/skyRenderCheck.ts", "src/engine/babylon/createSkyRuntime.ts",
  "src/engine/babylon/imagery/terrainLightPlugin.ts", "src/engine/babylon/createStarField.ts", "src/engine/babylon/createLightPoints.ts",
  "src/engine/babylon/createGroundLightProbe.ts", "src/sky/skyState.ts", "src/sky/atmosphere.ts", "src/sky/lunarPosition.ts", "src/sky/stars.ts",
]) {
  sources[name] = createHash("sha256").update(await readFile(path.join(root, name))).digest("hex");
}
const SOFTWARE = /swiftshader|llvmpipe|software/i;
const chrome = await openHeadlessChrome(path.join(out, "chrome-profile"), undefined, software
  // WebGL through ANGLE on SwiftShader, and WebGPU on SwiftShader's adapter: both on the CPU.
  ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader", "--enable-features=Vulkan"]
  : ["--enable-unsafe-webgpu", "--enable-gpu", "--disable-software-rasterizer", ...(process.platform === "darwin" ? ["--use-angle=metal"] : [])]);
let results = [];
const errors = [];
let browser = "";
try {
  browser = (await chrome.send("Browser.getVersion")).product;
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params = {}) => chrome.send(method, params, sessionId);
  chrome.onEvent(message => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method !== "Fetch.requestPaused") return;
    const url = new URL(message.params.request.url);
    if (url.origin !== "https://foss-earth.test") {
      errors.push(`Unexpected network request: ${url.origin}${url.pathname}`);
      void send("Fetch.failRequest", { requestId: message.params.requestId, errorReason: "BlockedByClient" }).catch(error => errors.push(String(error)));
      return;
    }
    const script = url.pathname === "/check.js";
    const body = script ? bundle : Buffer.from('<!doctype html><meta charset="utf-8"><body style="margin:0;background:#222"><script src="/check.js"></script>');
    void send("Fetch.fulfillRequest", { requestId: message.params.requestId, responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: script ? "text/javascript" : "text/html" }], body: body.toString("base64") }).catch(error => errors.push(String(error)));
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setUserAgentOverride", { userAgent: "foss-earth-check/1.0" });
  await send("Emulation.setDeviceMetricsOverride", { width: 640, height: 480, deviceScaleFactor: 1, mobile: false });
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await send("Page.navigate", { url: "https://foss-earth.test/" });
  // A software renderer takes a minute or two over the three backends.
  await waitForExpression(chrome, sessionId, "window.skyRenderCheck?.done === true", 600_000);
  results = await evaluate(chrome, sessionId, "window.skyRenderCheck.results.map(result => ({ ...result, shots: Object.keys(result.shots) }))");
  for (const [index, result] of results.entries()) {
    for (const name of result.shots) {
      const url = await evaluate(chrome, sessionId, `window.skyRenderCheck.results[${index}].shots[${JSON.stringify(name)}]`);
      await writeFile(path.join(out, `${result.backend}-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`), Buffer.from(url.split(",")[1], "base64"));
    }
  }
} catch (error) {
  errors.push(String(error?.stack ?? error));
} finally {
  try {
    await writeFile(path.join(out, "report.json"), `${JSON.stringify({ tool: "scripts/validation/sky-render.mjs", generatedAt: new Date().toISOString(), browser, software, sources, errors, results }, null, 2)}\n`);
  } finally {
    await chrome.close();
  }
}

let failed = errors.length;
for (const error of errors) console.log(`ERROR ${error}`);
for (const result of results) {
  console.log(`\n== ${result.backend}: ${result.renderer}`);
  // On the GPU, a software renderer drew nothing that counts.
  if (!software && SOFTWARE.test(result.renderer || "software")) { failed++; console.log("ERROR a software renderer drew this, not the GPU: run with --software to accept one"); }
  for (const check of result.checks) {
    if (!check.ok) failed++;
    console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name}: expected ${JSON.stringify(check.expected)}${check.tolerance ? ` ±${check.tolerance}` : ""}, drawn ${JSON.stringify(check.actual)}`);
  }
  for (const note of result.notes) console.log(`     ${note}`);
  for (const error of result.errors) { failed++; console.log(`ERROR ${error}`); }
}
if (results.length !== 3) failed++;
const checks = results.reduce((sum, result) => sum + result.checks.length, 0);
console.log(`\n${failed ? `${failed} FAILED` : `all ${checks} checks passed`} on ${software ? "Chrome's software renderer" : "this machine's GPU"}, ${browser}`);
console.log(`Evidence: ${out}`);
if (failed) process.exitCode = 1;
