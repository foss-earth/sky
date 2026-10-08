import { Color3, Constants, Material, Matrix, Mesh, RawTexture, StandardMaterial, Texture, Vector3, VertexBuffer, type Observer, type Scene, type TransformNode } from "@babylonjs/core";
import type { Rgb } from "../../sky/atmosphere";
import { DISPLAY_GAMMA } from "./imagery/terrainLightPlugin";

/**
 * The image a point of light is spread over, across a square in half-sides:
 * a sharp core and a faint glare around it, falling to nothing at the edge.
 * A brighter light saturates more of the core and lights more of the glare,
 * so it looks bigger, as a bright light does to an eye or a lens.
 */
const POINT_IMAGE = { texels: 64, coreSigma: 0.06, glareWidth: 0.05, glareShare: 0.02 } as const;

export interface LightPoint {
  /** The node the light is fixed to, or null for the scene's axes. */
  parent: TransformNode | null;
  /** Where on it, in its axes, m. */
  position: Vector3;
  /**
   * Its luminous intensity towards a viewer, cd in each band, for a unit
   * vector from the light to the viewer in the parent's axes: zero where the
   * light does not shine that way, or is off.
   */
  intensityToward(towardViewer: Vector3, out: Rgb): Rgb;
}

export interface LightPointsOptions {
  /**
   * The luminance the exposure shows as white, cd/m²: a sky model's, or null
   * where none is on, when `referenceWhiteLuminance` stands in.
   */
  getWhiteLuminance(): number | null;
  /** The white without a sky model, cd/m². */
  referenceWhiteLuminance(): number;
  /** The square a point's light is spread over, px across. */
  sizePx(): number;
  /** How far a point is drawn towards the camera, m, so the surface it is mounted on does not cut its glare. */
  liftMeters(): number;
}

export interface LightPointsHandle {
  setPoints(points: readonly LightPoint[]): void;
  /** Brings the points up to date for the frame about to be drawn; called before each frame on its own. */
  update(): void;
  /** What the last update drew, for readings: the brightest point's peak over white. */
  getPeak(): number;
  dispose(): void;
}

/** The point image, display-encoded as the standard material holds colour, and its mean over the square. */
function pointImage(): { data: Uint8Array; mean: number } {
  const { texels, coreSigma, glareWidth, glareShare } = POINT_IMAGE;
  const data = new Uint8Array(texels * texels * 4);
  let sum = 0;
  for (let row = 0; row < texels; row++) {
    for (let column = 0; column < texels; column++) {
      const u = ((column + 0.5) / texels) * 2 - 1;
      const v = ((row + 0.5) / texels) * 2 - 1;
      const r2 = u * u + v * v;
      const edge = Math.max(0, 1 - r2) ** 2;
      const value = (Math.exp(-r2 / (2 * coreSigma * coreSigma)) + glareShare / (1 + r2 / (glareWidth * glareWidth)) ** 1.5) * edge;
      const encoded = Math.round(Math.min(1, value) ** (1 / DISPLAY_GAMMA) * 255);
      sum += (encoded / 255) ** DISPLAY_GAMMA;
      const at = (row * texels + column) * 4;
      data[at] = encoded; data[at + 1] = encoded; data[at + 2] = encoded; data[at + 3] = 255;
    }
  }
  return { data, mean: sum / (texels * texels) };
}

/**
 * Point lights as they are seen: each a light of known intensity in
 * candelas, whose illuminance at the camera, I / d², is spread over a small
 * square facing it and shown against the exposure's white, as the stars are.
 * Nothing about their brightness is chosen for looks: a navigation light is
 * a glare at night and a faint dot by day because it is. One mesh, one draw;
 * positions and colours are written each frame for the camera drawing it.
 */
export function createLightPoints(scene: Scene, options: LightPointsOptions): LightPointsHandle {
  const image = pointImage();
  const texture = RawTexture.CreateRGBATexture(image.data, POINT_IMAGE.texels, POINT_IMAGE.texels, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  const material = new StandardMaterial("light-points-material", scene);
  // Unlit, the standard material shows its emissive colour times the texture and the vertex's colour: white, as the dome's.
  material.disableLighting = true;
  material.diffuseTexture = texture;
  material.emissiveColor = Color3.White();
  material.specularColor = Color3.Black();
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  material.fogEnabled = false;
  // Light added to what is behind it. The framebuffer holds display-encoded colour, where a plain sum would
  // overstate light on a bright background; a screen blend, a + b - a b, is the sum on a dark one and stays
  // within a few percent of the linear sum's encoding on a bright one.
  material.transparencyMode = Material.MATERIAL_ALPHABLEND;
  material.alphaMode = Constants.ALPHA_SCREENMODE;
  const mesh = new Mesh("light-points", scene);
  mesh.material = material;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.doNotSyncBoundingInfo = true;
  mesh.isPickable = false;
  mesh.applyFog = false;
  mesh.hasVertexAlpha = false;
  mesh.setEnabled(false);

  let points: readonly LightPoint[] = [];
  let positions = new Float32Array(0);
  let colors = new Float32Array(0);
  let peak = 0;
  const world = new Vector3();
  const toViewer = new Vector3();
  const local = new Vector3();
  const inverse = new Matrix();
  const intensity: Rgb = [0, 0, 0];

  function build(): void {
    const count = points.length;
    positions = new Float32Array(count * 12);
    colors = new Float32Array(count * 16);
    const uvs = new Float32Array(count * 8);
    const indices = new Uint32Array(count * 6);
    for (let point = 0; point < count; point++) {
      uvs.set([0, 0, 1, 0, 1, 1, 0, 1], point * 8);
      const at = point * 4;
      indices.set([at, at + 1, at + 2, at, at + 2, at + 3], point * 6);
    }
    if (count === 0) {
      mesh.setEnabled(false);
      return;
    }
    mesh.setVerticesData(VertexBuffer.PositionKind, positions, true);
    mesh.setVerticesData(VertexBuffer.ColorKind, colors, true, 4);
    mesh.setVerticesData(VertexBuffer.UVKind, uvs, false);
    mesh.setIndices(indices, count * 4);
  }

  function update(): void {
    const camera = scene.activeCamera;
    const height = scene.getEngine().getRenderHeight();
    if (!camera || points.length === 0 || height <= 0) {
      mesh.setEnabled(false);
      return;
    }
    const white = options.getWhiteLuminance() ?? options.referenceWhiteLuminance();
    const pixelAngle = (2 * Math.tan(camera.fov / 2)) / height;
    const sizePx = Math.max(1, options.sizePx());
    const lift = options.liftMeters();
    const view = camera.getViewMatrix();
    // The camera's right and up in the scene: a square facing it.
    const right = new Vector3(view.m[0], view.m[4], view.m[8]).normalize();
    const up = new Vector3(view.m[1], view.m[5], view.m[9]).normalize();
    const eye = camera.globalPosition;
    peak = 0;
    points.forEach((point, index) => {
      const matrix = point.parent ? point.parent.computeWorldMatrix(true) : null;
      if (matrix) Vector3.TransformCoordinatesToRef(point.position, matrix, world);
      else world.copyFrom(point.position);
      eye.subtractToRef(world, toViewer);
      const distance = Math.max(1e-3, toViewer.length());
      toViewer.scaleInPlace(1 / distance);
      if (matrix) {
        matrix.invertToRef(inverse);
        Vector3.TransformNormalToRef(toViewer, inverse, local);
        local.normalize();
      } else {
        local.copyFrom(toViewer);
      }
      point.intensityToward(local, intensity);
      // E = I / d², spread over the square's solid angle, over white, over the image's mean.
      const drawnDistance = Math.max(1e-3, distance - lift);
      const solidAngle = (sizePx * pixelAngle) ** 2;
      const scale = 1 / (distance * distance * solidAngle * white * image.mean);
      const half = (sizePx / 2) * pixelAngle * drawnDistance;
      const centre = world.add(toViewer.scale(Math.min(lift, distance * 0.5)));
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
      corners.forEach(([s, t], corner) => {
        const at = (index * 4 + corner) * 3;
        positions[at] = centre.x + (s * right.x + t * up.x) * half;
        positions[at + 1] = centre.y + (s * right.y + t * up.y) * half;
        positions[at + 2] = centre.z + (s * right.z + t * up.z) * half;
      });
      for (let corner = 0; corner < 4; corner++) {
        const at = (index * 4 + corner) * 4;
        for (let band = 0; band < 3; band++) {
          const value = Math.max(0, intensity[band]) * scale;
          peak = Math.max(peak, value);
          colors[at + band] = value ** (1 / DISPLAY_GAMMA);
        }
        colors[at + 3] = 1;
      }
    });
    mesh.updateVerticesData(VertexBuffer.PositionKind, positions, false, false);
    mesh.updateVerticesData(VertexBuffer.ColorKind, colors, false, false);
    mesh.setEnabled(peak > 0);
  }

  const observer: Observer<Scene> = scene.onBeforeRenderObservable.add(update);

  return {
    setPoints(next) {
      points = [...next];
      build();
    },
    update,
    getPeak: () => peak,
    dispose() {
      scene.onBeforeRenderObservable.remove(observer);
      mesh.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
