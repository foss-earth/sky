import { createSkyCore, requireWorkerRealm } from "./core.js";

let loading;
/** No fetch/compilation on import. This entry refuses a browser page realm. */
export function loadSkyCore() {
  requireWorkerRealm();
  loading ??= (async () => {
    const response = await fetch(new URL("./single/sky.wasm", import.meta.url));
    if (!response.ok) throw new Error(`Sky WASM fetch failed (${response.status})`);
    return instantiateSkyCore(await response.arrayBuffer());
  })();
  return loading;
}
/** Offline/worker loading of supplied real bytes; no mock or JS substitution. */
export async function instantiateSkyCore(bytes) {
  requireWorkerRealm();
  let view;
  if (bytes instanceof ArrayBuffer) view = new Uint8Array(bytes);
  else if (ArrayBuffer.isView(bytes)) view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  else throw new TypeError("Sky WASM bytes must be an ArrayBuffer or view");
  const { exp, log, sqrt, sin, cos, pow } = Math;
  const { instance } = await WebAssembly.instantiate(new Uint8Array(view), { sky_math: { exp, log, sqrt, sin, cos, pow } });
  return createSkyCore(instance.exports);
}
