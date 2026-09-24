"""The replay extractor reads every line format the capabilities recorder writes, old and new.

Before 2026-09-24 the recorder wrote every step back of the lap clock as a LAP BOUNDARY; since then a
correction is a CLOCK STEP BACK line and a LAP BOUNDARY is always a lap, possibly with the clock going
forward (the lap count's alone) or missing. None of these may stop the extraction.
"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import extract_replay  # noqa: E402

START = "2026-09-24 10:00:00"
END = "2026-09-24 11:00:00"


def line(clock, text):
    return "[2026-09-24 10:00:" + clock + "] [ACEUIAppLoader] [UI Capabilities Probe] rec: " + text


class ExtractReplayTests(unittest.TestCase):
    def kinds(self, lines):
        return [(e["kind"], e.get("fromMs"), e.get("lapMs")) for e in extract_replay.extract(lines, START, END, 0)["events"]]

    def test_old_recorder_small_step_back_is_a_correction_and_a_big_one_a_lap(self):
        lines = [
            line("01.000", 'LAP BOUNDARY: lap clock 30000 -> 29955 npos=0.5 location="Track" timing={invalid:false} lowfreq={total_lap_count:3}'),
            line("02.000", 'LAP BOUNDARY: lap clock 98000 -> 20 npos=0.01 location="Track" timing={invalid:false} lowfreq={total_lap_count:4}'),
        ]
        self.assertEqual(self.kinds(lines), [("clock", 30000, 29955), ("lap", 98000, 20)])

    def test_new_recorder_every_lap_boundary_is_a_lap_and_corrections_are_their_own_lines(self):
        lines = [
            line("01.000", 'CLOCK STEP BACK: lap clock 30000 -> 29955 location="Track" invalid=false total_lap_count:3'),
            line("02.000", 'LAP BOUNDARY: lap clock 5100 -> 4900 npos=0.5 location="Track" timing={invalid:false} lowfreq={total_lap_count:4}'),
            line("03.000", 'CLOCK STEP BACK: lap clock 40000 -> 39960 location="Track" invalid=undefined total_lap_count:null (2 more since the last line)'),
        ]
        events = extract_replay.extract(lines, START, END, 0)["events"]
        self.assertEqual([(e["kind"], e["fromMs"], e["lapMs"]) for e in events], [("clock", 30000, 29955), ("lap", 5100, 4900), ("clock", 40000, 39960)])
        self.assertEqual(events[0]["invalid"], False)
        self.assertIsNone(events[2]["invalid"], "no timing model on that frame: unknown, not false")
        self.assertIsNone(events[2]["count"])

    def test_a_count_only_boundary_with_the_clock_forward_or_missing_is_a_lap_and_does_not_stop_the_extraction(self):
        lines = [
            line("01.000", 'LAP BOUNDARY: lap clock 5000 -> 5016 npos=0.5 location="Track" timing={invalid:false} lowfreq={total_lap_count:4}'),
            line("02.000", 'LAP BOUNDARY: lap clock 60000 -> undefined npos=0.5 location=undefined timing=undefined lowfreq={total_lap_count:5}'),
            line("03.000", 'LAP BOUNDARY: lap clock -1 -> 5016 npos=0.5 location="Pitlane" timing={invalid:true} lowfreq={total_lap_count:6}'),
        ]
        events = extract_replay.extract(lines, START, END, 0)["events"]
        self.assertEqual([(e["kind"], e["fromMs"], e["lapMs"]) for e in events], [("lap", 5000, 5016), ("lap", 60000, None), ("lap", None, 5016)])
        self.assertIsNone(events[1]["location"], "location=undefined is no location")
        self.assertEqual(events[2]["location"], "Pitlane")


if __name__ == "__main__":
    unittest.main()
