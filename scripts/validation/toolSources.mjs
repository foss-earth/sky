import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
const versions = {
  "@foss-earth/sky": "0.1.0", "@foss-earth/engine": "0.1.0", "@foss-earth/renderer": "0.1.0",
  "@foss-earth/ui": "0.1.0", "@foss-earth/research": "0.1.0", "@babylonjs/core": "8.56.2", vite: "8.3.4",
};
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
};
/** Public packages must be installed inside this owner; no ancestor or sibling checkout resolution. */
export async function publicModule(specifier) {
  const resolved = await realpath(fileURLToPath(import.meta.resolve(specifier)));
  const owner = await realpath(root);
  if (!within(owner, resolved)) throw new Error(`Sky tool resolved outside owner workspace: ${specifier}`);
  const installed = within(path.join(owner, "node_modules"), resolved);
  const ownDist = specifier.startsWith("@foss-earth/sky") && within(path.join(owner, "dist"), resolved);
  if (!installed && !ownDist) throw new Error(`Sky tool requires installed public exports or owner dist/: ${specifier}`);
  const segments = specifier.split("/");
  const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  if (!versions[name]) throw new Error(`Sky tool has no exact prerequisite version for ${specifier}`);
  let directory = path.dirname(resolved);
  let metadata;
  for (;;) {
    try {
      const candidate = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      if (candidate.name) { metadata = candidate; break; }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = path.dirname(directory);
    if (parent === directory || !within(owner, parent)) break;
    directory = parent;
  }
  if (metadata?.name !== name || metadata?.version !== versions[name]) throw new Error(`Sky tool prerequisite name/version mismatch: ${specifier}`);
  return resolved;
}
export async function sourceDigests(files, exports) {
  const sources = {};
  for (const file of files) sources[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  for (const specifier of exports) sources[`export:${specifier}`] = createHash("sha256").update(await readFile(await publicModule(specifier))).digest("hex");
  return sources;
}
/** Vite may consume only this owner's tool fixtures, built exports and installed closure. */
export function ownerResolutionGuard() {
  return {
    name: "sky-validation-owner-resolution", enforce: "pre",
    async load(id) {
      const clean = id.split("?")[0];
      if (!path.isAbsolute(clean)) return null;
      const resolved = await realpath(clean);
      const owner = await realpath(root);
      const allowed = ["dist", "node_modules", "scripts/validation", "fixtures/validation"].some(part => within(path.join(owner, part), resolved));
      if (!allowed) throw new Error(`Sky validation bundle cannot load checkout/private source: ${id}`);
      return null;
    },
  };
}

/** Browser helper is an explicit installed Research public tool, never a local implementation copy. */
export async function researchHelper(expectedSha256) {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256 ?? "")) throw new Error("Supply --chrome-helper-sha256=<exact installed Research helper SHA256>; browser validation is a separate grant.");
  const helper = await publicModule("@foss-earth/research/headless-chrome");
  const actual = createHash("sha256").update(await readFile(helper)).digest("hex");
  if (actual !== expectedSha256.toLowerCase()) throw new Error("Installed Research browser helper digest mismatch.");
  return { path: helper, sha256: actual };
}
