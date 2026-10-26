#!/usr/bin/env node
// Source-level GPU regression check. Inject an existing public browser helper;
// this neither installs tools nor qualifies the packaged numerical cores.
// node scripts/validation/lens-flare.mjs --browser-helper=/absolute/path/to/browser-testing/src/headlessPage.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "vite";

const helper = process.argv.find(arg => arg.startsWith("--browser-helper="))?.slice("--browser-helper=".length);
if (!helper || !path.isAbsolute(helper)) throw new Error("Supply --browser-helper=/absolute/path/to/an/existing/browser-testing/page module");
const { openHeadlessPage } = await import(pathToFileURL(helper).href);
const root = fileURLToPath(new URL("../../", import.meta.url));
const out = path.join(root, "build/lens-flare/gpu-regression");
await mkdir(out, { recursive: true });
await build({ configFile: false, root, publicDir: false, logLevel: "warn", resolve: { dedupe: ["@babylonjs/core"] },
  build: { outDir: path.join(out, "bundle"), emptyOutDir: true, lib: {
    entry: path.join(root, "fixtures/validation/lensFlareCheck.ts"), formats: ["iife"], name: "LensFlareCheck", fileName: () => "check.js",
  } },
});
const bundle = await readFile(path.join(out, "bundle/check.js"), "utf8");
const profile = path.join(out, "profile");
const page = await openHeadlessPage("chrome", profile, { width: 600, height: 600,
  binary: process.env.CHROME_BIN,
  chromeArgs: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader", "--enable-features=Vulkan"],
  respond: () => ({ status: 200, headers: { "content-type": "text/html" }, body: `<!doctype html><body><script>${bundle.replaceAll("</script", "<\\/script")}</script>` }),
});
try {
  await page.navigate("https://lens-flare.test/");
  for (let i = 0; i < 100 && !await page.evaluate("typeof window.runLensFlareCheck === 'function'"); i++) await new Promise(resolve => setTimeout(resolve, 50));
  const results = [];
  for (const config of [["webgl2", false, false], ["webgpu", false, false], ["webgl2", true, false], ["webgl2", false, true]]) {
    const result = await page.evaluate(`window.runLensFlareCheck(...${JSON.stringify(config)})`);
    assert.equal(result.cases.length, 8);
    assert.equal(result.idleFrames, 0);
    results.push(result);
  }
  const evidence = page.captureEvidence();
  assert.deepEqual(evidence.console.filter(item => item.level === "error" || /GPUValidationError/.test(item.text)), []);
  await writeFile(path.join(out, "report.json"), JSON.stringify({ softwareRenderer: true, results }, null, 2));
  console.log(`32 GPU cases passed; report: ${path.relative(root, path.join(out, "report.json"))}`);
} finally {
  await writeFile(path.join(out, "browser-evidence.json"), JSON.stringify(page.captureEvidence(), null, 2));
  await page.close();
  await rm(profile, { recursive: true, force: true });
}
