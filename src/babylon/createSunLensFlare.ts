import {
  Camera, Constants, EffectRenderer, EffectWrapper, FreeCamera, Material, Matrix, Mesh,
  RawTexture, RenderTargetTexture, ShaderLanguage, ShaderMaterial, Texture, Vector3, VertexBuffer,
  type AbstractMesh, type Scene,
} from "@babylonjs/core";
import { DepthRenderer } from "@babylonjs/core/Rendering/depthRenderer.js";
import "@babylonjs/core/Rendering/depthRendererSceneComponent.js";
import { ATMOSPHERE, type Rgb } from "../atmosphere.js";
import { cleanupAll } from "./cleanup.js";
import { lensFlareEnergy, lensFlareStops, SUN_LENS, type LensFlareMode, type LensFlareState } from "./lensFlareModel.js";
import { DISC_SAMPLES, quadFragmentGlsl, quadFragmentWgsl, quadVertexGlsl, quadVertexWgsl, visibilityGlsl, visibilityWgsl } from "./lensFlareShaders.js";

export interface SunLensFlareView {
  mode: Exclude<LensFlareMode, "off">;
  direction: Vector3;
  up: Vector3;
  /** Sine of the geometric horizon's dip, negative below the observer's horizontal. */
  horizonDot: number;
  illuminance: Readonly<Rgb>;
  /** White after renderer exposure compensation, cd/m². */
  white: number;
}

export interface SunLensFlareOptions {
  scene: Scene;
  requestRender(): void;
  clock(): number;
  timers: { set(callback: () => void, delayMs: number): number; clear(id: number): void };
}

/** Deterministic, energy-normalized glare/starburst and ghost images, in one atlas. */
function lensImage(): { bytes: Uint8Array; means: [number, number] } {
  const n = SUN_LENS.imageSize, bytes = new Uint8Array(n * n * 8);
  const means: [number, number] = [0, 0];
  for (let image = 0; image < 2; image++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = 2 * (x + 0.5) / n - 1, v = 2 * (y + 0.5) / n - 1, r = Math.hypot(u, v);
    const edge = Math.max(0, 1 - r * r) ** 2;
    let value: number;
    if (image === 0) {
      const core = Math.exp(-r * r / (2 * SUN_LENS.coreWidth ** 2));
      const halo = 0.04 / (1 + (r / SUN_LENS.haloWidth) ** 2) ** 1.5;
      let rays = 0;
      for (let blade = 0; blade < SUN_LENS.blades / 2; blade++) {
        const a = blade * 2 * Math.PI / SUN_LENS.blades;
        const along = u * Math.cos(a) + v * Math.sin(a), across = -u * Math.sin(a) + v * Math.cos(a);
        rays += Math.exp(-0.5 * (across / SUN_LENS.rayWidth) ** 2) / (1 + (along / 0.15) ** 2);
      }
      value = (core + halo + 0.12 * rays) * edge;
    } else {
      value = r < 1 ? (0.18 + 0.6 * Math.exp(-(((r - 0.78) / 0.1) ** 2))) * Math.min(1, (1 - r) * 15) : 0;
    }
    // Three base-255 digits preserve faint wings without 8-bit contour bands.
    // Decoding is linear, so ordinary bilinear filtering remains correct.
    const encoded = Math.round(Math.min(1, value) * 255 ** 3);
    means[image] += encoded / 255 ** 3 / (n * n);
    const at = (y * n * 2 + image * n + x) * 4;
    bytes.set([Math.floor(encoded / 255 ** 2), Math.floor(encoded / 255) % 255, encoded % 255, 255], at);
  }
  return { bytes, means };
}

/**
 * A small depth image aimed at the Sun, reduced to a visible sample count,
 * then one screen-blended mesh. No full-screen copy or post-process chain.
 * Created only for an enabled setting, disposed when it is switched off.
 */
export function createSunLensFlare(options: SunLensFlareOptions) {
  const { scene } = options, engine = scene.getEngine(), size = SUN_LENS.probeSize;
  const shaderLanguage = engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL;
  const camera = new FreeCamera("sky-flare-probe-camera", Vector3.Zero(), scene, false);
  camera.inputs.clear();
  camera.fov = 2 * ATMOSPHERE.sunAngularRadius;
  camera.fovMode = Camera.FOVMODE_VERTICAL_FIXED;
  // Explicit square projection: the main canvas is often a wide strip.
  const projection = scene.useRightHandedSystem
    ? Matrix.PerspectiveFovRH(camera.fov, 1, 0.01, 1e9, engine.isNDCHalfZRange)
    : Matrix.PerspectiveFovLH(camera.fov, 1, 0.01, 1e9, engine.isNDCHalfZRange);
  camera.freezeProjectionMatrix(projection);

  const target = new RenderTargetTexture("sky-flare-depth", size, scene, {
    generateMipMaps: false, type: Constants.TEXTURETYPE_UNSIGNED_BYTE, samplingMode: Texture.NEAREST_SAMPLINGMODE,
  });
  const depth = new DepthRenderer(scene, Constants.TEXTURETYPE_UNSIGNED_BYTE, camera, false, Texture.NEAREST_SAMPLINGMODE, false, "sky-flare-depth", target);
  // Own the target explicitly, rather than registering a second scene depth renderer.
  target.renderList = [];
  target.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
  scene.customRenderTargets.push(target);
  const maskBytes = new Uint8Array(size * size * 4);
  const mask = RawTexture.CreateRGBATexture(maskBytes, size, size, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
  const visibility = new RenderTargetTexture("sky-flare-visibility", 1, scene, {
    generateMipMaps: false, generateDepthBuffer: false, type: Constants.TEXTURETYPE_UNSIGNED_BYTE, samplingMode: Texture.NEAREST_SAMPLINGMODE,
  });
  const reduce = new EffectWrapper({
    engine, name: "sky-flare-visibility", fragmentShader: engine.isWebGPU ? visibilityWgsl : visibilityGlsl,
    shaderLanguage, samplerNames: ["depthSampler", "maskSampler"],
  });
  const effectRenderer = new EffectRenderer(engine);
  reduce.onApplyObservable.add(() => {
    reduce.effect.setTexture("depthSampler", target);
    reduce.effect.setTexture("maskSampler", mask);
  });

  const image = lensImage();
  const atlas = RawTexture.CreateRGBATexture(image.bytes, SUN_LENS.imageSize * 2, SUN_LENS.imageSize, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
  atlas.wrapU = atlas.wrapV = Texture.CLAMP_ADDRESSMODE;
  const material = new ShaderMaterial("sky-flare-material", scene, {
    vertexSource: engine.isWebGPU ? quadVertexWgsl : quadVertexGlsl,
    fragmentSource: engine.isWebGPU ? quadFragmentWgsl : quadFragmentGlsl,
  }, { attributes: ["position", "uv", "color"], uniforms: ["ready"], samplers: ["imageSampler", "visibilitySampler"], shaderLanguage, needAlphaBlending: true });
  material.setTexture("imageSampler", atlas);
  material.setTexture("visibilitySampler", visibility);
  material.setFloat("ready", 0);
  material.disableDepthWrite = true;
  material.depthFunction = Constants.ALWAYS;
  material.backFaceCulling = false;
  material.alphaMode = Constants.ALPHA_SCREENMODE;
  material.transparencyMode = Material.MATERIAL_ALPHABLEND;
  const mesh = new Mesh("sky-sun-lens-flare", scene);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.doNotSyncBoundingInfo = true;
  mesh.renderingGroupId = 3;
  mesh.setEnabled(false);

  let view: SunLensFlareView | null = null, disposed = false;
  let state: LensFlareState = { mode: "glare", status: "pending", settled: false, sources: [] };
  let generation = 0, reading = false;
  let timer: number | null = null, waitingSince = 0;
  let pending = false, ready = false;
  let checkingResources = false;
  const right = new Vector3(), up = new Vector3(), direction = new Vector3();
  const cameraInverse = new Matrix();
  const positions = new Float32Array(5 * 12), colors = new Float32Array(5 * 12), uvs = new Float32Array(5 * 8);
  const indices: number[] = [];
  for (let i = 0; i < 5; i++) {
    const a = i * 4;
    indices.push(a, a + 1, a + 2, a, a + 2, a + 3);
  }
  mesh.setVerticesData(VertexBuffer.PositionKind, positions, true);
  mesh.setVerticesData(VertexBuffer.ColorKind, colors, true, 3);
  mesh.setVerticesData(VertexBuffer.UVKind, uvs, true);
  mesh.setIndices(indices);

  function cancelWait(): void {
    if (timer !== null) options.timers.clear(timer);
    timer = null;
  }

  function fail(reason: string): void {
    pending = false; ready = false;
    material.setFloat("ready", 0);
    state = { ...state, settled: true, status: "error", reason };
    cancelWait();
  }

  function resourcesReady(): boolean {
    checkingResources = true;
    try { return reduce.isReady() && mesh.isReady(true) && target.isReadyForRendering(); }
    finally { checkingResources = false; }
  }

  // Compilation is polled without drawing, with bounded backoff and a finite
  // failure state. No recurring timer remains once the material is ready.
  function waitReady(delay = 16): void {
    if (disposed || timer !== null) return;
    timer = options.timers.set(() => {
      timer = null;
      if (disposed || !pending) return;
      if (resourcesReady()) { options.requestRender(); return; }
      if (options.clock() - waitingSince > 10_000) { fail("Lens flare shaders did not become ready within 10 seconds."); return; }
      waitReady(Math.min(250, delay * 2));
    }, delay);
  }

  function occluders(): AbstractMesh[] {
    const active = scene.activeCamera;
    return scene.meshes.filter(m => m !== mesh && m.isEnabled() && m.isVisible && m.visibility > 0 && !m.infiniteDistance
      && !!m.material && !m.material.disableDepthWrite && !m.material.needAlphaBlendingForMesh(m)
      && (!active || (m.layerMask & active.layerMask) !== 0));
  }

  function prepare(): void {
    if (disposed || !view) return;
    generation++;
    const active = scene.activeCamera;
    state.mode = view.mode;
    const xr = active && (active.isRigCamera || active.cameraRigMode !== Camera.RIG_MODE_NONE);
    if (!active || xr) {
      mesh.setEnabled(false); pending = false; cancelWait();
      state = { mode: view.mode, status: xr ? "xr" : "ready", settled: true, sources: [] };
      return;
    }
    const eye = active.globalPosition;
    camera.position.copyFrom(eye);
    // Stable probe axes: roll/heading of the viewing camera cannot change the quadrature.
    Vector3.CrossToRef(view.direction, Math.abs(view.direction.y) < 0.9 ? Vector3.UpReadOnly : Vector3.RightReadOnly, right);
    right.normalize();
    Vector3.CrossToRef(right, view.direction, up); up.normalize();
    camera.upVector.copyFrom(up);
    camera.minZ = active.minZ;
    camera.maxZ = active.maxZ;
    // Use the view's near/far, including reverse-depth and backend conventions.
    const matrix = scene.useRightHandedSystem
      ? Matrix.PerspectiveFovRH(camera.fov, 1, camera.minZ, camera.maxZ, engine.isNDCHalfZRange, 0, engine.useReverseDepthBuffer)
      : Matrix.PerspectiveFovLH(camera.fov, 1, camera.minZ, camera.maxZ, engine.isNDCHalfZRange, 0, engine.useReverseDepthBuffer);
    camera.freezeProjectionMatrix(matrix);
    camera.setTarget(eye.add(view.direction.scale(10_000)));
    camera.getViewMatrix(true);
    const probeView = camera.getViewMatrix();
    // These are the actual probe image axes for either handedness. Babylon's
    // WebGPU shader processor already flips render-target Y to match WebGL.
    probeView.invertToRef(cameraInverse);
    const rayAt = (x: number, y: number): Vector3 => {
      const z = scene.useRightHandedSystem ? -1 : 1;
      Vector3.TransformNormalFromFloatsToRef(x * Math.tan(camera.fov / 2), y * Math.tan(camera.fov / 2), z, cameraInverse, direction);
      return direction.normalize();
    };
    const vp = active.getViewMatrix().multiply(active.getProjectionMatrix());
    const width = engine.getRenderWidth(), height = engine.getRenderHeight();
    const viewport = active.viewport.toGlobal(width, height);
    const project = (ray: Vector3): { x: number; y: number; front: boolean } => {
      const v = Vector3.TransformNormal(ray, active.getViewMatrix());
      const front = scene.useRightHandedSystem ? v.z < 0 : v.z > 0;
      const m = vp.m;
      const w = ray.x * m[3] + ray.y * m[7] + ray.z * m[11];
      return { x: (ray.x * m[0] + ray.y * m[4] + ray.z * m[8]) / w,
        y: (ray.x * m[1] + ray.y * m[5] + ray.z * m[9]) / w, front };
    };
    const sun = project(view.direction);
    const pixel = sun.front ? { x: viewport.x + (sun.x + 1) * viewport.width / 2, y: height - viewport.y - (sun.y + 1) * viewport.height / 2 } : null;
    maskBytes.fill(0);
    let possible = 0;
    for (const sample of DISC_SAMPLES) {
      const ray = rayAt(sample.x, sample.y);
      const p = project(ray);
      if (Vector3.Dot(ray, view.up) >= view.horizonDot && p.front && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1) {
        maskBytes[sample.index * 4] = 255; possible++;
      }
    }
    const list = occluders();
    // Every requested frame may change skinning, morphs or vertex data without
    // moving a node. Read that frame's GPU result, rather than trying to infer
    // whether arbitrary host geometry changed from a transform cache.
    if (!pending) waitingSince = options.clock();
    state = { mode: view.mode, status: "pending", settled: false, sources: [{ id: "sun", pixel, visibleFraction: 0, stopsOverWhite: null }] };
    if (!possible) {
      pending = false; ready = false; mesh.setEnabled(false); cancelWait();
      state = { mode: view.mode, status: "ready", settled: true, sources: [{ id: "sun", pixel, visibleFraction: 0, stopsOverWhite: null }] };
      return;
    }
    mask.update(maskBytes);
    target.renderList = list;
    target.resetRefreshCounter();
    pending = true;
    mesh.setEnabled(true);
    const energy = lensFlareEnergy(view.illuminance, view.white);
    const tanY = 1 / active.getProjectionMatrix().m[5], tanX = 1 / active.getProjectionMatrix().m[0];
    const quad = (index: number, x: number, y: number, halfAngle: number, share: number, tint: readonly number[], imageIndex: number): void => {
      const halfY = Math.tan(halfAngle) / tanY, halfX = Math.tan(halfAngle) / tanX;
      const scale = share / (4 * Math.tan(halfAngle) ** 2 * image.means[imageIndex]);
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      corners.forEach(([s, t], corner) => {
        const at = (index * 4 + corner) * 3;
        positions.set([x + s * halfX, y + t * halfY, 0], at);
        colors.set(energy.map((e, band) => e * scale * tint[band]), at);
        // Half-texel inset keeps the two atlas images from bleeding together.
        uvs.set([(imageIndex + (s > 0 ? 1 - 0.5 / SUN_LENS.imageSize : 0.5 / SUN_LENS.imageSize)) / 2,
          t > 0 ? 1 - 0.5 / SUN_LENS.imageSize : 0.5 / SUN_LENS.imageSize], (index * 4 + corner) * 2);
      });
    };
    quad(0, sun.x, sun.y, SUN_LENS.glareHalfAngle, SUN_LENS.glareShare, [1, 1, 1], 0);
    SUN_LENS.ghosts.forEach((g, i) => quad(i + 1, sun.x * (1 - g.spacing), sun.y * (1 - g.spacing), g.radius * Math.PI / 180,
      view!.mode === "flare" ? g.share : 0, g.tint, 1));
    mesh.updateVerticesData(VertexBuffer.PositionKind, positions, false, false);
    mesh.updateVerticesData(VertexBuffer.ColorKind, colors, false, false);
    mesh.updateVerticesData(VertexBuffer.UVKind, uvs, false, false);
    ready = resourcesReady();
    material.setFloat("ready", ready ? 1 : 0);
    if (!ready) waitReady();
  }

  target.onAfterUnbindObservable.add(() => {
    if (disposed || checkingResources || !pending || !view || !ready) return;
    // WebGPU has ended the depth render pass here. The one-pixel result is
    // consumed by the screen mesh later in this same frame, without a CPU wait.
    effectRenderer.render(reduce, visibility);
    if (reading) return;
    reading = true;
    const captured = generation, source = state.sources[0], irradiance = [...view.illuminance] as Rgb, white = view.white;
    const result = visibility.readPixels();
    if (!result) { reading = false; fail("Lens flare visibility readback is unavailable."); return; }
    result.then(pixels => {
      reading = false;
      if (disposed) return;
      if (!pixels) { fail("Lens flare visibility readback returned no pixels."); return; }
      const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      if (captured !== generation) { if (pending) options.requestRender(); return; }
      const fraction = (bytes[0] + 256 * bytes[1]) / DISC_SAMPLES.length;
      pending = false;
      state = { mode: view!.mode, status: "ready", settled: true, sources: [{ ...source, visibleFraction: fraction, stopsOverWhite: lensFlareStops(irradiance, white, fraction) }] };
      // The picture already used this visibility. Publishing the readback does
      // not ask for a redundant frame, and a still capture can now proceed.
    }, () => { reading = false; if (!disposed) fail("Lens flare visibility readback failed."); });
  });
  const observer = scene.onBeforeRenderObservable.add(prepare);
  return {
    update(next: SunLensFlareView): void { view = next; },
    getState: (): LensFlareState => state,
    dispose(): void {
      if (disposed) return;
      disposed = true; pending = false; view = null;
      cleanupAll("Sun lens flare cleanup failed.", [
        cancelWait, () => { scene.onBeforeRenderObservable.remove(observer); },
        () => { const i = scene.customRenderTargets.indexOf(target); if (i >= 0) scene.customRenderTargets.splice(i, 1); },
        () => mesh.dispose(), () => material.dispose(), () => atlas.dispose(), () => mask.dispose(),
        () => depth.dispose(), () => target.dispose(), () => visibility.dispose(), () => reduce.dispose(), () => effectRenderer.dispose(), () => camera.dispose(),
      ]);
    },
  };
}
