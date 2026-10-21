import type { AtmosphereNumericKernel, AtmosphereSnapshot, Rgb } from "./index.js";

export type SharedMemorySupport = { supported: boolean; reason: string | null; crossOriginIsolated: boolean | null };
/** Whether this realm can share WebAssembly memory: a browser needs cross-origin isolation. */
export function sharedMemorySupport(): SharedMemorySupport;
/** Fetches and compiles shared/sky-shared.wasm once; worker realms only. */
export function loadSharedSkyModule(): Promise<WebAssembly.Module>;

export interface SharedSkyKernel extends AtmosphereNumericKernel {
  readonly kind: "threaded";
  /** Several rows' fans; false, having written nothing, outside the shared bounds. */
  radianceFanRows(altitudeMeters: number, muSun: number, rows: number, mus: Float64Array, counts: Uint32Array, nus: Float64Array,
    steps: number, out: Float64Array): "solo" | "parallel" | false;
}
export interface SharedSkyCoreStatus {
  actual: "threaded" | "retired";
  retiredReason: string | null;
  sharedMemory: true;
  crossOriginIsolated: boolean | null;
  memoryBytes: number;
  memoryGrows: false;
  stackBytesPerThread: number;
  threads: { limit: number; connected: number; ready: number; helpers: Array<{ thread: number; state: string; reason: string | null }> };
  batches: number; parallelBatches: number; soloBatches: number; rows: number; directions: number; rowsByThread: number[];
  waitMs: number; maxWaitMs: number; copiedInBytes: number; copiedOutBytes: number;
  lastBatch: { mode: "solo" | "parallel"; rows: number; directions: number; steps: number; helpersReady: number; rowsByThread: number[]; ms: number; waitMs: number } | null;
}
export interface SharedHelperPort {
  postMessage(message: unknown): void;
  addEventListener?(type: "message", listener: (event: { data?: unknown }) => void): void;
  start?(): void;
}
export interface SharedSkyCore {
  setActiveThreads(lanes: number): void;
  readonly actualTier: "threaded";
  readonly validationStatus: "unvalidated";
  readonly memory: WebAssembly.Memory;
  readonly module: WebAssembly.Module;
  connectHelper(port: SharedHelperPort): boolean;
  /** Bounded Atomics.wait; worker realms only. */
  waitForHelpers(count: number, timeoutMs: number): boolean;
  status(): SharedSkyCoreStatus;
  stackUse(): number[];
  retire(reason: string): void;
  dispose(): void;
  createTables(parameters: { aerosolOpticalDepth: number; groundAlbedo: number }): AtmosphereSnapshot;
  /** One model at a time: a later atmosphere's tables replace this one's, and it then refuses work. */
  createAtmosphere(snapshot: AtmosphereSnapshot): SharedSkyKernel;
}
export interface SharedSkyCoreOptions {
  /** Helper threads besides the coordinator, at most 7. */
  helpers?: number;
  now?: () => number;
  /** Bounds on waiting for helpers' rows: the first parallel batch, then each. */
  firstDeadlineMs?: number;
  deadlineMs?: number;
  /** Directions × steps below which a batch stays on the coordinator. */
  minParallelWork?: number;
  onRetire?(reason: string): void;
}
/** Creates the shared memory and instantiates thread 0 in this worker. Throws, with `reason`, where memory cannot be shared. */
export function createSharedSkyCore(module: WebAssembly.Module, options?: SharedSkyCoreOptions): SharedSkyCore;
export type { Rgb };
