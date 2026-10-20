import { parentPort, workerData } from "node:worker_threads";
import { installSkySharedHelper } from "../../helper.js";
import { CONTROL, mathImports, stackBase } from "../../threads.js";

// A Node helper thread, as a browser helper worker installs it. The adversarial
// modes drive the real helper loop into the failures the coordinator must survive.
const mode = workerData?.mode ?? "normal";
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const hooks = {
  normal: {},
  // Wakes, then sleeps past the generation it woke for before joining it.
  late: { beforeJoin: () => pause(workerData.delayMs ?? 5) },
  // Claims a row and dies holding it, as a crashed or terminated worker does.
  "claim-and-exit": { beforeJoin: ({ control }) => { Atomics.add(control, CONTROL.ACTIVE, 1); Atomics.add(control, CONTROL.CLAIM, 1); process.exit(0); } },
  // Claims a row and hangs forever.
  "claim-and-hang": { beforeJoin: ({ control }) => { Atomics.add(control, CONTROL.CLAIM, 1); for (;;) pause(1000); } },
  // A realm whose Math traps inside the kernel.
  trap: { imports: { ...mathImports(), exp() { throw new Error("trap"); } } },
  // Overwrites the bottom of its own stack slot, as a stack overflow would.
  "smash-stack": { beforeJoin: ({ memory, thread }) => { new Int32Array(memory.buffer, stackBase(thread), 4).fill(0); } },
}[mode];
if (!hooks) throw new Error(`Unknown helper mode ${mode}`);
installSkySharedHelper(parentPort, hooks);
