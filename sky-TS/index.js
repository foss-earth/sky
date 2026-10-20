/**
 * The TypeScript sky core: the reference that sky-WASM's single and
 * shared-memory builds must match bit for bit. Its source stays in src/, where
 * the rest of the sky uses it: src/atmosphere.ts builds the tables and evaluates
 * radiance and irradiance, and src/skyEvaluation.ts is the evaluation a sky
 * worker runs, with either core behind its numeric ports.
 */
export { ATMOSPHERE, atmosphereTables, createAtmosphere, createAtmosphereFromTables, createSkyEvaluationState } from "@foss-earth/sky";
