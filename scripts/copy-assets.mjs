import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync(new URL("../dist/styles/", import.meta.url), { recursive: true });
copyFileSync(new URL("../src/styles/sky.css", import.meta.url), new URL("../dist/styles/sky.css", import.meta.url));
