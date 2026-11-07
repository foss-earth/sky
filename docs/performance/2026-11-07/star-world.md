# The world's matrix read once for all the stars — 7 November 2026

P-129 in the performance ledger. Sky `6cfc3c8`; baseline sky `e98cb02`
(after P-127). Not an item of the performance limits audit. It came from a
CPU profile of the 0SFS flight app at night at a phone's viewport.

## What it was

The star field turns each star's direction from the Earth's axes into the
scene's through the sky's `toScene` (`starToScene`). That function read the
world's matrix from the host (`getWorldMatrix`) for each star, so about
8,400 times a frame while the stars were drawn again.

The globe gives the matrix by building it again
(`worldRoot.computeWorldMatrix(true)`), through its parents. In fly the
world turns each frame in flight, so the stars are drawn again each frame
at night. At a phone's viewport with 4× CPU throttling, at night, this took
most of the frame:

- Babylon's `computeWorldMatrix`, 161 ms/s of self time;
- the globe's `worldMatrix`, 67 ms/s.

By day, in sky P-128's runs, `computeWorldMatrix` took 6.0 ms/s, and the
globe's `worldMatrix` too little to be listed.

## What changed

`src/babylon/createSkyRuntime.ts`: the star field's `toScene` reads the
world's matrix at its first star and keeps it until the field's update
returns (`starFieldWorld`). The next update reads it again.

## Why it is exact

- Nothing moves the world while the star field works out its stars. The
  field calls `toScene` only inside its update, which changes no transform.
- Each read built the same matrix from the same transforms, into the same
  object. The stars read only its values.
- The matrix is read when the field asks for a direction, as before, so
  every update that read it at least once still does. Building it again
  also has effects for the nodes, and they stay as they were:
  - its children and its parent's other children are marked out of date
    (`_childUpdateId`), which one read does as well as many, since none of
    them is brought up to date during the field's update;
  - its `onAfterWorldMatrixUpdateObservable` is notified once and not
    8,400 times. No code in FOSS Earth or 0SFS observes it.
- The reference is dropped when the update returns, even if it throws.

## Proof

- **Differential harness** (`build/star-world/diff.test.ts`, NullEngine).
  A vite plugin serves `createSkyRuntime.ts` at HEAD or the working tree
  under the same module path.
  - The world is a node under a parent that turns and moves, read as the
    globe reads it. It has a child.
  - The tours are those of sky P-127: one with the page evaluating and one
    with an in-process worker evaluator, 55 steps each, the world turning
    between them.
  - After every step, the trace records:
    - the data last uploaded to the dome's and the stars' vertex buffers;
    - the transforms;
    - the lights;
    - the terrain lighting;
    - the environment;
    - the render requests;
    - the child's world matrix.
  - HEAD and the change give identical traces (110 steps). The A/A run is
    identical too.
  - The world's matrix was read 824,657 times over both tours at HEAD, and
    1,163 times with the change. In a frame after the world turns, that is
    8,413 reads at HEAD and 10 with the change.
- The P-127 harness (`build/sky-show/diff.test.ts`) gives the world as a
  new matrix at each turn. Its trace is unchanged.
- **`tests/star-world.test.ts`**: a new test. With the world given as the
  globe gives it, an update after a turn reads the matrix fewer than 20
  times, and the stars are where a new sky at that turn puts them. It
  fails on HEAD, with 8,413 reads.
- **Mutants** (`build/star-world/mutants.py`): 3 of 4 caught.
  - Caught:
    - the first update's matrix kept, which the plain-matrix harness and
      `tests/dome-writes.test.ts` catch, since the node's matrix is one
      object built again in place;
    - a read at every star;
    - a copy of the matrix kept across updates.
  - The survivor reads a missing world again, at each star. This is
    equivalent: it gives the same identity transform.
- `npm run typecheck`, and `eslint` on both files, pass. Fly's
  `npm run typecheck` passes.
- The sky's suite: 149 pass and 2 fail, the same 2 in
  `src/skyState.test.ts` that fail before this change (sky P-127).

## Measured

- **Node** (`build/star-world/bench.test.ts`, NullEngine): the default
  dome and all 8,404 stars out at midnight, at a fixed exposure, on the
  page. The world is the node chain above. One process per run, 9
  interleaved rounds, 500 updates each after a warm-up. Medians, with the
  ranges:

  | `update`, µs | HEAD | The change |
  | --- | ---: | ---: |
  | The world turned before each update | 873 (862–898) | 209 (208–210) |
  | The world still | 5.4 (4.6–6.0) | 4.4 (4.3–4.5) |

  These are Node timings, not a frame rate.
- **Chrome**: fly in flight, at the phone's viewport (412 × 915 at 2.625)
  with 4× CPU throttling, at night (`?set.sky.time.utcHours=6`, near
  midnight over Minneapolis, where fly starts). Research's `profile.mjs` took 10 s in
  flight, 15 s after content. The builds were interleaved: before, after,
  after, before. Times are ms/s of main-thread CPU. The sky's and the star
  field's updates include what they call; the other two are self time.

  | Run | fps | Frames over 25 ms, % | Main thread, % | Script, % | Sky `update` | Star field `update` | `computeWorldMatrix` | Globe `worldMatrix` | `writeBuffer` |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
  | Before 1 | 40.1 | 39 | 99 | 82 | 315.0 | 306.3 | 142.0 | 70.9 | 32.3 |
  | After 1 | 54.4 | 3 | 86 | 67 | 69.8 | 59.4 | 10.2 | 0 | 44.5 |
  | After 2 | 54.9 | 2 | 84 | 65 | 69.0 | 58.5 | 8.8 | 0 | 41.4 |
  | Before 2 | 37.7 | 45 | 99 | 82 | 318.3 | 308.0 | 144.0 | 74.3 | 32.7 |

  - The frame rate: 40.1 and 37.7 → 54.4 and 54.9 fps.
  - Frames over 25 ms: 39 % and 45 % → 3 % and 2 %.
  - The main thread: 99 % → 86 % and 84 % of a core.
  - `writeBuffer` rises because more frames are drawn, and each frame
    uploads the stars' positions.
- Not measured on a desktop. On a desktop by day the catalogue does not
  load (sky P-127), so nothing changes there. At night the same reads were
  made, unthrottled.

## Left

- At night the star field still works out and uploads all its squares
  each frame the world turns. In the first run after the change, its 59.4
  ms/s was:
  - the positions' upload, 24.5;
  - the directions turned into the scene (`starToScene`), 8.1;
  - the field's own loop, the rest.

  Fly turns the world by its travel over the Earth: at 250 m/s and 60
  frames a second, about 6.5 × 10⁻⁷ rad a frame. With a field of view of
  0.8 rad across that phone's 2,402 pixels, that is about 0.002 of a
  pixel. Two ways to avoid most of this work, both of which change
  pixels:
  - keep the squares while the world has turned by less than a small
    share of a pixel, as the field already does for the pixel's angle
    (`PIXEL_ANGLE_TOLERANCE`, 1 %);
  - draw the field under the world's turn as the mesh's rotation, and
    write the squares only when the view or the sky changes.

  Either needs a decision on the tolerance, so neither is done here.
- The globe builds the world's matrix again at every read
  (`computeWorldMatrix(true)`), through its parents. The sky alone reads it
  about 10 times in a frame after a turn (the harness). In these runs,
  `computeWorldMatrix` still took 8.8 and 10.2 ms/s of self time, and 6.0
  by day. Building the matrix once a frame would need the globe to know
  when the floating origin moves it, so it is not done here.
