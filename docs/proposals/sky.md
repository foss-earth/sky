# Sky: the Sun, the sky and one scale of luminance

Status: rungs 0 to 2 of the [ladder](#the-ladder) implemented on 2026-10-07, with
the Moon, the stars, ground lit by each point's own Sun and Moon, light from the
ground, and the shared **Sky** tab. Checked on the CPU, with Babylon's NullEngine,
and by reading pixels drawn by Chrome's software renderer through WebGL 2, WebGL 1
and WebGPU. No check has run on a real GPU or with real map tiles, so nothing here
says how a frame looks. [Validation](#validation) separates what is verified from
what is not.
Owner: FOSS Earth. 0sfs consumes it for the flight
([`0sfs/docs/foss-earth-relationship.md`](../../../0sfs/docs/foss-earth-relationship.md)).
Earlier research on sky rendering in Babylon:
[`0sfs/docs/proposals/skies.md`](../../../0sfs/docs/proposals/skies.md).

## Why

On 2026-10-07 the user flew 0sfs at night-like settings, **Ambient fill
multiplier 0.02** and **Exposure compensation +8.8 EV**, and saw the F135's red
exhaust in dry mode for the first time. At the same settings the aircraft and the
ground were solid white. Their hypothesis: the exhaust was not the problem, the
missing Sun and sky were.

The code agreed with the shape of that. The scene had no physical light. Lit
surfaces had hemispheric fill lights of no unit (1.1, 1.0 and 0.95 times the
multiplier); map imagery was unlit and shown at its photograph's brightness at any
hour; the background was a fixed colour. The exhaust alone had a unit: it computes
luminance in cd/m² and shows it against a provisional white of 1000 cd/m². With no
common scale there was no exposure at which a dim emitter and the night around it
could both be right: +8.8 EV made the emitter visible (white at 2.2 cd/m²) and
multiplied the photographs on the ground by 446 and the fill, cut to 0.02, by 8.9.

This spec gives everything one scale. Light is computed in lux and cd/m² from the
Sun's position and a model of the atmosphere, and every value reaching the screen
is a luminance divided by the luminance the exposure shows as white.

## One scale

| Quantity | Unit | Where it comes from |
| --- | --- | --- |
| Sun's illuminance above the air | lux | 133,334 lx at 1 AU (Darula, Kittler and Gueymard 2005), over the Earth–Sun distance squared |
| Sun's and sky's light at the viewpoint | lux in three bands | [The atmosphere](#the-atmosphere), per unit of the above |
| Sky, ground and Sun's disc | cd/m² in three bands | The same model, along each line of sight |
| Night sky | cd/m² | `sky.night.luminance` |
| Moon's illuminance above the air | lux | Its magnitude by its phase against the Sun's, at its distance today ([The Moon](#the-moon)) |
| A star's illuminance above the air | lux | Its catalogue magnitude against the Sun's ([Stars](#stars)) |
| A lamp's intensity | cd in three bands | The application's photometry for it ([Lamps](#lamps)) |
| Exposure | EV at ISO 100 | Metered, or fixed (`sky.exposure.*`) |
| White | cd/m² | `1.2 × 2^EV` (ISO 12232, saturation-based) |
| A value on screen, before encoding | ratio | luminance ÷ white |

The meter reads light falling at the viewpoint as an incident-light meter does
(ISO 2720, C = 250): EV = log2(0.4 × E), where E is the Sun's and the Moon's light
on surfaces facing them plus the sky's on a level one, in lux, by luminance (BT.709
weights). With these two standards a perfectly white Lambertian surface facing the
Sun shows at two thirds of white (1/π ÷ (1.2 × 0.4) = 0.663). Exposure stays inside
the user's `sky.exposure.meterRange`; outside it the reading shows where the meter
is and that the scene is left darker or brighter. Fixed mode holds
`sky.exposure.ev100` for comparisons.

**Exposure follows the light part of the way down.** A camera's meter shows a scene
at one brightness whatever lights it. Dusk then looks as bright as noon, and with
the Sun just under the horizon the meter reads the sky alone and shows it at two
thirds of white. Eyes do not: dusk looks darker than day. `sky.exposure.adaptation`
is how many stops exposure moves for each stop the light falls below what the meter
would read under a Sun overhead, at the viewpoint's height:
`EV = EV_overhead − a × (EV_overhead − EV_meter)`. At 1 it is the camera's meter;
at 0 exposure stays at noon's. A reading above the
overhead Sun's is followed whole, and the range still bounds the result. The default
is 0.75. At the equator on an equinox with no Moon, as shares of white:

| Sun | Meter | Adapted, a = 0.75 | Ground of reflectance 0.3 | Sky's mean | Ground and sky at a = 1 |
| --- | --- | --- | --- | --- | --- |
| 60° | EV 15.6 | EV 15.6 | 0.18 | 0.10 | 0.18, 0.10 |
| 10° | EV 14.2 | EV 14.5 | 0.046 | 0.078 | 0.059, 0.10 |
| 2° | EV 10.8 | EV 12.0 | 0.043 | 0.14 | 0.10, 0.32 |
| 0° | EV 8.8 | EV 10.5 | 0.060 | 0.20 | 0.20, 0.65 |
| −2° | EV 7.3 | EV 9.4 | 0.046 | 0.16 | 0.20, 0.66 |
| −4° | EV 4.6 | EV 7.4 | 0.030 | 0.099 | 0.20, 0.66 |
| −6° | EV 1.0 | EV 4.7 | 0.016 | 0.053 | 0.20, 0.66 |

The last column is what the user flew on 2026-10-07 and found far too bright: once
the Sun was down, the sky was held at two thirds of white on average, and its glow
towards the Sun went well past white. 0.75 is a starting point to tune by eye, not
a measurement of how eyes adapt.

**Exposure is applied once.** The sky's exposure is one division, done where each
physical value is written: light intensities, the dome's colours, the background,
the imagery factor and, in 0sfs, the exhaust's reference. Nothing is divided again
in a shader. `renderer.exposureEV` stays a display multiplier of 2^EV on top
(compensation), applied by Babylon's image processing to every material that uses
it (PBR, standard, the 0sfs exhaust's shader) and by the sky to its background
colour, which skips image processing. Display encoding happens once, in the
material's image processing or, for the background, in the sky runtime. There is
no tone mapping: values above white clip, as they always have here.

One thing is shown against a white of its own, and says so: the stars, from high
above the ground by day ([Stars](#stars)). Everything else shares the one exposure.

An emitter of luminance L writes L ÷ white. Under a sky model 0sfs passes the white
as the exhaust's gas and surface references in place of their provisional 1000
cd/m²; no source luminance, temperature, soot or hue changes.

## The ladder

Each rung adds to the one below. All rungs share one solar position and one
atmosphere, so a device on a lower rung sees the same light, only less of the sky
drawn. The rung is the user's choice, `sky.model`; nothing picks it from a device
name.

| Rung | `sky.model` | Adds | Recomputed when the Sun or height moves | Every frame | GPU resources | Runs on |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | `off` | Nothing: the fixed background and the fill lights, as before | Nothing | Nothing | None | Anything |
| 1 | `lights` | A light for the Sun, or for the Moon when it gives more; a sky light; a background colour; map imagery lit by each point's own Sun and Moon; metered exposure | 192 lines of sight, and as many for the Moon: 1 ms | Two lights in each lit material's shader; in map imagery's, two table look-ups a pixel | A table of 27 samples in the imagery shader's uniforms | Any WebGL 1 device |
| 2 | `dome` | The sky, the Sun's disc and the Moon's with its phase as one mesh with a colour per vertex; the stars as a second | 1,387 more lines of sight at the defaults: 3 ms. On a night with the Moon up, 2,688 more for the sky it lights: 8 ms in all. The stars' places and colours: 2.5 ms | Two draw calls: 5,532 triangles, and 16,808 for 8,404 stars while any is bright enough to show | A 78 KiB vertex buffer, and the stars' 1.35 MiB of buffers and one 4 KiB texture. No render target or shader of its own | Any WebGL 1 device |
| 3, planned | | The sky computed per pixel from a sky-view table on the GPU, and aerial perspective: distant terrain hazed and coloured by the air between | Table passes | Lookups per pixel | Half-float render targets | WebGL 2, WebGPU |
| 4, planned | | Volumetric clouds, ray-marched at reduced resolution and reconstructed over frames | | Compute passes | 3D textures | WebGPU |

Shared by rungs 1 to 4: the atmosphere's tables, 106 KiB, built in about 65 ms
when the haze or the ground albedo changes; the Sun's position, 6 µs; and the
Moon's, 11 µs. Milliseconds are single-threaded JavaScript on the development Mac
while in use, not qualified measurements (`cost.qualified: false` in the
[evidence](../../validation/evidence/sky/2026-10-07-sky-model/sky-model.json)).

Beside the rungs, each its own setting with its cost shown: the Moon
(`sky.moon.mode`), the stars (`sky.stars.mode`), how map imagery is lit
(`sky.surface.lighting`) and where the light from the ground comes from
(`sky.groundLight.mode`). The one that renders anything more is the last, when set
to Rendered: an image of the ground below, 16 pixels across, twice a second
([Light from the ground](#light-from-the-ground)).

The default is `dome`, on the globe and in the flight: the planet lit as it is at
that hour, with its day, twilight and night where they are. `off` shows the map as
its imagery is at any hour, for debugging and for devices too slow for the sky.
Presets change how finely the dome is sampled and how often it is recomputed, not
the rung; *This device* puts the rung and the four settings above back at their
defaults.

Rung 3 is where the dome's limits go: a sky sampled per vertex is smooth only as
far as its vertices are close, and terrain is not hazed by distance. Babylon's
atmosphere addon (`@babylonjs/addons`, not a dependency here; the earlier research
assumed Babylon 9, and this checkout has core 8.56.2) is a candidate for it after
its version, licence, backends and resource cost are checked against this
checkout. A rung 3 of our own would keep the CPU model as its reference. Rung 4
needs weather input and clouds that cast light, which nothing here has yet.

## The Sun

[src/sky/solarPosition.ts](../../src/sky/solarPosition.ts) is the Solar Position
Algorithm of Reda and Andreas (NREL/TP-560-34302, revised January 2008): stated
uncertainty ±0.0003° in zenith and azimuth for the years −2000 to 6000. Its
periodic terms (Tables A4.2 and A4.3) were extracted from the report's text by
[scripts/sky/extract-spa-terms.mjs](../../scripts/sky/extract-spa-terms.mjs) into
[solarPositionTerms.ts](../../src/sky/solarPositionTerms.ts); no code was copied.
The report's example (Table A5.1) is reproduced to every printed digit, and its
intermediate values to five decimals.

- The clock gives UTC, which is taken as UT1, and ΔT defaults to 69.184 s, TT −
  UTC since 2017. UT1 − UTC stays under 0.9 s, which turns the Sun's hour angle by
  up to 0.004°: more than the algorithm's own uncertainty, a twelfth of the
  default recompute angle.
- The Sun is placed from the viewpoint, parallax included, in Earth-centred,
  Earth-fixed coordinates, so the floating origin, a turned world and a height
  above the ellipsoid all agree (tested).
- Refraction is the report's, with the standard atmosphere's pressure and
  temperature at the viewpoint's height (ISO 2533). The report stops refraction
  where the disc's top meets the horizon, which would make the drawn Sun jump by
  more than its width; for drawing it fades from that value to none at 6° below.

The time is the device's clock or a set UTC date and hour, set on the
[Date and time tab](#date-and-time). The Sky tab opens with a line saying where the
Sun is at that time from the place shown, its elevation and bearing, and a button
that opens Date and time.

### Date and time

The **Date and time** tab sets the instant on two dials, side by side where the tab
is wide enough and one under the other where not: a paragraph grid of two items
140 px across, which a 320 px panel holds side by side. Each is a circular slider
(`src/shell/dial.ts`): a knob on a ring, moments marked round the edge, a readout
and a button in the middle.

- **Solar time.** Both dials read as a sundial at the place shown would: local
  apparent solar time, 12:00 when the Sun is on the meridian and 00:00 when it is
  opposite. It is UTC plus four minutes for each degree east plus the equation of
  time, which [src/sky/solarDay.ts](../../src/sky/solarDay.ts) takes from the
  algorithm's hour angle (14.638 minutes for the report's example, and the year's
  extremes of −14.2 and +16.4 minutes, tested). The instant is still stored in UTC,
  to the second, under the same ids, so moving the camera east moves the knob on
  while the Sun stays where the instant puts it.
- **The time dial** is one solar day: midnight at the bottom, noon at the top, the
  morning on the left, so the knob stands as high as the Sun. Its ring is shaded
  night, astronomical, nautical and civil twilight, and day, from the times the
  Sun's centre crosses −18°, −12°, −6° and −0.833° (the disc's top on the horizon,
  as almanacs time sunrise). Those come from the declination at the day's two
  midnights and the hour angle at each elevation, refined twice at the crossing's
  own declination: within 0.02° of the algorithm's elevation at every crossing
  tested, from Quito to Tromsø. Its marks are Sunrise, Noon, Sunset and Midnight;
  where the Sun does not rise or set that day, those marks are left off and a line
  says so.
- **The date dial** is one year: the mean June solstice at the top, so the knob's
  height follows the Sun's declination, and the year running clockwise. Its ring is
  shaded by the length of the day at the place's latitude, in 73 five-day
  stretches, from the polar night's colour to the polar day's. Its marks are the
  equinoxes and solstices, found where the Sun's apparent longitude is 0°, 90°, 180°
  and 270° (within 2 minutes of the U.S. Naval Observatory's times for 2024, tested).
- **Turning.** Pressing the ring takes the knob there within the day or year shown.
  Dragging carries on past midnight into the next day, and past the year's end into
  the next year, as a clock's hand does. Pressing a mark sets that moment: on the
  time dial within the date shown, on the date dial keeping the time of day. The
  knob takes a slider's keys: the arrows step a minute or a day, Page Up and Page
  Down an hour or a month, Home and End the day's or the year's start and end.
- **Now and Today.** Now, in the time dial's middle, follows the device's clock;
  anything else sets a time. Today, in the date dial's middle, sets today's date and
  keeps the time of day. While a time is set, a hollow ring on each dial shows where
  the clock is.
- The middle of each dial is also a field: type a time as `9`, `0930` or `09:30`, or
  a date as year-month-day. One that cannot be read puts back what was there.
- Under the dials, one line each gives the instant (solar time, UTC and this
  device's clock), the time zones, the day's sunrise, sunset and length, and the
  place.
- **Time zones.** The dials are in no zone: solar time is the place's own. The zones
  line names the zone this device's clock keeps, with its offset from UTC at the
  instant shown, from the device's own settings; and the hour the place shown lies
  in by its longitude alone, as zones run at sea, each 15° wide about its meridian.
  The civil time kept at the place is not known to the app: that needs a map of the
  zones' boundaries, which is not in it ([TODO](../../TODO.md)).
- The tab looks again at the clock and the place once a second while it is on
  screen, and draws only when something it shows has changed. It asks the renderer
  for nothing itself: the sky follows the parameters.
- These times are for the sea-level horizon, as an almanac's are. From an
  aircraft the horizon dips, and the sky model, which follows the viewpoint, shows
  the Sun up a little earlier than the dial's sunrise.

## The atmosphere

[src/sky/atmosphere.ts](../../src/sky/atmosphere.ts) models a clear atmosphere
around a spherical Earth: air molecules (Rayleigh), haze (Mie, with the
Cornette–Shanks phase function, asymmetry 0.8) and ozone, with the constants of
Bruneton's 2017 reference implementation, for three bands at 680, 550 and 440 nm
taken as the display's red, green and blue. Light scattered once is integrated
along each line of sight; light scattered more often is Hillaire's isotropic
estimate (2020), summed as a geometric series. Everything is computed per unit of
the Sun's illuminance above the air; [skyState.ts](../../src/sky/skyState.ts)
gives it its units.

Three tables keep the expensive parts. Light falling by orders of magnitude
between neighbouring samples is kept as its logarithm, which interpolates along
the curve where the light itself would bow above it.

| Table | Size | Held as |
| --- | --- | --- |
| Transmittance to the top of the air, by height and direction | 128 × 64 × 3, 96 KiB | Optical depth |
| Light scattered more than once, by height and the Sun's height | 24 × 33 × 3, 9.3 KiB | Logarithm; 25 of the Sun's 33 samples between 27° below the horizon and 9° above |
| The sky's light on level ground at sea level, by the Sun's height | 48 × 3, 0.6 KiB | Logarithm; 36 of 48 samples between 20.5° below and 9° above |

Accuracy, from [atmosphere.test.ts](../../src/sky/atmosphere.test.ts) and the
[evidence](../../validation/evidence/sky/2026-10-07-sky-model/sky-model.json):

- Transmittance within 1.1% of brute force along slanting paths from sea level to
  40 km.
- Sixteen steps along a line of sight within 5.2% of 512 at every direction and
  Sun height tested, twilight included; eight steps 22.5%, 32 steps 1.3%.
- The sky's light on a level surface (12 rings × 16 bearings, in equal steps of
  zenith angle so a Sun overhead is not missed) within 2% of a 72 × 72 sum by day
  and through civil twilight, 10% to the Sun 13° down. The ground table agrees
  with that sum to the same bounds at every quarter degree from 18° down to
  overhead.

At the equator on an equinox, with haze 0.1 and the default night sky:

| Sun | Sun's light | Sky's light | Level ground | Meter |
| --- | --- | --- | --- | --- |
| 88° | 107,000 lx | 19,400 lx | 126,000 lx | EV 15.6 |
| 30° | 85,600 lx | 14,000 lx | 56,800 lx | EV 15.3 |
| 10° | 39,200 lx | 7,000 lx | 13,800 lx | EV 14.2 |
| 0° | 23 lx | 1,100 lx | 1,090 lx | EV 8.8 |
| −6° | | 5.2 lx | 5.1 lx | EV 1.0 |
| −12° | | 0.0032 lx | 0.0032 lx | |
| −18° | | 0.00064 lx | 0.00064 lx | |

The American Meteorological Society's Glossary gives about 3.5 to 2 lx where civil
twilight ends (6° down), 0.008 lx at 12° and 0.0006 lx at 18°. The model is 1.5 to
2.6 times the first, 0.40 times the second and 1.07 times the third, which is the
night sky's own light. Its twilight falls faster than observed between 6° and 12°,
the expected direction for an isotropic estimate of light scattered many times.

Not modelled: clouds; water vapour and absorbers other than ozone; haze that varies
with wavelength, place or time; mountains' shadows in the air; refraction of the
lines of sight (only the Sun and the Moon are lifted); polarization; light the
ground sends back into the air other than by its uniform albedo
(`sky.atmosphere.groundAlbedo`); cities' light; more than three bands.

## Night

Below the horizon the Sun's light still reaches the air above, and the model
follows it down until the Earth's shadow covers the sky. Beyond that the light is
the Moon's, the stars' and `sky.night.luminance`: a uniform sky of airglow and of
the stars too faint to draw, added in every direction above the horizon and to the
light on surfaces (π × L on a level one). Its default, 0.0002 cd/m², is a moonless
sky far from cities, 0.0006 lx on level ground. A city's sky is 0.01 to 0.1 cd/m²,
within the parameter's range.

With no Moon up the meter reads about EV −12 and the default adaptation makes that
EV −5, below the default range's floor of EV 1, so exposure stays at EV 1 and white
is 2.4 cd/m². An emitter of 1 cd/m² then shows at 0.42 of white, while ground of
reflectance 0.3 under the night sky shows at 0.00003: black. The floor is a display
choice, the longest exposure the user accepts, with the reason given beside it;
lowering it shows the night sky's own light on the ground and drives emitters
further past white. It changes no source.

### The Moon

[src/sky/lunarPosition.ts](../../src/sky/lunarPosition.ts) places the Moon by
chapter 47 of Meeus's *Astronomical Algorithms*: the 60 largest terms of the
ELP-2000/82 theory's longitude and distance and the 60 of its latitude, within about
10″ and 4″. Its nutation, obliquity and sidereal time are the solar position
algorithm's, so the Sun and the Moon share one clock and one frame. Meeus's worked
example (47.a) is reproduced to every printed digit.

- **Place.** One evaluation gives the Moon's centre in Earth-centred, Earth-fixed
  metres for everywhere on Earth. Each viewpoint subtracts its own position, which
  is the parallax, up to a degree. On the centre line of the eclipse of 8 April 2024
  the Moon's centre passes within 11″ of the Sun's (tested). Refraction lifts it as
  it lifts the Sun.
- **Light.** Its visual magnitude at its mean distance, by its phase angle i in
  degrees, is −12.73 + 0.026 |i| + 4 × 10⁻⁹ i⁴ (Allen's fit, as Krisciunas and
  Schaefer use it). That becomes lux against the Sun's −26.74 at 133,334 lx, then
  by the inverse square of its distance today: 0.33 lx above the air at full Moon
  and 0.030 lx at a quarter. Its colour is sunlight's shifted by the Moon's colour
  indices, 0.27 magnitudes fainter in blue and 0.11 brighter in red at the same
  luminance.
- **Through the air.** Moonlight passes the same atmosphere as sunlight: the same
  transmittance, the same sky scattered from it, the same table of light on level
  ground. A full Moon 62° up over Minneapolis on 2026-10-26 gives 0.27 lx direct
  and 0.040 lx from the sky it lights, 0.28 lx on level ground. Published values for
  a full Moon on a clear night run from 0.05 to 0.3 lx, by its height and distance
  (Kyba, Mohar and Posch 2017).
- **Exposure.** That night the meter reads EV −3.0, the default adaptation makes it
  EV 1.7, and ground of reflectance 0.3 shows at 0.007 of white: a landscape that
  can be made out, not a day.
- **The disc** is 145 of the dome's vertices, each coloured by Lommel–Seeliger
  reflection of the Sun's light from that part of the Moon, scaled so that the whole
  disc's light is the Moon's direct light at the viewpoint, over the sky in front of
  it. Its unlit part shows that sky alone and hides the stars behind it. Earthshine
  is not modelled.
- **The moonlit sky** is drawn on the dome when `sky.moon.mode` is *Light, disc and
  sky* and the Moon's sky gives at least a hundredth of the sunlit sky's light on a
  level surface (`MOONLIT_SKY_SHARE`); below that it would change no colour by more
  than a percent. It has no symmetry about the Sun's bearing, so it is sampled at
  every vertex: 2,688 samples at the defaults.
- **One directional light.** The scene's directional light carries the Sun's light
  or, when it gives more at the viewpoint, the Moon's, so a night costs lit
  materials no more than a day. At dusk with both up, the dimmer of the two reaches
  lit surfaces only through the sky's light; map imagery has both from its table.

### Stars

[src/sky/stars.ts](../../src/sky/stars.ts) holds the 9,096 stars of the Bright Star
Catalogue (5th revised edition; CDS V/50): J2000 places, V magnitudes, B−V colours
and proper motions, packed by
[scripts/sky/build-star-catalogue.mjs](../../scripts/sky/build-star-catalogue.mjs)
into 16 bytes a star, brightest first: 145 kB, which is a file of 196 kB in the
app, 135 kB compressed. It is downloaded when the sky first gets dark enough for a
star to show at the exposure in use, and not by day: Sirius with no air in its way,
and twice its light allowed for a star's colour, is tried against the least share
of white that is drawn. The Stars setting's reading says which of the three it is:
not needed, loading or drawn.

- **Place.** Proper motion to the year, precession by the IAU 1976 angles (Meeus's
  example 21.b within 0.01″), then the Earth's turn by Greenwich apparent sidereal
  time. Nutation's own shift of the stars and aberration, each about 20″ at most,
  are left out: a pixel spans a few arc minutes.
- **Light.** A star's magnitude becomes lux as the Moon's does: Sirius gives
  1.0 × 10⁻⁵ lx and a star of magnitude 6.5 gives 6.7 × 10⁻⁹ lx. Its colour is a
  black body's at the temperature its B−V gives (Ballesteros 2012), sampled at the
  three bands and taken against the Sun's, which the model draws white. The air on
  its line of sight dims and reddens it by the model's transmittance; below the
  horizon none of it arrives.
- **Drawn** as one mesh named `sky-stars`, with the dome only. Each star is a
  square `sky.stars.sizePx` across facing the viewpoint, its light spread over the
  square's solid angle through a Gaussian image and added to the sky behind by a
  screen blend, so a star gives the same light at any size. The mesh is not drawn
  while its brightest star is under 1/1024 of white, which is all day.
- `sky.stars.limitingMagnitude` draws the catalogue's first stars: 518 to magnitude
  4, 5,080 to 6, and 8,404 to the default of 6.5.

**By day above the air.** The scene's exposure shows no star by day at any height:
it is set for sunlight, as a camera's is, and a photograph of the sunlit Earth from
orbit has none. Near the ground that is also how it looks, because the sky there is
far brighter than any star. But the sky thins with height, and above the air it is
black beside the sunlit planet, where an eye turned to it sees stars. So the stars
alone get an exposure of their own, `sky.stars.daylightAltitude`: between two
heights it moves from the scene's, at the lower, to the darkest the metered range
allows, at the upper, a stop for each equal step of height
(`starEv100` in [skyState.ts](../../src/sky/skyState.ts)). The Sun, the Moon, the
sky, the ground and every emitter keep the scene's exposure. At night the scene's
is the darkest already, so nothing changes at any height; with a fixed exposure the
stars are held to it as all else is.

The default heights, 0 and 80 km, are what metering on the sky behind the stars
gives. In the model the daytime sky's mean luminance halves with each 5 km, and a
reflected-light meter pointed at it (ISO 2720, K = 12.5) shows a luminance L against
a white of 9.6 L. With the Sun 60° up:

| Height | Sky's mean luminance | Of sea level's | Scene | Metered on the sky | Stars, at the defaults |
| --- | --- | --- | --- | --- | --- |
| 0 km | 5,720 cd/m² | 1 | EV 15.6 | EV 15.5 | EV 15.6 |
| 20 km | 245 cd/m² | 0.043 | EV 15.7 | EV 10.9 | EV 12.0 |
| 40 km | 20.7 cd/m² | 0.0036 | EV 15.7 | EV 7.4 | EV 8.4 |
| 60 km | 1.63 cd/m² | 0.00029 | EV 15.7 | EV 3.7 | EV 4.7 |
| 80 km | 0.118 cd/m² | 0.000021 | EV 15.7 | EV 1.0, the range's floor | EV 1.0 |
| 400 km | The night sky's own | | EV 15.7 | EV 1.0 | EV 1.0 |

The straight line between the two heights is within a stop of the meter's reading
all of the way. On a view 46° high and 800 px tall, with stars 3 px across, Sirius
shows from about 20 km, stars of the second magnitude from about 45 km, and the
faintest drawn from about 80 km. No aircraft flies there, so a flight's day has no
stars; a view of the planet from space has all of them. The heights are the
user's to move: both to one height makes a step there. The setting's reading says
what the stars' exposure is at the viewpoint's height, beside the scene's.

Stars light nothing. Their summed light to magnitude 6.5, 0.00025 lx above the air
over the whole sphere, is part of what `sky.night.luminance` stands for on surfaces.
The drawn sky therefore counts those stars twice: about a tenth more light above
the horizon than the parameter's alone.

## Into the scene

[src/engine/babylon/createSkyRuntime.ts](../../src/engine/babylon/createSkyRuntime.ts)
writes the state into Babylon. Every value is written already divided by white.

- **Sun or Moon:** a `DirectionalLight` named `sky-sun`, pointing from whichever of
  the two gives more light at the viewpoint, as drawn. Its colour is that body's
  three bands over the brightest, its intensity that band's illuminance ÷ white.
  Babylon's PBR material divides a punctual light's diffuse by π (Lambert, or
  Burley's, which is normalized the same), so a surface returns ρ E cos θ / π. With
  both below the horizon its intensity is zero.
- **Sky:** a `HemisphericLight` named `sky-light`, up being the viewpoint's ellipsoid
  normal. Its colour is the sky's level illuminance ÷ π ÷ white, the moonlit and the
  night sky's included; its ground colour is the
  [light from the ground](#light-from-the-ground) ÷ white. Babylon's hemispheric
  term has no 1/π in either material, so a white surface facing up returns the sky's
  E/π, and one facing down the ground's luminance. No specular.
- **Background:** with `lights`, and behind the dome, the scene's clear colour is the
  sky's mean luminance (E/π) ÷ white, times compensation, display-encoded. A
  background someone else sets meanwhile, such as a map switch's, is the one given
  back when the sky turns off.
- **Dome:** with `dome`, one mesh named `sky-dome`: rows crowded towards the horizon
  as seen from the viewpoint's height (three quarters above it), nine more rows
  around the Sun's height, columns crowded towards the Sun's bearing and mirrored,
  a disc of the Sun's own luminance (E ÷ its solid angle), and
  [the Moon's disc](#the-moon). Colours are luminance ÷ white, encoded as the
  standard material holds them; the material is unlit, so it decodes, applies
  compensation and encodes them again. Infinitely far, never culled or picked,
  writing no depth.
- **Stars:** with `dome`, a second mesh named `sky-stars` ([Stars](#stars)).
- **Map imagery:** a factor on its linear colour, found in its own shader for each
  pixel's place ([Ground](#ground)).
- **Coordinates:** the world matrix the host gives takes Earth-centred metres into
  the scene; the viewpoint is the active camera through its inverse, and directions
  go through it as normals. Shifting, turning or mirroring the world changes
  nothing seen (tested); in a mirrored world the dome is mirrored with it, so the
  Moon stays on its own side of the Sun.
- **The lights it replaces:** while a sky model lights the scene, the simulation's
  fill light (1.1 × multiplier), Google tiles' (1.0 ×) and the fallback globe's
  (0.95 ×) are off. `renderer.ambientFillMultiplier` applies only with the model
  off.

### Contribution and unit audit

| Contribution | Model off (unchanged) | Model on | Status |
| --- | --- | --- | --- |
| Direct sunlight or moonlight | None | `sky-sun`, the brighter body's E ÷ white | PBR returns ρ E cos θ / π; standard π too bright ([policy](#material-policy)) |
| Diffuse sky light | Hemispheric fills of no unit, × multiplier | `sky-light`, E/π ÷ white and the ground's luminance ÷ white | Units right in both material classes; the sky's light taken as one colour above and the ground's below |
| Environment and reflections | None | None: no environment texture, so no specular reflection of the sky | Not modelled |
| Local lights | Their own | Unchanged. The 0sfs exhaust's light keeps its own gain and range. [Lamps](#lamps) given to the sky light map imagery in candelas, and are seen as points; they do not light lit surfaces | Lamps' pixels checked on a software renderer; the rest not audited here |
| Emission | Exhaust: cd/m² ÷ 1000 cd/m² | Exhaust: cd/m² ÷ white | By construction; unrendered |
| Raster imagery | Unlit, its photograph | Unlit, × the light at each pixel's place, or as photographed | Pixels checked on a software renderer |
| Google 3D Tiles | Lit by their fill if their material is lit | Lit by the Sun, the Moon and the sky if lit; unlit ones as raster imagery | Which they are is unverified; an unlit glTF material's pixels checked on a software renderer |
| Sky and background | Fixed colour | Dome and stars, or clear colour, in cd/m² ÷ white | The Moon's disc, a star and the moonlit sky checked on a software renderer |
| Exposure | 2^EV in image processing | ÷ white once at the source, then 2^EV compensation | Implemented |
| Encoding, tone mapping | Material image processing; no tone mapping | Same | Unchanged; clipping above white |
| Panoramas | Their own encoding | Same: the Sky tab is hidden inside a panorama | Unchanged |

## Ground

Map imagery is unlit: the scene's lights do not reach it. Under a sky model a
[material plugin](../../src/engine/babylon/imagery/terrainLightPlugin.ts) multiplies
its colour, in its fragment shader, by the light on level ground where each pixel
is. `sky.surface.lighting` chooses how.

- **By daylight**, the default, lights each point by its own Sun and Moon. A pixel's
  up is its direction from the Earth's centre, so the sines of the Sun's and the
  Moon's heights there are two dot products. Each reads a table of the light a body
  gives level ground at sea level by its height: its own through the air plus the
  sky it lights, per unit of its light above the air. The factor is
  table(Sun) × the Sun's scale + table(Moon) × the Moon's scale + the night sky's,
  where a scale is the body's illuminance above the air × `sky.surface.albedoScale`
  ÷ π ÷ white. The planet seen from afar then has its day, its twilight along the
  terminator and its night where they are, and the ground under a low flight
  darkens through dusk as the sky does.
- **The table** has 27 samples: every 1.5° from 18° below the horizon to 12° above,
  where the light changes by orders of magnitude, then every 13° to overhead. Below
  −18° it fades to nothing over 2°. It holds the logarithm of the light over the
  sine of the body's height (over the sine of 12° below that height), which changes
  slowly where the light itself does not, and the shader multiplies the sine back.
  Against the model it samples it is within 4.2% above 12° and within 6.4% below,
  worst 12.8° under the horizon, where about two millilux are left. It depends only on
  the atmosphere, so it is built with the atmosphere's tables, in 7 µs, and reaches
  the shader as uniforms, not a texture. WebGL 1 may index a uniform array only by
  a loop's index, so there the shader walks the table; WebGL 2 and WebGPU index it.
- **Cost a pixel:** for each of the Sun and the Moon, a dot product, an inverse
  sine, two table reads, a mix and an exponential.
- **As at the viewpoint** is one factor for all imagery, the light on level ground
  below the viewpoint. It is right near the viewpoint and wrong far from it, so a
  planet seen from afar is all day or all night; it saves the work above. FOSS
  Earth does not offer it. An application whose views stay low may add it to the
  choices with `settings.setChoices` and `VIEWPOINT_SURFACE_LIGHTING_CHOICE`
  (`foss-earth/settings`): 0sfs does, and makes it its default only on a very slow
  device.
- **As photographed** keeps the map as it is at any hour, for cartography and
  debugging. With no factor the shader is untouched.
- The ground is taken as level and at sea level: no pixel is shaded by its slope,
  a mountain casts no shadow, and a summit is no brighter than the plain.
- With large-world rendering a shader's positions are relative to the eye. The
  plugin gives the Earth's centre and lamps' places the same way, by
  `scene.floatingOriginOffset`.

### Lamps

Light that reaches the ground from something other than the sky, such as an
aircraft's landing lights, comes from the application through
`runtime.sky.setGroundLights`: up to four beams (`TERRAIN_LOCAL_LIGHTS_MAX`), each a
place, an axis, an intensity in candelas for each band, and the cosines of the
half-angles its beam is full within and gone beyond. For each, the imagery shader
adds I ÷ d², times the cosine of the light's angle from the ground's up, times the
beam's soft edge, with the reflectance and white of the rest: a factor per candela.
Distance is held to a metre at least. A change in their number recompiles the
shader; moving or dimming them is uniforms. They show only while a sky model lights
the map.

A lamp seen directly is a point of light. `createLightPoints` (`foss-earth/lights`)
draws points of known intensity as the stars are drawn: each one's illuminance at
the camera, I ÷ d², spread over a square `sizePx` across through an image of a sharp
core and a faint glare, over white, and added by a screen blend. A lamp is then a
glare at night and a faint dot by day because it is; nothing about its brightness is
chosen for looks. It asks the caller for each point's intensity towards the viewer,
so a navigation light shows only in its sector. With the sky model off it is shown
against a white the application gives.

### Light from the ground

Lit surfaces receive light from below as well: an aircraft's underside faces the
ground, not the sky. `sky.groundLight.mode` chooses where the hemispheric light's
ground colour comes from.

| Mode | The light from below | Cost |
| --- | --- | --- |
| Off | None | None; for comparing |
| Uniform, the default | Ground of `sky.atmosphere.groundAlbedo` under the Sun's, the Moon's and the sky's light below the viewpoint: one colour for any ground | None beyond the sky's own |
| Rendered | The ground below as it is drawn: its own colours and every light on it, lamps included | One image of the ground 16 pixels across, twice a second while frames are drawn |

Rendered ([createGroundLightProbe.ts](../../src/engine/babylon/createGroundLightProbe.ts))
puts a camera at the receiver, which is the application's
(`runtime.sky.setGroundLightReceiver`, an aircraft) or else the view's. It looks
straight down with `sky.groundLight.probeFieldOfView` (120°) into a render target
`sky.groundLight.probeSize` across (16 px), and sees only the map's meshes and the
dome's ground below the horizon. The image is read back and averaged, each pixel
weighted by cos⁴ of its angle from straight down: cos³ for its solid angle and cos
for how a surface facing down receives it. The display's encoding and compensation
are taken off and the mean multiplied by white, which gives cd/m². Three quarters of
what a surface facing down receives comes from within 60° of straight down; the
rest is taken as the same.

- The read-back does not wait for the GPU on WebGL 2, where it goes through a pixel
  buffer and a fence, nor on WebGPU, whose read is asynchronous. WebGL 1 has only
  the read that waits.
- One reading is on its way at a time, asked for at most every
  `sky.groundLight.probeInterval` (0.5 s) and only while frames are drawn. A reading
  asks for a frame only when it differs from the light shown by more than 2%
  (`GROUND_READING_CHANGE`), so a still view settles and then draws nothing.
- The reading shows beside the setting, in cd/m², with the time it took to come
  back.
- The globe's default is Uniform: on a globe the light from below reaches little but
  walls. The flight's host default is Rendered, and Uniform on a very slow device.

### Night lights

The light people put out at night lights the map where it is.
`sky.nightLights.mode` chooses how it shows:

- **Lamps' light**, the default, is the lamps' light on the ground, which lights the
  map's own daytime imagery as the Sun's does. The imagery stays the picture; only
  its light changes.
- **Satellite's picture** is the night data itself: the luminance the satellite
  saw, added to the imagery without lighting it, a glow in the satellite's pixels.
- **Off** downloads nothing. With the sky model off, or imagery as photographed,
  there are none either, and a note beside the mode says so.

**Source.** NASA's Global Imagery Browse Services (GIBS) serve the Day/Night Band
of the VIIRS instruments as `VIIRS_NOAA20_GapFilled_BRDF_Corrected_DayNightBand_Radiance`
(from 2018-01-05) and `VIIRS_SNPP_…` (from 2012-01-19), one layer a night: cloudy
places filled from earlier nights, moonlight taken out. `sky.nightLights.date` and
`sky.nightLights.satellite` choose the night; the lights do not follow the date the
sky is shown for. The tiles are Web Mercator, zoom 0 to 8 (9 is refused), 256 px,
about 600 m a pixel at zoom 8 on the equator, with no key and open CORS:

```
https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{layer}/default/{date}/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png
```

GIBS answers `cache-control: no-store`, so the [map cache](../../src/terrain/mapCache.ts)
never stores a tile; they are kept in memory for the page's life only. GIBS asks for
the credit line `NIGHT_LIGHTS_CREDIT`, which the mode's description carries. The
mode's description also says that NASA's servers learn which parts of the world are
looked at, since it is on by default.

**Radiance.** Each tile is a palette PNG of greys, the colour map
`VIIRS_DayNightBand_At_Sensor_Radiance` v1.3: 180 bins with greys 7 to 255, a tenth
of a nW/(cm² sr) wide up to 6.8 and wider above, the last open from 38.2. A grey is
its bin's middle; the last bin is 38.2, so city centres clip there
(`NIGHT_RADIANCE_CLIP`). A transparent pixel, or any other grey, is no data, taken
as none. Tiles are decoded with `createImageBitmap` without colour conversion, so
the greys stay the colour map's.

**Light from radiance.** Ground of reflectance G under lamps' light E sends up a
luminance G E ÷ π, which the satellite measures as k G E ÷ π (the Otus 3 model,
equations 1 and 3, straight down). k, `sky.nightLights.radiancePerEmittance`, is
the radiance per lm/m² of lamps: the share of their light in the sensor's band, and
how much buildings and trees hide. The model's range is 260 to 714 across lamp
types; the default is their geometric mean, 431. G is
`sky.nightLights.groundReflectance`, 0.15. Above `sky.nightLights.floor`, 0.5
nW/(cm² sr), which is about the sensor's threshold of two 8,000 lm lamps in a 750 m
pixel, and airglow and noise below it, a radiance R is:

| | Per nW/(cm² sr) | A clipped centre, 37.7 above the floor |
| --- | --- | --- |
| Lamps' light on the ground, π R ÷ (k G) | 0.049 lx | 1.8 lx |
| Luminance the satellite saw, R ÷ k | 0.0023 cd/m² | 0.09 cd/m² |

The lamps' colour is a black body at `sky.nightLights.colourTemperature`, 3,000 K,
of luminance 1 relative to sunlight (`blackBodyTint`): the band has no colour, so
the colour is the same everywhere.

**Shader.** The [terrain light](#ground) reads radiance at each pixel's place.
The point's latitude on the ellipsoid, atan(z, (1 − e²) p), is exact on the
surface; with its longitude it gives Web Mercator coordinates in tiles of the
window's zoom. Light adds (R − floor) × π ÷ (k G) × `sky.surface.albedoScale` ÷ π
÷ white, in the lamps' colour, to the factor on the imagery's linear colour. The
picture adds (R − floor) ÷ k ÷ white to the linear colour itself. The standard
material holds colour display-encoded, so it decodes, sums and encodes again. Cost
a pixel: one texture read and a few dozen operations. Google 3D Tiles whose
materials are unlit get the same, through the same plugin. The shader has the
night lights only while a map of them exists, which by day it does not: their
arriving and leaving recompile it; the window moving is uniforms.

**Window and texture.** Radiance reaches the GPU in one texture,
`sky.nightLights.windowTiles` tiles across (8, rounded to a power of two), 256
texels a tile: red the high byte and green the low byte of radiance in thousandths
(`NIGHT_RADIANCE_UNITS`). Filtering the two bytes filters radiance exactly, as
filtering a picture's greys would not. The texture wraps: tile (x, y) of the
window's zoom has slot (x mod N, y mod N), so a tile keeps its slot while the window
moves over it, and the window crosses the antimeridian. It has no mipmaps, so the
lights may shimmer near the horizon. At 8 × 8 it is 16 MiB.

- The window's zoom is the finest, at most `sky.nightLights.maxZoom` (8), at which
  N tiles hold the ground to the horizon with a tile to spare on every side. At
  45°, with N = 8, that is zoom 8 below about 6 km and zoom 7 to about 24 km; from
  space, the whole world at zoom 3. A window in use is kept while it still holds the
  ground in view and is no coarser than that zoom, so the texture changes only when
  it must.
- A tile is downloaded only when it is within the horizon's distance and the Sun is
  below `sky.nightLights.sunBelow` (0°) somewhere on it: on a 5 × 5 grid of its
  points, or where the point opposite the Sun is on it. By day nothing is
  downloaded.
- Downloads go nearest first, at most `map.imagery.concurrentRequests` at once. A
  failure is tried again after `map.retryDelay`, doubling. A tile GIBS refuses
  (400, 404, 204) or of the wrong size is not asked for again. A view that moves on
  stops what it no longer needs.
- A new window is shown only when every tile it needs is here or has failed once,
  all of it in one task; until then the last stays. Within the window shown, a tile
  shows as it arrives: at the horizon, or where the Sun has just set.
- Decoded tiles are kept as greys, 64 KiB each, the least recently needed forgotten
  beyond `sky.nightLights.memory` (32 MiB); the tiles of the window shown or being
  made ready are kept beyond it.
- Without `createImageBitmap`, as outside a browser, nothing is downloaded.

**Below the viewpoint.** The radiance there, the lamps' light and the luminance seen
are in `SkyEnvironment.nightLights` with the tiles' state, and beside the mode. With
the light from the ground uniform, the lamps' luminance below is added to it;
rendered, it is drawn. A change of more than 2% shows the sky again.

**Exposure.** At night the meter holds at its range's dark end, EV 1, where white is
2.4 cd/m². Imagery at full white under a clipped centre's 1.8 lx then shows at about
a third of white, and the satellite's picture of that centre at 4% of white, about a
fifth once encoded for the display. The meter does not read the lamps' light.

## Material policy

- **2D map imagery** is a photograph: sunlight of the day it was taken, not a
  reflectance. *By daylight* takes each pixel's linear value ×
  `sky.surface.albedoScale` as a reflectance under the light on level ground at its
  place ([Ground](#ground)). The default scale, 1.5, shows a photograph of sunlit
  ground as itself again under a high Sun at the metered exposure. The plugin
  scales the colour after the imagery atlas samples it.
- **Google 3D Tiles** are lit by the Sun, the Moon and the sky if their glTF
  materials are lit. A tile whose material arrives unlit (`KHR_materials_unlit`)
  gets the same factor as 2D imagery, on its linear albedo before the unlit path
  reads it. Which kind Google serves was not checked: that needs the user's key and
  a browser.
- **PBR materials**, the aircraft's included, are photometric under both lights.
  **Babylon's standard material** has no 1/π in its Lambert term, so a lit standard
  material shows the Sun's light π times too bright; its sky light is right. The two
  lit standard materials in use are placeholders: the fallback globe and 0sfs's
  placeholder aircraft. Unlit standard materials (markers, debug drawing) do not
  change with the hour.

## Computed once, drawn on demand

Following [render on demand](../render-on-demand.md):

- The state is recomputed only when the Sun or the Moon has moved more than
  `sky.update.sunAngle` in the viewpoint's sky, by the clock or by travel, or the
  air's density at the viewpoint has changed by more than
  `sky.update.densityChange` (the haze layer's below 6 km, the air's above), or a
  setting it depends on changes. Above the air, 100 km in the model, there is none
  to thin: height then changes only where the horizon is, and the sky is recomputed
  when the horizon's dip has moved by the same angle as the Sun's step. From
  20,000 km that is every 90 km of approach, where the density's measure, left
  uncapped, asked for it every 160 m. Exposure, ground and star settings only rewrite
  values; haze and albedo rebuild the tables.
- With the clock running, one frame is asked for each time the Sun has moved the
  recompute angle: every 12 s at the default 0.05°. The timer stops while the page
  is hidden, with a set time, and with the model off.
- The stars' places and colours are computed again only when the instant, the
  viewpoint, the exposure, their settings or a pixel's angle (by more than 1%) has
  changed. A reading of the ground's light changes none of those.
- Map imagery's light moving is uniforms. Its shader is compiled again only when
  the light is turned on or off, changes between per point and one factor, or the
  number of lamps changes.
- A rendered reading of the ground's light asks for a frame only when it changes
  the light shown by more than 2%.
- Night light tiles ask for a frame when a window is shown, or a tile arrives in the
  one shown; one on its way, or for a window not yet shown, asks for none. The
  tiles needed are found again only when the view has moved about a kilometre, the
  horizon a kilometre, or the Sun a twentieth of a degree.
- Turning the model off removes the lights, the dome, the stars, the ground's image
  and the imagery factor, gives the background back, and turns the fill lights on,
  inside the frame that is being prepared.
- What it costs is shown: the tables' build time and bytes beside the haze; the
  last computation's time and samples, the moonlit sky's among them, beside the
  model; the Moon's phase, height, bearing and distance beside the Moon; the number
  of stars, their time and whether any is bright enough to draw beside the stars;
  the ground's luminance and its reading's delay beside the light from the ground;
  the exposure, white, the meter's reading and what adaptation made of it beside the
  exposure; and the imagery factor below the viewpoint beside the map imagery's
  choice.

## Settings

The **Sky** and **Date and time** tabs are shared by the globe and the flight.
Every parameter has one home.

| Tab, section | Parameter | Unit, bounds | Default |
| --- | --- | --- | --- |
| Date and time | `sky.time.mode` | Now, A set time | Now |
| | `sky.time.date` | UTC date, year-month-day | 2026-06-21 |
| | `sky.time.utcHours` | h, 0 to 24, to the second | 18 |
| Sky, Atmosphere and illumination | `sky.model` | Off, Lights, Dome | Dome |
| | `renderer.ambientFillMultiplier` | ratio, 0 to 4; shown with the model off | 1 |
| | `sky.atmosphere.aerosolOpticalDepth` | optical depth, 0 to 1.5 | 0.1 |
| | `sky.atmosphere.groundAlbedo` | fraction | 0.2 |
| | `sky.dome.zenithSamples`, `sky.dome.azimuthSamples` | count, 8 to 128 | 32, 32 |
| | `sky.dome.integrationSteps` | count, 4 to 96 | 16 |
| | `sky.update.sunAngle` | degrees, 0.01 to 5 | 0.05 |
| | `sky.update.densityChange` | fraction, 0.001 to 0.5 | 0.02 |
| Sky, Moon and stars | `sky.night.luminance` | cd/m², 0.00001 to 1 | 0.0002 |
| | `sky.moon.mode` | Off; Light and disc; Light, disc and sky | Light, disc and sky |
| | `sky.stars.mode` | Off, Catalogue | Catalogue |
| | `sky.stars.limitingMagnitude` | magnitude, −1.5 to 8.1; shown with the stars on | 6.5 |
| | `sky.stars.sizePx` | px, 1 to 12; shown with the stars on | 3 |
| | `sky.stars.daylightAltitude` | km, 0 to 200, one track; shown with the stars on | 0 to 80 |
| Sky, Ground | `sky.surface.lighting` | By daylight, As photographed; an application may add As at the viewpoint | By daylight |
| | `sky.surface.albedoScale` | ratio, 0.1 to 4 | 1.5 |
| | `sky.groundLight.mode` | Off, Uniform, Rendered | Uniform; the flight's host default is Rendered |
| | `sky.groundLight.probeSize` | px, 2 to 64; shown when rendered | 16 |
| | `sky.groundLight.probeInterval` | s, 0.05 to 10; shown when rendered | 0.5 |
| | `sky.groundLight.probeFieldOfView` | degrees, 30 to 150; shown when rendered | 120 |
| Sky, Night lights | `sky.nightLights.mode` | Off, Lamps' light, Satellite's picture | Lamps' light |
| | `sky.nightLights.date` | UTC date, year-month-day | 2025-09-21 |
| | `sky.nightLights.colourTemperature` | K, 1,700 to 6,500 | 3,000 |
| | `sky.nightLights.satellite` | NOAA-20, Suomi NPP | NOAA-20 |
| | `sky.nightLights.floor` | nW/(cm² sr), 0 to 10 | 0.5 |
| | `sky.nightLights.radiancePerEmittance` | nW/(cm² sr) per lm/m², 100 to 2,000 | 431 |
| | `sky.nightLights.groundReflectance` | fraction, 0.02 to 0.8; shown for the lamps' light | 0.15 |
| | `sky.nightLights.sunBelow` | degrees, −18 to 10 | 0 |
| | `sky.nightLights.maxZoom` | levels, 0 to 8 | 8 |
| | `sky.nightLights.windowTiles` | count, 2 to 16 and the renderer's largest texture | 8 |
| | `sky.nightLights.memory` | MiB, 1 to 512 | 32 |
| Sky, Exposure and display | `sky.exposure.mode` | Metered, Fixed | Metered |
| | `sky.exposure.meterRange` | EV, −12 to 20, one track; shown when metered | 1 to 16 |
| | `sky.exposure.adaptation` | ratio, 0 to 1; shown when metered | 0.75 |
| | `sky.exposure.ev100` | EV, −12 to 20; shown when fixed | 9.7 |
| | `renderer.exposureEV` | EV, −16 to 16 | 0 |

Each default's reason is in the [catalogue](../../src/settings/catalogue/sky.ts).
The presets: *Save battery* samples the dome at 16 × 16 and recomputes after 0.25°
and 5%; *Sharpest* at 64 × 64 with 32 steps; *Smooth motion* at 24 × 24 and 5%.
*This device* puts those back, and with them the sky model, the Moon, the stars,
the map imagery's lighting, the light from the ground and the night lights. The
Night lights section starts closed.

The two dials cover the three time parameters, so the Date and time tab draws no
other control for them; Show all parameters lists them with their values.

### Migration

The relocated parameters keep their ids and saved values; nothing is rewritten.

| Parameter | Was | Is |
| --- | --- | --- |
| `sky.time.mode`, `sky.time.date`, `sky.time.utcHours` | Sky → Time and location: a choice, a text field and a slider, with buttons for Now, Sunrise, Noon, Sunset and Midnight (2026-10-07, never released) | Date and time, on the two dials. A set time is now kept to the second, so changing its date keeps its solar time of day |
| `renderer.exposureEV` | Renderer → Lighting and exposure; the only exposure | Sky → Exposure and display. With the model off, unchanged. With it on, compensation on top of the sky's exposure; a note says how many times brighter or darker it shows everything |
| `renderer.ambientFillMultiplier` | Renderer → Lighting and exposure | Sky → Atmosphere and illumination, shown with the model off, where it applies as before. The sky's own lights replace the fills it scales |
| `sky.model` | Default Off on the globe, with Dome as the flight's host default (2026-10-07, never released) | Default Dome. A saved Off stays Off |
| `sky.surface.lighting` | *By daylight* was one factor for all imagery, the light below the viewpoint (2026-10-07, never released) | *By daylight* lights each point by its own Sun and Moon. The one factor is *As at the viewpoint*, which only an application adds. A saved `daylight` now means per point |
| `sky.night.luminance` | Sky → Atmosphere and illumination | Sky → Moon and stars |
| Sky → Surface appearance | The section's title | Sky → Ground |

A saved compensation of +8.8, the user's setting from the observation, shows a
flight under the sky 446 times brighter than the meter would: set it back to 0. The
observation's own settings are still reproducible with the sky model off.

A globe that showed its map as photographed at every hour now shows it by the hour:
at night where the view is, the map is dark. *As photographed*, or the sky model
Off, gives the old picture.

## Package surfaces

- `foss-earth/sky`: `solarPosition`, `solarEphemeris`, `sunDirectionFrom`,
  `createAtmosphere`, `computeSkyIllumination`, the dome's geometry and fill, the
  exposure conversions with `adaptEv100`, and their types. The Moon:
  `lunarPosition`, `lunarEphemeris`, `moonViewFrom`, `moonMagnitude`,
  `moonIlluminanceLux` and `MOONLIGHT_TINT`. The stars: `loadStarCatalogue`,
  `starDirections`, `starIlluminanceLux`, `starTint`, `precessionMatrix` and
  `celestialToEcefMatrix`. The ground's table: `groundLightTable`, `groundLightAt`,
  `groundLightWeight` and `GROUND_LIGHT_TABLE`. And `starEv100`, the stars'
  exposure by height, with `horizonDipDeg`. The night lights: `nightLightTileUrl`,
  `isNightLightDate`, `RADIANCE_BY_GREY` and `radianceOfGrey`,
  `illuminancePerRadiance`, `luminancePerRadiance` and `radianceAboveFloor`,
  `mercatorXY`, `mercatorSpan`, `horizonDistanceMeters`, `chooseNightWindow` and
  `neededNightTiles`; `blackBodyTint` for a lamp's colour. Pure TypeScript, no
  renderer.
- `BabylonRuntime.sky`: `getEnvironment()` and `subscribe()`. A `SkyEnvironment`
  has the illumination at the viewpoint, the Moon's included; which body the
  directional light carries; the EV in use, the meter's and the adapted one, and
  whether the range held it; the white luminance; the imagery factor below the
  viewpoint; the light from the ground and its source; the stars drawn, the
  exposure they are shown at and whether their catalogue is here; the
  [night lights](#night-lights), their tiles and the lamps below; and the costs. `setGroundLights(lights)` gives the [lamps](#lamps) that light the map, and
  `setGroundLightReceiver(getter)` says where the
  [light from the ground](#light-from-the-ground) is measured from.
- `foss-earth/lights`: `createLightPoints(scene, options)` and its `LightPoint`,
  for lamps seen as points. It imports nothing of the map, so an application's unit
  tests can load it without the tile renderer.
- `foss-earth/settings`: `VIEWPOINT_SURFACE_LIGHTING_CHOICE`, for an application
  that offers imagery lit as at the viewpoint.
- `foss-earth/sky` also has the solar day and year: `solarClockMs` and
  `utcForSolarClockMs` between UTC and a place's solar time, `equationOfTimeMs`,
  `solarDay` for a day's sunrise, sunset and twilights, `seasonInstants` for a
  year's equinoxes and solstices, and `dayLengthsHours`.
- `foss-earth/shell`: `createSkyPanel({ settings, getPlace, openDateTime })` and
  `createDateTimePanel({ settings, getPlace })` build the tabs' contents, with any
  host sections homed in them; `WindowOverlay` takes them as `skyTab` and
  `timeTab`, and hides both inside a panorama. `fixedTimeValues` and
  `instantInUse` write and read the time's parameters.

## Validation

Verified on the CPU and in NullEngine:

- Solar position: the report's example and Julian days; equinoxes and solstices of
  2024; the Sun overhead at the subsolar point.
- Solar time: the equation of time against the report's example and the year's
  extremes; UTC to solar time and back within a millisecond; the Sun on the
  meridian at 12:00; every crossing of each day part's elevation within 0.02° in
  five places from the equator to 70° N; polar days and nights, and Helsinki's
  white nights; day lengths at the equator, Minneapolis and 80° N.
- The Date and time tab, in jsdom: its two dials covering the three parameters;
  marks, Now and Today; minute, hour, day and month steps; drags carried on past
  midnight and past the year's end; typed times and dates; a host's lock; the
  zones line for a device's zone and for places east and west. And once
  in headless Chrome, from a page built of the panels' code and not kept: the two
  dials side by side in 320 and 420 px panels and one under the other in 300 px,
  legible in the dark and light themes.
- Atmosphere: as [above](#the-atmosphere); phase functions keep their energy; blue
  overhead and red at sunset; dark at height and black above the air; no more light
  on level ground than arrives; twilight falling without a step.
- The Moon: Meeus's example 47.a; the phases of October 2024 within 0.01° of the
  U.S. Naval Observatory's instants; the Moon's centre within 11″ of the Sun's on
  the centre line of the eclipse of 8 April 2024, which tests the parallax; its
  magnitude and light by phase and distance; its phase the right way round in a
  mirrored world.
- The stars: the catalogue's count, order and Sirius's entry; Meeus's example 21.b
  of precession; Polaris 0.63° from the pole in 2026; the sky back where it was a
  sidereal day later; each star's light and colour; their catalogue not fetched by
  day near the ground; their own exposure by height, at 300 m, 40 km and 400 km by
  day, with the heights moved, and with a fixed exposure.
- Units: Sun intensity × white is the Sun's illuminance; sky colour × white × π is
  the sky's; the meter's EV is log2(0.4 E); exposure changes write new values
  without recomputing light; a night emitter of 1 cd/m² writes 0.42; adaptation's
  share of each stop.
- The ground: the factor at a point by its own Sun and Moon against the table; the
  table against the model; one factor for all imagery; lamps by the inverse square,
  their beam's edge and the ground's slope; the shader code Babylon builds for a PBR
  material and for a standard one, in GLSL for WebGL 1, GLSL for WebGL 2 and WGSL;
  uniforms relative to the eye with large-world rendering.
- The light from the ground: the cos⁴ mean of an image; its three sources; one
  reading at a time, and a frame asked for only when it changes what is shown.
- Night lights: the tiles' addresses and dates; every bin of the colour map, and
  what is no data; radiance through the texture's two bytes to a thousandth; the
  photometry's numbers and that the satellite's luminance is the lit ground's; the
  horizon's span on the map, a pole's included; the window chosen, kept while it
  holds the view, wrapped across the antimeridian and the whole world from space;
  the least distance to a tile; tiles needed only where the Sun is low, nearest
  first. With a fetch, a decoder and a clock of the tests' own: nothing downloaded
  by day or without a decoder; the limit at once; a window shown whole in one frame,
  the last kept meanwhile; what a view left stopped; retries after the delay and
  none for a refusal; memory trimmed outside the windows in use; another night
  starting again, and a date that is none. The shader's mapping of a point against
  the tiles', and its code in GLSL and WGSL; its define and uniforms; the sky's
  light, picture and light from below.
- Light points: I ÷ d² over a square's solid angle, over white; a point dark from
  behind its lamp.
- Lifecycle: computed once per change; the clock's frames and their stopping;
  thresholds by travel and climb, for the Sun and for the Moon; above the air,
  nothing computed for a kilometre of height and once for the horizon's step; the stars computed
  again only when what they show has changed; one frame to turn off, none extra;
  the scene given back; floating-origin invariance; the flight's fill lights
  replaced and restored (a simulation test with a world shifted by thousands of
  kilometres).
- 0sfs: the flight defaults to the dome and the rendered light from the ground,
  offers the Sky tab and imagery lit as at the viewpoint, gives its landing and
  taxi beams to the ground, and passes the sky's white to the exhaust, then its own
  references again when the sky is off.

[scripts/validation/sky-model.mjs](../../scripts/validation/sky-model.mjs) prints
the model's numbers on this CPU: the Sun's and the Moon's worked examples, light
from noon to night and under the Moon against the published values, table and step
errors, the stars, exposure through a day at the defaults, and costs. Retained run:
[validation/evidence/sky/2026-10-07-sky-model/](../../validation/evidence/sky/2026-10-07-sky-model/).

### Drawn pixels

[scripts/validation/sky-render.mjs](../../scripts/validation/sky-render.mjs) draws
the runtime's own shaders in headless Chrome, with the app's engine options, and
compares pixels with what the model says they should be. On 2026-10-07 it ran with
`--software`, on Chrome's software renderer (SwiftShader) and no GPU: 33 checks in
each of WebGL 2, WebGL 1 and WebGPU, all passed. Retained run:
[validation/evidence/sky/2026-10-07-sky-render/](../../validation/evidence/sky/2026-10-07-sky-render/).

- Level ground 600 m ahead, as a 2D tile's unlit standard material and as an unlit
  glTF (PBR) material, within 4 of 255 of the model: in the afternoon, at dusk
  with a quarter Moon up, under a full Moon, under the night sky alone, with a
  1,000 cd beam from 30 m above it, lit as at the viewpoint, as photographed, and
  with the sky off.
- The planet from 20,000 km, at nine longitudes along 30° N from the afternoon
  across the terminator into the night, within 8 of 255.
- The full Moon's disc at white, and the sky 10° from it lit and far under white.
- A bright star standing out from the sky beside it at night; no star drawn by day
  near the ground; and a bright star standing out from 400 km up by day, with the
  scene still at its daylight exposure.
- A 40 cd red lamp 20 m away: saturated at night; by day, its light added to the
  ground's within 12 of 255.
- The light from the ground, rendered and read back, within a tenth of the ground's
  luminance.

Three faults showed only when pixels were drawn, and each now has a test. The stars
and light points drew black: an unlit standard material shows its emissive colour
times the vertex's, and theirs was black. Their plain additive blend overstated
light on a bright background, where the framebuffer holds encoded colour; a screen
blend replaced it. On WebGPU the ground's image read back ten times too dark: it was
read inside its own render pass, and into a buffer Babylon fills only in part.

### Found by flying it

The user flew the first build on 2026-10-07, on a GPU, and reported what the checks
had missed:

- **The ground stayed as bright as day at night**, over Google 3D Tiles; over a 2D
  map it darkened. An unlit PBR material never got the imagery's factor. Babylon
  collects a material plugin's shader code while the plugin's base class is
  constructed; the plugin chose its place in the shader from a field of its own,
  not yet set then, and so gave every material the standard material's place, which
  a PBR shader does not have. It now reads the material itself, and a test builds
  the injected code for both kinds. That Google's tiles are unlit, and that this
  was all of the fault, is inferred from what the user saw: no check has drawn one.
- **No Moon or stars**, so nothing lit the night. Both are modelled now.
- **Sunrise and sunset far too bright once the Sun was down.** Exposure followed
  the meter all of the way; it now follows it by `sky.exposure.adaptation`.
- **From afar the whole planet was lit as the viewpoint was.** Imagery is now lit
  by each point's own Sun and Moon.
- **No stars beside the sunlit planet from space**, which the user foresaw from the
  rule that hid them by day. They have an exposure of their own by height now, and
  the heights are a setting.

Not verified:

- Anything drawn by a real GPU. The software renderer runs the same shaders, and
  says nothing of a GPU's drivers, precision or limits. `node
  scripts/validation/sky-render.mjs`, without `--software`, runs the same checks on
  this machine's GPU; it has not been run.
- Real map tiles under the terrain light, through the imagery atlas, and Google 3D
  Tiles: whether they arrive lit or unlit, and how either looks.
- How a frame looks: the twilight's colours, the adaptation's default, the stars'
  size and the Moon's disc were not judged by eye.
- A WebGL 1 device's limit on uniforms: the imagery shader's light takes 45 vectors
  of them, beside the material's own.
- The exhaust's composition (premultiplied blending of linear values) against the
  sky's background.
- Timing on any device other than this Mac's CPU, and none of it qualified.
- The dials under a finger on a touch screen, and with a screen reader.

## The exhaust hypothesis

The user's hypothesis: the dry exhaust was invisible because the scene had no
physical light, not because of the exhaust code. Whether the exhaust itself is
right is a separate question this work does not answer.

**What supports it (numerical, not rendered).** At night the sky's exposure comes
to rest at white = 2.4 cd/m², within 0.1 stop of the 2.24 cd/m² the user found by
hand (1000 cd/m² ÷ 2^8.8). At that exposure the ground and the aircraft are lit
only by the night sky, 0.0006 lx, and show at about 0.00003 of white, where at
+8.8 EV the old fill showed lit surfaces at 8.9 times their brightness at 0 EV and
map imagery at 446 times. So the exposure that revealed the exhaust is the one
physics gives for night, and under physical light it no longer whitens the scene.

**What would falsify it**, on a GPU when authorized, flying the F-35B dry at night
under the dome with compensation 0, the meter at its floor and the exhaust's
settings unchanged:

- the dry exhaust still not visible: the exhaust's emission or its composition
  is wrong after all;
- the aircraft or ground still white or bright: a lighting or exposure path here
  is wrong;
- in daylight a dry exhaust stands out strongly: its luminance is too high, since a
  real dry plume is faint against a sunlit sky.

The comparisons to run are the exhaust thread's source-only, reflection-only and
combined views, with the same captures at fill 0, 0.02 and 1 and compensation 0
and +8.8 with the model off, as the
[handoff](../sky-lighting-implementation-prompt.md) lists. Remaining exhaust work,
source calibration and the audiovisual timing of A/B switching, stays in 0sfs.

## Next

- Run the [drawn-pixel check](#drawn-pixels) on a GPU, and look at Google 3D
  Tiles in the live app at night: whether their materials are lit, and how the
  ground then looks.
- Tune `sky.exposure.adaptation` and the stars' size by eye.
- Look at the [night lights](#night-lights) on a GPU, where nothing has drawn them
  yet, and decide by eye: whether the meter should read the lamps, so that a city
  at night is shown brighter than its surroundings' darkness allows now; and
  whether Google 3D Tiles should get them only at their finest detail, as first
  proposed, where they now get them wherever their materials are unlit.
- Light pollution: the night lights' glow in the sky above a city, and mipmaps for
  the night lights' texture if they shimmer.
- Ground shaded by its slope and by mountains' shadows; lamps lighting lit
  surfaces as well as the map.
- Rung 3: per-pixel sky and aerial perspective on the GPU, the CPU model as its
  reference; evaluate Babylon's atmosphere addon for it.
- Spectral rendering beyond three bands, if colour accuracy at twilight demands it.

## References

- I. Reda and A. Andreas, *Solar Position Algorithm for Solar Radiation
  Applications*, NREL/TP-560-34302, revised January 2008.
- E. Bruneton and F. Neyret, *Precomputed Atmospheric Scattering*, Computer
  Graphics Forum 27(4), 2008; E. Bruneton's 2017 reference implementation and its
  constants.
- S. Hillaire, *A Scalable and Production Ready Sky and Atmosphere Rendering
  Technique*, Computer Graphics Forum 39(4), 2020.
- W. M. Cornette and J. G. Shanks, *Physically reasonable analytic expression for
  the single-scattering phase function*, Applied Optics 31(16), 1992.
- D. Darula, R. Kittler and C. A. Gueymard, *Reference luminous solar constant and
  solar luminance for illuminance calculations*, Solar Energy 79, 2005.
- ISO 12232 (saturation-based exposure), ISO 2720 (incident-light meter
  calibration), ISO 2533 (standard atmosphere), ITU-R BT.709 (luminance weights).
- American Meteorological Society, *Glossary of Meteorology*: civil, nautical and
  astronomical twilight.
- J. Meeus, *Astronomical Algorithms*, 2nd edition, Willmann-Bell, 1998: chapter
  21 for precession and chapter 47 for the Moon.
- J. H. Lieske, T. Lederle, W. Fricke and B. Morando, *Expressions for the
  precession quantities based upon the IAU (1976) system of astronomical
  constants*, Astronomy and Astrophysics 58, 1977.
- K. Krisciunas and B. E. Schaefer, *A model of the brightness of moonlight*,
  Publications of the Astronomical Society of the Pacific 103, 1991, for the
  Moon's magnitude by its phase.
- C. C. M. Kyba, A. Mohar and T. Posch, *How bright is moonlight?*, Astronomy &
  Geophysics 58(1), 2017.
- D. Hoffleit and W. H. Warren Jr., *The Bright Star Catalogue*, 5th revised
  edition, 1991; CDS catalogue V/50.
- F. J. Ballesteros, *New insights into black bodies*, EPL 97, 2012, for a star's
  temperature from its B−V.
- Monnier and others, *Multi-faceted light pollution modelling and its application
  to the decline of artificial illuminance in France*, arXiv:2510.02977, 2025: the
  Otus 3 model, for radiance as lamps' light.
- NASA Global Imagery Browse Services (GIBS): the WMTS API, the
  `VIIRS_NOAA20_GapFilled_BRDF_Corrected_DayNightBand_Radiance` and
  `VIIRS_SNPP_GapFilled_BRDF_Corrected_DayNightBand_Radiance` layers, and the colour
  map `VIIRS_DayNightBand_At_Sensor_Radiance` v1.3.
