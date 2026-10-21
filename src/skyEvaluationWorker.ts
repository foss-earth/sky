import type { AtmosphereParameters } from "./atmosphere.js";
import type { AtmosphereNumericKernel, AtmosphereNumericPorts, AtmosphereNumericSnapshot, AtmosphereNumericStatus } from "./atmosphereNumericKernel.js";
import { createSkyEvaluationState, type SkyEvaluationRequest, type SkyEvaluationResult } from "./skyEvaluation.js";
import type { SkyComputeAdmission, SkyComputeLease } from "./computeAdmission.js";

/**
 * Where the sky's evaluation runs, and with which numbers. `typescript`: the
 * reference in the worker, the JavaScript side of an A/B. `single`: the
 * single-threaded WASM core after first-use comparison. `threaded`: the
 * shared-memory WASM core, whose helper threads join the dome's batched fans;
 * without shared memory it falls back to `single`, then to the reference,
 * and says why.
 */
export type SkyEvaluationKernel = "typescript" | "single" | "threaded";

/** The worker's numeric core, already compiled for its own realm. */
export interface SkyNumericCore {
  createTables(parameters: AtmosphereParameters): AtmosphereNumericSnapshot;
  createAtmosphere(snapshot: AtmosphereNumericSnapshot): AtmosphereNumericKernel;
}

/**
 * The shared-memory core's threads and memory, as its host reports them. Its
 * helpers are cooperating threads over one memory, not independent workers.
 */
export interface SkySharedThreadsStatus {
  /** "retired" once a failure abandoned its memory. */
  actual: "threaded" | "retired";
  retiredReason: string | null;
  sharedMemory: boolean;
  crossOriginIsolated: boolean | null;
  memoryBytes: number;
  memoryGrows: boolean;
  stackBytesPerThread: number;
  /** Counts include the coordinator, thread 0. */
  threads: { limit: number; connected: number; ready: number; helpers: Array<{ thread: number; state: string; reason: string | null }> };
  batches: number;
  parallelBatches: number;
  soloBatches: number;
  rows: number;
  directions: number;
  rowsByThread: number[];
  waitMs: number;
  maxWaitMs: number;
  copiedInBytes: number;
  copiedOutBytes: number;
  lastBatch: { mode: "solo" | "parallel"; rows: number; directions: number; steps: number; helpersReady: number; rowsByThread: number[]; ms: number; waitMs: number } | null;
}

/** The shared-memory core, already compiled and instantiated as thread 0 in this worker. */
export interface SkyThreadedCore extends SkyNumericCore {
  /** Change only between evaluations, never while a generation is open. */
  setActiveThreads?(lanes: number): void;
  /** Starts the next helper through its port; false when no slot is left or the core is retired. */
  connectHelper(port: SkyHelperPort): boolean;
  status(): SkySharedThreadsStatus;
  dispose(): void;
}

/** A MessagePort to one helper worker. */
export interface SkyHelperPort {
  postMessage(message: unknown): void;
  addEventListener?(type: "message", listener: (event: { data?: unknown }) => void): void;
  start?(): void;
  close?(): void;
}

/**
 * The helper workers a page started for a threaded sky, owned by its evaluator:
 * `ports` go to the sky worker once, and `terminate` ends every helper.
 */
export interface SkyHelperGroup {
  ports: SkyHelperPort[];
  terminate(): void;
}

export interface SkyEvaluationBackend {
  kernel: SkyEvaluationKernel;
  /** What evaluated the last request: a native build once one of its operations passed its first comparison. */
  actual: "typescript" | "single" | "threaded";
  state: "typescript" | "starting" | "checking" | "ready" | "fallback";
  fallbackReason: string | null;
  /** Fetching and compiling the core, once. */
  startupMs: number | null;
  numeric: AtmosphereNumericStatus | null;
  jobs: number;
  /** The shared-memory core, for a threaded request that started one; null otherwise. */
  threads?: SkySharedThreadsStatus | null;
  /** Threads asked for, the coordinator included; 1 for the single-threaded kernels. */
  requestedThreads?: number;
}

/** `helpers`: one port per helper worker the page started for a threaded request. */
export type SkyEvaluationWorkerRequest = { type: "evaluate"; id: number; request: SkyEvaluationRequest; lanes?: number } | { type: "helpers"; ports: SkyHelperPort[] };
export type SkyEvaluationWorkerReply =
  | { type: "result"; id: number; result: SkyEvaluationResult; backend: SkyEvaluationBackend }
  | { type: "error"; id: number; message: string; backend: SkyEvaluationBackend };

export interface SkyEvaluationWorkerScope {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: SkyEvaluationWorkerReply, transfer: Transferable[]): void;
}

export interface SkyEvaluationWorkerHostOptions {
  scope: SkyEvaluationWorkerScope;
  kernel: SkyEvaluationKernel;
  /** Loads the native core, once, for `single` and as the fallback of `threaded`. Bounded by `startupTimeoutMs`. */
  loadNumericCore?: () => Promise<SkyNumericCore>;
  /** Loads the shared-memory core, once and only for `threaded`; it rejects, with a `reason`, where memory cannot be shared. */
  loadThreadedCore?: () => Promise<SkyThreadedCore>;
  /** Threads asked for, the coordinator included. */
  threads?: number;
  now: () => number;
  timers: { set(callback: () => void, delayMs: number): unknown; clear(handle: unknown): void };
  startupTimeoutMs?: number;
}

/** Answers the page's evaluation requests one at a time, in the order they came. */
export function installSkyEvaluationWorker(options: SkyEvaluationWorkerHostOptions): void {
  const threaded = options.kernel === "threaded";
  const backend: SkyEvaluationBackend = {
    kernel: options.kernel, actual: "typescript", state: options.kernel === "typescript" ? "typescript" : "starting",
    fallbackReason: null, startupMs: null, numeric: null, jobs: 0, threads: null,
    requestedThreads: threaded ? Math.max(1, Math.floor(options.threads ?? 1)) : 1,
  };
  if (threaded && !options.loadThreadedCore) {
    backend.fallbackReason = "threaded-unsupported";
    if (!options.loadNumericCore) backend.state = "fallback";
  }
  let numericPorts: AtmosphereNumericPorts | undefined;
  let threadedCore: SkyThreadedCore | null = null;
  // Helper ports that came before the core: connected once it starts, closed if it does not.
  const waitingPorts: SkyHelperPort[] = [];
  const connect = (ports: SkyHelperPort[]): void => {
    for (const port of ports) {
      let used = false;
      try { used = threadedCore?.connectHelper(port) ?? false; } catch { used = false; }
      if (!used) { try { port.close?.(); } catch { /* Already closed. */ } }
    }
  };
  const bounded = async <T>(load: () => Promise<T>): Promise<T> => {
    let timer: unknown = null;
    try {
      return await Promise.race([
        load(),
        new Promise<never>((_, reject) => { timer = options.timers.set(() => reject(new Error("startup-timeout")), options.startupTimeoutMs ?? 5000); }),
      ]);
    } finally { if (timer !== null) options.timers.clear(timer); }
  };
  const reasonOf = (error: unknown, fallback: string): string => error instanceof Error && error.message === "startup-timeout" ? "startup-timeout"
    : error && typeof error === "object" && "reason" in error && typeof error.reason === "string" ? error.reason : fallback;
  let starting: Promise<void> | null = null;
  const start = (): Promise<void> => starting ??= (async () => {
    if (options.kernel === "typescript") return;
    const started = options.now();
    if (threaded && options.loadThreadedCore) {
      try {
        const core = await bounded(options.loadThreadedCore);
        threadedCore = core;
        backend.startupMs = options.now() - started;
        numericPorts = {
          execution: "worker", kind: "threaded",
          createKernel: snapshot => core.createAtmosphere(snapshot),
          createTables: parameters => core.createTables(parameters),
        };
        backend.state = "checking";
        connect(waitingPorts.splice(0));
        return;
      } catch (error) {
        // The single core is the next rung; its reason stays on the backend.
        backend.fallbackReason = reasonOf(error, "threaded-startup-failed");
      }
    }
    // No shared core: waiting helper ports are closed.
    connect(waitingPorts.splice(0));
    if (!options.loadNumericCore) { backend.state = "fallback"; backend.fallbackReason ??= "native-core-unavailable"; return; }
    try {
      const core = await bounded(options.loadNumericCore);
      backend.startupMs = options.now() - started;
      numericPorts = {
        execution: "worker",
        createKernel: snapshot => core.createAtmosphere(snapshot),
        createTables: parameters => core.createTables(parameters),
      };
      backend.state = "checking";
    } catch (error) {
      backend.startupMs = options.now() - started;
      backend.state = "fallback";
      const reason = reasonOf(error, "startup-failed");
      backend.fallbackReason = backend.fallbackReason ? `${backend.fallbackReason}; ${reason}` : reason;
    }
  })();
  let state: ReturnType<typeof createSkyEvaluationState> | null = null;
  let queue = Promise.resolve();
  const snapshot = (): SkyEvaluationBackend => ({ ...backend, numeric: backend.numeric && structuredCopy(backend.numeric), threads: backend.threads && structuredCopy(backend.threads) });
  options.scope.addEventListener("message", event => {
    const message = event.data as SkyEvaluationWorkerRequest;
    if (message?.type === "helpers" && Array.isArray(message.ports)) {
      // Before the core starts they wait for it; afterwards they join it, or are closed without one.
      if (threaded && !starting) waitingPorts.push(...message.ports);
      else void (starting ?? Promise.resolve()).then(() => connect(message.ports));
      return;
    }
    if (!message || message.type !== "evaluate" || !Number.isSafeInteger(message.id)) return;
    queue = queue.then(async () => {
      try {
        await start();
        if (message.lanes !== undefined) {
          if (!Number.isSafeInteger(message.lanes) || message.lanes < 1) throw new Error("Invalid sky admission width.");
          if (threadedCore && !threadedCore.setActiveThreads && message.lanes < (options.threads ?? 1)) throw new Error("Shared sky core cannot honor admission width.");
          threadedCore?.setActiveThreads?.(message.lanes);
        }
        state ??= createSkyEvaluationState({ now: options.now, numericPorts });
        const { result, transfer } = state.evaluate(message.request);
        backend.jobs += 1;
        backend.numeric = result.numeric;
        if (threadedCore) backend.threads = threadedCore.status();
        if (result.numeric) {
          backend.actual = result.numeric.actual;
          if (result.numeric.state === "fallback" || result.numeric.state === "disposed") {
            backend.state = "fallback";
            backend.fallbackReason = result.numeric.fallbackReason ?? backend.fallbackReason;
          } else backend.state = result.numeric.state;
        } else if (threadedCore && backend.threads?.actual === "retired") {
          backend.state = "fallback";
          backend.fallbackReason = `shared-core-retired: ${backend.threads.retiredReason}`;
        }
        options.scope.postMessage({ type: "result", id: message.id, result, backend: snapshot() }, transfer);
      } catch (error) {
        options.scope.postMessage({ type: "error", id: message.id, message: error instanceof Error ? error.message : String(error), backend: snapshot() }, []);
      }
    });
  });
}

/** A plain copy: the status objects hold only data. */
function structuredCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The page's handle on a sky worker. */
export interface SkyEvaluationWorkerPort {
  readonly compute?: SkyComputeAdmission;
  postMessage(message: SkyEvaluationWorkerRequest, transfer?: unknown[]): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: { data?: unknown; message?: string }) => void): void;
  terminate(): void;
}

export interface SkyEvaluatorStatus {
  placement: "worker";
  kernel: SkyEvaluationKernel;
  /** idle/busy while usable; failed once the worker is retired. */
  state: "idle" | "busy" | "failed" | "disposed";
  failure: string | null;
  /** Whether a worker was ever created: none until the first evaluation. */
  started: boolean;
  backend: SkyEvaluationBackend | null;
  jobs: number;
  lastJob: { roundTripMs: number; workMs: number; tablesMs: number; illuminationMs: number; domeMs: number; starsMs?: number; starInputBytes?: number; transferBytes: number } | null;
  totals: { roundTripMs: number; workMs: number };
}

/** Evaluates the sky away from the page; the runtime keeps at most one request outstanding. */
export interface SkyEvaluator {
  evaluate(request: SkyEvaluationRequest, ownership?: { signal?: AbortSignal; isCurrent?(): boolean }): Promise<SkyEvaluationResult>;
  status(): SkyEvaluatorStatus;
  dispose(): void;
}

export interface SkyWorkerEvaluatorOptions {
  /** Created on the first evaluation; null where workers are unavailable. */
  createWorker(): SkyEvaluationWorkerPort | null;
  kernel: SkyEvaluationKernel;
  now: () => number;
  timers: { set(callback: () => void, delayMs: number): unknown; clear(handle: unknown): void };
  /** The first request includes starting the worker, compiling a core and comparing it. */
  firstTimeoutMs?: number;
  timeoutMs?: number;
  /**
   * For a threaded kernel: starts helper workers once, with the sky worker.
   * Null where memory cannot be shared or no worker is left; the sky worker
   * then runs without helpers. They are terminated with the evaluator, and as
   * soon as a reply shows no shared core is running.
   */
  createHelpers?(): SkyHelperGroup | null;
}

export function createSkyWorkerEvaluator(options: SkyWorkerEvaluatorOptions): SkyEvaluator {
  const status: SkyEvaluatorStatus = {
    placement: "worker", kernel: options.kernel, state: "idle", failure: null, started: false, backend: null, jobs: 0,
    lastJob: null, totals: { roundTripMs: 0, workMs: 0 },
  };
  let worker: SkyEvaluationWorkerPort | null = null;
  let helpers: SkyHelperGroup | null = null;
  const endHelpers = (): void => {
    const ended = helpers;
    helpers = null;
    try { ended?.terminate(); } catch { /* Already gone. */ }
  };
  let nextId = 0;
  let pending: { id: number; sent: number; starInputBytes: number; resolve(result: SkyEvaluationResult): void; reject(error: unknown): void; timer: unknown; abort: AbortController; lease?: SkyComputeLease; signal?: AbortSignal; isCurrent?(): boolean; onAbort(): void } | null = null;
  const retire = (reason: string, nextState: "failed" | "disposed"): void => {
    if (status.state === "failed" || status.state === "disposed") return;
    status.state = nextState;
    if (nextState === "failed") status.failure = reason;
    const current = pending;
    pending = null;
    if (current) { current.signal?.removeEventListener("abort", current.onAbort); if (current.timer !== null) options.timers.clear(current.timer); current.abort.abort(); current.reject(new Error(reason)); }
    const retired = worker;
    worker = null;
    try { retired?.terminate(); } finally { endHelpers(); current?.lease?.release("retired"); }
  };
  const onMessage = (event: { data?: unknown }): void => {
    const reply = event.data as SkyEvaluationWorkerReply;
    if (!pending || !reply || reply.id !== pending.id) return;
    const current = pending;
    pending = null;
    options.timers.clear(current.timer);
    current.signal?.removeEventListener("abort", current.onAbort);
    current.lease?.release(current.signal?.aborted || current.isCurrent?.() === false ? "stale" : reply.type === "error" ? "failed" : "useful");
    status.backend = reply.backend;
    // A sky that fell back, or whose shared core retired, leaves its helpers idle or stopped.
    if (helpers && reply.backend && reply.backend.state !== "starting" && reply.backend.threads?.actual !== "threaded") endHelpers();
    if (reply.type === "error") { retire(`worker-error: ${reply.message}`, "failed"); current.reject(new Error(reply.message)); return; }
    const result = reply.result;
    const roundTripMs = options.now() - current.sent;
    const transferBytes = [result.tables?.transmittance, result.tables?.multipleScattering, result.tables?.groundIrradiance, result.groundTable,
      result.dome?.directions, result.dome?.luminances, result.stars?.ecef, result.stars?.transmittance, result.stars?.colors?.rgb].reduce((sum, array) => sum + (array?.byteLength ?? 0), 0);
    status.jobs += 1;
    status.lastJob = { roundTripMs, workMs: result.timing.workMs, tablesMs: result.timing.tablesMs, illuminationMs: result.timing.illuminationMs,
      domeMs: result.timing.domeMs, starsMs: result.timing.starsMs ?? 0, starInputBytes: current.starInputBytes, transferBytes };
    status.totals.roundTripMs += roundTripMs;
    status.totals.workMs += result.timing.workMs;
    status.state = "idle";
    current.resolve(result);
  };
  return {
    evaluate(request, ownership = {}) {
      if (ownership.signal?.aborted) return Promise.reject(ownership.signal.reason);
      if (status.state === "failed" || status.state === "disposed") return Promise.reject(new Error(status.failure ?? "Sky evaluator disposed."));
      if (pending) return Promise.reject(new Error("Sky evaluator already has a request outstanding."));
      if (!worker) {
        try { worker = options.createWorker(); } catch { worker = null; }
        if (!worker) { retire("worker-unavailable", "failed"); return Promise.reject(new Error("worker-unavailable")); }
        status.started = true;
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", event => retire(`worker-failed: ${event.message ?? "error"}`, "failed"));
        worker.addEventListener("messageerror", () => retire("worker-message-error", "failed"));
        if (options.kernel === "threaded" && options.createHelpers) {
          try { helpers = options.createHelpers(); } catch { helpers = null; }
          if (helpers && helpers.ports.length) {
            try { worker.postMessage({ type: "helpers", ports: helpers.ports }, helpers.ports); } catch { endHelpers(); }
          } else endHelpers();
        }
      }
      const id = ++nextId;
      status.state = "busy";
      return new Promise<SkyEvaluationResult>((resolve, reject) => {
        const timeout = status.jobs === 0 ? options.firstTimeoutMs ?? 15000 : options.timeoutMs ?? 5000;
        const stars = request.stars;
        const catalogue = stars && "generation" in stars ? stars.catalogue : null;
        const starInputBytes = catalogue ? catalogue.directions.byteLength + catalogue.vmag.byteLength + catalogue.colourIndex.byteLength
          : stars && "directions" in stars ? stars.directions.byteLength : 0;
        const current = { id, sent: 0, starInputBytes, resolve, reject, timer: null as unknown, abort: new AbortController(), lease: undefined as SkyComputeLease | undefined,
          ...ownership, onAbort() {
            // Dispatched synchronous work keeps its team until the actual reply.
            // A queued obsolete generation can settle without retiring workers.
            if (current.timer !== null || pending !== current) return;
            pending = null; status.state = "idle"; current.abort.abort(ownership.signal?.reason);
            ownership.signal?.removeEventListener("abort", current.onAbort); reject(ownership.signal?.reason);
          } };
        pending = current;
        ownership.signal?.addEventListener("abort", current.onAbort, { once: true });
        const dispatch = (lease?: SkyComputeLease): void => {
          if (pending !== current) { lease?.release("stale"); return; }
          current.lease = lease; current.sent = options.now();
          current.timer = options.timers.set(() => retire("worker-timeout", "failed"), timeout);
          try { worker!.postMessage({ type: "evaluate", id, request, ...(lease ? { lanes: lease.lanes } : {}) }); }
          catch (error) { retire(`worker-post-failed: ${error instanceof Error ? error.message : String(error)}`, "failed"); }
        };
        // Acquire the entire cooperating team at once; no coordinator permit
        // is held while helpers wait. The core enforces this generation's width.
        if (worker!.compute) void worker!.compute.acquire({ lanes: 1 + (helpers?.ports.length ?? 0), signal: current.abort.signal }).then(dispatch,
          () => { if (pending === current) retire("compute-admission-ended", "disposed"); });
        else dispatch();
      });
    },
    status: () => ({ ...status, backend: status.backend && { ...status.backend }, lastJob: status.lastJob && { ...status.lastJob }, totals: { ...status.totals } }),
    dispose: () => retire("disposed", "disposed"),
  };
}
