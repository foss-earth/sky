# Civil and solar clocks

Date and time defaults to **Civil**, with **Civil / Solar** in one shared segmented
control. Changing display preserves the simulated UTC instant and lighting. The
selection is a persisted setting (`sky.clock.display`), separate from the sky's
three instant parameters, so the choice does not start or stop time.

Civil uses the simulated location's IANA time zone and the browser's dated DST
rules. In 0SFS the location is the aircraft state, including with a detached
camera; Earth uses the place shown. Neither uses device location, device time
zone, IP lookup or browser geolocation. The active zone and UTC offset are visible.
Unknown location reads UTC with an explicit unavailable label. Solar keeps the
existing apparent-solar clock at the longitude shown.

Fields, dials, dates, sunrise/sunset positions and their actions share the selected
clock. Civil minute readouts truncate like a normal clock; solar keeps its existing
nearest-minute readout. Civil edits choose the earlier repeated fall hour and move
nonexistent spring times forward by the DST gap.

`@photostructure/tz-lookup` 11.7.0 supplies a compact offline coordinate lookup,
licensed CC0-1.0: https://github.com/photostructure/tz-lookup . Its geographic
boundaries are approximate; this limitation is in the clock help. Intl supplies
historical/date-dependent offsets. No sky model or native/WASM core changed.

Validation covers Minneapolis, Tokyo, Kathmandu, seasonal offsets, date rollover,
DST repeats/gaps, default Civil, preservation of the instant on switching, field
edits in the active zone, and live location changes. The host flight typechecks and
its existing composition tests pass. Visual review and the downloadable Test tab
feedback are in the consuming flight checkout's ignored build directory.
