# Notes

What this widget reads, what it decided, and why, kept for the next timing app in this
engine.

## What the game gives a delta bar

Everything is read from the globals the stock UI mirrors every frame (see
`ACEGameInternals/docs/ui-models.md`), nothing is computed from telemetry:

| field | what it is | how it is used |
|---|---|---|
| `ModelCurrentCar.delta_time_ms_ui` | the stock ks-delta's delta, int ms, rounded to 10 ms; `2147483647` (int32 max) when there is no reference lap | the gate: the sentinel means "no reference"; the fallback figure |
| `ModelCurrentCar.delta_time_ms` | the same delta before the UI rounding | the figure and the trend, when it is a sane number (under an hour) |
| `ModelCurrentCar.predicted_lap_time_ms` | the lap this pace ends in; `<= 0` when unknown | the PRED figure, coloured against the best |
| `ModelCurrentCar.current_lap_time_ms` | the running lap time | going backwards is a new lap: the trace clears, the trend ring resets |
| `ModelCurrentCar.npos` / `npos_perc` | position along the lap, 0..1 / 0..100 | which slot of the lap trace takes the delta; the trace hides itself when neither is a number |
| `ModelCurrentCar.delta_time_drivername` | who the delta is against when it is not your own lap | the "vs Name" line |
| `ModelTiming.best` | the best lap as the game formats it, `""` when none | shown as is; parsed to ms to colour the prediction |
| `ModelTiming.ideal` / `.last` | the session optimal (best sectors added up) and the last lap, formatted | the other two cells, shown as they come |
| `ModelTiming.invalid` | the lap is invalid; **true from the first metre of the lap out of the pits** (measured: `lap time 468 ms, invalid true`), and a cut on that lap does not change it | one of two sources for the INVALID tag: the flag counts only when it rises during a lap that started valid (latched over the first 500 ms, `lapStartedInvalid`); a pit exit shows nothing |
| `engine.on("UINotification")` | the game's UI notifications, the event the stock top-right box draws from; a lap invalidation is a `UINotificationType_SessionPenalty` whose `tuples[0].values` were `["{PENALTY_CLEARED_KEY} #666", <reason key>, <type key shown as LAP INVALIDATED>]` for a track-limits cut in practice (log, 2026-09-22 15:59) | the other source, and the one that works on a first lap: type key containing "invalid" and the car number matching the focused leaderboard line marks the lap cut until the next lap. The type key's exact spelling is not in the stock enum table (`ePenaltyType` has no lap-invalidated entry), hence the loose match; the widget logs every penalty notification it sees. The notice comes once and Escape/resume rebuilds the page, so the cut is kept through `me.remember` keyed by `low_frequency.total_lap_count` (or the lap time and the flag when there is none) and restored on the first frame if it is still that lap |

Positive is time lost, as everywhere in the game. The stock widget clamps the delta to
+/-1000 ms for its bar width and colours bar and figure by the sign; it colours nothing by
the trend, which is the gap this widget fills.

**Which way the bar grows differs between sims.** The stock ks-delta anchors its bar at the
centre with `transform-origin: right` and mirrors it with `scaleX(-1)` for a negative delta,
so time GAINED grows to the right. iRacing's bar (and SimHub overlays copying it) grows to
the right for time LOST. The default here is the game's; the "Faster side" option is the
other. The script owns the side (it decides which fill takes the share and signs the tick's
shift); the stylesheet only colours whichever fill shows by the sign, so both halves carry
both colours.

## Two layouts, one markup

The full layout is a broadcast-style block: a near-opaque panel with hard corners, the
figure laid over the bar, the fill fading in from the centre to a bright tick at its end,
and a row of lap-time cells with a colour tab each (gold optimal, purple best -- the stock
lap-time widget's own best-lap purple -- white last, and the prediction's tab in its
comparison colour). Compact is the iRacing shape: no panel, a thin rounded bar with a solid
fill, the figure in a dark tag under it. `.bd-compact` on the root switches the stylesheet;
the script's only compact-specific work is moving the figure row to the fill's end when
"follows the fill" is on, a `translateX` in percent of the row's own width, which is the
bar's, so half the width times the share lands exactly on the fill's end. The tick uses the
same trick on its own full-width track, which is why a 2 px tick does not get thinner as
the fill scales: it is never inside the scaled element.

Every option applies to both layouts except the ones for things only one layout has: the
cell switches and the trace are the full layout's, the follow-the-fill switch the compact
one's. Those carry a `when` (loader 0.25.0) so the settings window draws only the switches
of the layout on screen and swaps them the moment the layout changes; a hidden switch keeps
its value. Background applies to both: the panel in full, the bar's track and the tag in
compact.

One trap found by the harness: a `section` spec and a value spec must not share a key
(the first version had a "layout" section and a "layout" choice, and the choice could not
be set).

The compact bar's black is 0.94 alpha: 0.8 read as mid grey against a bright sky in game.

`npos` was not measured live before 0.1.0: the field is in the protobuf schema
(`UICurrentCarState` field 113, `npos_perc` 112) and is range-checked at read time, so a
value outside 0..1 leaves the trace empty rather than wrong. The first in-game session
tells: the minute log line says `no npos` when neither field reads.

## The trend

The delta is sampled at 20 Hz through `ACEUIAppLoader.loop.sampler` into a ring of 40
(two seconds, the widest window) and compared with the sample one window back, a second by
default. The difference per second is the rate:

- inside the dead band (15 ms/s by default; 5 fine, 40 coarse) the trend is **flat**,
- past it **gaining** (rate negative: the delta is falling) or **losing**,
- past five bands **strong**, which brightens the colour and the chevron.

Leaving a trend needs the rate to fall under half the band (hysteresis), or a delta
drifting along the threshold would flicker between colours every sample. A change of more
than a second between two consecutive samples cannot be driving: it is a new lap or a new
reference, and the ring restarts rather than reading it as a huge trend. A missing delta
also empties the ring, and so does a sampler stall over two seconds (a pause).

Why a window rather than a per-frame derivative: the delta arrives as integer ms and is
updated as the car crosses the reference lap's samples, so frame to frame it steps by a
few ms in bursts; the derivative of that is noise. A one-second difference is what a
driver means by "am I gaining right now".

## What the options change, and how

Every option is either a class on the root (what is shown, the width, the colour rules,
the background) or a number the loop reads (range, decimals, trend window and band).
Nothing is built or torn down when one changes. The colour rules are pure CSS: the script
puts `.bd-gain / .bd-lose / .bd-flat` (the trend) and `.bd-faster / .bd-slower` (the overall
sign) on the root every frame they change, and the stylesheet decides which of the two the
figure follows (`.bd-num-overall`) and whether the bar follows its side or the trend
(`.bd-bar-trend`). "Number colour: overall" therefore reproduces the stock widget's rule
exactly, for anyone who prefers it.

## Rendering rules

- Never rebuild geometry per frame (PedalGraph's first build did, and the game died inside
  Renoir). The bar's two halves are fixed elements scaled by `transform`; the lap trace is
  120 fixed slots, each with an up and a down bar, written once as the car passes and all
  blanked once per lap.
- Per frame the script writes `textContent` when a string changed, toggles a class when a
  state changed and writes `transform` on a handful of elements. Every write is guarded by
  a cache of the last value, so a steady delta costs nothing.
- `var(--name, fallback)` is not supported by this Cohtml build; plain `var(--name)` only.
- The chevrons are CSS border triangles, the one technique here the stock stylesheets do
  not use. Proven in game on 2026-09-22 (compact layout, the tag following the fill, the
  chevron drawn). They point the way the END OF THE FILL moves, which depends on the
  "Faster side" option: the first version pointed green left whatever the side, which read
  wrong against a bar growing right; now `.bd-faster-left` on the root turns them with the
  bar, in the stylesheet alone.

Full background in `ACEGameInternals/docs/gameface-notes.md`.

## The look

Follows the stock HUD widgets so it reads as part of the game: a dark translucent panel
(a slight vertical gradient, hairline border, soft shadow, small radii), the game's
Rajdhani through `--font-family-main`, `rajdhani-numerals-mono` for the figures so they do
not jitter as digits change, and the stock delta bar's own two colours: `#44EA78` for
time gained and `#FF1418` for time lost.

Judged from `dev/preview.html` rendered headless with the game's font
(`tools/preview_fonts.py`), which is also where the README image comes from. A Chromium
run with `--virtual-time-budget` delivers exactly one animation frame, so the preview's
`#shot` flag drives frames from timers for that purpose.

## Versioning

The version lives in `betterdeltabar/app.json` only. The loader reads it and logs it
(`script loaded, version <version>`); outside the game it reads `dev`. Bumping means:
edit `app.json`, update the README footer (tested), reinstall.

## Releasing

```
python ..\ACEUIAppLoader\tools\release_app.py betterdeltabar
```

writes `dist/ACEBetterDeltaBar-<version>.zip`: the app folder under
`mods\uiresources\ACEUIAppLoader\` and the empty marker under `Video\`, laid out as the
contents of `Saved Games\ACE`, exactly what `install_app.py` puts on disk. It refuses a
dirty tree and runs this suite first.

## Verifying in game

The game writes UI `console.log` output into `Saved Games\ACE\Logs\log-*.txt` as
`[gameface]` lines. Run `python ..\ACEUIAppLoader\tools\check_ingame_log.py` after playing:
`[ACEUIAppLoader] app betterdeltabar <version>: loading` followed by
`[Better Delta Bar] script loaded, version <version>` means the loader served the app;
`widget attached` carries the options the game restored; `delta ok <figure> trend <trend>`
once a minute means car data is flowing, and says `no npos` if the position field is not
there (then the trace stays empty and should be switched off in the options).
