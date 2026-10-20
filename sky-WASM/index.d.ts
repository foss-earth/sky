export interface AtmosphereSnapshot {
  aerosolOpticalDepth: number;
  groundAlbedo: number;
  transmittance: Float32Array;
  multipleScattering: Float32Array;
  groundIrradiance: Float32Array;
}
export type Rgb = [number, number, number];
export interface AtmosphereNumericKernel {
  radiance(altitudeMeters: number, mu: number, muSun: number, nu: number, steps: number, out: Rgb): Rgb;
  radianceFan(altitudeMeters: number, mu: number, muSun: number, nus: Float64Array, count: number, steps: number, out: Float64Array): void;
  skyIrradiance(altitudeMeters: number, muSun: number, out: Rgb): Rgb;
  dispose(): void;
}
export interface SkyCore {
  readonly actualTier: "single";
  readonly validationStatus: "unvalidated";
  /** Builds all three tables in Rust and returns owned copies; transient model is freed. */
  createTables(parameters: { aerosolOpticalDepth: number; groundAlbedo: number }): AtmosphereSnapshot;
  /** Copies all tables. The caller owns the returned model and must dispose it. */
  createAtmosphere(snapshot: AtmosphereSnapshot): AtmosphereNumericKernel;
}
/** Lazy loading; rejected in a browser page. No JavaScript fallback in this package. */
export function loadSkyCore(): Promise<SkyCore>;
/** Executes only with the current worker realm's Math imports, without Rust libm. */
export function instantiateSkyCore(bytes: ArrayBuffer | ArrayBufferView): Promise<SkyCore>;
