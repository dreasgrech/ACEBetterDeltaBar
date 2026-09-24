# Changelog

## Unreleased

Version not bumped yet (still 0.1.0 in `app.json`). Needs ACE UI App Loader 0.26.0.

### Look
- Centre mark on the bar in both layouts; the compact bar had none.
- The figure's decimal point now lines up with the centre mark.
- No reference lap: no figure and no chevrons instead of a dim placeholder.
- Compact bar with Background: none has a darker track, fixing a flickering edge.
- Faster side options listed Left, Right.

### INVALID tag
- A late race verdict (NO GAIN) could mark the wrong lap INVALID: after a pit stop, a return to the pits, an Escape/resume, or switching to another car.
- A reload right at the pit exit could read the pit-exit flag as a cut.
- The lap count and the lap clock moving a frame apart counted as two laps.
- After a spell with no focused car, a flag found up was taken as a cut on the new lap.
- A cut remembered through Escape/resume early in a lap could be lost.
- Switching to another car mid-lap could show its pit-exit flag as INVALID.
- A cut could be lost when the car dropped out for a frame in multiplayer.
- A pit-exit flag could show red for a moment after Escape/resume, before the lap count came back.

### Other fixes
- With two decimals, a delta that rounds to 0.00 still painted the faster side.
- With no focused car, the last figure, colours and predicted lap stayed on screen.
- Predicted lap colour was dropped on any option change.
- Compact layout with Number: overall or white: a black shadow came and went with a strong trend.
- Lap trace no longer draws into its hidden slots in the compact layout.
- Bad values from the game (NaN in the lap count or the delta) are ignored.

### Docs
- README: lap trace is full layout only; Attract mode is in the Look section; the predicted lap colour starts 20 ms from your best and holds to 10 ms; INVALID shows while the game's flag is up; OUTLAP covers any lap partly in the pit lane.
- notes.md: figure alignment, centre mark, stylesheet review findings, lifecycle, the INVALID tag's rules, test setup.

### Tests
- Widget harness now 145 cases, plus a replay harness (five sessions recorded in game, replayed with reloads, jitter and dropped frames) and a fuzz harness (five seeds of 12,000 random frames).
- `tools/extract_replay.py` and `tools/make_replay_harness.py`, with tests for every recorder line format.
- The preview reads the focused car from the cars-on-track model and raises the flag with the cut notice.

## 0.1.0 — 2026-09-23

First public release.
