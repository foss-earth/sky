import { SUN_LENS, sunDiscSamples } from "./lensFlareModel.js";

const size = SUN_LENS.probeSize;
export const DISC_SAMPLES = sunDiscSamples();

// One pixel reduces the depth-tested disc. RG stores an exact integer count,
// so the reported CPU fraction and the fraction drawn by the GPU agree.
export const visibilityGlsl = `precision highp float;
uniform sampler2D depthSampler;
uniform sampler2D maskSampler;
void main() {
  float count = 0.0;
  for (int y = 0; y < ${size}; y++) for (int x = 0; x < ${size}; x++) {
    vec2 uv = (vec2(float(x), float(y)) + 0.5) / ${size}.0;
    vec4 d = texture2D(depthSampler, uv);
    float clear = step(0.999, min(min(d.r, d.g), min(d.b, d.a)));
    count += clear * step(0.5, texture2D(maskSampler, uv).r);
  }
  gl_FragColor = vec4(mod(count, 256.0) / 255.0, floor(count / 256.0) / 255.0, 0.0, 1.0);
}`;

export const visibilityWgsl = `
var depthSamplerSampler: sampler; var depthSampler: texture_2d<f32>;
var maskSamplerSampler: sampler; var maskSampler: texture_2d<f32>;
@fragment fn main(input: FragmentInputs) -> FragmentOutputs {
  var count = 0.0;
  for (var y = 0; y < ${size}; y++) { for (var x = 0; x < ${size}; x++) {
    let d = textureLoad(depthSampler, vec2i(x, y), 0);
    let clear = step(0.999, min(min(d.r, d.g), min(d.b, d.a)));
    count += clear * step(0.5, textureLoad(maskSampler, vec2i(x, y), 0).r);
  }}
  fragmentOutputs.color = vec4f((count % 256.0) / 255.0, floor(count / 256.0) / 255.0, 0.0, 1.0);
}`;

export const quadVertexGlsl = `precision highp float;
attribute vec3 position; attribute vec2 uv; attribute vec3 color;
varying vec2 vUV; varying vec3 vEnergy;
void main() { gl_Position = vec4(position, 1.0); vUV = uv; vEnergy = color; }`;
export const quadFragmentGlsl = `precision highp float;
uniform sampler2D imageSampler; uniform sampler2D visibilitySampler; uniform float ready;
varying vec2 vUV; varying vec3 vEnergy;
void main() {
  vec2 count = texture2D(visibilitySampler, vec2(0.5)).rg * 255.0;
  float visible = (count.x + 256.0 * count.y) / ${DISC_SAMPLES.length}.0;
  float kernel = dot(texture2D(imageSampler, vUV).rgb, vec3(1.0, 1.0 / 255.0, 1.0 / 65025.0));
  gl_FragColor = vec4(pow(clamp(kernel * vEnergy * visible * ready, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;
export const quadVertexWgsl = `attribute position: vec3f; attribute uv: vec2f; attribute color: vec3f;
varying vUV: vec2f; varying vEnergy: vec3f;
@vertex fn main(input: VertexInputs) -> FragmentInputs {
  vertexOutputs.position = vec4f(vertexInputs.position, 1.0);
  vertexOutputs.vUV = vertexInputs.uv; vertexOutputs.vEnergy = vertexInputs.color;
}`;
export const quadFragmentWgsl = `
var imageSamplerSampler: sampler; var imageSampler: texture_2d<f32>;
var visibilitySamplerSampler: sampler; var visibilitySampler: texture_2d<f32>;
uniform ready: f32; varying vUV: vec2f; varying vEnergy: vec3f;
@fragment fn main(input: FragmentInputs) -> FragmentOutputs {
  let count = textureLoad(visibilitySampler, vec2i(0, 0), 0).rg * 255.0;
  let visible = (count.x + 256.0 * count.y) / ${DISC_SAMPLES.length}.0;
  let kernel = dot(textureSample(imageSampler, imageSamplerSampler, input.vUV).rgb, vec3f(1.0, 1.0 / 255.0, 1.0 / 65025.0));
  fragmentOutputs.color = vec4f(pow(clamp(kernel * input.vEnergy * visible * uniforms.ready, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), 1.0);
}`;
