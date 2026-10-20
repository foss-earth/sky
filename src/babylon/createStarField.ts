import { Color3, Constants, Material, Mesh, RawTexture, StandardMaterial, Texture, VertexBuffer, type Scene, type Vector3 } from "@babylonjs/core";
import type { Atmosphere, Rgb } from "../atmosphere.js";
import type { SkyObserver } from "../skyState.js";
import type { StarAtmosphereResult } from "../starAtmosphere.js";
import { starDirections, starIlluminanceLux, starTint, type Matrix3, type StarCatalogue } from "../stars.js";
import { DISPLAY_GAMMA } from "../units.js";
import { cleanupAll } from "./cleanup.js";

/** The stars' radius, m: the dome's, past every far plane. */
const STAR_RADIUS_METERS = 1e10;
/** The texture each star's light is spread over: a Gaussian across a square, sides in texels and its width in half-sides. */
const STAR_IMAGE = { texels: 32, sigma: 0.4 } as const;
/** A star's square's corners, in its two directions across the line of sight. */
const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1] as const;
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
  /** Samples for exactly this catalogue selection, matrix, observer and atmosphere; absent uses the synchronous reference. */
  atmosphereBatch?: StarAtmosphereResult | null;
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
  /** Where the heading-independent atmosphere samples were evaluated. */
  atmosphere?: "page" | "worker";
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

/** Exact mean of the display-encoded Gaussian, shared with worker colour requests. */
export function starImageMean(): number { return starImage().mean; }

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
export function createStarField(scene: Scene, options: { clock(): number }): StarField {
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
  let disposed = false;
  // What does not change for a star while its catalogue and the Sun's light do not: its tint, and its light above the air.
  let lightOf: { catalogue: StarCatalogue; solarIlluminanceAt1AuLux: number; stars: number } | null = null;
  let tints = new Float64Array(0);
  let lux = new Float64Array(0);
  const transmittance: Rgb = [0, 0, 0];
  let colorState: { inputs: number[]; atmosphere: Atmosphere; catalogue: StarCatalogue; directions: Float32Array; batch: StarAtmosphereResult | null; brightest: number } | null = null;

  function build(count: number): void {
    positions = new Float32Array(count * 12);
    colors = new Float32Array(count * 16);
    const uvs = new Float32Array(count * 8);
    const indices = new Uint32Array(count * 6);
    for (let star = 0; star < count; star++) {
      const uv = star * 8;
      uvs[uv + 2] = 1; uvs[uv + 4] = 1; uvs[uv + 5] = 1; uvs[uv + 7] = 1;
      const at = star * 4, index = star * 6;
      indices[index] = at; indices[index + 1] = at + 1; indices[index + 2] = at + 2;
      indices[index + 3] = at; indices[index + 4] = at + 2; indices[index + 5] = at + 3;
    }
    mesh.setVerticesData(VertexBuffer.PositionKind, positions, true);
    mesh.setVerticesData(VertexBuffer.ColorKind, colors, true, 4);
    mesh.setVerticesData(VertexBuffer.UVKind, uvs, false);
    mesh.setIndices(indices, count * 4);
    built = count;
  }

  return {
    update(view) {
      if (disposed) return { stars: 0, updateMs: 0, visible: false };
      const started = options.clock();
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
        return { stars: 0, updateMs: options.clock() - started, visible: false };
      }
      const half = (view.sizePx / 2) * view.pixelAngle;
      const solidAngle = (2 * half) ** 2;
      const toValue = view.scale / (solidAngle * image.mean);
      const batch = view.atmosphereBatch ?? null;
      const batchEcef = batch?.ecef.length === directions.length ? batch.ecef : null;
      const workerColors = batch?.colors?.rgb.length === directions.length && Object.is(batch.colors.toValue, toValue) ? batch.colors : null;
      const workerTransmittance = batchEcef && batch?.transmittance.length === directions.length;
      const evaluated = workerColors || workerTransmittance ? "worker" : "page";
      // No star can reach the share drawn at this exposure, whatever the air: the field would not be drawn,
      // so its squares and colours, and the air on each star's line of sight, are not worked out.
      if (!starsCouldShow(view)) {
        mesh.setEnabled(false);
        return { stars: count, updateMs: options.clock() - started, visible: false, atmosphere: evaluated };
      }
      const up = view.observer.up;
      const altitude = Math.max(0, view.observer.altitudeMeters);
      const { catalogue, solarIlluminanceAt1AuLux } = view;
      if (!lightOf || lightOf.catalogue !== catalogue || !Object.is(lightOf.solarIlluminanceAt1AuLux, solarIlluminanceAt1AuLux) || lightOf.stars < count) {
        tints = new Float64Array(count * 3);
        lux = new Float64Array(count);
        for (let star = 0; star < count; star++) {
          const tint = starTint(catalogue.colourIndex[star]);
          tints[star * 3] = tint[0]; tints[star * 3 + 1] = tint[1]; tints[star * 3 + 2] = tint[2];
          lux[star] = starIlluminanceLux(catalogue.vmag[star], solarIlluminanceAt1AuLux);
        }
        lightOf = { catalogue, solarIlluminanceAt1AuLux, stars: count };
      }
      const m = view.toEcef;
      const colorInputs = [altitude, ...up, ...m, toValue, solarIlluminanceAt1AuLux];
      const reuseColors = colorState && colorState.atmosphere === view.atmosphere && colorState.catalogue === catalogue
        && colorState.directions === directions && colorState.batch === batch && colorInputs.every((value, index) => Object.is(value, colorState!.inputs[index]));
      let brightest = reuseColors ? colorState!.brightest : workerColors ? workerColors.brightest : 0;
      // Babylon's Vector3.Cross, normalize and scaleInPlace, written out with their operations in their order.
      for (let star = 0; star < count; star++) {
        const sx = directions[star * 3], sy = directions[star * 3 + 1], sz = directions[star * 3 + 2];
        const x = batchEcef ? batchEcef[star * 3] : m[0] * sx + m[1] * sy + m[2] * sz;
        const y = batchEcef ? batchEcef[star * 3 + 1] : m[3] * sx + m[4] * sy + m[5] * sz;
        const z = batchEcef ? batchEcef[star * 3 + 2] : m[6] * sx + m[7] * sy + m[8] * sz;
        const d = view.toScene(x, y, z);
        const dx = d.x, dy = d.y, dz = d.z;
        // Two directions across the line of sight, for the square's corners: e1 = d × (up, or right near the poles), normalized, and e2 = d × e1.
        const across = Math.abs(dy) < 0.9;
        const rx = across ? 0 : 1, ry = across ? 1 : 0, rz = 0;
        let ax = dy * rz - dz * ry, ay = dz * rx - dx * rz, az = dx * ry - dy * rx;
        const length = Math.sqrt(ax * ax + ay * ay + az * az);
        if (!(length === 0 || length === 1.0)) {
          const inverse = 1.0 / length;
          ax *= inverse; ay *= inverse; az *= inverse;
        }
        let bx = dy * az - dz * ay, by = dz * ax - dx * az, bz = dx * ay - dy * ax;
        ax *= half; ay *= half; az *= half;
        bx *= half; by *= half; bz *= half;
        for (let corner = 0; corner < 4; corner++) {
          const s = CORNERS[corner * 2], t = CORNERS[corner * 2 + 1];
          const at = (star * 4 + corner) * 3;
          positions[at] = (dx + s * ax + t * bx) * STAR_RADIUS_METERS;
          positions[at + 1] = (dy + s * ay + t * by) * STAR_RADIUS_METERS;
          positions[at + 2] = (dz + s * az + t * bz) * STAR_RADIUS_METERS;
        }
        // Scene rotation affects positions only. Keep the exact last colour values and avoid new atmosphere/gamma work.
        if (reuseColors) continue;
        if (workerColors) {
          for (let corner = 0; corner < 4; corner++) {
            const at = (star * 4 + corner) * 4;
            colors[at] = workerColors.rgb[star * 3]; colors[at + 1] = workerColors.rgb[star * 3 + 1];
            colors[at + 2] = workerColors.rgb[star * 3 + 2]; colors[at + 3] = 1;
          }
          continue;
        }
        // Its light through the air: none below the horizon.
        if (batch && workerTransmittance) {
          transmittance[0] = batch.transmittance[star * 3];
          transmittance[1] = batch.transmittance[star * 3 + 1];
          transmittance[2] = batch.transmittance[star * 3 + 2];
        } else view.atmosphere.sunTransmittance(altitude, x * up[0] + y * up[1] + z * up[2], transmittance);
        const light = lux[star] * toValue;
        const v0 = light * tints[star * 3] * transmittance[0];
        const v1 = light * tints[star * 3 + 1] * transmittance[1];
        const v2 = light * tints[star * 3 + 2] * transmittance[2];
        brightest = Math.max(brightest, v0, v1, v2);
        const c0 = v0 ** (1 / DISPLAY_GAMMA), c1 = v1 ** (1 / DISPLAY_GAMMA), c2 = v2 ** (1 / DISPLAY_GAMMA);
        for (let corner = 0; corner < 4; corner++) {
          const at = (star * 4 + corner) * 4;
          colors[at] = c0; colors[at + 1] = c1; colors[at + 2] = c2; colors[at + 3] = 1;
        }
      }
      if (!reuseColors) colorState = { inputs: colorInputs, atmosphere: view.atmosphere, catalogue, directions, batch, brightest };
      const visible = brightest >= VISIBLE_SHARE;
      if (visible) {
        mesh.updateVerticesData(VertexBuffer.PositionKind, positions, false, false);
        if (!reuseColors) mesh.updateVerticesData(VertexBuffer.ColorKind, colors, false, false);
      }
      mesh.setEnabled(visible);
      return { stars: count, updateMs: options.clock() - started, visible, atmosphere: evaluated };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      directions = null;
      lightOf = null;
      colorState = null;
      tints = new Float64Array(0);
      lux = new Float64Array(0);
      positions = new Float32Array(0);
      colors = new Float32Array(0);
      cleanupAll("Sky star field disposal failed.", [
        () => mesh.dispose(),
        () => material.dispose(),
        () => texture.dispose(),
      ]);
    },
  };
}

/** Whether a new pixel angle changes the stars' squares enough to redraw them. */
export function starPixelAngleChanged(previous: number, next: number): boolean {
  return previous === 0 || Math.abs(next - previous) > PIXEL_ANGLE_TOLERANCE * previous;
}
