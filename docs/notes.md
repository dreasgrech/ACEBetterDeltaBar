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
| `ModelTiming.invalid` | the lap is invalid; **true on any lap the car spent time in the pit lane on**: from the first metre of the lap out of the pits (measured: `lap time 468 ms, invalid true`), or from the pit exit when the timing line lies inside the pit lane; a cut on such a lap does not change it | one of two sources for the INVALID tag: the flag counts only when it rises during a lap that started valid AND never touched the pit lane (latched over the first 500 ms, `lapStartedInvalid`; the pit-lane visit is `pitLap`); a pit lap gets the quiet PIT LANE / OUTLAP tag instead |
| `ModelCurrentCar.car_location` | where the car is, `CarLocation.Type` as a string: `Pitlane`, `Pitentry`, `Pitexit`, `Track` (`Unassigned` exists too); the stock pit-limiter warning compares it to `"Pitlane"` and `"Pitentry"` | the pit lane (any of the three) makes the lap a pit lap, remembered through the reload; PIT LANE while in it, OUTLAP once out with the flag still up |
| `engine.on("UINotification")` | the game's UI notifications, the event the stock top-right box draws from; a lap invalidation is a `UINotificationType_SessionPenalty` whose `tuples[0].values` are `["{PENALTY_CLEARED_KEY} #666", "InvestigationType_Racecar_Cut", "lblNotificationPenalty_LAP_INVALIDATED"]` for a track-limits cut in practice (measured 2026-09-22 16:07, several times per cut) | the other source, and the one that works on a first lap: that exact type key and the car number matching the focused leaderboard line marks the lap cut until the next lap. The key is a l10n id (not in the stock `ePenaltyType` table), so it is the same in every language; the widget logs every penalty notification it sees. The notice comes once and Escape/resume rebuilds the page, so the cut is kept through `me.remember` keyed by `low_frequency.total_lap_count` (or the lap time and the flag when there is none) and restored on the first frame if it is still that lap |

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

**What the log proved about the flag (2026-09-22, practice, one car).** A pit exit reads
`lap time 465 ms, invalid true` on its first frame and stays flagged all the way round; a cut
on that lap changes nothing in the timing model, only the notification says. Crossing the
line: `new lap: lap time 35 ms, invalid false` in the same frame the lap time resets, so the
500 ms latch window is generous. A cut on a lap that started valid: the notification arrives
(16:16:47.276) and the flag rises 19 ms later (`invalid true, lap started invalid false`), so
both sources agree and either alone would do there. The invalid tag therefore appears in
exactly two cases: the game's own lap-invalidated notice for our car, or the flag rising on a
lap it was down for and driven wholly on the track; it clears when the lap time resets (the
line, or a return to the pits), and a HUD reload keeps it only for the very lap it was set on.

**What the second log proved (2026-09-22 17:48, practice, four pit exits).** On that track
the timing line lies inside the pit lane. Every exit read the same: the lap out of the box
flagged from its first metre; the line crossed still in the pit lane, `new lap: lap time 34
ms, invalid false`; the game's "Zone Exit" 50 to 170 ms later; and the flag up again at 290,
751, 502 and 333 ms into the lap, within 30 ms of the game logging the car's pit slot as
`None`, i.e. the car joining the track. Three of the four exits had a pit-speeding notice
(`PenaltyType_Warning`, `InvestigationType_Speeding`, sent in the pit lane), one had none, and
the flag behaved identically, so the warning invalidates nothing: the game's own log says so
too, `Penalty Type PenaltyType_Warning has no tranformation`. The invalidation is the pit
exit itself, filed on whichever lap it falls in. That is why the car's location is read: the
tag for such a lap is OUTLAP, quiet, not red, and the 30 s "recent notice" attribution that
would have printed INVALID · SPEEDING on it was removed the same day.

## The two layouts are held to the same states

`python tools/render_states.py` renders the widget in nineteen states in both layouts and
puts them side by side in `dev/states.png` (not committed). The rule it checks: the two
columns show the same figures, colours, chevron sides, fills, tags and gaps, and differ only
in what the compact layout has no room for (cells, trace, tick). `--reasons` renders a second
sheet, `dev/reasons.png`: every reason the game has on the invalid tag, in the tightest case
the line can meet (a driver named, no reference, the narrow width). Checked 2026-09-22: all
21 fit in both layouts with the tag whole; what gives is the left of the line, as designed
(the note clips first, then the driver's name, down to "vs M. Verstap" under the longest
reason in compact narrow). The preview has the same check by eye: a reason picker beside its
cut button (and the `reason=Name` flag) for one at a time, and an "all reasons" button (the
`reasons` flag) that opens a gallery of the live widget cloned once per reason and layout,
with the tag text the widget itself would write, under the widget's current options; two
checkboxes add or drop the driver's name and the no-reference note. The first run of it
(2026-09-22) found three faults the harness had not: the game's `-1` for "no predicted lap"
passed the lap-time sanity check and coloured the PREDICTED cell green against the best (now
a lap time must be positive); "vs Name" and the no-reference note ran together (a gap); and
the top line was in the flow, so the bar jumped a line down whenever a tag came and back up
when it went (now the line floats above the panel, out of the flow, with the panel's own
dark behind it in full and the tags' own backgrounds in compact). All three are in the
harness now, the third by measuring that the bar's top does not move.

A second pass from other angles (the same day): a soak case in the harness now drives forty
seconds of the scripted lap through each layout and each faster side and checks, on every
frame, the invariants that tie the parts together (one trend class, sign classes against the
delta, the figure's text, one fill only and on the right side with the right share, the
tick's shift, the figure row following it only in compact, the top line on exactly when it
has something, the chevron on the side the fill is heading, the prediction's colour). It
found nothing wrong in the widget and one thing wrong in the checker (judging a frame before
it was drawn). A long driver name is now clipped in its group and can never push the
INVALID tag out of the line (tested). And the game's log for the session was read for engine
warnings: 163 `Trying to set display property to invalid value!` lines came from the loader's
settings pane using `display: inline-flex`, which this Cohtml does not have (now `flex`, and
refused by the loader's kit); nothing else in the log traced to this widget.

Later passes, each from a new angle: a sweep of all 3,456 combinations of the look options
(classes, the numbers the loop reads and what is on screen all agree); lifecycle paths (models
vanishing and returning, no timing model, focus lost); numeric edges (minus zero, NaN,
infinity, the range boundary, a minute of delta); a stall longer than the sampler's gap; fifty
attach/detach rounds (no listener, handler or frame leaks); a steady frame writing nothing to
the DOM and a moving one touching only the fills, the tick and the figure. Three more faults
came out of them and are fixed: the lap trace switched on mid-lap showed the slots of a lap
driven while it was off (now blanked when it comes back); after a stall the trend's ring
spanned the stall (now emptied when a frame gap exceeds the sampler's two seconds); and a
root reused by a re-attach (the drawer switching the app off and on) kept the per-frame
classes of its earlier life, so `bd-gain` could sit beside `bd-flat` until the trend next
changed (attach now puts every per-frame class where the fresh state says). The write-count
case is what caught the last one: the root's class list was wrong while nothing was writing.
After those, five passes in a row found nothing: the state matrix re-rendered, the release
zip's contents, Pedal Graph's suite against the tightened kit, a privacy sweep of the change
set, and the preview's flags and buttons against its code.

**The reason on the tag.** The notice's second value is a reason key
(`InvestigationType_Racecar_Cut` for the cut measured); the stock box prints it through
`engine.translate`, which turns it into "Track Limits". The widget does the same, falls back
to the key with its prefix and underscores dropped when the engine has no translation, and
shows it after INVALID; the reason is remembered with the cut through the reload. The keys
are the members of the game's `InvestigationType` enum (`PenaltySystem.proto`, twenty of
them, `Racecar_Cut` to `StartFromPit`), and their English words are in the game's own
localisation table (`uiresources\localization\en.loc` inside `content.kspkg`: `Track
Limits`, `Pitlane Speeding`, `Wrong Way`, ...), so the widget carries the whole table as a
fallback and a contract test holds it to the enum; the engine's translation is still asked
first so the player's language wins. The flag alone carries no reason of its own: a flag
rising on a lap driven wholly on the track, with no notice, reads plain INVALID. The enum
also has two lap invalidations as penalty types, `PenaltyType_InvalidLap` and
`PenaltyType_InvalidNextLap` ("Invalid Lap" in the table); neither has been seen in a
notice yet, but a notice of the first marks this lap and one of the second the lap that
follows, from its first frame, with the notice's reason, remembered through the reload.

**The flag is the truth, the notice the reason.** Which penalties also void the lap is the
game's decision per session, and the notice's type does not say so for the dozen real
penalty types (Warning to Disqualification), so the widget does not guess from the type: a
flag rising on a lap driven wholly on the track is an invalidation, and it takes its reason
from the last notice for our car within 500 ms (the measured gap between a cut's notice and
its flag is 19 ms), or a notice within 500 ms after the flag fills the reason in. Outside the
window the tag reads plain INVALID. The window is safe against the pit-speeding case because
a pit lap's flag is never a cut, and against a warning followed by a real cut because the
cut's own notice always wins. The harness sends every one of the 21 reasons on each of the
three invalidating types and every one of the 14 non-invalidating types, and a contract test
holds both lists to the game's enums.

**Two labels on game fields the game does not explain.** `delta_time_drivername` has been
empty in every session measured; the stock bar shows it above its bar when it is not, and so
does this widget ("vs Name"), with no switch: a switch for a line that never appeared did
nothing visible and was removed (2026-09-22). `ModelTiming.ideal` is shown as SESSION OPTIMAL
on the reading that an ideal lap is the session's best sectors added up; the stock UI never
displays the field, so this is not confirmed. The widget logs `laps: best, ideal, last` every
time one of them changes, so a session's log tells: the ideal must never exceed the best, and
must fall after a lap that beat a sector without beating the lap.

**Edges that are known and left.** A cut in the last metres of a lap whose notice arrives
after the line would mark the NEW lap; the notices measured came within 20 ms of the flag,
so this needs a cut across the timing line itself, and the flag path would still be right
about the old lap. A cut on a pit lap can only be seen through the notice, and it wins over
the quiet tag; no notice, OUTLAP. A build of the game that stopped publishing
`car_location` would leave every pit exit unnamed: a lap flagged from its first metre shows
nothing, as before, and one flagged at the pit exit after the line would read plain INVALID.

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
