# Changelog

## 0.2.0 — 2026-09-24

Needs ACE UI App Loader 0.26.0.

### Look
- Centre mark on the bar in both layouts; the compact bar had none.
- The figure's decimal point now lines up with the centre mark.
- No reference lap: no figure and no chevrons instead of a dim placeholder.
- Compact bar with Background: none has a darker track, fixing a flickering edge.
- Faster side options listed Left, Right.
- Attract mode drives realistic laps for recording: real lap length, each lap measured against the best one, big swings both ways, the best lap improving. Its lap trace is drawn at once. It swings as far across the bar at any Bar range, lasts one game session and ignores the game's notices.

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
- With two decimals, a figure reading 0.00 was coloured as if gaining or losing. The fill still moves smoothly with the delta, through the centre too.
- With no focused car, the last figure, colours and predicted lap stayed on screen.
- Predicted lap colour was dropped on any option change.
- Compact layout with Number: overall or white: a black shadow came and went with a strong trend.
- Lap trace no longer draws into its hidden slots in the compact layout.
- Lap trace survives Escape/resume.
- Bad values from the game (NaN in the lap count or the delta) are ignored.

### Docs
- README: shorter, in the style of the other apps; says which loader version it needs.
- notes.md: figure alignment, centre mark, stylesheet review findings, lifecycle, the INVALID tag's rules, test setup.

### Tests
- Widget harness now 147 cases, plus a replay harness (five sessions recorded in game, replayed with reloads, jitter and dropped frames) and a fuzz harness (five seeds of 12,000 random frames).
- `tools/extract_replay.py` and `tools/make_replay_harness.py`, with tests for every recorder line format.
- The preview reads the focused car from the cars-on-track model and raises the flag with the cut notice.

## 0.1.0 — 2026-09-23

First public release.
