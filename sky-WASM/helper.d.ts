export interface SharedSkyHelperStart {
  kind: "sky-shared-start";
  abi: 1;
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  thread: number;
  control: number;
  stackTop: number;
}
/** Runs one helper thread until the coordinator stops it; blocks this worker. Returns why it stopped. */
export interface SharedSkyHelperHooks {
  onReady?(): void;
  /** Tests only: runs after a helper wakes for `epoch` and before it joins. */
  beforeJoin?(state: { control: Int32Array; memory: WebAssembly.Memory; thread: number; epoch: number }): void;
  /** Tests only: replaces the realm's Math imports. */
  imports?: Record<"exp" | "log" | "sqrt" | "sin" | "cos" | "pow", (value: number, other?: number) => number>;
}
export function runSkySharedHelper(start: SharedSkyHelperStart, options?: SharedSkyHelperHooks): string;
/** Waits for the page's `{ kind: "sky-shared-port", port }`, then for the coordinator's start message on that port. */
export function installSkySharedHelper(scope?: { addEventListener(type: "message", listener: (event: { data?: unknown }) => void): void; removeEventListener(type: "message", listener: (event: { data?: unknown }) => void): void }, hooks?: Omit<SharedSkyHelperHooks, "onReady">): void;
