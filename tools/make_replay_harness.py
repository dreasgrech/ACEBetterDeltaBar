"""Write tests/replay/harness.html for the delta bar: recorded game sessions driven through the real
widget in the browser, the tag checked after every event the recorder saw, with Escape/resume
reloads injected, then every session again with a reload after each event (but the notices and the game's
own clock corrections) and with a jittered clock. Every replay also holds the widget's count of laps to
the game's own.
Regenerate from a new recording with tools/extract_replay.py (a game log written with the capabilities
app's model recorder on), then this: python tools/make_replay_harness.py"""
import io
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPLAY = os.path.join(os.path.dirname(HERE), "tests", "replay")

EVENTS = json.load(io.open(os.path.join(REPLAY, "replay_events.json"), encoding="utf-8"))
OUT = os.path.join(REPLAY, "harness.html")

# the log lines of the widget itself are dropped from the record: the replay is about what the widget does now
for name in EVENTS:
    EVENTS[name]["events"] = [e for e in EVENTS[name]["events"] if e["kind"] != "bdb"]

TITLES = {
    "race2_cut_verdict": "race, 2026-09-23 00:38 Road Atlanta: a cut at 0.21 of lap 2, the flag alone, clean again at the line",
    "race4_pitstop_outlap_cut": "race, 01:13: a pit stop ending lap 1 (PIT LANE), the line inside the pit lane, the exit flag (OUTLAP), a cut verdict on the out-lap (INVALID), two Escape/resume reloads",
    "race5_timed_two_cuts": "timed race, 01:32: a cut with its NO GAIN verdict 7.8 s later, a clean lap and a reload, a second cut with its verdict 9.3 s later",
    "practice6_rain_six_cuts": "practice in rain, 01:47: spawned in the pit lane (PIT LANE), out-lap (OUTLAP), a lap with six LAP_INVALIDATED notices and a reload, the session ending on a double boundary",
    "mp7_clock_corrections": "multiplayer practice, 02:29: the game's lap clock stepping back 79 times by 2 to 54 ms (35 parked in the pit lane at three hours on the clock, 44 while driving), around the two real boundaries",
}
EXPECT = {
    "race2_cut_verdict": [("flag", "true @22522", "INVALID"), ("lap", "108072", "")],
    "race4_pitstop_outlap_cut": [
        ("location", "Pitentry", "PIT LANE"), ("flag", "true @107513", "PIT LANE"), ("location", "Pitlane", "PIT LANE"), ("lap", "123673", "PIT LANE"),
        ("location", "Pitexit", "PIT LANE"), ("flag", "true @69081", "PIT LANE"), ("location", "Track @79162", "OUTLAP"), ("reload", "", "OUTLAP"),
        ("notice", "NO_GAIN", "INVALID \u00b7 TRACK LIMITS"), ("reload", "", "INVALID \u00b7 TRACK LIMITS"), ("lap", "175841", "")
    ],
    "race5_timed_two_cuts": [
        ("flag", "true @82552", "INVALID"), ("notice", "NO_GAIN", "INVALID \u00b7 TRACK LIMITS"), ("lap", "100310", ""), ("reload", "", ""),
        ("flag", "true @10479", "INVALID"), ("notice", "NO_GAIN", "INVALID \u00b7 TRACK LIMITS"), ("lap", "101215", "")
    ],
    "mp7_clock_corrections": [
        ("start", "", "PIT LANE"), ("location", "Track", "OUTLAP"), ("lap", "-> 124", ""), ("lap", "-> 0", ""),
    ],
    "practice6_rain_six_cuts": [
        ("start", "", "PIT LANE"), ("location", "Pitexit", "PIT LANE"), ("location", "Track", "OUTLAP"), ("lap", "156349", ""),
        ("notice", "LAP_INVALIDATED", ""), ("flag", "true @28922", "INVALID \u00b7 TRACK LIMITS"), ("reload", "", "INVALID \u00b7 TRACK LIMITS"),
        ("notice", "LAP_INVALIDATED", "INVALID \u00b7 TRACK LIMITS"), ("notice", "LAP_INVALIDATED", "INVALID \u00b7 TRACK LIMITS"),
        ("notice", "LAP_INVALIDATED", "INVALID \u00b7 TRACK LIMITS"), ("notice", "LAP_INVALIDATED", "INVALID \u00b7 TRACK LIMITS"),
        ("notice", "LAP_INVALIDATED", "INVALID \u00b7 TRACK LIMITS"), ("lap", "183791", "")
    ],
}
RELOADS = {
    "race4_pitstop_outlap_cut": [("location", "79162", 3000), ("notice", "NO_GAIN", 2000)],
    "race5_timed_two_cuts": [("lap", "", 20000)],
    "practice6_rain_six_cuts": [("notice", "LAP_INVALIDATED", 1500)],
}
UNTIMED_START = ["practice6_rain_six_cuts"]

page = r'''<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Better Delta Bar replay tests</title>
<style>
  body { margin: 0; background: #222; color: #ddd; font: 12px monospace; }
  .absolutecenter { position: relative; width: 1600px; height: 900px; overflow: hidden; }
  #results { white-space: pre; }
</style>
<!--
  Recorded sessions replayed through the real widget. The events (car location, the timing flag,
  lap boundaries, the game's own corrections of its clock, penalty notices, each with the lap clock
  it came at) were taken from the game's
  own logs by the capabilities app's model recorder on 2026-09-22/23 at Road Atlanta, and the tag
  is checked after every one: what the expectation list says at its moments, and the same until the
  next. Escape/resume reloads (a fresh root and state, the store kept) are injected where they hurt
  most; then every session is replayed once more per recorded event with a reload right after that
  event but the notices and the clock corrections (a reload inside the notice-to-flag gap is a known
  edge; a reload per correction would be 79 replays of one session), and once with the
  lap clock jittered by up to 2 ms and every seventh frame dropped, and
  the same expectations must hold. Generated by make_replay_harness.py from replay_events.json;
  edit the expectations there, not here.
-->
<script src="../../../ACEUIAppLoader/tests/lib/doubles.js"></script>
<script>
window.ModelCurrentCar = { has_focused_car: true, delta_time_ms_ui: 2147483647, delta_time_ms: 0, predicted_lap_time_ms: -1,
                           current_lap_time_ms: 0, npos: 0.03, delta_time_drivername: "", car_location: "Track",
                           low_frequency: { total_drivers: 11, total_lap_count: 0 } };
window.ModelTiming = { best: "", ideal: "", last: "", current: "", invalid: false };
window.ModelCarsOnTrack = { cars_on_track: [{ car_number: 0, is_focused: true }, { car_number: 1, is_focused: false }] };
</script>
<script src="../../../ACEUIAppLoader/tests/lib/lib.js"></script>
<link rel="stylesheet" type="text/css" href="../../betterdeltabar/betterdeltabar.css">
<script src="../../betterdeltabar/betterdeltabar.js"></script>
</head>
<body>
<div class="absolutecenter" id="center"></div>
<script>
(function () {
    const H = window.__harness;
    const t = H.t, eq = H.eq, ok = H.ok;
    const B = BetterDeltaBar;
    const clock = window.__clock;
    const car = window.ModelCurrentCar, timing = window.ModelTiming;
    const center = document.getElementById("center");
    const FRAME = 16;
    const MS_PER_MIN = 60000, MS_PER_S = 1000;
    const DATA = %(data)s;
    const TITLES = %(titles)s;
    const EXPECT = %(expect)s;
    const RELOADS = %(reloads)s;
    const UNTIMED_START = %(untimed)s;

    const engineHandlers = {};
    window.engine = {
        on: function (name, cb) { engineHandlers[name] = cb; return { clear: function () { delete engineHandlers[name]; } }; },
        trigger: function () {},
        translate: function (key) { return ({ InvestigationType_Racecar_Cut: "Track Limits" })[key] || key; },
        call: function () { return { then: function (done) { done({ penalties: [] }); } }; }
    };

    const pad = function (n, width) { let s = String(n); while (s.length < width) { s = "0" + s; } return s; };
    /** The game's lap text, "mm:ss.fff", or nothing while the clock stands at 0 or the lap is untimed. */
    const lapText = function (ms, untimed) {
        if (untimed || ms === 0) { return ""; }
        const w = Math.round(ms);
        return pad(Math.floor(w / MS_PER_MIN), 2) + ":" + pad(Math.floor((w % MS_PER_MIN) / MS_PER_S), 2) + "." + pad(w % MS_PER_S, 3);
    };
    const tagOf = function (root) {
        return root.classList.contains("bd-invalid") || root.classList.contains("bd-pit") ? root.querySelector(".bd-invalid-tag").textContent : "";
    };

    const JITTER_MS = 2, DROP_EVERY = 7;
    /** A small deterministic generator for the jitter, so a failure replays the same. */
    const rng = function (seed) { let x = seed; return function () { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }; };

    /** Replay one session: `extra` reloads (as {t}) on top of the listed ones, `perturb` jitters the clock and drops frames. */
    const replay = function (name, label, extra, perturb) {
            const events = DATA[name].events.slice();
            const expect = EXPECT[name].slice();
            (RELOADS[name] || []).forEach(function (r) {
                const hit = events.filter(function (e) { return e.kind === r[0] && (r[1] === "" || JSON.stringify(e).indexOf(r[1]) >= 0); })[0];
                ok(hit, "reload anchor found: " + r.join(" "));
                events.push({ t: hit.t + r[2], kind: "reload" });
            });
            (extra || []).forEach(function (e) { events.push({ t: e.t, kind: "reload" }); });
            events.sort(function (a, b) { return a.t - b.t; });
            const r = rng(name.length);
            ACEUIAppLoader.app("betterdeltabar").forget("lap");   // no record carried in from the session before
            const faults = [];
            const note = function (what) { if (faults.length < 5) { faults.push(what); } };
            const laps = function () { return window.__log.filter(function (l) { return l.indexOf("new lap") >= 0; }).length; };
            const lapsBefore = laps();
            const realLaps = events.filter(function (e) { return e.kind === "lap"; }).length;
            let frames = 0;
            /** One frame (the loop variable `step` is the time step): the model's clock as given, or jittered by up to JITTER_MS; every seventh frame is dropped when perturbing. */
            const runFrame = function () {
                frames += 1;
                if (perturb && frames % DROP_EVERY === 0) { return; }
                if (perturb && typeof car.current_lap_time_ms === "number" && car.current_lap_time_ms > 0) {
                    const clean = car.current_lap_time_ms;
                    car.current_lap_time_ms = Math.max(0, clean + Math.round((r() * 2 - 1) * JITTER_MS));
                    clock.step(now);
                    car.current_lap_time_ms = clean;
                    return;
                }
                clock.step(now);
            };
            window.ModelCarsOnTrack.cars_on_track[0].car_number = DATA[name].car;
            car.low_frequency.total_lap_count = 0;
            center.innerHTML = "";
            let root = document.createElement("div");
            center.appendChild(root);
            let now = 1000;
            clock.step(now);
            let untimed = UNTIMED_START.indexOf(name) >= 0;
            const start = events.filter(function (e) { return e.kind === "start"; })[0];
            const firstFlag = events.filter(function (e) { return e.kind === "flag"; })[0];
            car.car_location = start ? start.location : "Track";
            car.current_lap_time_ms = start ? start.lapMs : 0;
            car.npos = start ? start.npos : 0.03;
            timing.invalid = firstFlag ? firstFlag.invalid : false;
            timing.current = lapText(car.current_lap_time_ms, untimed);
            let state = B.attach(root);
            let prevT = start ? start.t : 0;
            let lapAtPrev = car.current_lap_time_ms;
            let checked = 0;
            let want = "";

            try {

            events.forEach(function (e) {
                // frames up to the event; the lap clock runs on from the last value the record gave, and a
                // clock standing at 0 (the grid before the start) stays at 0 as in the game
                const baseT = prevT;
                while (prevT < e.t) {
                    const step = Math.min(FRAME, e.t - prevT);
                    prevT += step; now += step;
                    if (lapAtPrev > 0) { car.current_lap_time_ms = lapAtPrev + (prevT - baseT); }
                    timing.current = lapText(car.current_lap_time_ms, untimed);
                    runFrame();
                }
                // a boundary or a correction: the game showed the old clock's last value one frame before it
                if (e.kind === "lap" || e.kind === "clock") { car.current_lap_time_ms = e.fromMs; timing.current = lapText(e.fromMs, untimed); now += FRAME; runFrame(); }
                let detail = "";
                if (e.kind === "start") { detail = e.location + " lap " + e.lapMs; }
                else if (e.kind === "flag") { timing.invalid = e.invalid; if (e.lapMs !== null) { car.current_lap_time_ms = e.lapMs; } detail = String(e.invalid) + " @" + e.lapMs; }
                else if (e.kind === "location") { car.car_location = e.location; if (e.lapMs !== null) { car.current_lap_time_ms = e.lapMs; } detail = e.location + " @" + e.lapMs; }
                else if (e.kind === "lap") { car.current_lap_time_ms = e.lapMs; car.low_frequency.total_lap_count = typeof e.count === "number" ? e.count : car.low_frequency.total_lap_count + 1; if (e.invalid !== null) { timing.invalid = e.invalid; } untimed = false; detail = e.fromMs + " -> " + e.lapMs; }
                // the game's own correction of its clock: it steps back a few ms and no lap begins
                else if (e.kind === "clock") { car.current_lap_time_ms = e.lapMs; if (typeof e.count === "number") { car.low_frequency.total_lap_count = e.count; } if (e.invalid !== null) { timing.invalid = e.invalid; } detail = e.fromMs + " -> " + e.lapMs + " (" + (e.fromMs - e.lapMs) + " ms back)"; }
                else if (e.kind === "notice") { if (e.lapMs !== null) { car.current_lap_time_ms = e.lapMs; } engineHandlers.UINotification({ type: "UINotificationType_SessionPenalty", tuples: [{ values: e.values }] }); detail = e.values.join(" | "); }
                else if (e.kind === "reload") { B.detach(state); root = document.createElement("div"); center.innerHTML = ""; center.appendChild(root); state = B.attach(root); detail = "Escape/resume"; }
                lapAtPrev = car.current_lap_time_ms;
                timing.current = lapText(car.current_lap_time_ms, untimed);
                now += FRAME;
                clock.step(now);   // the event's own frame is never dropped, so the judgement below is of a frame that ran
                // the tag is judged after every event: what the list says at its moments, and the same until the next
                if (expect.length && expect[0][0] === e.kind && (expect[0][1] === "" || detail.indexOf(expect[0][1]) >= 0)) {
                    want = expect.shift()[2];
                    checked += 1;
                }

                if (tagOf(root) !== want) { note(label + Math.round(e.t / 1000) + " s, " + e.kind + " " + detail + ": tag " + JSON.stringify(tagOf(root)) + ", expected " + JSON.stringify(want)); }
            });
            // the widget found the game's laps and no others: a clock correction taken for a boundary would
            // clear the trace, reset the trend and forget the lap, which the tag alone cannot always show
            if (laps() - lapsBefore !== realLaps) { note(label + "the widget found " + (laps() - lapsBefore) + " lap boundaries; the game had " + realLaps); }

            if (expect.length) { note(label + "moments never met: " + JSON.stringify(expect)); }

            if (checked <= 0) { note(label + "nothing was checked"); }

            // every fault of this replay together: a tag that went wrong early must not hide the count below
            eq(faults.join(" | "), "", label + "faults");
            } finally {
                B.detach(state);   // whatever was judged, the loop stops here, so a fault cannot poison the next replay
            }
    };

    Object.keys(DATA).forEach(function (name) {
        t(TITLES[name] || name, function () { replay(name, "", [], false); });
    });

    Object.keys(DATA).forEach(function (name) {
        t((TITLES[name] || name).split(":")[0] + ": the same with an Escape/resume reload right after each recorded event in turn", function () {
            DATA[name].events.forEach(function (e, i) {
                // not the widget's own log lines; and not a notice: a reload inside the 19 to 48 ms between a practice
                // notice and its flag keeps the tag (the flag's) but loses the reason, a documented edge (notes.md)
                if (e.kind === "bdb" || e.kind === "notice" || e.kind === "clock") { return; }   // a reload per correction would be 79 replays of one session
                replay(name, "reload after event " + i + " (" + e.kind + " at " + e.t + " ms): ", [{ t: e.t + FRAME }], false);
            });
        });
    });

    Object.keys(DATA).forEach(function (name) {
        t((TITLES[name] || name).split(":")[0] + ": the same with the lap clock jittered by up to 2 ms and every seventh frame dropped", function () {
            replay(name, "jittered: ", [], true);
        });
    });

    H.finish();
}());
</script>
</body>
</html>
'''
for key, value in (('data', EVENTS), ('titles', TITLES), ('expect', EXPECT), ('reloads', RELOADS), ('untimed', UNTIMED_START)):
    page = page.replace('%(' + key + ')s', json.dumps(value))
io.open(OUT, "w", encoding="utf-8", newline="\n").write(page)
print("wrote", OUT, len(page), "bytes")
