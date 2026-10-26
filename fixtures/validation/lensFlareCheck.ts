import { Color3, Color4, Engine, FreeCamera, MeshBuilder, Scene, StandardMaterial, Vector3, WebGPUEngine } from "@babylonjs/core";
import { createSunLensFlare, type SunLensFlareView } from "../../src/babylon/createSunLensFlare.js";
import type { LensFlareState } from "../../src/babylon/lensFlareModel.js";

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
interface Case {
  name: string;
  state: LensFlareState;
  pixels: { max: number; lit: number; source: number[]; hash: number };
}

/** Source-level compositor regression check; separate from installed-core qualification. */
async function runLensFlareCheck(backend: "webgl2" | "webgpu", rightHanded = false, reverse = false) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 600;
  document.body.replaceChildren(canvas);
  const engine = backend === "webgpu" ? new WebGPUEngine(canvas, { antialias: false }) : new Engine(canvas, false, { preserveDrawingBuffer: true });
  if (engine instanceof WebGPUEngine) await engine.initAsync();
  engine.useReverseDepthBuffer = reverse;
  const scene = new Scene(engine);
  scene.useRightHandedSystem = rightHanded;
  scene.clearColor = new Color4(0, 0, 0, 1);
  const camera = new FreeCamera("eye", Vector3.Zero(), scene);
  camera.setTarget(new Vector3(0, 0, rightHanded ? -1 : 1));
  camera.fov = 40 * Math.PI / 180; camera.minZ = 0.01; camera.maxZ = 1000;
  scene.activeCamera = camera;
  const blocker = MeshBuilder.CreatePlane("blocker", { width: 1, height: 1, sideOrientation: 2 }, scene);
  blocker.position.z = rightHanded ? -10 : 10;
  const material = new StandardMaterial("blocker", scene);
  material.disableLighting = true; material.emissiveColor = Color3.Black();
  blocker.material = material; blocker.setEnabled(false);
  let frames = 0, queued: number | null = null, stopped = false;
  const draw = (): void => {
    if (stopped) return;
    frames++; engine.beginFrame();
    try { scene.render(); } finally { engine.endFrame(); }
  };
  const flare = createSunLensFlare({ scene, clock: () => performance.now(),
    timers: { set: (callback, ms) => window.setTimeout(callback, ms), clear: id => window.clearTimeout(id) },
    requestRender: () => {
      if (queued !== null || stopped) return;
      queued = window.setTimeout(() => { queued = null; draw(); }, 0);
    },
  });
  let view: SunLensFlareView = { mode: "flare", direction: new Vector3(0, 0, rightHanded ? -1 : 1),
    up: new Vector3(0, 1, 0), horizonDot: -1, illuminance: [133334, 133334, 133334], white: 1.2 * 2 ** 12 };
  const cases: Case[] = [];
  const settle = async (): Promise<LensFlareState> => {
    flare.update(view); draw();
    const deadline = performance.now() + 12_000;
    while (!flare.getState().settled && performance.now() < deadline) await pause(25);
    if (!flare.getState().settled || flare.getState().status !== "ready") throw new Error(JSON.stringify(flare.getState()));
    return structuredClone(flare.getState());
  };
  const capture = async (): Promise<Case["pixels"]> => {
    // Read while the WebGPU swapchain texture is still valid, in the drawing task.
    engine.beginFrame(); scene.render();
    const reading = engine.readPixels(0, 0, 600, 600);
    engine.endFrame();
    const copy = document.createElement("canvas"); copy.width = copy.height = 600;
    const context = copy.getContext("2d")!;
    context.drawImage(canvas, 0, 0);
    const point = flare.getState().sources[0]?.pixel;
    const source = point ? [...context.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data] : [];
    const raw = await reading;
    const pixels = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    let max = 0, lit = 0, hash = 2166136261;
    for (let i = 0; i < pixels.length; i++) {
      hash = Math.imul(hash ^ pixels[i], 16777619) >>> 0;
      if (i % 4 !== 3) { max = Math.max(max, pixels[i]); if (pixels[i] > 0) lit++; }
    }
    return { max, lit, source, hash };
  };
  const check = async (name: string, fraction: number): Promise<void> => {
    const state = await settle(), pixels = await capture();
    cases.push({ name, state, pixels });
    if (state.sources[0]?.visibleFraction !== fraction) throw new Error(`${backend}/${name}: ${JSON.stringify(state)}`);
    if ((pixels.max > 0) !== (fraction > 0)) throw new Error(`${backend}/${name}: unexpected rendered pixels`);
    if (fraction > 0 && pixels.source[0] < 200) throw new Error(`${backend}/${name}: glare is not at the source pixel`);
  };
  try {
    await check("visible", 1);
    blocker.position.x = -0.5; blocker.setEnabled(true); await check("half", 0.5);
    blocker.position.x = 0; await check("blocked", 0);
    blocker.setEnabled(false); view = { ...view, horizonDot: 0 }; await check("earth-half", 0.5);
    blocker.position.y = 0.5; blocker.setEnabled(true); await check("earth-and-upper-blocker", 0);
    blocker.setEnabled(false); blocker.position.y = 0; view = { ...view, horizonDot: 0.01 }; await check("earth", 0);
    view = { ...view, horizonDot: -1, direction: new Vector3(0.15, 0.08, rightHanded ? -1 : 1).normalize() };
    await check("off-axis", 1); await check("repeat", 1);
    if (cases.at(-1)!.pixels.hash !== cases.at(-2)!.pixels.hash) throw new Error("Repeated still changed pixels");
    await settle();
    const before = frames; await pause(150);
    if (frames !== before) throw new Error("Still view requested more frames");
    let started = performance.now(); for (let i = 0; i < 10; i++) draw();
    const onCpuMs = (performance.now() - started) / 10;
    flare.dispose(); started = performance.now(); for (let i = 0; i < 10; i++) draw();
    const offCpuMs = (performance.now() - started) / 10;
    if (scene.customRenderTargets.length || scene.textures.length || scene.meshes.length !== 1) throw new Error("Off retained flare resources");
    return { backend, rightHanded, reverse, cases, idleFrames: frames - before - 20, onCpuMs, offCpuMs };
  } finally {
    stopped = true;
    if (queued !== null) window.clearTimeout(queued);
    flare.dispose(); scene.dispose(); engine.dispose();
  }
}

declare global { interface Window { runLensFlareCheck: typeof runLensFlareCheck } }
window.runLensFlareCheck = runLensFlareCheck;
