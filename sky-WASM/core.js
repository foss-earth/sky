const TRANS_LEN = 128 * 64 * 3, MULTIPLE_LEN = 33 * 24 * 3, GROUND_LEN = 48 * 3;
const SNAPSHOT_LEN = 2 + TRANS_LEN + MULTIPLE_LEN + GROUND_LEN;
const MAX_STEPS = 4096, MAX_DIRECTIONS = 4096, MAX_STEP_DIRECTIONS = 1048576;
const MAX_MEMORY = 256 * 1024 * 1024;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x0a0b0c0d]).buffer)[0] === 0x0d;
const FUNCTIONS = ["sky_abi_version", "sky_alloc_f64", "sky_free_f64", "sky_model_create", "sky_model_drop", "sky_model_build", "sky_model_snapshot", "sky_radiance", "sky_radiance_fan", "sky_irradiance"];

export function requireWorkerRealm() {
  if (typeof document !== "undefined" || typeof window !== "undefined") throw new Error("WASM sky kernels must run in a worker, never a browser page");
}
const finite = values => values.every(value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12);
const stepsOf = value => {
  if (!Number.isFinite(value)) throw new RangeError("WASM sky steps must be finite");
  const steps = Math.max(1, Math.round(value));
  if (steps > MAX_STEPS) throw new RangeError("WASM sky steps exceed 4096");
  return steps;
};
function statusError(status) {
  return new Error(`WASM sky operation failed (${String(status)}: ${({ 1: "invalid or over-budget numeric input", 3: "wrong output length", 5: "invalid allocation/model or reentrant access" })[status] ?? "unknown status"})`);
}
function writeDoubles(buffer, pointer, data) {
  if (LITTLE_ENDIAN) new Float64Array(buffer, pointer, data.length).set(data);
  else { const view = new DataView(buffer, pointer, data.length * 8); for (let i = 0; i < data.length; i++) view.setFloat64(i * 8, data[i], true); }
}
function readDoubles(buffer, pointer, length) {
  if (LITTLE_ENDIAN) return new Float64Array(new Float64Array(buffer, pointer, length));
  const out = new Float64Array(length), view = new DataView(buffer, pointer, length * 8);
  for (let i = 0; i < length; i++) out[i] = view.getFloat64(i * 8, true);
  return out;
}
/** Internal ABI adapter: owned registry buffers, no retained linear-memory views. */
export function createSkyCore(exports) {
  requireWorkerRealm();
  for (const name of FUNCTIONS) if (typeof exports?.[name] !== "function") throw new Error(`Invalid WASM sky ABI: missing ${name}`);
  if (!(exports.memory instanceof WebAssembly.Memory) || exports.sky_abi_version() !== 1) throw new Error("Invalid WASM sky memory/ABI version");
  const buffer = () => {
    const current = exports.memory.buffer;
    if (!(current instanceof ArrayBuffer) || current.byteLength === 0 || current.byteLength > MAX_MEMORY) throw new Error("WASM sky requires unshared memory bounded at 256 MiB");
    return current;
  };
  const span = (pointer, length) => {
    const current = buffer(), bytes = length * 8;
    if (!Number.isSafeInteger(pointer) || pointer <= 0 || pointer > 0xffffffff || pointer % 8 || pointer > current.byteLength || bytes > current.byteLength - pointer) throw new Error("Invalid WASM sky buffer allocation");
    return current;
  };
  let busy = false;
  function withBuffers(inputs, outputLength, run) {
    requireWorkerRealm();
    if (busy) throw new Error("WASM sky instance cannot be reentered");
    busy = true;
    const allocated = []; let failed = false, failure;
    try {
      const lengths = [...inputs.map(data => data.length), ...(outputLength ? [outputLength] : [])];
      for (const length of lengths) {
        if (!Number.isSafeInteger(length) || length < 1 || length > 65536) throw new RangeError("WASM sky buffer length exceeds its ABI bound");
        const pointer = exports.sky_alloc_f64(length);
        // Retain any valid owned allocation for finally even when span checks fail.
        if (!Number.isSafeInteger(pointer) || pointer <= 0 || pointer > 0xffffffff) throw new Error("WASM sky allocation failed");
        allocated.push({ pointer, length }); span(pointer, length);
      }
      const current = buffer();
      for (let i = 0; i < allocated.length; i++) {
        const a = allocated[i]; span(a.pointer, a.length);
        for (let j = 0; j < i; j++) { const b = allocated[j]; if (a.pointer < b.pointer + b.length * 8 && b.pointer < a.pointer + a.length * 8) throw new Error("WASM sky allocations overlap"); }
        if (i < inputs.length) writeDoubles(current, a.pointer, inputs[i]);
      }
      const result = run(allocated.map(allocation => allocation.pointer));
      if (!outputLength) return result;
      if (result !== 0) throw statusError(result);
      const output = allocated.at(-1); const values = readDoubles(span(output.pointer, output.length), output.pointer, output.length);
      if (!values.every(Number.isFinite)) throw new Error("WASM sky returned nonfinite radiance");
      return values;
    } catch (error) { failed = true; failure = error; throw error; }
    finally {
      const errors = [];
      for (const { pointer, length } of allocated.reverse()) {
        try { const status = exports.sky_free_f64(pointer, length); if (status !== 0) throw statusError(status); }
        catch (error) { errors.push(error); }
      }
      busy = false;
      if (errors.length) throw new AggregateError(failed ? [failure, ...errors] : errors, "WASM sky operation/buffer cleanup failed", failed ? { cause: failure } : undefined);
    }
  }
  buffer();
  return {
    actualTier: "single",
    validationStatus: "unvalidated",
    createTables(parameters) {
      requireWorkerRealm();
      const aerosol = Math.max(0, parameters?.aerosolOpticalDepth), albedo = Math.min(1, Math.max(0, parameters?.groundAlbedo));
      if (!finite([aerosol, albedo])) throw new RangeError("Invalid WASM sky atmosphere parameters");
      if (busy) throw new Error("WASM sky instance cannot be reentered");
      let model = 0, failed = false, failure;
      try {
        busy = true;
        try { model = exports.sky_model_build(aerosol, albedo); }
        finally { busy = false; }
        if (!Number.isSafeInteger(model) || model <= 0 || model > 0xffffffff) { model = 0; throw new Error("WASM sky table construction failed"); }
        const packed = withBuffers([], SNAPSHOT_LEN, ([output]) => exports.sky_model_snapshot(model, output, SNAPSHOT_LEN));
        let offset = 2;
        const transmittance = new Float32Array(packed.subarray(offset, offset + TRANS_LEN)); offset += TRANS_LEN;
        const multipleScattering = new Float32Array(packed.subarray(offset, offset + MULTIPLE_LEN)); offset += MULTIPLE_LEN;
        const groundIrradiance = new Float32Array(packed.subarray(offset, offset + GROUND_LEN));
        return { aerosolOpticalDepth: packed[0], groundAlbedo: packed[1], transmittance, multipleScattering, groundIrradiance };
      } catch (error) { failed = true; failure = error; throw error; }
      finally {
        if (model) {
          try { const status = exports.sky_model_drop(model); if (status !== 0) throw statusError(status); }
          catch (cleanup) { throw new AggregateError(failed ? [failure, cleanup] : [cleanup], "WASM sky table build/model cleanup failed", failed ? { cause: failure } : undefined); }
        }
      }
    },
    createAtmosphere(snapshot) {
      requireWorkerRealm();
      const tables = [snapshot?.transmittance, snapshot?.multipleScattering, snapshot?.groundIrradiance];
      const lengths = [TRANS_LEN, MULTIPLE_LEN, GROUND_LEN];
      if (!finite([snapshot?.aerosolOpticalDepth, snapshot?.groundAlbedo]) || snapshot.aerosolOpticalDepth < 0 || snapshot.groundAlbedo < 0 || snapshot.groundAlbedo > 1
        || tables.some((table, index) => !(table instanceof Float32Array) || table.length !== lengths[index] || !table.every(Number.isFinite))) throw new Error("Invalid WASM sky atmosphere table snapshot");
      const packed = new Float64Array(SNAPSHOT_LEN); packed[0] = snapshot.aerosolOpticalDepth; packed[1] = snapshot.groundAlbedo;
      let offset = 2; for (const table of tables) { packed.set(table, offset); offset += table.length; }
      let model = 0;
      try {
        withBuffers([packed], 0, ([pointer]) => {
          model = exports.sky_model_create(pointer, packed.length);
          if (!Number.isSafeInteger(model) || model <= 0 || model > 0xffffffff) { model = 0; throw new Error("WASM sky model allocation/snapshot failed"); }
          return model;
        });
      } catch (error) {
        if (model) { try { const status = exports.sky_model_drop(model); if (status !== 0) throw statusError(status); } catch (cleanup) { throw new AggregateError([error, cleanup], "WASM sky model setup and cleanup failed", { cause: error }); } }
        throw error;
      }
      let disposed = false;
      const active = () => { requireWorkerRealm(); if (disposed) throw new Error("WASM sky atmosphere disposed"); };
      const copyRgb = (values, out) => { out[0] = values[0]; out[1] = values[1]; out[2] = values[2]; return out; };
      return {
        radiance(altitude, mu, muSun, nu, steps, out) {
          active(); if (!finite([altitude, mu, muSun, nu])) throw new RangeError("Invalid WASM sky ray input");
          const count = stepsOf(steps);
          return copyRgb(withBuffers([], 3, ([output]) => exports.sky_radiance(model, altitude, mu, muSun, nu, count, output, 3)), out);
        },
        radianceFan(altitude, mu, muSun, nus, count, steps, out) {
          active();
          const integrationSteps = stepsOf(steps);
          if (!finite([altitude, mu, muSun]) || !Number.isSafeInteger(count) || count < 0 || count > MAX_DIRECTIONS || count * integrationSteps > MAX_STEP_DIRECTIONS
            || !(nus instanceof Float64Array) || nus.length < count || !(out instanceof Float64Array) || out.length < count * 3 || !finite(nus.subarray(0, count))) throw new RangeError("Invalid or over-budget WASM sky fan input");
          if (count === 0) return;
          const values = withBuffers([nus.subarray(0, count)], count * 3, ([input, output]) => exports.sky_radiance_fan(model, altitude, mu, muSun, input, count, integrationSteps, output, count * 3));
          out.set(values, 0);
        },
        skyIrradiance(altitude, muSun, out) {
          active(); if (!finite([altitude, muSun])) throw new RangeError("Invalid WASM sky irradiance input");
          return copyRgb(withBuffers([], 3, ([output]) => exports.sky_irradiance(model, altitude, muSun, output, 3)), out);
        },
        dispose() {
          if (disposed) return; requireWorkerRealm(); if (busy) throw new Error("WASM sky instance is busy");
          const status = exports.sky_model_drop(model); if (status !== 0) throw statusError(status);
          disposed = true;
        },
      };
    },
  };
}
