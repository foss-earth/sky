# Agent instructions

Follow the shared rules for every foss-earth repository in
[foss-earth/.github/AGENTS.md](https://github.com/foss-earth/.github/blob/main/AGENTS.md)
(in a local checkout of the organization: `../.github/AGENTS.md`).

## TypeScript and WebAssembly twins

The TypeScript sky core stays in `src/` (`sky-TS/` re-exports it). Its Rust
twin is `sky-WASM/`: a Cargo workspace with the single and shared-memory
builds, their JavaScript wrappers, checked-in binaries and build receipts. New
cores use Rust. Keep the TypeScript reference. Accept a WebAssembly result only
after exact functional parity (`npm run check:parity`), and report the
requested and actual backend and every fallback. Do not claim speed or power
improvements from a successful conversion or correctness test. No fast math or
reduced precision to make a benchmark pass. Rebuild with `npm run build:wasm`,
which uses installed tools offline and keeps intermediates under `build/`;
never install a toolchain without the user's authorization.

Every twin's layout, its settings in the apps and how to measure one are in
[webassembly-cores.md](https://github.com/foss-earth/docs/blob/main/docs/webassembly-cores.md)
(`../docs/docs/webassembly-cores.md`).
