import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Generation prepares reviewable files in this owner; source is never overwritten by default. */
export function outputFile(name, requested) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const target = requested
    ? path.resolve(root, requested)
    : path.join(root, "build", "generated", new Date().toISOString().replace(/[:.]/g, "-"), name);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Output must stay inside this repository.");
  mkdirSync(path.dirname(target), { recursive: true });
  return target;
}
