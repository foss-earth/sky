# Sun lens flare handoff

Implemented 25 October 2026; validation continued after midnight UTC.

The setting is `sky.exposure.lensFlare`: **Off / Glare / Flare**, default
**Off**, in **Sky → Exposure and display**. It is shared with 0SFS fly without
host changes. A URL can set `set.sky.exposure.lensFlare=flare`.

The [model and limits](sky.md#camera-lens-flare) document the light scale,
fixed nominal lens constants, depth occlusion and capture state. Captures can
read `runtime.sky.getEnvironment().lensFlare`; require `settled === true`,
the requested `mode`, and `status === "ready"`. The sources report the visible
fraction of the whole disc, visible light's stops over effective white, and
its pixel from the canvas's upper left. No capture script was edited.

## Files changed by this work

All source changes are in the Sky repository:

- `src/settings.ts`: the one control, help, default and URL registry entry.
- `src/babylon/createSkyRuntime.ts`: optional lifecycle and live environment state.
- `src/babylon/index.ts`: exports the state and mode types.
- `src/babylon/createSunLensFlare.ts`: depth probe, lens atlas, GPU reduction,
  screen composite, readiness, generation-safe readback and disposal.
- `src/babylon/lensFlareModel.ts`: nominal lens, light/exposure conversions and
  CPU visibility reference.
- `src/babylon/lensFlareShaders.ts`: GLSL and native WGSL shaders.
- `tests/lens-flare.test.ts`: exposure, reddening, partial occlusion,
  horizon weighting and resource-free Off tests.
- `fixtures/validation/lensFlareCheck.ts` and
  `scripts/validation/lens-flare.mjs`: retained GPU regressions.
- `docs/proposals/sky.md` and this report.

Existing civil-clock changes in Sky, map changes in engine, app changes and
flight changes were preserved. Copies of the two shared source files before
editing are under `sky/build/lens-flare/original/`. Nothing was staged,
committed or pushed. Engine, renderer, app and fly needed no source changes.

## Pictures and review

Paths below are relative to `~/gh/foss-earth/app/`:

| Check | Capture |
| --- | --- |
| Before, default Off | `build/lens-flare/before/sky-sunset-orbit/20261026T035313Z/original.png` |
| After, Flare, WebGL 2 | `build/lens-flare/final/sky-sunset-orbit/20261026T040132Z/original.png` |
| After, Flare, WebGPU | `build/lens-flare/webgpu/sky-sunset-orbit/20261026T041630Z/original.png` |
| Wide orbital sunset | `build/lens-flare/final/sky-sunset-orbit-wide/20261026T040137Z/original.png` |
| Sun behind Earth | `build/lens-flare/final/night-lights-orbit/20261026T040140Z/original.png` |
| Ground sunset above a Google building | `build/lens-flare/above-building.png` |
| Same Sun hidden by the Google wall | `build/lens-flare/behind-building.png` |
| Sky control and Test tab | `build/lens-flare/shots/index.html` |

[Review gallery and custom test link](../../../app/build/lens-flare/review.html),
[downloadable review bundle](../../../app/build/lens-flare/review.zip).
The bundle contains only selected pictures, the test plan and safe result JSON;
it excludes browser profiles, caches and key-bearing evidence.

The real building check uses loaded Google geometry, with depth writing on
and alpha blending off. With camera surface clearance disabled **in this test
page only**, its Sun ray hits `node0_primitive0` at 9.99 m and the visible
fraction is 0. From 100 m above the wall the fraction is 1. The Sun is about
0.53° above the local horizontal: its air-dimmed light is 9.2–9.7 stops above
white at EV 12, compared with 18.6 above the air. Readings are in
`app/build/lens-flare/building-check.json`. This checks actual geometry,
not a CPU ray as the flare's occlusion implementation.

The isolated final app build is `app/build/lens-flare/app-dist/`.
**Build-directory mistake:** at approximately 04:00 UTC I accidentally ran
the app's default build while preparing feedback artifacts, which overwrote
the shared `app/dist/`. That build finished before it could be stopped; its
previous contents could not be restored. Subsequent builds used only the
isolated directory above. Use that directory for captures, not the shared
dist. This exception to the handoff's build isolation rule is reported here
because another capture may have observed the overwritten build.

## Verification

| Check | Result |
| --- | --- |
| Sky typecheck, validation-tool typecheck, changed-file ESLint | Passed |
| Sky tests | 24 files, 144 tests passed |
| Engine typecheck and tests | Passed; 129 files, 1,399 tests |
| App typecheck and tests | Passed; 78 files, 503 tests |
| 0SFS fly typecheck | Passed |
| 0SFS fly tests | 2,653 passed and 4 expected failures on the initial full run; see the remaining failure below |
| GPU compositor regressions | 32 cases passed across WebGL 2, WebGPU, right-handed WebGL 2 and reverse-depth WebGL 2 |

The GPU checks use explicitly selected Chrome with SwiftShader. They verify
visible, half occluded, fully blocked, half behind Earth, the union of Earth
and a blocker, fully behind Earth, off-axis alignment and identical repeated
still pixels. They also check zero idle frames and complete resource disposal.
The compound Earth/blocker case caught a WebGPU render-target Y mistake; it
now passes on both APIs. The ordinary scene captures used the real app with
Google tiles; WebGL 2 reported ANGLE Metal on Apple M5. WebGPU did not expose
a GPU identity in the capture report.

Run the retained check from `~/gh/foss-earth/sky`:

```sh
CHROME_BIN='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node scripts/validation/lens-flare.mjs \
  --browser-helper=/Users/felg/gh/foss-earth/browser-testing/src/headlessPage.mjs
```

It uses existing tools only, writes to `build/lens-flare/gpu-regression/`,
closes its browser, and takes a few seconds. It is a working-source compositor
check, separate from the existing installed-core qualification workflow.

## Quick cost check

In the retained 600×600, one-blocker software-renderer fixture, ten requested
frames averaged **0.21 ms on / 0.01 ms off** in WebGL 2 and **0.18 / 0.01 ms**
in WebGPU. These are CPU submission measurements, not GPU timings or a
performance claim for a detailed flight scene. Enabled cost grows with the
number of depth-writing occluders. A settled view requested **0 further
frames**. Disabling the compositor left **0 targets and 0 textures** belonging
to it. Default Off constructs no flare resources or shaders.

## Remaining limits

- Fly's full suite is not green because the existing sound benchmark
  `sound/benchmarks/audio/renderSweep.test.mjs:26` expects snapshot size 34,
  while the current `snapshot.h` defines 37. A focused rerun reproduced it.
  The other initial failures (an F135 asset-build timeout under contention,
  and a stowed-gear test needing localhost access) passed when rerun with
  two workers and browser/server access. No unrelated audio or aircraft code
  was changed. Logs: `fly/build/lens-flare/fly-tests.log` and `fly-recheck.log`.
- XR intentionally has no effect; physical headset testing was not performed.
- Moon/lamp ghosts, transparent-glass absorption and a calibrated real-lens
  model are outside this implementation. Angular image normalization uses a
  paraxial square-area approximation; there is no optical vignetting.
- The depth mask resolves 812 disc samples, so thin edges can alias. Geometry
  must be loaded to occlude. The analytic Earth edge follows the sky's sphere.
- Flight cockpit/aircraft rendering was not manually flown in this session.
  Their opaque, alpha-tested and skinned geometry uses the same depth path
  exercised by the shared compositor; a dedicated aircraft visual remains a
  useful hands-on check.
- The capture owner still needs to wire the published field into capture
  readiness/reporting. Their scripts were left untouched as requested.

Start local user testing with `cd ~/gh/foss-earth/app && npm run dev`, then
open the gallery's custom Test link. It uses the default HTTPS port 3600;
Start → try the checks → Finish → Download feedback produces a reviewable
JSON file without uploading it. The same tab was verified on a temporary
port 3617. The temporary server and all owned browsers are stopped at handoff.

Sky is on `main`, with push remote `https://github.com/foss-earth/sky.git`.
After an explicitly requested, separately reviewed commit, the source push
command would be `git -C ~/gh/foss-earth/sky push origin main`; it has not been
run. Ask explicitly if you want a commit or push, keeping other pending hunks
separate.
