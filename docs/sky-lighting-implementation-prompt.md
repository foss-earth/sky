# Implement physical sky lighting and a shared Sky tab

Work in the canonical FOSS Earth checkout, `../foss-earth` beside 0sfs.
Read `AGENTS.md`, then this prompt. Read `../0sfs/AGENTS.md` before changing the
flight consumer.
Preserve existing and concurrent work in both repositories.

## Problem and outcome

On 2026-10-07 the user tested `http://localhost:5173/fly/` with **Ambient fill
multiplier = 0.02** and **Exposure compensation = +8.8 EV**. They could see the
red exterior exhaust in dry mode and described it as the appearance they had
been looking for. The aircraft and ground, however, became solid white. No
exhaust runtime changes had been made between the earlier failed observation
and this test. Exact throttle, conversion/nozzle pose, camera, map provider,
other settings and native state were not recorded. This is user visual feedback,
not an independently captured or radiometrically calibrated result.

Implement coherent sun/sky/surface lighting and display behavior for meaningful
day, twilight and night comparisons. Add environmental controls in a shared
**Sky** tab. First test whether scene lighting/display explains the coupled
dark-exhaust/white-surfaces problem. Keep exhaust physical validity separate.

FOSS Earth owns solar geometry, atmosphere, environmental illumination, terrain
materials, HDR composition, exposure, generic light receiving and the Sky tab.
0sfs owns aircraft source bindings and the flight comparison. JSBSim owns engine
dynamics; this lighting task needs no native engine change or WASM SDK build.
Export shared behavior through documented FOSS Earth package surfaces and
consume those exports in 0sfs.

## Read before editing

- `docs/proposals/settings.md`, especially Lighting and exposure;
  `docs/render-on-demand.md`; `docs/ui-layout.md`.
- `docs/validation/README.md`, `docs/validation/benchmark-interference.md` and
  `docs/validation/chrome-code-sign-clones.md` before authorized browser work.
- `src/engine/babylon/createBabylonRuntime.ts` and its simulation tests;
  `createRasterTilesRuntime.ts`; the Google tile material path.
- `src/settings/catalogue/renderer.ts`, catalogue sections and shared
  `WindowOverlay`/choice-panel tab composition.
- `../0sfs/docs/foss-earth-relationship.md` and
  `../0sfs/docs/validation/f135-dry-vtol-mechanism.md`, especially the latest
  lighting observation; `../0sfs/docs/validation/f135-exhaust-response.md`.
- `../0sfs/src/flight/aircraft/createEngineExhaust.ts` and
  `createEngineHotSurfaceGlow.ts` for the emitter/display contract.

Do not follow finished prompts in `docs/old/` as procedure.

## Verify these findings in the current checkout

These are code facts at writing time, not measurements of the user's pixels:

- Simulation uses a world-up hemispheric light at `1.1 * ambientFillMultiplier`.
  Google tiles add one at `1.0 * multiplier`; check mesh filtering and overlap
  on the aircraft. The fallback light at `0.95 * multiplier` is restricted to
  its globe. No physical solar direction/irradiance or sky lighting is present
  on this path; the simulation background is a fixed clear color.
- Raster ground has `emissiveColor = White()` and `disableLighting = true`.
  Fill reduction neither darkens it nor makes it receive local source light.
- Shared exposure is `2 ** exposureEV`; tone mapping and image-processing
  postprocessing are disabled. Babylon's material function multiplies exposure,
  gamma-encodes and saturates. Audit custom shaders and transparency too: common
  linear HDR composition has not been qualified across the scene.
- `2 ** 8.8 ≈ 445.72`; multiplied by `0.02`, it is **8.914**. An otherwise
  unchanged linear fill contribution is therefore increased relative to unit
  fill at 0 EV. Emissive raster imagery gets no fill reduction. This makes
  clipping plausible but does not quantify actual PBR pixels or prove the
  complete live cause.
- F135 gas/metal calculations retain absolute emission units, then use
  provisional **1000 cd/m²** white references. Relative lights/imagery do not
  yet share an established physical scale with these emitters. Revealing dry
  emission does not validate engine temperatures, soot, chemistry or the deck.
- Installed Babylon core was **8.56.2**. Recheck versions/API/backend support;
  a feature in newer documentation is not proof of compatibility here.

## Investigate first

Retain a contribution/unit audit for direct environmental light, diffuse fill,
environment/reflections, local lights, emission, raster/custom imagery,
sky/background, exposure and tone mapping. State physical units and relative
approximations. Inspect shader code where CPU tests cannot establish behavior.

Use fixed sources and controlled diffuse/material patches to distinguish excess
environmental illumination, self-lit terrain, inconsistent luminance scales,
clipping during transparent composition, duplicate exposure/encoding and
overlapping lights. Include fill **0, 0.02, 1** and exposure **0, +8.8 EV** with
the same source. Derive expected scaling from units and the display contract.
Record observations, verified facts, hypotheses and unknowns separately.

## Implement

### Solar, sky and surface illumination

1. Establish deterministic UTC instant, world position and altitude inputs.
   Compute solar direction from a primary-source algorithm with a stated domain
   and tested accuracy. Handle ECEF/local up, the floating origin, simulation
   world root and altitude-dependent horizon consistently.
2. Drive the visible sky, direct light and diffuse sky illumination from the
   same solar/atmospheric state. State units and their conversion into Babylon.
   Remove unintended duplication with legacy fill. Below-horizon solar light
   must follow Earth occlusion and atmospheric transport. A dark clear color
   under daytime fill is not night. Bound/model non-solar night illumination
   explicitly; elaborate celestial artwork and volumetric weather can wait.
3. Precompute expensive atmospheric/spectral transport into compact licensed
   tables where appropriate. Choose a reduced model by accuracy and cost,
   state its limitations and avoid unbounded per-pixel integration.
4. Define an explicit material policy for raster and photographic 3D terrain.
   Baked photographs are not measured albedo. Provide a physically lit path or
   documented albedo approximation for relevant surfaces and preserve an
   intentional cartographic presentation where needed. Night surfaces must
   respond to environmental and local light under that policy. A dark tint is
   not a reconstruction of true night imagery.
5. Qualify generic local-light receiving with an ordinary surface fixture,
   independently of F135. Do not invent a source-power-independent bright patch.

### Display and composition

1. Establish one documented luminance/reference scale for sky, reflected light
   and emitters. Provisional references must be explicit. Display controls must
   not change physical source watts, candela, luminance or engine temperature.
2. Preserve linear radiance through addition, attenuation and transparency to
   the shared display transform. Apply exposure and encoding once. Qualify
   opaque/emissive/volume composition. Introduce targets/postprocessing only as
   required by the contract, recording memory/pass cost. Tone mapping alone
   cannot correct excess illumination.
3. Retain fixed exposure for reproducible comparisons. Any automatic exposure
   must have user-set bounds/adaptation controls, show its active value/reason
   and offer a fixed mode. It must not conceal an invalid source.
4. Keep the reported low-fill/high-exposure case reproducible. Preserve saved
   settings; document migrations and avoid silently changing source references.

### Shared Sky tab and integration

Add **Sky** as a shared tab in the globe and flight. Suggested sections: time
and location, atmosphere and illumination, surface appearance, exposure and
display. Every setting has one home. Move any relocated exposure/fill controls
out of Renderer; retain IDs/values where semantics remain valid and document
semantic migrations. Follow the paragraph-grid and single-tab rules.

Give continuous quantities continuous controls with units, bounds, defaults and
reasons. Include UTC instant, solar altitude/azimuth readout, fixed exposure and
actual illumination/reference values needed to interpret the scene. Resource
and update/error budgets are visible named parameters, not opaque quality names.
Export the environment interface from FOSS Earth; 0sfs only supplies its context
and integrates shared UI/rendering. Keep aircraft comparison controls in 0sfs.

### Performance and lifecycle

Update state only when inputs change to the declared accuracy. Reuse tables,
buffers, materials/lights and cached transforms. Request one frame per visible
change and none for hidden progress. A fixed scene/environment must settle.
Any running clock has an explicit rate/update policy and stops its scheduling
when stopped or disposed. Record texture bytes, passes and update work even
when timings are unavailable. Preserve backends/fallbacks, map handoffs, camera
momentum, floating origin and teardown. Keep exhaust ray/field budgets unchanged.

## Primary references and acceptance

- [Reda and Andreas, Solar Position Algorithm, NREL/TP-560-34302](https://docs.nlr.gov/docs/fy08osti/34302.pdf):
  qualify solar geometry using its tables/example. Review licensing for any
  separately downloaded code; do not submit the user's contact details.
- [Bruneton's precomputed atmospheric scattering implementation and tests](https://ebruneton.github.io/precomputed_atmospheric_scattering/):
  offline transport/spectra and reference comparisons. This does not establish
  every proposed non-solar night source.
- Installed Babylon image-processing source/tests. Evaluate
  [official atmosphere documentation](https://doc.babylonjs.com/addons/atmosphere/)
  with verified version, license, backend compatibility and resource cost.

Retain versions, licenses, units, domains and uncertainties. Required checks:

1. Solar reference cases, day/twilight/night transitions, and coordinate/rebase
   invariance across globe and simulation consumers.
2. Fixed-source invariance under Sky/display controls; consistent reference
   scaling and one exposure/encoding application across material classes.
3. A known diffuse receiver, with `L = reflectance * illuminance / pi` for the
   declared Lambertian case. Qualify actual rendering when authorized.
4. Night context at +8.8 EV with appropriately dark unilluminated surfaces and
   visible local illumination/emission. Quantify selected clipping: physically
   bright highlights can still clip. A black background alone does not pass.
5. Unchanged F135 source-only, reflection-only and combined comparisons in
   0sfs. Explain what supports/falsifies the lighting hypothesis. Do not retune
   engine temperatures, soot, chemistry, source hue or white references to pass.
6. Related checks after edits and full CI once in each affected repository,
   logs under `build/`, retained evidence in its documented validation layout.
   No JSBSim/audio WASM build is required for a lighting-only change.

The user previously declined GPU testing for the exhaust work. This handoff
does **not** revoke that restriction or authorize starting dev/preview/watch
servers, visible browser use, benchmarks or deployment. Until the user changes
those instructions, perform independent terminal/CPU checks and leave rendered
and device acceptance unverified. The existing localhost server is not ours to
start, restart or stop. Follow AGENTS for later authorized browser checks and
natural Chrome teardown.

Deliver implemented shared sky/lighting/display behavior and Sky UI, consumer
integration, updated specification/evidence, and separate numerical/model,
live appearance and performance results. Identify remaining source calibration
and AB audiovisual timing work for the exhaust thread. This environment is a
prerequisite for meaningful night-radiance comparison; it does not establish
that every exhaust assumption is correct. Do not publish.
