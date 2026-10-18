import { afterEach, describe, expect, it, vi } from "vitest";
import type { AtmosphereParameters } from "./atmosphere.js";
import type { AtmosphereNumericSnapshot } from "./atmosphereNumericKernel.js";
import type { PrecomputedAtmosphereTables } from "./precomputedAtmosphereTables.js";
import { SKY_PARAMETERS } from "./settings.js";

const PRECOMPUTED = "./precomputedAtmosphereTables.js";
const REGENERATE = "to regenerate them: npm run generate:atmosphere-tables -- src/precomputedAtmosphereTables.ts";

/** createAtmosphere from a fresh atmosphere.ts that has these precomputed tables, or the committed ones. */
async function createAtmosphereWith(precomputed?: readonly PrecomputedAtmosphereTables[]) {
  vi.resetModules();
  if (precomputed) vi.doMock(PRECOMPUTED, () => ({ PRECOMPUTED_ATMOSPHERE_TABLES: precomputed }));
  else vi.doUnmock(PRECOMPUTED);
  return (await import("./atmosphere.js")).createAtmosphere;
}

/** The tables an atmosphere is built with, as a numeric kernel is handed them. None is started. */
function tablesOf(create: Awaited<ReturnType<typeof createAtmosphereWith>>, parameters: AtmosphereParameters): AtmosphereNumericSnapshot {
  let tables: AtmosphereNumericSnapshot | undefined;
  create(parameters, undefined, {
    execution: "worker",
    createKernel(snapshot) { tables = snapshot; throw new Error("Only the tables are wanted."); },
  });
  return tables!;
}

const decode = (base64: string): Float32Array => {
  const bytes = Buffer.from(base64, "base64");
  return Float32Array.from({ length: bytes.length / 4 }, (_, index) => bytes.readFloatLE(index * 4));
};
const encode = (table: Float32Array): string => {
  const bytes = Buffer.alloc(table.length * 4);
  table.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes.toString("base64");
};
const setting = (id: string): number => SKY_PARAMETERS.find(parameter => parameter.id === id)!.default as number;

afterEach(() => {
  vi.doUnmock(PRECOMPUTED);
  vi.resetModules();
});

describe("the precomputed atmosphere tables", () => {
  it("are the settings' default atmosphere's", async () => {
    const { PRECOMPUTED_ATMOSPHERE_TABLES } = await vi.importActual<typeof import("./precomputedAtmosphereTables.js")>(PRECOMPUTED);
    expect(PRECOMPUTED_ATMOSPHERE_TABLES.map(({ aerosolOpticalDepth, groundAlbedo }) => ({ aerosolOpticalDepth, groundAlbedo })), `Their parameters, ${REGENERATE}`).toEqual([{
      aerosolOpticalDepth: setting("sky.atmosphere.aerosolOpticalDepth"),
      groundAlbedo: setting("sky.atmosphere.groundAlbedo"),
    }]);
  });

  it("are, bit for bit, what createAtmosphere builds without them", async () => {
    const { PRECOMPUTED_ATMOSPHERE_TABLES } = await vi.importActual<typeof import("./precomputedAtmosphereTables.js")>(PRECOMPUTED);
    const built = await createAtmosphereWith([]);
    for (const precomputed of PRECOMPUTED_ATMOSPHERE_TABLES) {
      const tables = tablesOf(built, precomputed);
      for (const key of ["multipleScattering", "groundIrradiance"] as const) {
        const kept = decode(precomputed[key]);
        expect(kept.length, `${key}'s length, ${REGENERATE}`).toBe(tables[key].length);
        expect(tables[key].findIndex((value, index) => !Object.is(value, kept[index])), `${key}'s first different value, ${REGENERATE}`).toBe(-1);
      }
    }
  });

  it("are what an atmosphere of exactly their parameters starts from, and of no other", async () => {
    const reference = tablesOf(await createAtmosphereWith([]), { aerosolOpticalDepth: 0.1, groundAlbedo: 0.2 });
    // Tables no build would make, to tell them from built ones.
    const marked = { multipleScattering: reference.multipleScattering.map(() => -1), groundIrradiance: reference.groundIrradiance.map(() => -2) };
    const create = await createAtmosphereWith([{
      aerosolOpticalDepth: 0.1, groundAlbedo: 0.2,
      multipleScattering: encode(marked.multipleScattering), groundIrradiance: encode(marked.groundIrradiance),
    }, {
      // A table of another length is not used.
      aerosolOpticalDepth: 0.3, groundAlbedo: 0.2,
      multipleScattering: encode(marked.multipleScattering.subarray(3)), groundIrradiance: encode(marked.groundIrradiance),
    }]);
    const used = tablesOf(create, { aerosolOpticalDepth: 0.1, groundAlbedo: 0.2 });
    expect(used.multipleScattering).toEqual(marked.multipleScattering);
    expect(used.groundIrradiance).toEqual(marked.groundIrradiance);
    // The transmittance is built as before.
    expect(used.transmittance).toEqual(reference.transmittance);
    for (const parameters of [{ aerosolOpticalDepth: 0.1, groundAlbedo: 0.21 }, { aerosolOpticalDepth: 0.1 + 1e-12, groundAlbedo: 0.2 }, { aerosolOpticalDepth: 0.3, groundAlbedo: 0.2 }]) {
      const tables = tablesOf(create, parameters);
      expect(tables.multipleScattering.some(value => value === -1), JSON.stringify(parameters)).toBe(false);
      expect(tables.groundIrradiance.some(value => value === -2), JSON.stringify(parameters)).toBe(false);
    }
  });

  it("give the default atmosphere the light it gives when it builds them", async () => {
    const parameters = { aerosolOpticalDepth: 0.1, groundAlbedo: 0.2 };
    const precomputed = (await createAtmosphereWith())(parameters);
    const built = (await createAtmosphereWith([]))(parameters);
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [0, 0, 0];
    for (const muSun of [1, 0.5, 0.1, 0, -0.1, -0.3]) {
      for (const mu of [1, 0.2, 0, -0.2]) {
        expect(precomputed.radiance(1000, mu, muSun, 0.3, 16, a)).toEqual(built.radiance(1000, mu, muSun, 0.3, 16, b));
      }
      expect(precomputed.skyIrradiance(0, muSun, a)).toEqual(built.skyIrradiance(0, muSun, b));
      expect(precomputed.groundSkyIrradiance(muSun, a)).toEqual(built.groundSkyIrradiance(muSun, b));
    }
  });
});
