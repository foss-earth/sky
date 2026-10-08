import { Camera, Constants, FreeCamera, RenderTargetTexture, Vector3, type AbstractMesh, type Scene } from "@babylonjs/core";
import type { Rgb } from "../../sky/atmosphere";
import { DISPLAY_GAMMA } from "./imagery/terrainLightPlugin";

/** The probe's near plane, m: an aircraft's belly is a metre or two above the runway it stands on. */
const PROBE_NEAR_METERS = 0.1;
/** How far below the point the probe aims, m. */
const PROBE_AIM_METERS = 10_000;

export interface GroundLightProbeSettings {
  /** The square image's side, px. */
  sizePx: number;
  /** Its field of view, degrees, about straight down. */
  fieldOfViewDeg: number;
}

export interface GroundLightReading {
  /** The ground's mean radiance as seen from below, cosine-weighted, over the white luminance: a hemispheric light's ground colour. */
  rgb: Rgb;
  /** Pixels that saw the ground or the sky's ground below the horizon, and the time the reading took to come back, ms. */
  pixels: number;
  latencyMs: number;
}

export interface GroundLightProbeOptions {
  scene: Scene;
  /** What the probe sees: the ground, and the sky's ground below the horizon where no map is drawn. */
  isSeen(mesh: AbstractMesh): boolean;
  /** Reads the rendered image back; asynchronously on WebGL 2 and WebGPU. Replaceable for tests. */
  readPixels?(target: RenderTargetTexture, buffer: Uint8Array): Promise<ArrayBufferView | null> | null;
  onReading(reading: GroundLightReading): void;
  /** A clock, ms; `performance.now` when omitted. */
  clock?: () => number;
}

export interface GroundLightProbe {
  /**
   * Renders the ground below a point at the start of the next frame and reads
   * it back when the GPU is done, unless a reading is still on its way.
   * `compensation` is the display's exposure multiplier the image is drawn with.
   */
  request(position: Vector3, up: Vector3, settings: GroundLightProbeSettings, compensation: number): boolean;
  /** Whether a rendering or reading is under way. */
  busy(): boolean;
  dispose(): void;
}

/**
 * The cosine-weighted mean of a square image looking straight down with a
 * field of view: what a surface facing down receives from what the image
 * shows. Each pixel's solid angle goes as cos³ of its angle from the axis and
 * the surface's projected area as cos, so pixels are weighted by cos⁴.
 * Values are display-encoded bytes; the result is linear, the compensation
 * taken off.
 */
export function meanGroundRadiance(pixels: ArrayLike<number>, size: number, fieldOfViewDeg: number, compensation: number): Rgb {
  const tangent = Math.tan((fieldOfViewDeg * Math.PI) / 360);
  const sum: Rgb = [0, 0, 0];
  let weights = 0;
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const x = (((column + 0.5) / size) * 2 - 1) * tangent;
      const y = (((row + 0.5) / size) * 2 - 1) * tangent;
      const cosine2 = 1 / (1 + x * x + y * y);
      const weight = cosine2 * cosine2;
      const at = (row * size + column) * 4;
      for (let band = 0; band < 3; band++) sum[band] += weight * (pixels[at + band] / 255) ** DISPLAY_GAMMA;
      weights += weight;
    }
  }
  return [sum[0] / weights / compensation, sum[1] / weights / compensation, sum[2] / weights / compensation];
}

type ReadableEngine = {
  isWebGPU?: boolean;
  webGLVersion?: number;
  _gl?: WebGL2RenderingContext;
  _readPixelsAsync?(x: number, y: number, w: number, h: number, format: number, type: number, out: ArrayBufferView): Promise<ArrayBufferView> | null;
  bindFramebuffer(target: unknown): void;
  unBindFramebuffer(target: unknown): void;
};

/** WebGL 2 reads through a pixel buffer and a fence, so the CPU never waits for the GPU; WebGPU's own read is asynchronous; WebGL 1 has only the read that waits. */
function defaultReadPixels(target: RenderTargetTexture, buffer: Uint8Array): Promise<ArrayBufferView | null> | null {
  const engine = target.getScene()?.getEngine() as unknown as ReadableEngine | undefined;
  const renderTarget = target.renderTarget;
  if (engine && !engine.isWebGPU && (engine.webGLVersion ?? 1) >= 2 && engine._readPixelsAsync && engine._gl && renderTarget) {
    engine.bindFramebuffer(renderTarget);
    const gl = engine._gl;
    const reading = engine._readPixelsAsync(0, 0, target.getSize().width, target.getSize().height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
    engine.unBindFramebuffer(renderTarget);
    return reading;
  }
  // Babylon's own buffer here: on WebGPU it reads rows padded to 256 bytes, and copies only what fits of them into a caller's.
  return target.readPixels() as Promise<ArrayBufferView | null> | null;
}

/**
 * The light the ground sends up, as the ground itself shows it: a small
 * image rendered from a point looking straight down, only the ground and the
 * sky's ground below the horizon in it, read back and averaged as a surface
 * facing down receives it. It shows whatever lights the ground: the Sun, the
 * Moon, the sky, local lights, and the map's own colours. One render of the
 * ground below at a few pixels, when asked, and no wait for the GPU.
 */
export function createGroundLightProbe(options: GroundLightProbeOptions): GroundLightProbe {
  const { scene } = options;
  const clock = options.clock ?? (() => performance.now());
  const readPixels = options.readPixels ?? defaultReadPixels;
  const camera = new FreeCamera("sky-ground-probe-camera", Vector3.Zero(), scene, false);
  camera.fovMode = Camera.FOVMODE_VERTICAL_FIXED;
  camera.minZ = PROBE_NEAR_METERS;
  camera.inputs.clear();
  let target: RenderTargetTexture | null = null;
  let size = 0;
  let buffer = new Uint8Array(0);
  let pending: { settings: GroundLightProbeSettings; compensation: number; startedAt: number } | null = null;
  let reading = false;
  let disposed = false;

  function ensureTarget(sizePx: number): RenderTargetTexture {
    if (target && size === sizePx) return target;
    if (target) {
      const index = scene.customRenderTargets.indexOf(target);
      if (index >= 0) scene.customRenderTargets.splice(index, 1);
      target.dispose();
    }
    size = sizePx;
    buffer = new Uint8Array(size * size * 4);
    const created = new RenderTargetTexture("sky-ground-probe", { width: size, height: size }, scene, {
      generateMipMaps: false,
      type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
    });
    created.activeCamera = camera;
    created.renderList = [];
    created.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    created.renderParticles = false;
    created.renderSprites = false;
    // After the target is unbound, when its render pass has ended: WebGPU cannot read a texture its open pass is drawing to.
    created.onAfterUnbindObservable.add(() => {
      const request = pending;
      if (!request || disposed || reading) return;
      pending = null;
      reading = true;
      const result = readPixels(created, buffer);
      const finish = (pixels: ArrayBufferView | null): void => {
        reading = false;
        if (disposed || !pixels) return;
        const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
        options.onReading({
          rgb: meanGroundRadiance(bytes, size, request.settings.fieldOfViewDeg, request.compensation),
          pixels: size * size,
          latencyMs: clock() - request.startedAt,
        });
      };
      if (!result) { reading = false; return; }
      result.then(finish, () => { reading = false; });
    });
    scene.customRenderTargets.push(created);
    target = created;
    return created;
  }

  return {
    request(position, up, settings, compensation) {
      if (disposed || pending || reading) return false;
      const rendered = ensureTarget(Math.max(2, Math.round(settings.sizePx)));
      camera.position.copyFrom(position);
      camera.fov = (settings.fieldOfViewDeg * Math.PI) / 180;
      // As far as the view itself reaches, which the runtime keeps beyond the ground from any height.
      camera.maxZ = scene.activeCamera?.maxZ ?? camera.maxZ;
      // Any direction across the vertical will do for the image's up.
      const across = Vector3.Cross(up, Math.abs(up.y) < 0.9 ? Vector3.UpReadOnly : Vector3.RightReadOnly).normalize();
      camera.upVector.copyFrom(across);
      // Aimed far below: Babylon nudges a camera looking straight down by a millimetre, which a far aim makes no tilt.
      camera.setTarget(position.subtract(up.scale(PROBE_AIM_METERS)));
      const list = rendered.renderList!;
      list.length = 0;
      for (const mesh of scene.meshes) if (mesh.isEnabled() && options.isSeen(mesh)) list.push(mesh);
      pending = { settings, compensation, startedAt: clock() };
      rendered.resetRefreshCounter();
      return true;
    },
    busy: () => pending !== null || reading,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (target) {
        const index = scene.customRenderTargets.indexOf(target);
        if (index >= 0) scene.customRenderTargets.splice(index, 1);
        target.dispose();
      }
      camera.dispose();
    },
  };
}
