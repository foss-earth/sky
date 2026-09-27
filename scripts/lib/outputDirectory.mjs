import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Creates and returns a new folder for one run's output, under the gitignored
 * `build/` tree and named for the local time the run started:
 * `newOutputDirectory("validation", "panorama-campus")` →
 * `build/validation/panorama-campus/2026-09-26_174512/`. Two runs in the same
 * second get -2, -3…: every run is kept, none overwritten.
 */
export function newOutputDirectory(...where) {
  const now = new Date();
  const pad = value => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const parent = path.join(root, "build", ...where);
  mkdirSync(parent, { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const directory = path.join(parent, attempt === 1 ? stamp : `${stamp}-${attempt}`);
    try {
      mkdirSync(directory);
      return directory;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}
