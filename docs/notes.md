# Notes

What this widget reads, what it decided, and why, kept for the next timing app in this
engine.

## What the game gives a delta bar

Everything is read from the globals the stock UI mirrors every frame (see
`ACEGameInternals/docs/ui-models.md`), nothing is computed from telemetry:

| field | what it is | how it is used |
|---|---|---|
| `ModelCurrentCar.delta_time_ms_ui` | the stock ks-delta's delta, int ms (not rounded: 57 of the 70 non-sentinel values measured are not multiples of ten); `2147483647` (int32 max) when there is no reference lap | the gate: the sentinel means "no reference"; the fallback figure |
| `ModelCurrentCar.delta_time_ms` | the same number as the field above whenever there is a reference; `0`, not the sentinel, when there is none (measured over 206 pairs in the logs of 2026-09-22 and 23), which is why the ui field is the one that says whether a reference exists | the figure and the trend, when it is a sane number (under an hour) |
| `ModelCurrentCar.predicted_lap_time_ms` | the lap this pace ends in; `<= 0` when unknown | the PRED figure, coloured against the best |
| `ModelCurrentCar.current_lap_time_ms` | the running lap time | going back by more than 150 ms to near the line (or by more than a second) is a new lap, as is the lap count moving or another car under focus: the trace clears, the trend ring resets |
| `ModelCurrentCar.npos` / `npos_perc` | position along the lap, 0..1 / 0..100 | which slot of the lap trace takes the delta; the trace stays blank when neither is a number |
| `ModelCurrentCar.delta_time_drivername` | who the delta is against when it is not your own lap | the "vs Name" line |
| `ModelTiming.best` | the best lap as the game formats it, `""` when none | shown as is; parsed to ms to colour the prediction |
| `ModelTiming.ideal` / `.last` | the session optimal (best sectors added up) and the last lap, formatted | the other two cells, shown as they come |
| `ModelTiming.invalid` | the lap is invalid; **true on any lap the car spent time in the pit lane on**: from the first metre of the lap out of the pits (measured: `lap time 468 ms, invalid true`), or from the pit exit when the timing line lies inside the pit lane; a cut on such a lap does not change it | the gate for the INVALID tag (red only while it is up); the flag alone counts as a cut only when it rises during a lap that started valid AND never touched the pit lane (latched over the first 500 ms, `lapStartedInvalid`; the pit-lane visit is `pitLap`); a pit lap gets the quiet PIT LANE / OUTLAP tag instead |
| `ModelCurrentCar.car_location` | where the car is, `CarLocation.Type` as a string: `Pitlane`, `Pitentry`, `Pitexit`, `Track` (`Unassigned` exists too); the stock pit-limiter warning compares it to `"Pitlane"` and `"Pitentry"` | the pit lane (any of the three) makes the lap a pit lap, remembered through the reload; PIT LANE while in it, OUTLAP once out with the flag still up |
| `engine.on("UINotification")` | the game's UI notifications, the event the stock top-right box draws from; a lap invalidation is a `UINotificationType_SessionPenalty` whose `tuples[0].values` are `["{PENALTY_CLEARED_KEY} #666", "InvestigationType_Racecar_Cut", "lblNotificationPenalty_LAP_INVALIDATED"]` for a track-limits cut in practice (measured 2026-09-22 16:07, several times per cut) | the reason, and what makes a lap flagged from its first metre a cut: that exact type key and the car number matching the focused car in the cars-on-track model marks the lap cut until the next lap (the tag shows while the game's flag is up). The key is a l10n id (not in the stock `ePenaltyType` table), so it is the same in every language; the widget logs every penalty notification it sees. The notice comes once and Escape/resume rebuilds the page, so the cut is kept through `me.remember` keyed by `low_frequency.total_lap_count` (or the lap time and the flag when there is none) and restored on the first frame if it is still that lap |

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

The compact bar's black is 0.94 alpha: 0.8 read as mid grey against a bright sky in game. With the
background option off its track is 0.35, not nothing: the fill's edge is antialiased against whatever
lies behind it, and over the moving scene that blend changes every frame, which the eye reads as a
flickering edge (reported from the game, 2026-09-23). The track's own body gives the edge something
constant to land on.

Both layouts mark the middle of the bar, which is the reference lap: the fill grows from there, so
without it a small fill near the centre says nothing about how far off you are (reported from the
game, 2026-09-23, where the compact layout hid the mark). In the full layout the panel's own track
gives the eye a frame and a hairline at 12% white is enough. The compact bar is a solid block over
the scene with a solid fill beside it, so its mark is 0.14em wide, white at 0.9, with a dark glow
to hold it apart from a green or red fill, and it is drawn after both fills so it is never covered.

Six cascade findings from the layout review of 2026-09-23, all order or units: the drag
outline rule came before the compact block, whose transparent border then beat it, so the
outline never showed in compact (the one layout where it is the only sign of the panel's
box); with background "none" in the full layout the top line and the cells had no shadow and
the bar's track vanished against the scene; the tag's box was a pixel border plus a
line height in tag-em, taller than the 0.98em band at every scale (now 1.2em plus 0.08em
borders, 0.952 root-em); the compact figure's no-background shadow rule came after the
strong-trend glow and cancelled it; and the "lap tags off" hide rule came before the tag
rules, so it only ever worked because the script never set the class (it is after them now);
and the top line painted a background of its own over the panel's, which darkened the strip
whenever the line came and lightened it when it went, so the band takes the panel's background
now. Each has a case in the harness.

`npos` was not measured live before 0.1.0: the field is in the protobuf schema
(`UICurrentCarState` field 113, `npos_perc` 112) and is range-checked at read time, so a
value outside 0..1 leaves the trace empty rather than wrong. The first in-game session
tells: the minute log line says `no npos` when neither field reads.

**What the log proved about the flag (2026-09-22, practice, one car).** A pit exit reads
`lap time 465 ms, invalid true` on its first frame and stays flagged all the way round; a cut
on that lap changes nothing in the timing model, only the notification says. Crossing the
line: `new lap: lap time 35 ms, invalid false` in the same frame the lap time resets, so the
boundary is unmistakable. A cut on a lap that started valid: the notification arrives
(16:16:47.276) and the flag rises 19 ms later (`invalid true, lap started invalid false`), so
both sources agree. The invalid tag therefore shows only while the game's flag is up, and then
in two cases: the flag rose on a lap it was down for and driven wholly on the track, or the
game's own notice named our lap (a lap flagged from its first metre with such a notice is a
cut, not a pit exit); it goes when the flag goes (the line, a return to the pits), and a HUD
reload keeps the reason only for the very lap it was set on.

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
when it went (now the line has a band of its own reserved at the top of the panel, inside
its box, so the bar never moves and a panel dragged to the top edge keeps the line on
screen; it first floated above the panel, out of the flow, until a review on 2026-09-23
found that the loader's drag clamp only knows the panel's box). All three are in the
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

**The flag is the truth, and only the game's own verdict is the reason.** The red tag is
never on screen while `ModelTiming.invalid` is false: a notice, or a cut remembered through a
reload, gives the flag its reason and never a tag of its own. The flag was never seen to drop
on an invalidated lap before the line in seven sessions; if it ever did, the game would be
calling the lap valid again, and so would the tag (found by fuzzing, 2026-09-23: a next-lap
notice, or a cut carried by a stale record, could paint a lap the game had not flagged). The game states
two facts about a lap's validity and nothing else: `ModelTiming.invalid`, at once, and
session-penalty notices, each with a car number, a reason and a type, no lap number and no
clock. The penalty-state model holds real penalties only and stayed empty through every cut
measured; the engine's log says nothing. So the widget uses no timing at all. A flag rising
on a lap driven wholly on the track is an invalidation, and its reason comes from a notice
for our car on the same lap that the game's own words tie to the lap: a type that is an
invalidation (LAP_INVALIDATED in practice, InvalidLap, InvalidNextLap), the type NO GAIN (the
verdict on a cut, "no time gained"), or any type whose reason is Racecar_Cut (a cut that
gained time draws a time penalty; the lap is void either way, and the game kept a faster cut
lap off `best` on 2026-09-23). Delay does not matter, and order does not for an invalidation
notice (LAP_INVALIDATED marks the lap before the flag; a verdict with no flag of this lap's
up is dropped and logged, the flag being the truth): in practice the cut's notice
comes 19 to 48 ms before the flag; in a race there is no LAP_INVALIDATED at all and the NO
GAIN verdict came 4.4, 4.8 and 9.8 s after the flag on three cuts at Road Atlanta
(2026-09-23), while a cut followed by a stop on the track never got its verdict. A collision,
an unsafe rejoin, a warning or pit-lane speeding is tied to the lap by nothing the game
sends, so the tag stays plain INVALID, which is what the game said. "The same lap" is
structural: a new lap forgets the cut, so a verdict that arrives after the line is dropped
and logged, never pinned on the lap that follows. A verdict on a lap whose flag was not a
cut's, the pit exit's on an out-lap or one up since the lap began, marks the cut: the game
says the lap had one, and INVALID with its reason replaces the quiet OUTLAP (Road Atlanta
2026-09-23 01:18:24, a NO GAIN a minute after the pit exit; the first version dropped it as
"no flag up" because the flag had been booked to the pit lap, and the driver saw OUTLAP with
no word of the cut). The first version had a 500 ms window
either side of the flag, tuned on practice, and a race cut then read plain INVALID for the
whole lap; that window is gone. Every notice's values are logged whole, so the record shows
everything the game sent. The harness sends every one of the 21 reasons on each of the three
invalidating types and every one of the 14 non-invalidating types, replays the race verdict
and the dropped late one, and a contract test holds both lists to the game's enums.

**Whose notice it is.** The "#N" in the notice is matched against the focused car's number,
read from `ModelCarsOnTrack` and nothing else. The stock UI fetches a model from the engine
only while one of its widgets has enabled it (`ksUI.Models.enable`); the track map enables
cars-on-track and nothing in the stock ever disables it, so once on it is fresh every frame.
The two leaderboard models were a fallback until 2026-09-23: the stock's MFD leaderboard page
disables them when it closes and leaves the stale globals on the window (with the leaderboard
widget hidden both sat frozen through a whole race, holding lines from an earlier attempt), so
a fallback to them could match a foreign notice against a stale focused line (found by review
against the stock bundle). The widget asks the game to stream cars-on-track at attach, and again
at any poll after the model has been seen streaming, in case a stock page switched it off; a game
that does not take the switch is asked once and told so in the log. It never switches the model
off itself (the list is not reference counted). If even so nothing says which car is ours, a notice naming a car is ours
only when the session has one driver; online, with no number to compare, it is nobody's. A
false INVALID from another car's cut is the one thing the tag must never do, and this is the
rule that makes it impossible rather than unlikely (checked with car numbers 0 to 10 and 42).

**Two labels on game fields the game does not explain.** `delta_time_drivername` has been
empty in every session measured; the stock bar shows it above its bar when it is not, and so
does this widget ("vs Name"), with no switch: a switch for a line that never appeared did
nothing visible and was removed (2026-09-22). `ModelTiming.ideal` is shown as SESSION OPTIMAL
on the reading that an ideal lap is the session's best sectors added up; the stock UI never
displays the field, so this is not confirmed. The widget logs `laps: best, ideal, last` when one
of them changes, at most once a second, so a session's log tells: the ideal must never exceed the best, and
must fall after a lap that beat a sector without beating the lap.

**A verdict on the boundary frame is the old lap's.** The car model's clock and the timing
model's flag come from two models that tick apart, so the frame the clock resets on can still
show the flag of the lap just finished (recorded: `lap 183791 -> 35, invalid true`). A verdict
(NO GAIN) arriving in that gap found the flag standing and the new lap not yet cut, and was
pinned on the new lap with the old lap's reason; the lap then read INVALID · TRACK LIMITS for
as long as the leftover flag stood, and a pit visit on it red instead of PIT LANE. Now the
verdict branch refuses a flag that has not yet been seen down on a lap inside its first
moments, as every other rule already did (review, 2026-09-23). A record filed under a lap
number, met by a first frame without the count (the low-frequency block can be missing on the
frame the car comes back), is neither restored nor thrown away: it waits for a frame that has
the count, or for the lap to end (same review; a bad frame used to destroy a genuine cut's
record for good). When it settles, the record adds to what the lap gathered meanwhile (a notice,
the pit lane) and never takes it away, bar a flag-only cut on a lap the record knows as a pit lap,
whose rise was the pit exit (second pass, 2026-09-23: the settling record used to erase a notice
received while it waited). A pending next-lap invalidation anchors nothing by itself: without a
lap number the flag decides, as for a cut (same review). A frame with no car lets go of the lap's
identity as well as its state (clock, count, car id): a count kept from before made the one the
car came back with look like a boundary a frame after it joined, and a cut on the new lap was
forgotten (second pass). And "inside the first moments of a lap" is a fact the lap keeps, not a
clock comparison: a boundary frame that lacks the clock field (the count moved, the clock did
not come) leaves the old clock standing, and the verdict guard read it as 98 s into the new lap
(second pass). A boundary the lap count alone made, on a frame without the clock, left the old
clock standing and the new lap's first clock read as a second boundary, which forgot everything the
new lap had gathered in between: a lap that has not yet shown a clock has no clock to have gone back
from (third pass, 2026-09-23). Such a lap takes the flag as found on the frame that first brings it
a clock past its first moments, as a lap whose first frame comes late does, or a real cut on it would
show nothing at all; its record is stamped at the start rather than with the clock kept from the lap
before, which no clock of this lap could ever reach, and re-stamped as soon as the lap has a clock
of its own, so that start mark (which any frame of any lap clears) does not outlive the lap's first
frames; and a lap count arriving a frame after the clock,
which the grace lets through as the same boundary, re-files the record under the lap it opened (fourth
pass, 2026-09-23: all three were ways a genuine cut was lost on a lap the count alone opened). And the
clock a record is judged against is the one kept from the
last frame that had the field, so the frame that brings the lap count can settle a record even
without a clock of its own (same pass); the clock must still have reached the mark the record was
written at, because within a session a lap's clock only goes forward, so the same lap number at an
earlier clock belongs to another session.

**A lap has three signs, and a cut needs the flag to come back.** A new lap is the lap
clock going back by more than a tick, or the car's lap count moving, or another car coming
under focus (a replay, spectating); any one of the three, and the clock is kept from the last
frame that had it, so a frame that loses the field cannot let a cut leak onto the lap that
follows. The grace that lets a lap count arriving a frame late count as the boundary just seen
belongs to the count alone: another car under focus is always another lap to follow, and
suppressing it could carry one car's cut onto another's (third pass, 2026-09-23). A frame with no focused car at all ends the lap the widget was following: the car that
comes back may be on any lap, so the next frame with one is a first frame again and joins its
lap by the remembered record's rules, and until it has one a flag found up is taken as found, not
as a cut (fuzzing found both: the freeze, where a spell without the car spanned
two laps and a pending next-lap invalidation was applied to the wrong one). A notice that arrives
while no lap is being followed (no car to read; the first frame after a reload not yet seen) is
logged and dropped: it names no lap, and the lap the car comes back on may not be the one it was
about (fuzzing again). The flag still shows on the lap the game voided; only the reason is lost. A remembered cut is
restored after a reload only with the game's flag up: a record left by an earlier session whose
lap number and clock happen to fit must not paint a clean lap (the flag is the truth; the record
is the reason). A record filed under a lap number is matched against a lap number and nothing
else, and against the session's event and session ids when the session model gives them (those
two fields are in the schema and have not been read in game yet; a record without them, or a
frame without them, skips the check). Both restore rules found by review on 2026-09-23.

**A lap is the clock going back, but not by a little.** `current_lap_time_ms` going backwards
is the lap boundary, but only by more than 150 ms, and only if it landed within 5 s of the line
(a real boundary lands in the first tens of ms, a stall over the line a few seconds in) or
dropped by more than a second (a longer stall over the line). A read a millisecond behind the
last one (two models refreshed on different ticks) is not a lap, and neither is the game's own
correction of its clock: in a multiplayer practice (log of 2026-09-23 02:29 to 02:31, 32
drivers) the clock stepped back 79 times in 107 s, 35 of them with the car parked in the pit
lane (its clock past three hours) and 44 while driving, the largest step 54 ms; no single-player
session showed one. The widget of that day took 41 of those steps for laps in that window, each
one clearing the trace, resetting the trend and forgetting the cut. The first version took any
step back as a new lap, which forgot the cut and the pit lap (replaying recorded sessions found
it); the second allowed one 20 ms tick, which that log showed was not enough; the tolerance is
now nearly three times the largest step seen, and the landing rule carries the rest. The game's
own double boundary at a session end (35 ms to 0) is now a wobble, harmlessly: the lap it would
open has nothing in it. A step back of more than 150 ms inside the first 5 s of a lap still reads
as a lap; no such correction has been seen.

**Edges that are known and left.** `total_lap_count` does not step at the out-lap's first line
crossing (measured three times: `156349 -> 35`, `146416 -> 26`, `10782611 -> 124`, the count 0
before and after), so the out-lap and the first flying lap share the lap number 0; a record
filed on the out-lap could be matched to the first flying lap by a reload that spans the line
with the flag up, which online (where Escape does not stop the car) is possible in theory and
has not happened. The session's event and session ids would settle it once they are seen in
game. A cut in the last metres of a lap whose notice arrives
after the line would mark the NEW lap; the notices measured came 19 to 48 ms before the flag,
so this needs a cut across the timing line itself, and the flag path would still be right
about the old lap. A HUD reload inside the 19 to 48 ms between a practice notice and its flag
(Escape hit within two frames of the cut) keeps the tag, which is the flag's, and loses the
reason: the record is restored only under the flag, and the flag is not up yet. A lap whose first frame the widget sees late (a stall over the line, a
pause on it) takes the flag as it finds it at that frame, so a cut later on that lap still
shows; inside the first half second the flag is assumed up until seen down, as before. A cut on a pit lap can only be seen through the notice, and it wins over
the quiet tag; no notice, OUTLAP. A build of the game that stopped publishing
`car_location` would leave every pit exit unnamed: a lap flagged from its first metre shows
nothing, as before, and one flagged at the pit exit after the line would read plain INVALID.

## The trend

The hysteresis is one-sided: staying in the trend we are in needs half the band, entering one
(from flat, or from the other side) needs the whole band, so jitter smaller than the band cannot
flip the colour. A rate that crosses the whole band in one step does change colour without a flat
frame between, which is a real change of pace and not what the rule is for.
The first version applied the half band to either direction once any trend was on, so a
steady driver with a millisecond or two of noise on the delta flapped green and red twenty
times a second after the first real trend (review, 2026-09-23). The ring's stall reset is
measured off the sampler's own clock, which trails the frame clock by up to a period: off
the frame clock, a stall a few ms short of the gap restarted the sampler and kept the ring,
and the first sample after it read a whole window's worth of change (same review). The strong
glow has the same one-sided hysteresis (entered at five bands, kept to four while the trend
stays): a rate hovering at the threshold blinked it at up to 20 Hz (second pass, 2026-09-23). A
change of the delta's reference mid-lap (another car under comparison) resets the ring: the
step in the delta is the reference's, not the driving's, and under the jump threshold it read
as a whole window of false trend (same pass).

The delta is sampled at 20 Hz through `ACEUIAppLoader.loop.sampler` into a ring of 41
(two seconds, the widest window, and the sample before it: a rate over forty samples needs
forty-one; a ring of forty left the 2 s window flat for good, found by review 2026-09-23) and compared with the sample one window back, a second by
default. The difference per second is the rate:

- inside the dead band (15 ms/s by default; 5 fine, 40 coarse) the trend is **flat**,
- past it **gaining** (rate negative: the delta is falling) or **losing**,
- past five bands **strong**, which brightens the colour and the chevron.

Staying in a trend needs only half the band, entering one the whole band, so jitter smaller than
the band cannot flip the colour (the strong glow is entered at five bands and kept to four). A delta
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

Three rules from the hot-path review of 2026-09-23, and one gate (`CHANGE_LOG_MS`) that two
lines share. The race-cut diagnostic fields are three numbers that could move every frame once
the rule they belong to is live (they never left zero in the sessions measured), and the three
lap strings could too if `ideal` turns out to be a rolling value; both are logged on change and
at most once a second, or the game log would take a line per frame. The trace fills in up to three skipped slots behind a
slow frame (`TRACE_BACKFILL_MAX`), never more: a delta outage or a hidden HUD leaves the slots it passed blank, because a
block painted over them with the delta of the moment would say the delta held there. The
predicted lap's colour has a dead band of 20 ms about the best and keeps a colour to 10 ms,
the trend's own hysteresis, because the prediction moves every frame and flickered at the
best. The bar range changed mid-lap blanks the trace and lets the lap draw on from the car's
slot: slots at the old scale beside slots at the new read as a step in the delta that never
was (options review, 2026-09-23; the same review put the README right about the trace being
the full layout's and about which section holds attract mode).


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

The figure is written as two halves that meet at the decimal point, each taking the same share of the
box, so the point is always at the box's middle. Centred as one string it sat wherever the glyph widths
left it: the digits of the numeral font are wide and the sign and the point are narrow, which in game
put the point a full glyph left of the bar's own centre mark (measured from a screenshot, 2026-09-23,
10.5 px on a 122 px tag). The eye anchors on the point, so the whole readout looked offset. A half
longer than its share spills outwards, away from the point, which also keeps the point still as the
number gains or loses a digit. How it got there (all 2026-09-23, each seen in game): the
figure was split into two halves meeting at the point, first by flex from a content-sized box, then
by halves placed at the middle with no width of their own; both overlapped in game while passing in
the browser, because the engine worked no width out of the text. Stated halves then worked, but in
the compact tag, which had side padding, the engine measured the halves against the content box and
placed them from the padding edge, 12.5 px left of the middle, and the point glyph (inked at the
left of its cell) added 13 px more. With the point finally pinned to the middle of a centred tag, the
digits were not balanced about it ("--" before, "---" after), which left an empty glyph's width on the
left of the tag (36 px against 16 px). The user chose the tag hugging the digits with the point still
on the mark, so the figure is one string again, in a tag sized from it (which the engine has always
drawn correctly), and the row holding the tag and its chevrons leans: it is moved by the distance
between the middle of the text and the point's ink. In the game's mono font (read from the font file:
digits and signs 0.511em, point and colon 0.255em, the point inked 0.038 to 0.166em into its glyph)
that is (lean x 0.511 / 4 + 0.255 / 2 - 0.102) em, the lean being the width after the point less the
width before, in half glyphs, so twelve classes cover every figure from "+10:02.34" (-7) to "0.000"
(4). A first table taken from a screenshot counted the point as a full glyph and was 0.128em out. The tag therefore sits slightly right of the
bar's centre for a figure under ten seconds with three decimals; the point is what lines up. Nothing in the suite could have caught that, because
the suite runs in a browser; see "What the tests cannot see" below.


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

## Lifecycle

`attach` acquires the panel loop, the scaler, a settings listener, the game's model switches
and the notification hook inside one try: if any step throws, whatever was acquired is released
again and the error goes on to the loader, which would otherwise hold a half-attached widget it
can neither stop nor restart. A second `attach` on a root already attached stops the first
widget first (the console and the harnesses can do that; the loader never does). The
penalty-state fetch is a promise the engine may never settle (a model the stock never binds):
an unanswered fetch is given up after five seconds and the next poll asks again, a late answer
is told apart by id and ignored, and an answer arriving after `detach` touches nothing (found by
review, 2026-09-23: one unanswered fetch used to end the polling for the life of the attach and
keep the state, its DOM included, alive through the pending promise). A fetch the engine refuses
is one log line, deduped like an answer, and a call that returns no promise leaves nothing in
flight. A call that throws rather than rejecting says the same one line (it used to go through the
library's `safely`, which has no memory and would have written a line every two seconds for the
whole session; third pass, 2026-09-23). The request to stream the cars-on-track model runs inside `safely`, is made once per
switch-off (a game that does not take it gets one line and is not asked again; a stock page that
switches the model off later is asked about again), so neither a throwing nor an unresponsive
`ksUI.Models.enable` can stop attach, break a frame, or write a line every poll (second pass).

## Attract mode

The scripted lap ("Attract mode", for recording without driving) shares nothing with the real
one: switching it either way drops the lap being followed from memory, so the next frame of
the other mode is a first frame that reads its own lap afresh, and the store is blind to it
(the scripted lap neither writes a record nor restores or judges the real one). Before
2026-09-23 the scripted lap ran through the same lap machinery, so switching attract on
mid-lap counted as a new lap and forgot the real cut's record from the store, and a notice
arriving during attract was filed under the scripted lap number (found by review). The lap
clock is read with the sentinel as its only upper bound, not the hour the deltas and lap times
are held to: it runs on past the hour while the car sits in the pit lane, and a widget attached
then drew nothing until the next line crossing (same review). The widget draws while it waits
for a lap clock: the wait is for the lap bookkeeping only, and switching attract off with no
clock about used to leave the scripted frame standing until the clock came (second pass).

## What the tests cannot see

The three harnesses run in a desktop browser. They drive the real widget through the real models, so
they prove what it decides, what it writes and when; they cannot prove how the game's engine lays it
out. Renoir is not the browser's layout engine, and where a layout leans on the engine measuring
content, the two disagree. That is how a figure that passed every case in the browser reached the game
with its two halves on top of each other (2026-09-23): the halves were sized by flex from a zero basis
inside a box whose width came from its own content, which the browser resolves by measuring the
content and Renoir resolves as nothing at all. The finding is recorded with the rest in
`ACEGameInternals/docs/gameface-notes.md`. It is not a kit rule: the same pattern is right where the
box's width is stated, which is how the four lap-time cells divide the panel, and a stylesheet cannot
be read to tell one from the other. So the rule is a habit rather than a check: lay a thing out the way
something already proven in game is laid out, and see it in the game before believing it. The rendered
sheets in `dev/` are a browser's opinion of the layout, not the game's.

## How it is tested

Three browser harnesses, all run by `python -m unittest tests.test_app` through the loader's
kit (`tests/**/harness.html`, the case count held to a minimum across them). `tests/widget`
is the specification: one case per rule, in the order the rules were found; every case that
follows a lap starts and leaves a fresh clean one, so a failure cannot travel. `tests/replay` drives five sessions recorded in the game (Road Atlanta, 2026-09-23,
from two logs: a race cut shown by the flag alone, clean again at the line; a pit stop with a cut
on the out-lap; a timed race with two cuts; a wet practice with six invalidations; and a
multiplayer practice whose clock stepped back 79 times) through the real widget, event by event
as the capabilities app's model recorder logged them. It judges the tag after every event and
holds the widget to the game's own count of laps, which the tag alone cannot always show: a
correction taken for a boundary clears the trace, resets the trend and forgets the lap, and on a
clean lap that is invisible in the tag (the multiplayer session and the wet practice both catch
the old 20 ms tolerance this way, and nothing else does). Then it replays each session once per
recorded event but the notices and the corrections (a reload inside the notice-to-flag gap is a
known edge, above; a reload per correction would be 79 replays of one session) with an
Escape/resume reload right after it, and once with the lap clock jittered by up to 2 ms and
every seventh frame dropped. It is
generated: `tools/extract_replay.py <game log>` turns the recorder's lines into
`tests/replay/replay_events.json`, `tools/make_replay_harness.py` writes the harness from
that and the expectations in the generator. `tests/fuzz` runs five seeds of twelve thousand
frames of random models, flags, locations, junk values, notices for our car and others', and
reloads, and holds what the game's data can answer: the red tag needs the flag up this frame
and a cause seen this lap (the flag rose, or the game named our lap), its reason is one the
game gave for this lap, the quiet tags need the pit lane this lap, and nothing throws. The
fuzz found the two carry bugs of 2026-09-23 (a spell without the car, a notice in that spell);
the replays found the tick tolerance and the reload inside the notice-to-flag gap.

## Verifying in game

The game writes UI `console.log` output into `Saved Games\ACE\Logs\log-*.txt` as
`[gameface]` lines. Run `python ..\ACEUIAppLoader\tools\check_ingame_log.py` after playing:
`[ACEUIAppLoader] app betterdeltabar <version>: loading` followed by
`[Better Delta Bar] script loaded, version <version>` means the loader served the app;
`waiting for a lap clock` once a minute means the car model has no `current_lap_time_ms` yet, so
the widget is drawing what it has without following a lap; `widget attached` carries the options
the game restored; `delta ok <figure> trend <trend>`
once a minute means car data is flowing, and says `no npos` if the position field is not
there (then the trace stays empty and should be switched off in the options).
