import { CONTROL, MAX_THREADS, SHARED_ABI_VERSION, STATUS, mathImports, stackTop } from "./threads.js";

/**
 * A helper thread of the shared sky core: its own instance of the coordinator's
 * module over the coordinator's memory, with its own stack slot. It joins each
 * published generation, claims rows until none are left, and waits again. It
 * blocks its own worker with Atomics.wait; it must never run on a page.
 * Returns why it stopped. Terminating its worker is always safe: rows it had
 * claimed are never completed, and the coordinator retires the whole memory.
 * `beforeJoin` and `imports` exist for the adversarial tests only.
 */
export function runSkySharedHelper(start, { onReady, beforeJoin, imports } = {}) {
  if (typeof document !== "undefined" || typeof window !== "undefined") throw new Error("Sky helper threads must run in a worker, never a browser page");
  const { module, memory, thread, control } = start ?? {};
  if (!(module instanceof WebAssembly.Module) || !(memory instanceof WebAssembly.Memory) || !(memory.buffer instanceof SharedArrayBuffer)
    || !Number.isSafeInteger(thread) || thread < 1 || thread >= MAX_THREADS || start.abi !== SHARED_ABI_VERSION) {
    throw new Error("Invalid sky helper start message");
  }
  // The start function initialises memory once; later instances only wait for it.
  const { exports } = new WebAssembly.Instance(module, { env: { memory }, sky_math: imports ?? mathImports() });
  if (exports.sky_shared_abi_version() !== SHARED_ABI_VERSION || exports.sky_shared_layout(0) !== control || !(exports.__stack_pointer instanceof WebAssembly.Global)) {
    throw new Error("Sky helper module does not match its coordinator");
  }
  const top = stackTop(thread);
  const ctl = new Int32Array(memory.buffer, control, CONTROL.WORDS);
  let seen = Atomics.load(ctl, CONTROL.EPOCH);
  Atomics.store(ctl, CONTROL.READY + thread, 1);
  Atomics.notify(ctl, CONTROL.READY + thread);
  onReady?.();
  let reason = "stopped";
  for (;;) {
    Atomics.wait(ctl, CONTROL.EPOCH, seen);
    if (Atomics.load(ctl, CONTROL.STOP) !== 0) break;
    const epoch = Atomics.load(ctl, CONTROL.EPOCH);
    if (epoch === seen) continue;
    seen = epoch;
    beforeJoin?.({ control: ctl, memory, thread, epoch });
    // Join before checking the generation is still open: the coordinator
    // closes it before waiting for ACTIVE to reach 0, so one of the two sees
    // the other.
    Atomics.add(ctl, CONTROL.ACTIVE, 1);
    let trapped = false;
    if (Atomics.load(ctl, CONTROL.OPEN) === epoch) {
      exports.__stack_pointer.value = top;
      try { exports.sky_shared_fan_claimed(thread); }
      catch { trapped = true; Atomics.compareExchange(ctl, CONTROL.ERROR, 0, STATUS.TRAP); }
      Atomics.notify(ctl, CONTROL.ROWS_DONE);
    }
    Atomics.sub(ctl, CONTROL.ACTIVE, 1);
    Atomics.notify(ctl, CONTROL.ACTIVE);
    // An instance that trapped may have left its stack or rows in any state.
    if (trapped) { reason = "trapped"; break; }
  }
  Atomics.store(ctl, CONTROL.READY + thread, 0);
  return reason;
}

/**
 * Installs a helper in a dedicated worker: the page sends it one port, the
 * coordinator sends the start message through that port.
 */
export function installSkySharedHelper(scope = globalThis, hooks = {}) {
  scope.addEventListener("message", function connect(event) {
    const port = event.data?.kind === "sky-shared-port" ? event.data.port : null;
    if (!port) return;
    scope.removeEventListener("message", connect);
    port.addEventListener("message", message => {
      const start = message.data?.kind === "sky-shared-start" ? message.data : null;
      if (!start) return;
      let reason;
      try { reason = runSkySharedHelper(start, { ...hooks, onReady: () => port.postMessage({ kind: "sky-shared-ready", thread: start.thread }) }); }
      catch (error) { reason = error instanceof Error ? error.message : String(error); }
      try { port.postMessage({ kind: "sky-shared-stopped", thread: start.thread, reason }); } catch { /* The coordinator may be gone. */ }
      port.close();
    });
    port.start?.();
  });
}
