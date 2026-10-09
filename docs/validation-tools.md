# Prepared Sky validation tools

All four original Earth `90e23b3` validation sources are retained and transformed
under this owner's `scripts/validation/`. They have not been executed, bundled,
typechecked or qualified. Original headers, named pixel rules, tolerances,
numerical references, report fields, console summaries and dated output defaults
are retained. The original CPU cost experiment still says `qualified: false`.
This document does not grant a benchmark, browser, GPU, native or server run.

`skyModelCheck.ts` exports `run(host)` with required monotonic millisecond clock,
WGS84 geodetic-to-ECEF and ECEF-to-geodetic ports. The actual Engine public root
implements the geographic ports in `fixtures/validation/skyModelHost.ts`.
Solar/lunar/clear-atmosphere/photometric calculations use the actual public Sky
root and settings exports. The new optional `@foss-earth/sky/catalogue` exports
the retained `STAR_RECORDS` and `STAR_RECORD_BYTES`, with original data notices;
it does not force that data into the pure root. Existing `starPlaceDeg` and
`yearsFromJ2000` functions are now root exports rather than private tool imports.

`skyRenderCheck.ts` exports `run(host, backend)` and `runSkyRenderCheck(host)`.
The required host supplies Document, backend/Scene, native geometry constructors,
one TerrainLightingAdapter, settings factory, geographic ports, UTC and cost
clocks, timers, hidden-state reader, pause, readiness and frame-request ports.
`fixtures/validation/skyRenderHost.ts` binds actual public Engine
`createTerrainLightingAdapter`, public Renderer `whenMeshesReady`, and public UI
`createSettingsRegistry`. The same Sky table functions/constants configure the
Engine lighting adapter and Sky runtime; no shader or coordinate implementation
is copied. The fixture registers Sky and actual Engine `MAP_LOADING_PARAMETERS`,
preserving host map retry/concurrency defaults instead of the old whole-app
settings singleton.

This standalone pixel experiment intentionally retains its original native
backend options: forced WebGL 1 or 2, preserved drawing buffer, no antialiasing,
large-world rendering and reverse depth. The current Renderer app bootstrap
cannot reproduce every one of these experiment options. The fixture uses the
exact Babylon peer's constructors explicitly; it does not claim to qualify that
bootstrap, fallback, restoration, real GPU identity or a new application render
authority. The original 400-attempt/10 ms compilation loop, 100-attempt/20 ms
ground-readback loop, 512×384 target and pixel tolerances remain experiment
policies. A host Renderer readiness check runs only after the retained mesh-ready
predicate settles. The tool drives its own explicit validation frames and starts
no application scheduler, watch server or background loop on import.

The host classifies the two retained raster/unlit fixture meshes as ground; the
later planet is disabled before the probe case. Ground irradiance is measured by
the actual public Sky ground probe on the supplied Scene. Native readback,
backend/color behavior and transfer-budget admission are unqualified. This
fixture is synthetic geometry at an ellipsoid coordinate height, not physical
terrain-height conversion. It exercises no NASA night-map acquisition; an
attempt fails explicitly until an admitted host transport is supplied. Clouds,
wind, forecast providers and volumetric weather remain unimplemented.

Every successful backend opening is followed by cleanup attempts for point
resources, Sky, Scene, backend and both canvases, including failed setup/render.
Cleanup failures enter the original report's `errors` array. A frame completion
failure is combined with its original render failure. This guarantees attempts;
a native disposal failure can still retain its native resource. Console error
capture is restored. Unavailable WebGPU reports no pixels instead of claiming a
passing backend. Four newly prepared source/lifecycle/guard cases remain UNRUN and
do not substitute for the original numerical and native assertions.

The CLI drivers require owner `dist/` output and exact current installed public
dependencies, never the old checkout's `src/` or ancestor node_modules. Exact prerequisite names/versions, public
module realpaths and Vite bundle inputs are confined to this owner. They hash
the current tool/fixture sources and actual resolved public export files into
the original `sources` object; its keys now identify those actual inputs. The
report shape and existing fields remain unchanged. Export-file hashes identify
entry bytes, not a complete transitive archive pin. A checked exact closure and
installed-artifact qualification remain required separately.

The browser CLI consumes the newly prepared optional experiment export
`@foss-earth/research/headless-chrome`. Research owns that concrete helper;
Sky copies no Chrome-control implementation. Supply its exact installed module
SHA256 through `--chrome-helper-sha256`. The Research archive/revision and helper
declarations are still pending, so the browser driver is not currently qualified
or accepted as runnable. Its helper must await natural Chrome exit after
`Browser.close`, including failures, and send no process signal. Sky's adapted
immutable output-directory helper creates a new collision-safe dated directory
inside **Sky's** `build/validation/`, never inside Research's installed package.

After a coordinator grant, checked current owner prerequisites and retained logs:

```sh
npm run typecheck:validation
# CPU cost experiment additionally needs its explicit benchmark grant:
node scripts/validation/sky-model.mjs
# Browser/GPU (including software mode) additionally needs its explicit grant:
node scripts/validation/sky-render.mjs --chrome-helper-sha256=<installed-helper-sha256> [--software]
```

Vite 8.3.4, TypeScript 5.9.3, Node declarations 24.12.4 and Babylon 8.56.2 are
exact source prerequisites, not a qualification range. Engine, Renderer, UI,
Research and Sky are staged 0.1.0 public packages; final candidate revisions,
archive digests, complete dependency closures and actual consumer evidence remain
unavailable. No automatic rebuild, dependency installation, package packing,
browser launch or experiment is part of `check:implementation`; it adds only the
tool declaration check after the owner build. Retained old evidence under the
original Earth/Research routing remains immutable and does not validate these
newly migrated tools. Evidence publication and original prose-link routing still
need coordinator receipts.

Rollback restores the exact pre-increment owner bytes preserved in
`build/source-only/2026-10-09-sky-validation/before/`; the original five tool/helper
blobs are retained beside them. No canonical source, dependency lock, app facade,
frozen archive, setting ID, metadata policy or shared CI caller changed.
