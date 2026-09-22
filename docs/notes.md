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
| `ModelTiming.invalid` | the lap is invalid | the INVALID tag |

Positive is time lost, as everywhere in the game. The stock widget clamps the delta to
+/-1000 ms for its bar width and colours bar and figure by the sign; it colours nothing by
the trend, which is the gap this widget fills.

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
- The chevrons are CSS border triangles. Borders render (the stock uses them everywhere);
  a triangle from them is the one technique here the stock stylesheets do not use, and
  the first in-game session is what proves it. If it does not draw, the fallback is a
  small rotated square.

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
