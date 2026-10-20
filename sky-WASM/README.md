# sky-WASM

The Rust twin of the TypeScript sky core ([sky-TS](../sky-TS/index.js), whose
source is `src/atmosphere.ts` and `src/skyEvaluation.ts`). `earth-sky` ports the
clear-atmosphere ray march, the shared sightline radiance fan, the
12-by-16-direction hemisphere irradiance integration, and all three precompute
loops: 128-by-64 transmittance optical depth, 33-by-24 logarithmic multiple
scattering with its isotropic directional gather, and 48-sample logarithmic
ground irradiance. Readiness flags keep scattering and ground tables
unavailable while the reference does, and tables round to f32 at the same
stores. Solar and lunar ephemerides, dome geometry and colour filling, stars,
and renderer integration remain JavaScript. This is a partial sky conversion.

The port keeps f64 expression and reduction order, the original coefficients,
f32 table rounding, and the reference fan's shared ray preparation. WASM imports
`sky_math.{exp,log,sqrt,sin,cos,pow}` directly from the executing worker's
`Math`; it does not replace them with Rust libm. No fast math or precision
reduction is requested. Host-native numeric execution deliberately fails
instead of using a different mathematical library.

`scripts/check-sky.mjs` runs the actual `single/sky.wasm` against the built
TypeScript sky through `createSkyEvaluationState`, the evaluation a sky worker
runs: 125 requests over five atmospheres, five places and five instants, with
135,480 table values and 1,070,250 dome values, all identical bits.
`scripts/check-sky-shared.mjs` does the same for the shared-memory build at 1,
2, 4 and 8 threads. These are parity checks, not speed evidence.

## Single-threaded build

`loadSkyCore()` is lazy. A host loads it in a worker, then passes
`{ execution: "worker", createKernel: core.createAtmosphere, createTables: core.createTables }`
as the third argument to the sky's `createAtmosphere(parameters, now, ports)`.
The sky port checks the first result of each operation against its retained
reference before using native outputs. A mismatch or error permanently falls
back to JavaScript and is reported by its status port. The first full native
table build is also compared against the retained JavaScript tables, and that
first atmosphere uses the reference tables. Reusing the same ports object in
the worker admits native tables on later builds only after that exact
comparison. A table build failure or mismatch permanently disables native work
for that ports object. Omitting `createTables` keeps reference table
construction and only selects query kernels. A browser page is rejected by
this wrapper; the app's sky evaluation worker loads it (`native.core.sky`). The
host should bound asynchronous module loading before calling the synchronous
factory and should terminate a worker that blocks. A JavaScript timeout cannot
interrupt synchronous WASM.

The ABI has explicit live allocations: f64 buffer handles are actual addresses
only of registry-owned allocations, and model IDs are monotonic handles.
Unknown, freed, wrong-length and reentrant accesses are rejected without
dereferencing caller pointers. Buffers are limited to 65,536 f64 elements each,
64 live buffers, 8 models, and 32 MiB registered payload. Each fan has at most
4,096 steps and 4,096 directions, with at most 1,048,576 step-direction
combinations; bounded temporary fan preparation is separate from registered
payload. The linked linear-memory maximum must be 256 MiB. The wrapper
refreshes memory views after allocation and execution, copies output before
release, checks overlapping spans, and attempts every buffer cleanup in
`finally`. Dispose each atmosphere explicitly. A missing binary fails rather
than pretending JavaScript is WASM.

## Shared-memory threaded build

The threaded build cooperates over one shared `WebAssembly.Memory`. It uses
`crates/earth-sky-shared`, which shares `crates/earth-sky-kernel` with the
single build:

- `shared/sky-shared.wasm`: atomics, imported 4 MiB fixed shared memory, 8
  stack slots of 64 KiB;
- `sharedCore.js`: the coordinator and capability checks;
- `helper.js`: the helper loop;
- `threads.js`: the control-block and stack layout, checked against the
  module's own layout export.

**Work and publication**
- Dome fan rows are claimed dynamically.
- Each thread writes disjoint ranges, which are assembled in row order.
- Publication is by epoch, with Atomics. Helpers block in `Atomics.wait` in
  their own workers; the coordinator waits in bounded slices; the page never
  waits.

**Exactness**
- f64, the same operation order, and the realm's `Math`. Each mode (solo,
  parallel) must match the TS reference bit for bit on its first batch.
- A timeout, trap, incomplete rows or a stack canary retires the shared core
  with a reason.
- The ladder is threaded → single → TS worker, with no reload.

**In the app**
- `?set.native.core.sky=threaded&set.native.threads=4` asks for it.
  `native.threads` takes 1–8 and includes the coordinator.
- Helpers are `skySharedHelper.worker.ts` workers from the `native.workers`
  budget, reserved only on a cross-origin isolated page.
- Without isolation the sky runs `single (worker)` with
  `not-cross-origin-isolated` and starts no helper.

**Results** (Chrome 155, 18 October 2026)
- Every arm matched exactly.
- In a browser worker, the warm dome p50 went from 12.1 ms (single) to
  3.9 ms (4 threads).
- In the Earth A/B the sky worker's work per job halved (3.05 → 1.73–1.83 ms).
  The round trip improved only 0.2–0.4 ms; page task and frames showed no gain
  beyond the A/A spread, and total sky CPU rose (4.2 → 4.4–4.7 s; 5.1 s with 8
  threads).
- No power was measured.

## Build and checks

From the sky root:

```sh
npm run build:wasm     # offline; writes single/sky.wasm, shared/sky-shared.wasm and their receipts
npm run check:wasm     # source and binary receipts, size and Node validation
npm run check:parity   # builds the sky, then scripts/check-sky.mjs and scripts/check-sky-shared.mjs
npm run test:wasm      # tests/sky-shared.test.mjs: protocol, faults and timeouts
npm run test:rust
```

The builds use installed tools only and fail clearly if
`wasm32-unknown-unknown` is absent; nothing is installed. The shared build uses
stable Rust with the atomics target feature, no nightly, build-std or
wasm-bindgen. Its crate is `no_std` with no allocator or thread-local storage,
so rustc's warning that `atomics` is an unstable target feature is the one
warning allowed. `scripts/build-shared.mjs` also checks the module's structure:
imported shared memory of the declared size, only memory and `Math` imports,
an exported stack pointer, no memory growth, no thread-local storage or
allocator, and once-only data initialisation. Parity reports go to the sky
repository's `build/sky-WASM/`.
