# @foss-earth/sky

Clear-sky atmosphere, astronomy, photometry, stars, and the Sky and Date and time tabs for FOSS Earth. Version 0.1.0.

This repository owns the solar and lunar position models, the clear-atmosphere and sky-illumination model, the star catalogue and star field, night-light rendering, the clock helpers, and the two UI panels. Clouds, precipitation, winds, forecast ingestion and volumetric weather are not implemented here.

## Exports

| Export | Contents |
| --- | --- |
| `@foss-earth/sky` | Pure solar and lunar position and ephemeris, atmosphere tables, sky illumination and dome geometry, photometry, star catalogue, observer basis and clock helpers. |
| `@foss-earth/sky/catalogue` | Optional retained catalogue records and the record-byte layout. Original data notices are preserved. |
| `@foss-earth/sky/settings` | `SKY_PARAMETERS`, `SKY_SECTION_TITLES`, the model choices and the current parameter IDs. |
| `@foss-earth/sky/panels` | `createSkyPanel`, `createDateTimePanel`, the UI, refresh and storage ports, and structural dial types. |
| `@foss-earth/sky/babylon` | Optional `createSkyRuntime`, night-light tiles, star and point resources, the ground probe, structural terrain ports and `bindSkyReadingsAndNotes`. It uses the Scene you supply. |
| `@foss-earth/sky/styles.css` | Layout for the Sky and Date and time containers. Generic controls and dials are styled by the UI package. |
| `@foss-earth/sky/sky-TS` | The TypeScript sky core that the WebAssembly builds must match: tables, atmosphere and the worker evaluation. |
| `@foss-earth/sky/sky-WASM`, `/sky-WASM/shared`, `/sky-WASM/helper` | Its Rust/WebAssembly twin, single-threaded or shared-memory with helper threads, for workers only. `/sky-WASM/wasm` and `/sky-WASM/shared/wasm` are the binaries. See [sky-WASM](sky-WASM/README.md). |

The pure and panel exports create no renderer, read no browser globals on import, and import no React, Babylon, engine or application code. Panel DOM is created only when a factory is called. UI registry types are type-only imports. The optional Babylon entry needs the public `@foss-earth/ui` contract and `@babylonjs/core` 8.56.2 as peer dependencies (both optional in `package.json`).

## Using it from a host app

### Settings

Register `SKY_PARAMETERS` in your `SettingsRegistry` and apply the section titles. The package keeps the existing Sky and Time settings homes and IDs, including the Sky-owned `renderer.ambientFillMultiplier` and `renderer.exposureEV`. It supplies no singleton settings object and no settings persistence of its own.

The engine's map download concurrency and retry settings stay with the host. Register them yourself when night maps are enabled.

### Optional worker atmosphere numeric port

`createAtmosphere(parameters, now, ports?)` keeps the JavaScript table builder
and reference as its default. A worker may preload a compatible numeric module
and supply `{ execution: "worker", createKernel, onStatus }`. The kernel receives
copied Float32 tables and implements ray radiance, the shared sightline fan and
hemisphere sky irradiance. Each operation's first input is compared exactly
against the retained reference; an error or difference permanently uses the
reference for that atmosphere. `atmosphereNumericStatusOf(atmosphere)` reports
the requested/actual backend, per-operation parity, fallback and cleanup state.
Call the optional `atmosphere.dispose()` before replacing a native atmosphere.

The optional `ports.createTables(parameters)` builds transmittance, multiple
scattering and ground irradiance in the worker as well. The first complete table
set is compared exactly with JavaScript's, which for the default atmosphere
include the two precomputed ones ([Data and generation tools](#data-and-generation-tools)),
and the reference tables are used for that atmosphere.
Reuse one ports object per worker: subsequent builds may skip
the JavaScript precompute after that comparison. Table failure or mismatch
permanently disables native work for that ports object. Status includes the
actual table backend and table parity independently of query parity.

The source port rejects a browser page and adds no engine dependency or app
wiring. The host owns bounded asynchronous startup and the worker lifecycle.
The Rust/WASM twin, [sky-WASM](sky-WASM/README.md), is in this repository. It
is a partial conversion whose tables and worker evaluations match this
TypeScript bit for bit (`npm run check:parity`): astronomy, dome filling and
renderer integration remain JavaScript. It has no qualified speed/power claim.

### Observer and clock

- `observerAt(x, y, z, ecefToGeodetic)` needs the host's ECEF-to-geodetic conversion.
- `observerFromGeodetic` takes a place the host has already resolved.
- Neither implements world-coordinate conversion. Angular constants and display gamma are local units. Camera mathematics stays in the engine.
- Clock helpers read `SkyTimeSettings.get<T>(id)`. `DAY_MS` and `HOUR_MS` are exported.

`fixtures/observer.json` holds a worked coordinate example.

### Panels

Both panels need the host's `document`, `settings`, `now`, `refresh.subscribe` and the UI factories `createParameterSection`, `createSectionsElement` and `appendHostSections`. The Date and time panel also needs `createDial` and `wrapTurn`. The `Dial*` types describe the dial widget contract; the dial's runtime and CSS belong to the UI package.

- Pass `panelStorage` to choose persistence, or `null` for memory only.
- The host supplies place and time changes and the refresh notifications.
- The same refresh port is passed to every UI parameter and host section.
- Panels start no interval. Destroying a panel detaches its refresh and settings subscriptions, dials and sections, and repeated destruction is safe.
- The Sky panel's time action calls a host callback to open the Date and time tab.

### Babylon runtime

`createSkyRuntime` needs a host Scene, settings, ECEF conversion, world matrix, a ground-mesh predicate, an epoch clock, a cost clock, a hidden-state reader, timers and a frame callback. It creates no second scene or renderer and starts no render loop. The host calls `update()`.

- `terrain.setLighting` and `terrain.setLocalLights` adapt its lighting output to the engine's terrain.
- NASA night maps use the host's `fetchTile`, `measureResponse`, `retryDelayMs` and `setNightLightMap`, so the engine keeps its cache, transport and retry behavior. Image decoding stays in the browser adapter.
- One wake timer asks the host for a frame when the Sun crosses its update threshold.
- `createStarField(scene, {clock})` and `GroundLightProbeOptions.clock` both require the host cost clock. The runtime passes the same clock to both.

`bindSkyReadingsAndNotes({settings, sky})` binds the existing parameter homes to a Sky instance and keeps the original reading wording and units. Readings run when the UI asks for them. Call the returned detach function before replacing the binding and before disposing Sky. Detach removes watches, readings and owned notes, and disposes neither Sky nor the registry. `skyReadings`, `nightLightReadings` and `applySkyNotes` are also exported for custom composition.

### Disposal

Disposing the runtime marks the instance stale first. It then tries every owned cleanup (timers, lights, dome, stars, ground probe, night maps, terrain, listeners, subscriptions, notes) and throws one `AggregateError` with the failures. Owned references are detached before release, so disposing twice does not retry. Turning a model off finishes its remaining shutdown steps before reporting failures. Notifications that arrive late from settings, timers, readback, the catalogue or night maps cannot restart a disposed instance, and a late night-map response cancels its body instead of decoding it.

This guarantees that cleanup is attempted and stale callbacks are suppressed. If a native or host release fails, the host still has to resolve the reported failure.

## Data and generation tools

`starCatalogue.ts` holds the 9,096-entry Bright Star Catalogue data with its original source notices. Copying the project license does not grant any additional rights to that data.

`precomputedAtmosphereTables.ts` holds two of the atmosphere's three tables for the settings' default haze and ground albedo: light scattered more than once and the sky's light on level ground, as `createAtmosphere` builds them, bit for bit. For those parameters `createAtmosphere` starts from them and builds only the transmittance, in about 26 ms instead of 115 ms on the development Mac (single-threaded, not qualified). Other parameters build all three. `src/precomputedAtmosphereTables.test.ts` fails when the tables are no longer what `src/atmosphere.ts` builds, or no longer for the settings' defaults.

Three tools regenerate committed data. The star catalogue and the solar terms come from inputs you supply; the atmosphere tables come from this checkout's `src/atmosphere.ts` and `src/settings.ts`. The tools download nothing and write under a dated `build/generated` directory by default; an optional output path must be inside this repository.

```sh
npm run generate:stars -- <catalog> [output]
npm run generate:solar-terms -- <layout-text> [output]
npm run generate:atmosphere-tables -- [output]
```

The committed generated records are the ones the package uses.

## Validation tools

`scripts/validation/` holds the model and render validation tools (`npm run validate:model`, `npm run validate:render`). They use only public Engine, Renderer, Sky and UI imports and explicit host fixtures. The render driver needs a browser and the public headless-Chrome helper from [@foss-earth/research](https://github.com/foss-earth/research). See [validation tools](docs/validation-tools.md) for the numerical and pixel rules, the report schema, and the WebGL 1 options.

## Development

This package names other `@foss-earth/*` libraries (`engine`, `renderer`, `research` and `ui`) by versions that are not published yet. Its own `npm install`, tests and build therefore do not work on their own. Develop it through the app, which uses libraries straight from their checkouts: see [Local source](https://github.com/foss-earth/app#local-source).

Scripts in `package.json`: `build`, `typecheck`, `lint`, `test`, `test:consumer`, `typecheck:consumer`, `typecheck:validation` and `ci`. The WebAssembly twin adds `build:wasm`, `check:wasm` (build receipts), `check:parity` (builds, then checks both builds against the TypeScript), `test:wasm` and `test:rust`; see [sky-WASM](sky-WASM/README.md).

Other documents: [source specifications](docs/source-specifications.md), [Sky proposal](docs/proposals/sky.md), [lighting implementation prompt](docs/sky-lighting-implementation-prompt.md). `fixtures/consumer/minimal.ts` shows every public type surface with explicit host ports.

## Project policies

- [Code of conduct](https://github.com/foss-earth/.github/blob/main/CODE_OF_CONDUCT.md)
- [Contributing](https://github.com/foss-earth/.github/blob/main/CONTRIBUTING.md)
- [AGPL-3.0 license](LICENSE)
- [Security](https://github.com/foss-earth/.github/blob/main/SECURITY.md)
