# The sky dome written when it changes, not each time the world turns — 7 November 2026

P-127 in the performance ledger. Sky `4e8fbaa`; baseline sky `0f91945`. Not
an item of the performance limits audit. It came from a CPU profile of the
0SFS flight app at a phone's viewport.

## What it was

The sky runtime shows its light (`show`) again when something it draws has
changed:

- a new evaluation;
- a setting;
- the ground's light;
- the lamps below;
- the stars' view.

The stars' view includes the world's turn (`starWorldTransform`). The stars
are drawn in the scene's axes, so a turned world must turn them.

Fly keeps the aircraft at the scene's origin and turns the world around it
(`createFloatingOrigin`, in ground-contact). The world's rotation is the
local frame at the aircraft, so in flight it changes every frame. So once
the star catalogue had loaded, `show` ran every frame. A fly build with
counters, over 10 s in flight, 15 s after content:

| Viewport | `update` per s | `show` per s | Set by the world's turn, per s |
| --- | ---: | ---: | ---: |
| Desktop, 1280 × 800, by day | 60.0 | 0.9 | 0 (no catalogue) |
| Phone, 412 × 915 at 2.625, 4× CPU, by day | 59.3 | 59.3 | 59.3 |

The catalogue loads once a star could show at the view's pixel size. That
happened by day at the phone's viewport, and did not at the desktop's. At
night it loads on any screen.

Each `show` rewrote the dome's vertices (2,854 at the default 32 × 32):

- three powers per vertex for the colours;
- the positions;
- both buffers uploaded (`updateVerticesData`: two `writeBuffer` calls, and
  the dome's material marked dirty for its attributes).

None of it depends on the world. The colours are the geometry's luminances
at the exposure's scale, and the positions are the geometry's directions.
The world only turns the mesh, through its rotation, which `show` still
sets each time.

`showStars` also worked out `celestialToEcefMatrix` (a solar position) again
for the same instant.

## What changed

`src/babylon/createSkyRuntime.ts`:

- The dome keeps the scale its vertices were last written at
  (`writtenScale`). `show` writes and uploads them only when the scale
  differs.
- Filling the dome again clears `writtenScale`, on the page (`fillSkyDome`)
  and from the worker (`applyEvaluation`). A new dome starts without one.
- The stars' turn into the Earth's axes is kept with the instant it is for
  (`starToEcef`), and worked out again for a new instant.

## Why it is exact

- The vertex values are a function of the geometry's luminances and
  directions and of the scale. The scales are compared with `Object.is`.
  When neither changed, the buffers already hold what would be written.
- The geometry's arrays are written in two places, `fillSkyDome` in
  `update` and the copy in `applyEvaluation`. Both clear `writtenScale`.
- Besides the arrays and the uploads, the skipped update only:
  - drops the geometry's cached positions for picking (the dome is not
    pickable);
  - disposes WebGL vertex array objects;
  - marks the dome's submeshes dirty for their attributes, which are the
    same.

  None of these changes what is drawn.
- `celestialToEcefMatrix` depends only on the instant (ΔT is a constant).
  The star field reads the matrix's values, and does not keep or change it.
- Everything else `show` does still runs, in the same order:
  - the lights;
  - the terrain lighting and the local lights;
  - the dome's rotation and mirror;
  - the stars;
  - the background;
  - the listeners.

## Proof

- **Differential harness** (`build/sky-show/diff.test.ts`, NullEngine). A
  vite plugin serves `createSkyRuntime.ts` at HEAD (`VARIANT=head`) or the
  working tree under the same module path.
  - Two tours, one with the page evaluating and one with an in-process
    worker evaluator, 55 steps each. The world turns between the steps.
  - The steps cover:
    - the start, with the catalogue loading;
    - a new fixed exposure;
    - a new time at the same exposure, which fills the dome again at the
      same scale;
    - metered exposure;
    - dusk;
    - the Moon's mode;
    - the field of view;
    - a new dome size;
    - the lights-only model and back;
    - stars off and on;
    - the sky off and on;
    - night at a fixed exposure.
  - After every step, the trace records:
    - the data last uploaded to each of the dome's and the stars' vertex
      buffers, hashed from the upload itself;
    - the arrays on the page;
    - the meshes' transforms and whether they are enabled;
    - the lights;
    - the background;
    - the terrain lighting and the local lights last set, and how often;
    - the environment the listeners got and `getEnvironment`;
    - the render requests.
  - HEAD and the change give identical traces (110 steps, `trace-head.txt`
    and `trace-fixed.txt`), and the A/A run gives the same trace again.
  - Uploads of the dome's buffers on the page, by the field-of-view step:
    30 at HEAD, 6 with the change, one for each new dome, evaluation or
    exposure.
- **`tests/dome-writes.test.ts`**: a new test, for the page and the worker.
  - While the world turns, the Sun's light and the stars follow it, and the
    dome's buffers are not sent again.
  - A new evaluation at the same exposure, then a new exposure, each send
    them once, and they are what a new runtime at those settings sends.
  - It fails on HEAD, with 7 and 8 uploads where 2 and 3 are expected.
- **Mutants** (`build/sky-show/mutants.py`): 10 of 10 caught.
  - The test catches HEAD and a written scale that is never kept.
  - The harness, the test or both catch:
    - either fill not clearing the scale;
    - the scale not compared;
    - either buffer not sent;
    - the stars keeping their first turn, or the comparison inverted;
    - the dome's rotation skipped with the vertices.
- `npm run typecheck`, and `eslint` on both files, pass. Fly's `npm run
  typecheck` passes.
- The sky's suite: 148 pass and 2 fail, both in `src/skyState.test.ts`
  (the dome's sampled bits for 2026-10-25T18:00Z). They fail the same way
  when that file runs alone. It does not import the runtime, so the failure
  is not from this change.

## Measured

- **Node** (`build/sky-show/bench.test.ts`, NullEngine): the default dome
  and all 8,404 of the catalogue's stars out at midnight, at a fixed
  exposure, on the page. One process per run, 9 interleaved rounds, 2,000
  updates each after a warm-up. Medians, with the ranges:

  | `update`, µs | HEAD | The change |
  | --- | ---: | ---: |
  | The world turned before each update | 416 (413–439) | 201 (199–205) |
  | The world still | 3.96 (3.66–4.35) | 4.03 (3.96–4.14) |

  With the world still, `show` does not run, and the times are alike. In a
  Node CPU profile of the change, the turning update's remaining time is
  the star field's update. These are Node timings, not a frame rate.
- **Chrome**: fly in flight, at the phone's viewport (412 × 915 at 2.625)
  with 4× CPU throttling, by day. Research's `profile.mjs` took 10 s in
  flight, 15 s after content. The builds were interleaved: before, after,
  after, before. Times are ms/s of main-thread CPU. The sky's `update` and
  `show` include what they call.

  | Run | fps | Main thread, % | Script, % | Sky `update` | `show` | `writeBuffer` | `isReadyForSubMesh` | GC |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
  | Before 1 | 55.6 | 73 | 56 | 32.4 | 24.6 | 23.5 | 10.9 | 4.4 |
  | After 1 | 55.7 | 73 | 56 | 14.3 | 6.1 | 20.3 | 10.0 | 4.2 |
  | After 2 | 55.9 | 75 | 57 | 13.7 | 4.5 | 21.0 | 9.8 | 8.1 |
  | Before 2 | 55.2 | 77 | 58 | 33.9 | 26.2 | 23.5 | 10.1 | 5.9 |

  - The sky's `update`: 32.4 and 33.9 → 14.3 and 13.7 ms/s.
  - `show`: 24.6 and 26.2 → 6.1 and 4.5 ms/s.
  - `writeBuffer`: about 2.5 to 3 ms/s less.
  - The main thread and the frame rate are within noise.
- Not measured on a desktop at night. On a desktop by day the catalogue did
  not load and `show` ran 0.9 times a second, so nothing changes there.

## Left

- `show` still runs each frame the world turns while the catalogue is
  loaded, for the lights, the terrain lighting, the stars and the
  listeners. The world-turn trigger fires even when no star is drawn, but
  skipping `show` then would stop the lights following the world. Of the
  sky's 14.3 ms/s in the first run after the change:
  - `show`, 6.1. This includes fly's listener (`noteExhaustReferences`,
    1.6) and `showStars` (1.2).
  - `instant`, 3.6. Of this, the settings registry's `mutate` takes 3.0:
    `instant` clears the date's note each frame, even when it has none.
    Parsing the date takes 0.5.
  - The night lights, 1.4.
- At night, the star field works out all its squares again each frame the
  world turns, and uploads their positions: 8,404 stars, 403 KB. This is
  the Node bench's remaining 200 µs. Drawing the stars under the world's
  turn, or keeping them while it has turned by a small part of a pixel,
  would change pixels, so neither is done here.
