# Changelog

## Unreleased

Version not bumped yet (still 0.1.0 in `app.json`).

### Look
- Centre mark on the bar in both layouts; the compact bar had none.
- The figure's decimal point now lines up with the centre mark.
- No reference lap: no figure and no chevrons instead of a dim placeholder.
- Compact bar with Background: none keeps a faint track, fixing a flickering edge.
- Faster side options listed Left, Right.

### Fixes
- Predicted lap colour was dropped on any option change.
- A lap opened by the lap count before its clock arrived read the invalid flag a frame late.
- A lap remembered through Escape/resume before its clock was seen could never be restored.
- After a spell with no focused car, a flag found up was taken as a cut on the new lap.
- Cars-on-track model stream request repeated every poll on a game that does not take it; now asked once.

### Docs
- README: lap trace is full layout only; Attract mode is in the Look section; predicted lap colour has a 20 ms dead band; INVALID shows while the game's flag is up; OUTLAP covers any lap partly in the pit lane.
- notes.md: figure alignment, centre mark, stylesheet review findings, lifecycle, test setup.

### Tests
- Widget harness 47 → 117 cases.
- Replay harness: five sessions recorded in game, replayed with and without reloads, jitter and dropped frames.
- Fuzz harness: five seeds of 12,000 random frames.
- `tools/extract_replay.py` and `tools/make_replay_harness.py`.
- Preview reads the focused car from the cars-on-track model and raises the flag with the cut notice.

## 0.1.0 — 2026-09-23

First public release.
