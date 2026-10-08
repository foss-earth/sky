import { Color3, Constants, Material, Mesh, RawTexture, StandardMaterial, Texture, Vector3, VertexBuffer, type Scene } from "@babylonjs/core";
import type { Atmosphere, Rgb } from "../../sky/atmosphere";
import type { SkyObserver } from "../../sky/skyState";
import { applyMatrix3, starDirections, starIlluminanceLux, starTint, type Matrix3, type StarCatalogue } from "../../sky/stars";
import { DISPLAY_GAMMA } from "./imagery/terrainLightPlugin";

/** The stars' radius, m: the dome's, past every far plane. */
const STAR_RADIUS_METERS = 1e10;
/** The texture each star's light is spread over: a Gaussian across a square, sides in texels and its width in half-sides. */
const STAR_IMAGE = { texels: 32, sigma: 0.4 } as const;
/**
 * A star's square is redrawn for a new field of view or render height only
 * when a pixel's angle has changed by more than this share: nothing seen
 * changes for less.
 */
const PIXEL_ANGLE_TOLERANCE = 0.01;
/**
 * The field is drawn only while its brightest star reaches this share of the
 * display's white: below it, after encoding, no star is a step above black.
 */
const VISIBLE_SHARE = 1 / 1024;
/**
 * No star gives more light than this in any band: Sirius, the catalogue's
 * brightest at V −1.46, with twice its light allowed for a star's colour, more
 * than any star's tint gives a band. For asking whether any star could show
 * before the catalogue is loaded.
 */
const BRIGHTEST_STAR = { magnitude: -1.46, tintHeadroom: 2 } as const;

export interface StarFieldView {
  catalogue: StarCatalogue;
  /** J2000 directions to the Earth's axes at the instant shown. */
  toEcef: Matrix3;
  /** Years from J2000, for proper motion. */
  years: number;
  observer: SkyObserver;
  atmosphere: Atmosphere;
  /** The Sun's illuminance above the air at 1 AU, lux: the scale of magnitudes. */
  solarIlluminanceAt1AuLux: number;
  /** One over the white luminance: what a luminance is multiplied by to reach the scene. */
  scale: number;
  /** Takes a direction in the Earth's axes into the scene's, normalized. */
  toScene(x: number, y: number, z: number): Vector3;
  limitingMagnitude: number;
  /** A star's square, px across. */
  sizePx: number;
  /** The angle a pixel spans at the view's centre, radians. */
  pixelAngle: number;
}

export interface StarFieldCost {
  stars: number;
  /** The last time positions or colours were computed, ms. */
  updateMs: number;
  /** Whether the brightest star shows: the field is drawn only then. */
  visible: boolean;
}

export interface StarField {
  update(view: StarFieldView): StarFieldCost;
  dispose(): void;
}

let builtImage: { data: Uint8Array; mean: number } | null = null;

/** A Gaussian on the texture, display-encoded as the standard material holds colour, and its mean over the square. Built once. */
function starImage(): { data: Uint8Array; mean: number } {
  if (builtImage) return builtImage;
  const { texels, sigma } = STAR_IMAGE;
  const data = new Uint8Array(texels * texels * 4);
  let sum = 0;
  for (let row = 0; row < texels; row++) {
    for (let column = 0; column < texels; column++) {
      const u = ((column + 0.5) / texels) * 2 - 1;
      const v = ((row + 0.5) / texels) * 2 - 1;
      const value = Math.exp(-(u * u + v * v) / (2 * sigma * sigma));
      const encoded = Math.round(value ** (1 / DISPLAY_GAMMA) * 255);
      sum += (encoded / 255) ** DISPLAY_GAMMA;
      const at = (row * texels + column) * 4;
      data[at] = encoded; data[at + 1] = encoded; data[at + 2] = encoded; data[at + 3] = 255;
    }
  }
  builtImage = { data, mean: sum / (texels * texels) };
  return builtImage;
}

/**
 * Whether any star could show at an exposure and a star size: the brightest
 * there is, with no air in its way, against the least share of white that is
 * drawn. It needs no catalogue, so by day, when none can, none is loaded.
 */
export function starsCouldShow(view: Pick<StarFieldView, "solarIlluminanceAt1AuLux" | "scale" | "sizePx" | "pixelAngle">): boolean {
  const solidAngle = (view.sizePx * view.pixelAngle) ** 2;
  if (!(solidAngle > 0)) return false;
  const light = starIlluminanceLux(BRIGHTEST_STAR.magnitude, view.solarIlluminanceAt1AuLux) * BRIGHTEST_STAR.tintHeadroom;
  return (light * view.scale) / (solidAngle * starImage().mean) >= VISIBLE_SHARE;
}

/**
 * The stars of the catalogue as one mesh of small squares, each the star's
 * light spread over the square's solid angle, dimmed and coloured by the air
 * on its line of sight, and added to the sky behind it. Unlit, as the dome
 * is: no shader of its own. Positions follow the sky's turning and the
 * field of view; colours follow the light and the exposure.
 */
export function createStarField(scene: Scene): StarField {
  const image = starImage();
  const texture = RawTexture.CreateRGBATexture(image.data, STAR_IMAGE.texels, STAR_IMAGE.texels, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  const material = new StandardMaterial("sky-stars-material", scene);
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
  const mesh = new Mesh("sky-stars", scene);
  mesh.material = material;
  mesh.infiniteDistance = true;
  mesh.ignoreCameraMaxZ = true;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.doNotSyncBoundingInfo = true;
  mesh.isPickable = false;
  mesh.applyFog = false;
  mesh.hasVertexAlpha = false;
  mesh.setEnabled(false);

  let directions: Float32Array | null = null;
  let directionsKey = "";
  let positions = new Float32Array(0);
  let colors = new Float32Array(0);
  let built = 0;

  function build(count: number): void {
    positions = new Float32Array(count * 12);
    colors = new Float32Array(count * 16);
    const uvs = new Float32Array(count * 8);
    const indices = new Uint32Array(count * 6);
    for (let star = 0; star < count; star++) {
      uvs.set([0, 0, 1, 0, 1, 1, 0, 1], star * 8);
      const at = star * 4;
      indices.set([at, at + 1, at + 2, at, at + 2, at + 3], star * 6);
    }
    mesh.setVerticesData(VertexBuffer.PositionKind, positions, true);
    mesh.setVerticesData(VertexBuffer.ColorKind, colors, true, 4);
    mesh.setVerticesData(VertexBuffer.UVKind, uvs, false);
    mesh.setIndices(indices, count * 4);
    built = count;
  }

  return {
    update(view) {
      const started = performance.now();
      const years = Math.round(view.years);
      const key = `${view.limitingMagnitude}/${years}`;
      if (!directions || key !== directionsKey) {
        directions = starDirections(view.catalogue, years, view.limitingMagnitude);
        directionsKey = key;
      }
      const count = directions.length / 3;
      if (count !== built) build(count);
      if (count === 0) {
        mesh.setEnabled(false);
        return { stars: 0, updateMs: performance.now() - started, visible: false };
      }
      const half = (view.sizePx / 2) * view.pixelAngle;
      const solidAngle = (2 * half) ** 2;
      const toValue = view.scale / (solidAngle * image.mean);
      const transmittance: Rgb = [0, 0, 0];
      const up = view.observer.up;
      const altitude = Math.max(0, view.observer.altitudeMeters);
      let brightest = 0;
      for (let star = 0; star < count; star++) {
        const [x, y, z] = applyMatrix3(view.toEcef, directions[star * 3], directions[star * 3 + 1], directions[star * 3 + 2]);
        const d = view.toScene(x, y, z);
        // Two directions across the line of sight, for the square's corners.
        let e1 = Vector3.Cross(d, Math.abs(d.y) < 0.9 ? Vector3.UpReadOnly : Vector3.RightReadOnly).normalize();
        const e2 = Vector3.Cross(d, e1);
        e1 = e1.scaleInPlace(half);
        e2.scaleInPlace(half);
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
        corners.forEach(([s, t], corner) => {
          const at = (star * 4 + corner) * 3;
          positions[at] = (d.x + s * e1.x + t * e2.x) * STAR_RADIUS_METERS;
          positions[at + 1] = (d.y + s * e1.y + t * e2.y) * STAR_RADIUS_METERS;
          positions[at + 2] = (d.z + s * e1.z + t * e2.z) * STAR_RADIUS_METERS;
        });
        // Its light through the air: none below the horizon.
        view.atmosphere.sunTransmittance(altitude, x * up[0] + y * up[1] + z * up[2], transmittance);
        const light = starIlluminanceLux(view.catalogue.vmag[star], view.solarIlluminanceAt1AuLux) * toValue;
        const tint = starTint(view.catalogue.colourIndex[star]);
        const value: Rgb = [light * tint[0] * transmittance[0], light * tint[1] * transmittance[1], light * tint[2] * transmittance[2]];
        brightest = Math.max(brightest, value[0], value[1], value[2]);
        for (let corner = 0; corner < 4; corner++) {
          const at = (star * 4 + corner) * 4;
          colors[at] = value[0] ** (1 / DISPLAY_GAMMA);
          colors[at + 1] = value[1] ** (1 / DISPLAY_GAMMA);
          colors[at + 2] = value[2] ** (1 / DISPLAY_GAMMA);
          colors[at + 3] = 1;
        }
      }
      const visible = brightest >= VISIBLE_SHARE;
      if (visible) {
        mesh.updateVerticesData(VertexBuffer.PositionKind, positions, false, false);
        mesh.updateVerticesData(VertexBuffer.ColorKind, colors, false, false);
      }
      mesh.setEnabled(visible);
      return { stars: count, updateMs: performance.now() - started, visible };
    },
    dispose() {
      mesh.dispose();
      material.dispose();
      texture.dispose();
      directions = null;
    },
  };
}

/** Whether a new pixel angle changes the stars' squares enough to redraw them. */
export function starPixelAngleChanged(previous: number, next: number): boolean {
  return previous === 0 || Math.abs(next - previous) > PIXEL_ANGLE_TOLERANCE * previous;
}
