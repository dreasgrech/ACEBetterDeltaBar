"""Turn the recorder's lines from the real game logs into replay event lists for the delta bar.

Each event: {"t": ms since the window start, "kind": ..., ...}. Kinds: start (location, lapMs, npos),
location (location, lapMs), flag (invalid, lapMs, npos), lap (fromMs, lapMs, invalid, location, count),
clock (the same fields: the game's clock stepping back without a lap, seen in multiplayer), notice
(values, lapMs, npos), bdb (the widget's own log line; the generator drops these). Each session record
carries the own car number as "car".

A step back is a lap or a correction by its size: a lap drops the clock by the whole lap (47 s to three
hours in the recordings) and a correction by 2 to 54 ms, three orders of magnitude apart, so the
threshold below cannot be mistaken and does not repeat the widget's own rule.
"""
import io
import json
import re
import sys
from datetime import datetime

import os

HERE = os.path.dirname(os.path.abspath(__file__))
# the game logs to read (Saved Games\ACE\Logs\log-*.txt, written with the capabilities app recording): the
# two behind the five recorded sessions; and the events file the harness is generated from
LOGS = r"C:\Users\User\Saved Games\ACE\Logs"
OUT = os.path.join(os.path.dirname(HERE), "tests", "replay", "replay_events.json")
# a step back bigger than this is a lap; anything smaller is the game correcting its own clock
CORRECTION_MS = 1000

# (name, log, start, end, own car number) as hh:mm:ss; the first log was begun on the evening of the 22nd
WINDOWS = [
    ("race2_cut_verdict", "log-260922-234702.txt", "2026-09-23 00:38:05", "2026-09-23 00:42:02", 0),
    ("race4_pitstop_outlap_cut", "log-260922-234702.txt", "2026-09-23 01:13:55", "2026-09-23 01:19:12", 0),
    ("race5_timed_two_cuts", "log-260922-234702.txt", "2026-09-23 01:32:36", "2026-09-23 01:39:22", 0),
    ("practice6_rain_six_cuts", "log-260922-234702.txt", "2026-09-23 01:47:35", "2026-09-23 01:53:17", 0),
    ("mp7_clock_corrections", "log-260923-020524.txt", "2026-09-23 02:29:24", "2026-09-23 02:31:20", 0),
]

STAMP = re.compile(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]")


def ms(stamp):
    return datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S.%f").timestamp() * 1000.0


def num(text, key):
    m = re.search(key + r":(-?[0-9.]+)", text)
    return float(m.group(1)) if m else None


def extract(lines, start, end, car):
    t0 = ms(start + ".000")
    t1 = ms(end + ".000")
    events = []
    for line in lines:
        m = STAMP.match(line)
        if not m:
            continue
        t = ms(m.group(1))
        if t < t0 or t > t1:
            continue
        rel = round(t - t0)
        if "rec: start: " in line:
            events.append({"t": rel, "kind": "start", "location": re.search(r'car_location:"([A-Za-z]*)"', line).group(1),
                           "lapMs": num(line, "current_lap_time_ms"), "npos": num(line, "npos")})
        elif "rec: initial timing.splits" in line or "rec: changed timing.splits" in line:
            inv = "invalid:true" in line
            events.append({"t": rel, "kind": "flag", "invalid": inv, "lapMs": num(line, "lapMs"), "npos": num(line, "npos")})
        elif "rec: changed car_location" in line or "rec: initial car_location" in line:
            loc = re.search(r'car_location: "([A-Za-z]*)"', line).group(1)
            events.append({"t": rel, "kind": "location", "location": loc, "lapMs": num(line, "lapMs")})
        elif "rec: LAP BOUNDARY" in line:
            mm = re.search(r"lap clock (\d+) -> (\d+)", line)
            was, now_ms = int(mm.group(1)), int(mm.group(2))
            count = re.search(r"total_lap_count:(\d+)", line)
            events.append({"t": rel, "kind": "lap" if was - now_ms > CORRECTION_MS else "clock",
                           "fromMs": was, "lapMs": now_ms,
                           "invalid": "invalid:true" in line.split("timing=")[1] if "timing=" in line else None,
                           "count": int(count.group(1)) if count else None,
                           "location": re.search(r'location="([A-Za-z]*)"', line).group(1)})
        elif "rec: NOTICE " in line and "UINotificationType_SessionPenalty" in line:
            values = re.search(r"values:\[([^\]]*)\]", line).group(1)
            vals = re.findall(r'"([^"]*)"', values)
            events.append({"t": rel, "kind": "notice", "values": vals, "lapMs": num(line, "lapMs"), "npos": num(line, "npos")})
        elif "[Better Delta Bar] invalid flag changed" in line or "[Better Delta Bar] penalty notification" in line \
                or "[Better Delta Bar] the verdict" in line or "[Better Delta Bar] new lap" in line or "[Better Delta Bar] in the pit lane" in line:
            events.append({"t": rel, "kind": "bdb", "text": line.split("[Better Delta Bar] ")[1].strip()[:160]})
    return {"car": car, "events": events}


read = {}
out = {}
for name, log, start, end, car in WINDOWS:
    path = log if os.path.isabs(log) else os.path.join(LOGS, log)
    if path not in read:
        read[path] = io.open(path, encoding="utf-8", errors="replace").read().split("\n")
    out[name] = extract(read[path], start, end, car)
    kinds = {}
    for e in out[name]["events"]:
        kinds[e["kind"]] = kinds.get(e["kind"], 0) + 1
    print(name, kinds)
io.open(OUT, "w", encoding="utf-8").write(json.dumps(out))
print("wrote", OUT)
