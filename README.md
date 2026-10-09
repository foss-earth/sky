# @foss-earth/sky

Private staging candidate, version 0.1.0. This repository owns the current clear
atmosphere, astronomy, photometry, stars, Sky tab and Date and time tab. It extracts
committed FOSS Earth source `90e23b3ee96f53ec5900afc5991a21fffa58649d`, tree
`c68d1fabd9fce19e255ea89c65502666d0f74a27`. Dirty atmosphere and weather work is
excluded. `provenance.json` records each selected source blob, byte digest and
transformation. Source history import and publication remain coordinator gates.

| Public export | Contract |
| --- | --- |
| `@foss-earth/sky` | Pure solar/lunar position and ephemeris, atmosphere tables, sky illumination and dome geometry, photometry, star catalogue, observer basis and clock helpers. |
| `@foss-earth/sky/catalogue` | Optional explicit retained catalogue records and record-byte layout; original data notices preserved. |
| `@foss-earth/sky/settings` | `SKY_PARAMETERS`, `SKY_SECTION_TITLES`, owned model choices and current parameter IDs. |
| `@foss-earth/sky/panels` | `createSkyPanel`, `createDateTimePanel`, explicit UI/refresh/storage ports and temporary structural dial types. |
| `@foss-earth/sky/babylon` | Optional `createSkyRuntime`, night-light tiles, star/point resources, ground probe, structural terrain ports and `bindSkyReadingsAndNotes`. Uses the supplied Scene. |
| `@foss-earth/sky/styles.css` | Sky and Date and time container layout. Generic controls and dials use UI styles. |

Pure and panel exports create no renderer, read no browser globals on import and
import no React, Babylon, engine or application implementation. Panel DOM is
created only when its factory is called. UI registry types are public type-only
imports. Optional Babylon needs the current public `@foss-earth/ui` contract and
`@babylonjs/core` 8.56.2; `dependency-pins.json` records the pending replacement
UI archive and prior foundation evidence. No current artifact, package range or
platform support is qualified before its checks.

The host registers `SKY_PARAMETERS` in its `SettingsRegistry` and applies the
section titles. Existing Sky/Time homes and IDs are preserved, including
Sky-owned `renderer.ambientFillMultiplier` and `renderer.exposureEV`. Engine map
download concurrency/retry settings remain host-owned and must be registered by
the host when night maps are enabled. This package supplies no complete feature
catalogue, singleton settings object or independent settings persistence record.

`observerAt(x, y, z, ecefToGeodetic)` requires the host conversion port.
`observerFromGeodetic` accepts a host-provided place. Neither API implements
world-coordinate conversion. Angular constants and display gamma are local
units; camera mathematics stays in engine.
Pure clock helpers use `SkyTimeSettings.get<T>(id)` rather than an optional UI
declaration dependency. `DAY_MS` and `HOUR_MS` are public clock units.

Panels require the supplied `document`, `settings`, `now`, `refresh.subscribe` and UI factories
`createParameterSection`, `createSectionsElement` and `appendHostSections`.
Date and time also requires injected `createDial` and `wrapTurn`. The temporary
`Dial*` declarations describe the exact committed widget contract; its runtime
and CSS remain UI-owned. The next UI release must expose this dial surface before
full host adoption. Supply `panelStorage` explicitly to choose persistence or
`null` for memory only. The host supplies place/time changes and visible refresh
notifications. Panels start no interval; destruction detaches refresh/settings
subscriptions, dials and sections. The Sky time action uses a host callback to
open the Date and time tab.

The same supplied refresh port is passed into every UI parameter/host section.
The new UI contract requires it explicitly. The earlier frozen UI artifact is
only a foundation fixture and cannot qualify these additional UI surfaces;
Sky's installed increment waits for the checked replacement UI artifact.

The Babylon adapter requires a host Scene, settings, ECEF conversion, world
matrix, ground-mesh predicate, epoch clock, cost clock, hidden-state reader,
timers and frame callback. `terrain.setLighting` and `terrain.setLocalLights`
adapt its physical output to the engine terrain implementation. NASA night maps
use host `fetchTile`, `measureResponse`, `retryDelayMs` and `setNightLightMap`
ports. These preserve the engine's cache, transport, retry and resource authority.
Optional decoding stays in the browser adapter. The existing single wake timer
requests a host frame when the Sun crosses its configured update threshold; the
host drives `update()`. Sky starts no independent render/tick loop and initializes
no second scene or renderer. Disposal cancels host timers/downloads and releases
its own lights, meshes, textures, probes and subscriptions.

`bindSkyReadingsAndNotes({settings, sky})` binds the existing parameter homes to
the supplied instance and preserves the original reading wording and units.
Readings run when the existing UI asks; no polling or render loop is started.
Call its returned detach function before replacing the binding and before
disposing the host Sky. Detach removes watches, readings and all owned notes;
it disposes neither Sky nor registry. `skyReadings`, `nightLightReadings` and
`applySkyNotes` are also exported for explicit host composition.
`createStarField(scene, {clock})` measures work using the supplied host cost
clock. `GroundLightProbeOptions.clock` is also required; the runtime supplies
that same clock to both resources. It does not start a second clock. Disposal
stops later setter/subscription/readback publication, and both panels dispose
their own subscriptions/resources once even if destruction is repeated.

Runtime disposal marks the instance stale before calling any native or host
release. It attempts all owned timer, light, dome, star, ground-probe, night-map,
terrain, listener, subscription and note cleanup, then throws one
`AggregateError` containing the failures. Owned references are detached before
release, so a repeated disposal does not retry them. Model-off transitions also
finish the remaining shutdown steps before reporting failures. Ground probes,
stars, light points and night maps follow the same release rule. Settings,
timer, readback, catalogue and night-map notifications retained by a failing
host release cannot restart a disposed instance. A late night response cancels
its body instead of starting image decoding. This guarantees cleanup attempts
and stale-callback suppression; a native or host operation that fails to release
its resource still needs the host to resolve that reported failure.

Prepared causal cases in `tests/runtime-ports.test.ts`,
`tests/resource-disposal.test.ts` and the retained night-map suite exercise the
actual public Babylon factories with the existing NullEngine and host-port
scaffolds. They include simultaneous native/terrain/listener/timer/unsubscribe
failures, continued model-off cleanup, late probe/night/settings notifications,
and resource release after observer or map-detachment failure. These new cases
are source-only and unrun; the original numerical and lifecycle assertions
remain retained.

This is the committed clear-sky ladder and current night/star capabilities.
Clouds, precipitation, winds, forecast ingestion, volumetric weather and the
staged weather proposal are not implemented or claimed by this release. The
Bright Star Catalogue's retained 9,096-entry data and source notices remain in
`starCatalogue.ts`; copying the project license does not invent additional data
rights. Catalogue and SPA generation tools are retained with explicit local
inputs; they prepare output under dated `build/generated` by default and perform
no downloads. `npm run generate:stars -- <catalog> [output]` and
`npm run generate:solar-terms -- <layout-text> [output]` accept an optional output
inside this repository. Neither tool has been executed or regeneration qualified
here; the committed generated records are retained.

`fixtures/consumer/minimal.ts` shows all public type surfaces and explicit host
ports. `fixtures/observer.json` declares the coordinate worked example.
Existing numerical/reference, ground-probe and night-map lifecycle tests are
retained, with host settings/transport fixtures. Additional tests cover observer
injection, panel refresh/disposal, and supplied-scene/static-frame behavior.
No checks have run for this candidate.
The original full Sky runtime and Date and time assertions are also retained in
`fixtures/composition/LegacySkyRuntimeTests.ts` and
`fixtures/composition/LegacyDateTimePanelTests.ts`. Their registration functions
require real public host terrain/geocoordinate/UI adapters; they are inactive
and unrun until that composition adopts them. They copy no engine shader,
coordinate converter, generic dial or application implementation.

The supplied-document panel case uses mocked host UI factories. Current public UI Document forwarding is prepared source only; real installed
cross-realm control behavior remains unqualified until a checked replacement
UI archive is adopted. The older frozen UI does not provide that new contract. Legacy night-map browser decoding and native
texture/readback submission remain retained adapters; no shared native-transfer
budget qualification or backend restoration is claimed here.

Reserve a coordinator check window before these commands:

```sh
npm run ci
npm run test:consumer -- --sky=/path/to/checked/sky.tgz --sky-sha256=<64-hex> --ui=/path/to/checked/ui.tgz --ui-sha256=<64-hex> --babylon=/path/to/babylon.tgz --babylon-sha256=<64-hex> --typescript=/path/to/typescript.tgz --typescript-sha256=<64-hex>
npm run check:conformance -- --consumer . --trusted-release .attribution-release.json --output-root build/common-conformance/2026-10-09-sky
```

Tests cap workers at 50%; typecheck/build caches stay in `node_modules/.tmp`,
lint cache in `node_modules/.cache`, and offline npm cache in `build/npm-cache`.
The installed consumer requires actual owner/UI/Babylon/compiler archives with
explicit SHA-256 pins and installs them offline. It loads pure/settings/panels
with peer imports forbidden and rejects realpath and type resolution outside its
clean workspace, including a negative control. It then exercises the optional
adapter and settings binding using a supplied NullEngine Scene and checks
strict declarations. No ancestor dependency is silently packed. Installed
consumer and shared conformance are separate mandatory acceptance gates from
the source `ci` command; the reviewed common CI archive must first be installed
for conformance. This provides no GPU or browser visual qualification. Retain dated
logs and the resulting archive/digest/environment receipt; no server is needed.

Migration adapts engine conversion/terrain/cache/clock ports and UI factories at
host composition, replaces old private imports with the exports above, and keeps
the same parameter/storage records. Rollback can restore the prior owner imports
and exact dependency lock because no setting IDs or record versions are changed.
Current Earth/flight/campus adoption, exact release revision/artifact, shared
`foss-earth/ci` caller/policy/conformance pins and actual remote admission settings
remain outstanding. The source caller is now pinned to reviewed CI
`9e046dd482e0229dc7c7b2d71b079d5905664656`; installed conformance, full intended
refs and remote admission have not run for this owner. No copied local checker substitutes for the shared component.
Metadata checks must cover docs-only changes.

YOU CANNOT HAVE AI AS A CO-AUTHOR, OR YOUR CONTRIBUTIONS WILL BE REJECTED.

The four original model/render validation tools are now prepared under this
owner's `scripts/validation/`, with public-only Engine/Renderer/Sky/UI imports and
explicit host fixtures. [Validation source contracts](docs/validation-tools.md)
records retained numerical/pixel rules, report schema, experiment-native WebGL 1
options and unavailable hooks. `typecheck:validation` prepares a separate strict
declaration check; neither model timings nor a Chrome/GPU run is implicit in CI.
The browser driver requires the exact installed optional Research public helper
and its module digest. These tools, fixtures, new catalogue export and all current
checks remain UNRUN; original evidence does not qualify the migration.
