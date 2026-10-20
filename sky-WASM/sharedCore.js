import { requireWorkerRealm } from "./core.js";
import {
  CANARY, CANARY_BYTES, CONTROL, FIELD, MAX_THREADS, MEMORY_PAGES, SHARED_ABI_VERSION, STACK_BYTES, STATUS, THREAD_STACK_BYTES,
  mathImports, stackBase, stackTop,
} from "./threads.js";

const TRANS_LEN = 128 * 64 * 3, MULTIPLE_LEN = 33 * 24 * 3, GROUND_LEN = 48 * 3;
const MAX_STEPS = 4096, MAX_DIRECTIONS = 4096, MAX_STEP_DIRECTIONS = 1048576;
const FUNCTIONS = ["sky_shared_abi_version", "sky_shared_layout", "sky_shared_build", "sky_shared_commit", "sky_shared_model",
  "sky_shared_radiance", "sky_shared_irradiance", "sky_shared_prepare", "sky_shared_fan_claimed"];
const finite = values => values.every(value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12);
const stepsOf = value => {
  if (!Number.isFinite(value)) throw new RangeError("Native sky steps must be finite");
  const steps = Math.max(1, Math.round(value));
  if (steps > MAX_STEPS) throw new RangeError("Native sky steps exceed 4096");
  return steps;
};
const statusName = status => ({ 1: "invalid input", 2: "no current model", 3: "outside the shared bounds", 4: "invalid thread", 100: "a helper trapped" })[status] ?? "unknown status";

/**
 * Whether this realm can share WebAssembly memory with workers: a browser
 * needs cross-origin isolation for SharedArrayBuffer; Node has it always.
 */
export function sharedMemorySupport() {
  const crossOriginIsolated = typeof globalThis.crossOriginIsolated === "boolean" ? globalThis.crossOriginIsolated : null;
  if (typeof SharedArrayBuffer !== "function") return { supported: false, reason: crossOriginIsolated === false ? "not-cross-origin-isolated" : "shared-array-buffer-unavailable", crossOriginIsolated };
  if (typeof Atomics?.wait !== "function") return { supported: false, reason: "atomics-wait-unavailable", crossOriginIsolated };
  try {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    if (!(memory.buffer instanceof SharedArrayBuffer)) return { supported: false, reason: "shared-memory-unavailable", crossOriginIsolated };
  } catch { return { supported: false, reason: "shared-memory-unavailable", crossOriginIsolated }; }
  return { supported: true, reason: null, crossOriginIsolated };
}

let compiling;
/** Fetches and compiles the shared module once; no instance or memory yet. */
export function loadSharedSkyModule() {
  requireWorkerRealm();
  compiling ??= (async () => {
    const response = await fetch(new URL("./shared/sky-shared.wasm", import.meta.url));
    if (!response.ok) throw new Error(`Native shared sky WASM fetch failed (${response.status})`);
    return WebAssembly.compile(await response.arrayBuffer());
  })();
  return compiling;
}

/**
 * The coordinator of a shared sky core: creates the shared memory, instantiates
 * thread 0 first (its start function initialises the memory once), and hands
 * helpers the module, memory and their stack slots. Thread 0 runs on its host's
 * worker and waits for helpers with bounded Atomics.wait; it must not be a page.
 *
 * One model at a time: a new atmosphere's tables replace the last one's, and
 * a kernel whose model was replaced refuses further work.
 *
 * Any helper failure, timeout or stack overwrite retires the whole core: a
 * helper that is late may still write its claimed rows, so the memory is never
 * reused. Retired calls throw; the caller keeps its reference path.
 */
export function createSharedSkyCore(module, options = {}) {
  requireWorkerRealm();
  const support = sharedMemorySupport();
  if (!support.supported) throw Object.assign(new Error(`Shared sky memory unavailable: ${support.reason}`), { reason: support.reason });
  if (!(module instanceof WebAssembly.Module)) throw new TypeError("Shared sky core needs a compiled WebAssembly.Module");
  const now = options.now ?? (() => performance.now());
  const firstDeadlineMs = options.firstDeadlineMs ?? 2000;
  const deadlineMs = options.deadlineMs ?? 1000;
  /** Smaller batches stay on thread 0: waking helpers would cost more than it saves. */
  const minParallelWork = options.minParallelWork ?? 4096;
  const helperLimit = Math.max(0, Math.min(MAX_THREADS - 1, Math.floor(options.helpers ?? MAX_THREADS - 1)));
  const memory = new WebAssembly.Memory({ initial: MEMORY_PAGES, maximum: MEMORY_PAGES, shared: true });
  const { exports } = new WebAssembly.Instance(module, { env: { memory }, sky_math: mathImports() });
  for (const name of FUNCTIONS) if (typeof exports[name] !== "function") throw new Error(`Invalid shared sky ABI: missing ${name}`);
  if (exports.sky_shared_abi_version() !== SHARED_ABI_VERSION || !(exports.__stack_pointer instanceof WebAssembly.Global) || exports.__stack_pointer.value !== STACK_BYTES) {
    throw new Error("Invalid shared sky ABI version or stack layout");
  }
  const at = field => exports.sky_shared_layout(field);
  const layout = {
    control: at(FIELD.CONTROL), job: at(FIELD.JOB), rows: at(FIELD.ROWS), nus: at(FIELD.NUS), out: at(FIELD.OUT),
    transmittance: at(FIELD.TRANSMITTANCE), multiple: at(FIELD.MULTIPLE), ground: at(FIELD.GROUND), result: at(FIELD.RESULT),
    maxThreads: at(FIELD.MAX_THREADS), maxRows: at(FIELD.MAX_ROWS), maxNus: at(FIELD.MAX_NUS), maxSteps: at(FIELD.MAX_SHARED_STEPS),
  };
  if (layout.maxThreads !== MAX_THREADS || at(FIELD.CONTROL_WORDS) !== CONTROL.WORDS || at(FIELD.JOB_BYTES) !== 32 || at(FIELD.ROW_BYTES) !== 16
    || [layout.job, layout.rows, layout.nus, layout.out, layout.result].some(pointer => pointer % 8 || pointer < STACK_BYTES)
    || layout.out + layout.maxNus * 24 > memory.buffer.byteLength) throw new Error("Shared sky layout does not match its host");
  const buffer = memory.buffer;
  const ctl = new Int32Array(buffer, layout.control, CONTROL.WORDS);
  const jobF64 = new Float64Array(buffer, layout.job, 2), jobU32 = new Uint32Array(buffer, layout.job + 16, 4);
  const rowF64 = new Float64Array(buffer, layout.rows, layout.maxRows * 2), rowU32 = new Uint32Array(buffer, layout.rows, layout.maxRows * 4);
  const nusView = new Float64Array(buffer, layout.nus, layout.maxNus), outView = new Float64Array(buffer, layout.out, layout.maxNus * 3);
  const result = new Float64Array(buffer, layout.result, 3);
  const tableViews = [new Float32Array(buffer, layout.transmittance, TRANS_LEN), new Float32Array(buffer, layout.multiple, MULTIPLE_LEN), new Float32Array(buffer, layout.ground, GROUND_LEN)];
  const stacks = new Int32Array(buffer, 0, STACK_BYTES / 4);
  // Every slot holds the pattern until something runs on it.
  stacks.fill(CANARY);

  let retired = null, busy = false, epoch = 0, connected = 0, liveKernel = null;
  const helpers = [];
  const stats = {
    batches: 0, parallelBatches: 0, soloBatches: 0, rows: 0, directions: 0, rowsByThread: new Array(MAX_THREADS).fill(0),
    waitMs: 0, maxWaitMs: 0, lastBatch: null, copiedInBytes: 0, copiedOutBytes: 0,
  };

  const ready = () => { let count = 0; for (let t = 1; t <= connected; t++) if (Atomics.load(ctl, CONTROL.READY + t) === 1) count++; return count; };
  function retire(reason) {
    if (retired) return;
    retired = reason;
    Atomics.store(ctl, CONTROL.STOP, 1);
    Atomics.store(ctl, CONTROL.OPEN, 0);
    Atomics.add(ctl, CONTROL.EPOCH, 1);
    Atomics.notify(ctl, CONTROL.EPOCH);
    liveKernel = null;
    options.onRetire?.(reason);
  }
  const active = () => { requireWorkerRealm(); if (retired) throw Object.assign(new Error(`Shared sky core retired: ${retired}`), { reason: retired }); if (busy) throw new Error("Shared sky core cannot be reentered"); };
  /** Bands at the bottom of each slot that ran must be intact. */
  function canariesIntact(threads) {
    for (let t = 0; t < threads; t++) {
      const base = stackBase(t) / 4;
      for (let i = base; i < base + CANARY_BYTES / 4; i++) if (stacks[i] !== CANARY) return false;
    }
    return true;
  }
  function callThread0(run) {
    exports.__stack_pointer.value = STACK_BYTES;
    try { return run(); }
    catch (error) { retire("coordinator-trapped"); throw Object.assign(error instanceof Error ? error : new Error(String(error)), { reason: "coordinator-trapped" }); }
    finally { if (!retired && !canariesIntact(1)) retire("stack-canary"); }
  }
  /** Waits, bounded, until `index` leaves `value`'s condition; false at the deadline. */
  function waitUntil(done, index, deadline) {
    for (;;) {
      const current = Atomics.load(ctl, index);
      if (done(current)) return true;
      const left = deadline - now();
      if (left <= 0) return false;
      Atomics.wait(ctl, index, current, Math.min(left, 50));
    }
  }
  /** Rows already written into the job area: validate, publish, compute, gather. */
  function runRows(rows, total, steps) {
    const status = exports.sky_shared_prepare();
    if (status !== STATUS.OK) throw Object.assign(new RangeError(`Shared sky batch rejected: ${statusName(status)}`), { status });
    const helpersReady = ready();
    const parallel = helpersReady > 0 && rows >= 2 && total * steps >= minParallelWork;
    const started = now();
    if (parallel) {
      epoch = (epoch + 1) | 0 || 1;
      Atomics.store(ctl, CONTROL.OPEN, epoch);
      Atomics.store(ctl, CONTROL.EPOCH, epoch);
      Atomics.notify(ctl, CONTROL.EPOCH);
    }
    const own = callThread0(() => exports.sky_shared_fan_claimed(0));
    let waited = 0;
    if (parallel) {
      const computed = now();
      const deadline = computed + (stats.parallelBatches === 0 ? firstDeadlineMs : deadlineMs);
      const finished = waitUntil(done => done === rows || Atomics.load(ctl, CONTROL.ERROR) !== 0, CONTROL.ROWS_DONE, deadline);
      Atomics.store(ctl, CONTROL.OPEN, 0);
      const left = finished && waitUntil(count => count === 0, CONTROL.ACTIVE, now() + deadlineMs);
      waited = now() - computed;
      if (!finished) { retire("helper-timeout"); throw Object.assign(new Error("Shared sky helpers missed their deadline"), { reason: "helper-timeout" }); }
      if (!left) { retire("helper-leave-timeout"); throw Object.assign(new Error("Shared sky helpers did not leave their generation"), { reason: "helper-leave-timeout" }); }
      if (!canariesIntact(1 + connected)) { retire("stack-canary"); throw Object.assign(new Error("A shared sky stack overflowed its slot"), { reason: "stack-canary" }); }
    }
    const error = Atomics.load(ctl, CONTROL.ERROR);
    if (error !== 0 || own !== STATUS.OK) {
      // Every participant validates the same job, so a disagreement is a fault.
      const reason = error === STATUS.TRAP ? "helper-trapped" : `batch-status-${error || own}`;
      retire(reason);
      throw Object.assign(new Error(`Shared sky batch failed: ${statusName(error || own)}`), { status: error || own, reason });
    }
    if (Atomics.load(ctl, CONTROL.ROWS_DONE) !== rows) { retire("rows-incomplete"); throw Object.assign(new Error("Shared sky batch is incomplete"), { reason: "rows-incomplete" }); }
    const byThread = [];
    for (let t = 0; t < MAX_THREADS; t++) { const count = Atomics.load(ctl, CONTROL.ROWS_BY + t); byThread.push(count); stats.rowsByThread[t] += count; }
    stats.batches++; parallel ? stats.parallelBatches++ : stats.soloBatches++;
    stats.rows += rows; stats.directions += total; stats.waitMs += waited; stats.maxWaitMs = Math.max(stats.maxWaitMs, waited);
    stats.lastBatch = { mode: parallel ? "parallel" : "solo", rows, directions: total, steps, helpersReady, rowsByThread: byThread, ms: now() - started, waitMs: waited };
    return parallel ? "parallel" : "solo";
  }
  function writeJob(altitude, muSun, rows, total, steps, generation) {
    jobF64[0] = altitude; jobF64[1] = muSun;
    jobU32[0] = rows; jobU32[1] = steps; jobU32[2] = total; jobU32[3] = generation;
  }
  function commitTables(aerosol, albedo, tables) {
    for (let i = 0; i < 3; i++) tableViews[i].set(tables[i]);
    const status = callThread0(() => exports.sky_shared_commit(aerosol, albedo));
    if (status !== STATUS.OK) throw new Error(`Shared sky tables rejected: ${statusName(status)}`);
    return exports.sky_shared_model();
  }

  const core = {
    actualTier: "threaded",
    validationStatus: "unvalidated",
    memory, module,
    /** Hands the next helper slot its start message through `port`, or returns false when none is left. */
    connectHelper(port) {
      if (retired || connected >= helperLimit) return false;
      const thread = ++connected;
      const record = { thread, state: "starting", reason: null };
      helpers.push(record);
      port.addEventListener?.("message", event => {
        if (event.data?.kind === "sky-shared-ready") record.state = "ready";
        else if (event.data?.kind === "sky-shared-stopped") { record.state = "stopped"; record.reason = event.data.reason ?? null; }
      });
      port.start?.();
      port.postMessage({ kind: "sky-shared-start", abi: SHARED_ABI_VERSION, module, memory, thread, control: layout.control, stackTop: stackTop(thread) });
      return true;
    },
    /** Waits, bounded and only on a worker, until `count` helpers are ready. */
    waitForHelpers(count, timeoutMs) {
      const deadline = now() + timeoutMs;
      for (let t = 1; t <= Math.min(count, connected); t++) {
        if (!waitUntil(value => value === 1, CONTROL.READY + t, deadline)) return false;
      }
      return true;
    },
    status() {
      return {
        actual: retired ? "retired" : "threaded", retiredReason: retired,
        sharedMemory: true, crossOriginIsolated: support.crossOriginIsolated, memoryBytes: buffer.byteLength, memoryGrows: false,
        stackBytesPerThread: THREAD_STACK_BYTES,
        threads: { limit: 1 + helperLimit, connected: 1 + connected, ready: 1 + ready(), helpers: helpers.map(helper => ({ ...helper })) },
        ...stats, rowsByThread: [...stats.rowsByThread], lastBatch: stats.lastBatch && { ...stats.lastBatch, rowsByThread: [...stats.lastBatch.rowsByThread] },
      };
    },
    /** The lowest stack address each slot has reached, as bytes used; for tests and reports. */
    stackUse() {
      const use = [];
      for (let t = 0; t < MAX_THREADS; t++) {
        const base = stackBase(t) / 4, top = stackTop(t) / 4;
        let lowest = top;
        for (let i = base; i < top; i++) if (stacks[i] !== CANARY) { lowest = i; break; }
        use.push((top - lowest) * 4);
      }
      return use;
    },
    retire,
    dispose() { retire("disposed"); },
    createTables(parameters) {
      active();
      const aerosol = Math.max(0, parameters?.aerosolOpticalDepth), albedo = Math.min(1, Math.max(0, parameters?.groundAlbedo));
      if (!finite([aerosol, albedo])) throw new RangeError("Invalid native sky atmosphere parameters");
      busy = true;
      try {
        liveKernel = null;
        const status = callThread0(() => exports.sky_shared_build(aerosol, albedo));
        if (status !== STATUS.OK) throw new Error("Native shared sky table construction failed");
        return { aerosolOpticalDepth: aerosol, groundAlbedo: albedo, transmittance: tableViews[0].slice(), multipleScattering: tableViews[1].slice(), groundIrradiance: tableViews[2].slice() };
      } finally { busy = false; }
    },
    createAtmosphere(snapshot) {
      active();
      const tables = [snapshot?.transmittance, snapshot?.multipleScattering, snapshot?.groundIrradiance];
      const lengths = [TRANS_LEN, MULTIPLE_LEN, GROUND_LEN];
      if (!finite([snapshot?.aerosolOpticalDepth, snapshot?.groundAlbedo]) || snapshot.aerosolOpticalDepth < 0 || snapshot.groundAlbedo < 0 || snapshot.groundAlbedo > 1
        || tables.some((table, index) => !(table instanceof Float32Array) || table.length !== lengths[index] || !table.every(Number.isFinite))) throw new Error("Invalid native sky atmosphere table snapshot");
      busy = true;
      let generation;
      try { generation = commitTables(snapshot.aerosolOpticalDepth, snapshot.groundAlbedo, tables); }
      finally { busy = false; }
      let disposed = false;
      const kernel = {};
      liveKernel = kernel;
      const use = () => {
        active();
        if (disposed) throw new Error("Native sky atmosphere disposed");
        if (liveKernel !== kernel || exports.sky_shared_model() !== generation) throw new Error("Native shared sky model was replaced");
      };
      const rgb = (status, out) => {
        if (status !== STATUS.OK) throw new Error(`Native shared sky operation failed: ${statusName(status)}`);
        if (!(Number.isFinite(result[0]) && Number.isFinite(result[1]) && Number.isFinite(result[2]))) throw new Error("Native sky returned nonfinite radiance");
        out[0] = result[0]; out[1] = result[1]; out[2] = result[2];
        return out;
      };
      const run = (work) => { busy = true; try { return work(); } finally { busy = false; } };
      Object.assign(kernel, {
        kind: "threaded",
        radiance(altitude, mu, muSun, nu, steps, out) {
          use(); if (!finite([altitude, mu, muSun, nu])) throw new RangeError("Invalid native sky ray input");
          const count = stepsOf(steps);
          return run(() => rgb(callThread0(() => exports.sky_shared_radiance(altitude, mu, muSun, nu, count)), out));
        },
        skyIrradiance(altitude, muSun, out) {
          use(); if (!finite([altitude, muSun])) throw new RangeError("Invalid native sky irradiance input");
          return run(() => rgb(callThread0(() => exports.sky_shared_irradiance(altitude, muSun)), out));
        },
        /** One fan, on thread 0. */
        radianceFan(altitude, mu, muSun, nus, count, steps, out) {
          use();
          const integrationSteps = stepsOf(steps);
          if (!finite([altitude, mu, muSun]) || !Number.isSafeInteger(count) || count < 0 || count > MAX_DIRECTIONS || count * integrationSteps > MAX_STEP_DIRECTIONS
            || integrationSteps > layout.maxSteps || !(nus instanceof Float64Array) || nus.length < count || !(out instanceof Float64Array) || out.length < count * 3
            || !finite(nus.subarray(0, count))) throw new RangeError("Invalid or over-budget native sky fan input");
          if (count === 0) return;
          run(() => {
            nusView.set(nus.subarray(0, count));
            rowF64[0] = mu; rowU32[2] = 0; rowU32[3] = count;
            writeJob(altitude, muSun, 1, count, integrationSteps, generation);
            runRows(1, count, integrationSteps);
            out.set(outView.subarray(0, count * 3));
          });
        },
        /**
         * Fans of several rows: row r looks along mus[r] with counts[r]
         * directions, whose nus and outputs follow the previous row's. Returns
         * false, having written nothing, for a batch outside the shared bounds;
         * otherwise "parallel" or "solo".
         */
        radianceFanRows(altitude, muSun, rows, mus, counts, nus, steps, out) {
          use();
          const integrationSteps = stepsOf(steps);
          if (!finite([altitude, muSun]) || !Number.isSafeInteger(rows) || rows < 1 || !(mus instanceof Float64Array) || !(counts instanceof Uint32Array)
            || mus.length < rows || counts.length < rows || !(nus instanceof Float64Array) || !(out instanceof Float64Array)) throw new RangeError("Invalid native sky fan rows");
          let total = 0;
          for (let r = 0; r < rows; r++) {
            const count = counts[r];
            if (count < 1 || count > MAX_DIRECTIONS || count * integrationSteps > MAX_STEP_DIRECTIONS) return false;
            total += count;
          }
          if (rows > layout.maxRows || total > layout.maxNus || integrationSteps > layout.maxSteps) return false;
          if (nus.length < total || out.length < total * 3) throw new RangeError("Native sky fan rows are shorter than their counts");
          if (!finite(mus.subarray(0, rows)) || !finite(nus.subarray(0, total))) throw new RangeError("Invalid native sky fan rows");
          return run(() => {
            nusView.set(nus.subarray(0, total));
            let start = 0;
            for (let r = 0; r < rows; r++) { rowF64[r * 2] = mus[r]; rowU32[r * 4 + 2] = start; rowU32[r * 4 + 3] = counts[r]; start += counts[r]; }
            writeJob(altitude, muSun, rows, total, integrationSteps, generation);
            const mode = runRows(rows, total, integrationSteps);
            out.set(outView.subarray(0, total * 3));
            stats.copiedInBytes += total * 8 + rows * 16; stats.copiedOutBytes += total * 24;
            return mode;
          });
        },
        dispose() { if (disposed) return; disposed = true; if (liveKernel === kernel) liveKernel = null; },
      });
      return kernel;
    },
  };
  return core;
}
