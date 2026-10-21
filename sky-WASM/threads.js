// The shared sky core's control block and stack layout, mirrored from
// crates/earth-sky-shared/src/lib.rs and toolchain.lock.json's threaded entry.
// Every value here is checked against the module's own layout export.

/** Control words, as Int32Array indices into the control block. */
export const CONTROL = Object.freeze({ EPOCH: 0, OPEN: 1, ACTIVE: 2, STOP: 3, CLAIM: 4, ROWS_DONE: 5, ERROR: 6, LANES: 7, READY: 8, ROWS_BY: 16, WORDS: 32 });
/** Status codes: the module's, then the hosts'. */
export const STATUS = Object.freeze({ OK: 0, INVALID: 1, NO_MODEL: 2, CAPACITY: 3, THREAD: 4, TRAP: 100, STARTUP: 101 });
export const SHARED_ABI_VERSION = 1;
export const MEMORY_PAGES = 64;
export const STACK_BYTES = 524288;
export const THREAD_STACK_BYTES = 65536;
export const MAX_THREADS = 8;
/** Bytes at the bottom of each thread's stack slot that must still hold the pattern after every job. */
export const CANARY_BYTES = 4096;
export const CANARY = 0x5ca1ab1e | 0;
/** Layout export fields. */
export const FIELD = Object.freeze({
  CONTROL: 0, JOB: 1, ROWS: 2, NUS: 3, OUT: 4, TRANSMITTANCE: 5, MULTIPLE: 6, GROUND: 7, RESULT: 8,
  MAX_THREADS: 9, MAX_ROWS: 10, MAX_NUS: 11, MAX_SHARED_STEPS: 12, CONTROL_WORDS: 13, JOB_BYTES: 14, ROW_BYTES: 15,
});

/** Where thread `thread`'s stack starts (its highest address); stacks grow down. */
export const stackTop = thread => STACK_BYTES - thread * THREAD_STACK_BYTES;
/** The lowest address of thread `thread`'s stack slot. */
export const stackBase = thread => STACK_BYTES - (thread + 1) * THREAD_STACK_BYTES;

/** The executing realm's Math, as the module imports it. */
export function mathImports() {
  const { exp, log, sqrt, sin, cos, pow } = Math;
  return { exp, log, sqrt, sin, cos, pow };
}
