/**
 * Better Delta Bar -- Assetto Corsa EVO HUD widget.
 *
 * A delta bar that tells you two things at a glance, where the stock one tells you one.
 * The stock ks-delta colours its bar and its number by the sign of the overall delta:
 * green while the lap as a whole is ahead of the reference, red while it is behind. That
 * says nothing about the last few seconds -- a lap that is 0.4 s up but bleeding time
 * through every corner is green all the way round. This widget keeps the bar for the
 * overall delta and colours the NUMBER by the trend: green while you are gaining on the
 * reference right now, red while you are losing, white while nothing is changing, with a
 * chevron pointing the way the end of the fill is moving: towards the faster side while
 * gaining, towards the slower side while losing.
 *
 * Two layouts. "Full" is a broadcast-style block: a wide bar with the figure sitting on
 * it and the fill growing out from the centre behind it, a bright tick at the fill's end,
 * and a row of cells beneath -- session optimal, session best, predicted lap (coloured
 * against the best) and, if wanted, the last lap. "Compact" is the iRacing shape: a thin
 * bar with a solid fill and the figure in a small tag under it, which can follow the end
 * of the fill. The full one can add a trace of the delta across the lap.
 *
 * Loaded into the stock HUD page by the ACEUIAppLoader (see app.json). It knows nothing
 * of the stock ks-* component framework; it only reads the global model objects the game
 * refreshes every frame and draws into one plain <div>. Styling lives in
 * betterdeltabar.css; this file writes no colours or sizes, only transforms, classes
 * and text (the one exception: each trace slot's left and width, in %, written once when
 * the markup is built).
 *
 * Built on the ACEUIAppLoader library: `me.panel` makes the root draggable and persists
 * its position and runs the frame loop, `ACEUIAppLoader.loop.sampler` samples the delta
 * at a fixed rate for the trend, `ACEUIAppLoader.settings` holds the options and draws
 * them in the app's settings window, `me.scale` sizes the panel.
 *
 * Data source: `window.ModelCurrentCar` (UICurrentCarState) and `window.ModelTiming`
 * (UITimingState), mirrored into the Gameface UI by ksUI.perFrameAllModelUpdate:
 *
 *     delta_time_ms_ui        int ms, the stock widget's delta; 2147483647 (int32 max) = no delta
 *     delta_time_ms           int ms, the same number as delta_time_ms_ui whenever there is a
 *                             reference; 0, not the sentinel, when there is none, which is why
 *                             the ui field is what says whether there is one
 *     predicted_lap_time_ms   int ms, the lap this pace ends in; <= 0 when unknown
 *     current_lap_time_ms     int ms; it going backwards is a new lap
 *     npos                    float 0..1, position along the lap (npos_perc is the same in %)
 *     delta_time_drivername   string, who the delta is against when it is not your own lap
 *     ModelTiming.best / .ideal / .last   strings "1:43.445", "" when there is none
 *     ModelTiming.current     the running lap as a string, "Outlap" or "" before a timed lap
 *     ModelTiming.invalid     the lap flag; up on any lap the car spent time in the pit lane on, so only a
 *                             rise on a lap driven wholly on the track is a cut
 *     car_location            "Pitlane" / "Pitentry" / "Pitexit" / "Track" (CarLocation.Type, as a string)
 *
 * A positive delta is time lost (slower than the reference), as everywhere in the game.
 * The stock bar grows to the RIGHT for time gained; so does this one by default, and the
 * "Faster side" option turns it round for anyone used to iRacing, where lost time grows right.
 *
 * Rendering rules (Cohtml/Renoir): the markup is built once at attach; per frame the
 * widget writes textContent when a string changed, toggles a class when a state changed
 * and writes `transform` on a fixed set of elements. No geometry is ever rebuilt (the
 * lesson of PedalGraph: SVG paths rewritten per frame crashed the game inside Renoir).
 *
 * The trend: the delta is sampled at a fixed rate into a small ring and compared with
 * the sample one window ago (a second by default). The difference per second is the rate
 * the delta is moving at; inside a dead band it reads flat, past it gaining or losing,
 * and past several bands strongly so. Staying in a trend needs half the band and entering one
 * the whole band, so jitter smaller than the band cannot flip the colour; the strong glow is
 * entered at five bands and kept to four. A jump between two samples bigger than any driving
 * could make (a new lap), or a change of the delta's reference, starts the ring again rather
 * than reading as a huge trend.
 *
 * Usage: `BetterDeltaBar.attach(rootElement)` returns the widget's state;
 * `BetterDeltaBar.detach(state)` stops it and releases its listeners.
 */
const BetterDeltaBar = (function () {

    /**
     * Identity from the loader: name, version (app.json), title, root, a prefixed
     * logger and the storage keys, so none of it is repeated here.
     */
    const me = ACEUIAppLoader.app("betterdeltabar");

    /** The game's "no delta" sentinel in delta_time_ms_ui: int32 max. */
    const NO_DELTA_MS = 2147483647;
    /** The same int32 maximum as the game's "nothing" in any of its int fields: no lap clock or lap count reaches it. */
    const INT32_SENTINEL = NO_DELTA_MS;
    /** A delta or lap time beyond an hour is a sentinel or garbage, not a time. */
    const MAX_TIME_MS = 3600000;
    const MS_PER_S = 1000;
    const MS_PER_MIN = 60000;
    const S_PER_MIN = 60;
    const MIN_PER_HOUR = 60;
    const LOG_EVERY_MS = 60000;
    /** Fields that could move every frame are logged on change, but no more often than this, or the game log takes a line a frame. */
    const CHANGE_LOG_MS = 1000;
    /**
     * Decimals kept when writing a scale: a ten-thousandth of the half bar, a fraction of a pixel. A thousandth
     * was 5 ms of delta at a 5 s range, and the fill then moved on a quarter of the frames the delta did.
     */
    const SCALE_DECIMALS = 4;
    const SHIFT_DECIMALS = 2;
    const LAYOUT_DECIMALS = 4;
    const PERCENT = 100;
    /** The fill's end sits at half the bar's width times the share: the tick and the tag move by that. */
    const HALF_PERCENT = 50;
    /** Digits of a millisecond fraction, and of a padded seconds field. */
    const MS_DIGITS = 3;
    const TWO_DIGITS = 2;
    /** The base the figures here are parsed and scaled in. */
    const DECIMAL_BASE = 10;
    /** What a bar that must not show is set to: the stylesheet's own initial transform. */
    const HIDDEN_Y = "scaleY(0)";
    const NO_SHIFT = "translateX(0%)";

    /**
     * The trend. The delta is sampled at TREND_HZ into a ring long enough for the widest
     * window, and compared with the sample one window back. Rates are in ms of delta per
     * second: below the band the trend is flat; at STRONG_FACTOR bands it is strong.
     */
    const TREND_HZ = 20;
    const TREND_MAX_S = 2;
    /** The ring holds the widest window AND the sample before it: a rate over N samples needs N + 1 of them. */
    const TREND_N = TREND_HZ * TREND_MAX_S + 1;
    /** The window choices, label to seconds. The label is the stored value. */
    const TREND_WINDOWS = { "0.5 s": 0.5, "1 s": 1, "2 s": 2 };
    const TREND_WINDOW_DEFAULT = "1 s";
    /** Dead band choices, label to ms of delta per second. */
    const TREND_BANDS = { fine: 5, normal: 15, coarse: 40 };
    const TREND_BAND_DEFAULT = "normal";
    const STRONG_FACTOR = 5;
    /** The strong glow, once on, is kept down to this share of its threshold: a rate hovering at the threshold must not blink it. */
    const STRONG_KEEP = 0.8;
    /** Leaving gain or lose needs the rate to drop under this share of the band: hysteresis. */
    const HYSTERESIS = 0.5;
    /** A change bigger than this between two samples is a new lap or a new reference, not driving. */
    const JUMP_MS = 1000;
    /** A sampler stall longer than this (a pause) starts the ring afresh. */
    const TREND_GAP_MS = 2000;

    const TREND_FLAT = "flat";
    const TREND_GAIN = "gain";
    const TREND_LOSE = "lose";

    /** Bar range choices: the delta that fills half the bar. The label is the stored value. */
    const RANGES = { "0.5 s": 500, "1 s": 1000, "2 s": 2000, "5 s": 5000 };
    const RANGE_DEFAULT = "1 s";
    /** Decimals of the delta figure; a choice stores strings. */
    const DECIMALS = { "2": 2, "3": 3 };
    const DECIMALS_DEFAULT = "3";
    /** What the figure shows with no reference lap, per decimals choice. */
    const NO_DELTA_TEXTS = { "2": "--.--", "3": "--.---" };
    const NO_TIME_TEXT = "-:--.---";
    const NO_REFERENCE_TEXT = "no reference lap";
    /** While there is no reference, the top line shows the lap ticking, so the widget is visibly alive. */
    const NO_REFERENCE_LAP_TEXT = "no reference yet · lap ";
    const TENTH_MS = 100;
    const INVALID_TEXT = "INVALID";
    /** Between INVALID and the game's reason for it, when the notice gave one ("INVALID · TRACK LIMITS"). */
    const REASON_SEPARATOR = " · ";
    /** The game's reason keys are l10n ids like "InvestigationType_Racecar_Cut"; this prefix goes when no translation is to be had. */
    const REASON_PREFIX = /^InvestigationType_/;
    /**
     * Every reason the game has (PenaltySystem.proto, enum InvestigationType, game 0.9.1),
     * with the words its English table gives them (uiresources\localization\en.loc inside
     * content.kspkg; StartFromPit has no entry there and Cleaning_Penalties has one without
     * being in the enum). The notice carries the key; the engine's own translation is asked
     * first, so the player's language wins, and this table answers when the engine does not
     * know the key or there is no engine (the preview). A key in neither is shown cleaned up.
     */
    const REASONS = {
        InvestigationType_Racecar_Cut: "Track Limits",
        InvestigationType_Collision: "Collision",
        InvestigationType_Illegal_Overtake: "Illegal Overtake",
        InvestigationType_Pit_Speeding: "Pitlane Speeding",
        InvestigationType_Pit_Entry: "Pit Entry",
        InvestigationType_Pit_Exit: "Pit Exit",
        InvestigationType_Ignored_Mandatory_Pit: "Ignored Mandatory Pit Stop",
        InvestigationType_Unsafe_Rejoin: "Unsafe Rejoin",
        InvestigationType_Race_Control: "Race Control",
        InvestigationType_Reverse_In_Pitlane: "Reversing In Pitlane",
        InvestigationType_Wrong_Way: "Wrong Way",
        InvestigationType_Ignored_Driver_Stint: "Ignored Driver Stint",
        InvestigationType_Exceeded_Driver_Stint_Limit: "Exceeded Driver Stint Limit",
        InvestigationType_Driver_Ran_No_Stint: "Failed To Meet Stint Requirement",
        InvestigationType_Damaged_Car: "Damaged Car",
        InvestigationType_Lights_Off: "Lights Off",
        InvestigationType_Speeding_On_Start: "Speeding On Start",
        InvestigationType_Wrong_Position_On_Start: "Wrong Position On Start",
        InvestigationType_Speeding: "Speeding",
        InvestigationType_StartFromPit: "Start From Pit",
        InvestigationType_Cleaning_Penalties: "Penalties Cleared"
    };
    /**
     * The two tags for a lap that does not count with nothing wrong: PIT LANE while the car is
     * in the pit lane (the game keeps the flag up there and the lap clock running), OUTLAP for
     * the rest of a lap the car spent any of in the pit lane. Neither is red: an outlap is not
     * a mistake.
     */
    const PIT_LANE_TAG = "PIT LANE";
    const OUTLAP_TAG = "OUTLAP";
    /**
     * The tags attract mode can put on its scripted lap, so a recording can show one without a
     * lap being cut: none, the usual cut first, then plain INVALID, the two quiet tags, and INVALID
     * with every other reason the game has. The option's value is the tag itself (the settings
     * window's cycle button shows a value as it is), in the English words of REASONS.
     */
    const ATTRACT_TAG_OFF = "Off";
    const ATTRACT_TAG_FIRST_REASON = "InvestigationType_Racecar_Cut";
    const invalidWith = function (key) { return INVALID_TEXT + REASON_SEPARATOR + REASONS[key].toUpperCase(); };
    const ATTRACT_TAGS = [ATTRACT_TAG_OFF, invalidWith(ATTRACT_TAG_FIRST_REASON), INVALID_TEXT, OUTLAP_TAG, PIT_LANE_TAG].concat(
        Object.keys(REASONS).filter(function (key) { return key !== ATTRACT_TAG_FIRST_REASON; }).map(invalidWith));
    /**
     * `ModelCurrentCar.car_location`: CarLocation.Type as a string (Unassigned, Pitlane,
     * Pitentry, Pitexit, Track; the stock pit-limiter warning compares it to "Pitlane" and
     * "Pitentry"). These three are the pit lane; anything else says nothing either way.
     */
    const PIT_LOCATIONS = { Pitlane: true, Pitentry: true, Pitexit: true };
    /** The one location that says the car is out on the circuit (Unassigned says nothing). */
    const TRACK_LOCATION = "Track";
    /**
     * What ModelTiming.current reads on the lap out of the pits, before a timed lap has
     * begun. The game flags that lap invalid from the start; the stock lap-time widget hides
     * itself while current reads this (or nothing), so the flag is only shown on a lap that
     * is actually being timed. Same rule here for the flag alone; a lap the game's own notice
     * named shows the tag under the raw flag, timed or not.
     */
    const OUTLAP_TEXT = "Outlap";
    /**
     * The first lap out of the pits is flagged invalid from its first metre, and in a fresh
     * session `current` already reads a running time then, so the text rule above does not
     * catch it. What tells a cut from a pit exit is the flag going up DURING the lap: the
     * flag's state is taken over the first moments of every lap, and the tag shows only
     * while the flag is up, on a lap that started valid and had the flag rise later (or
     * that the game's own notice named). The grace is short so a cut in
     * the first corner still counts, and long enough for the game to clear the flag at the
     * line, which need not happen in the same frame the lap time resets.
     */
    const LAP_START_GRACE_MS = 500;
    /**
     * A new lap is the lap clock going backwards, but only by more than this: a real boundary
     * takes it from a whole lap down to a few tens of ms, a reset to the pits to a few hundred.
     * A read a millisecond or two behind the last one (a frame served twice, a value re-sent)
     * is not a lap, and treating it as one forgot the cut and the pit lap under way (found by
     * replaying recorded sessions, 2026-09-23). Nor is the game's own correction of the clock:
     * in a multiplayer practice the clock stepped back 79 times in 107 s, 35 of them with the
     * car parked in the pit lane and 44 while driving, the largest step 54 ms, and never in a
     * single-player session (log of 2026-09-23 02:29 to 02:31; the widget of that day took 41 of
     * them for laps in that window). The tolerance is nearly three times the largest step seen.
     * A clock that went back by more than that is a lap only if
     * it landed near the line (a real boundary lands in the first tens of ms, a stall over the
     * line a few seconds in) or dropped by a good part of a lap; a small step back from a
     * running clock far from the line is a correction, whatever its size.
     */
    const LAP_CLOCK_JITTER_MS = 150;
    const LAP_CLOCK_LANDING_MS = 5000;
    const LAP_CLOCK_DROP_MS = 1000;
    /**
     * The other source, and the decisive one: the game announces a lap invalidation as a UI
     * notification, the same event the stock notification panel draws its top-right box from
     * (`engine.on("UINotification")`, components.js NotificationPanel). A session-penalty
     * message carries `tuples[0].values`: "[{PENALTY_..._KEY} #<car number>", the reason key,
     * the penalty type key]; a track-limits cut in practice (2026-09-22) came as
     * ["{PENALTY_CLEARED_KEY} #666", "InvestigationType_Racecar_Cut",
     * "lblNotificationPenalty_LAP_INVALIDATED"]. The type key is matched exactly and the car
     * number against the focused car in the cars-on-track model, so another car's penalty
     * online is not ours. The timing flag alone cannot tell this apart from a pit exit (see above), so this
     * is what makes the tag appear on a first lap.
     */
    const NOTIFICATION_EVENT = "UINotification";
    const PENALTY_NOTIFICATION = "UINotificationType_SessionPenalty";
    /** The penalty type key the game sends for a lap invalidation (measured in game: a track-limits cut, reason InvestigationType_Racecar_Cut). A l10n id, so the same in every language. */
    const LAP_INVALIDATED_TYPE = "lblNotificationPenalty_LAP_INVALIDATED";
    const CAR_NUMBER_MARK = "#";
    /** Where the three strings of a penalty notice sit in its first tuple. */
    const PENALTY_HEAD_INDEX = 0;
    const PENALTY_REASON_INDEX = 1;
    const PENALTY_TYPE_INDEX = 2;
    /**
     * The notice comes once, and Escape/resume rebuilds the HUD page, so what is known about
     * the lap under way (a cut and its reason, a pit-lane visit, an invalidation announced for
     * the lap that follows) is remembered through the loader's per-app store (which survives
     * that reload) with the lap it belongs to: the car's lap count when the game gives one,
     * else the lap time it was at. The first frame after a reload takes it back if it is still
     * that lap, and a new lap forgets it.
     */
    const LAP_KEY = "lap";
    /**
     * What looked like a pit-speeding invalidation was not one (log 2026-09-22 17:59, 18:00,
     * 18:01 and 18:10: four pit exits, three with the warning and one without, all alike). The
     * speeding notice is a PenaltyType_Warning, which the game's own log calls a penalty type
     * with "no transformation", and it invalidates nothing. On that track the timing line lies
     * inside the pit lane, so the lap out of the pits crosses it still in the pit lane (`new
     * lap ... invalid false`) and 250 to 750 ms later, at the pit exit (the game's "Zone Exit",
     * the car's location going Pitexit then Track), the flag rises: the ordinary rule that a
     * lap driven partly in the pit lane does not count, applied to the lap the pit exit is in.
     * Where the exit merges before the line, the same rule flags the pit-exit lap from its
     * first metre and the next lap is clean. So the car's location is watched: a lap the car
     * spent any time in the pit lane on is a pit lap, and the flag rising on it is the pit exit
     * (or entry), not a cut. A flag rising on a lap driven wholly on the track, with no notice,
     * is an invalidation the game gave no reason for, and reads plain INVALID.
     *
     * The game's penalty enum has two lap invalidations of its own (PenaltySystem.proto:
     * PenaltyType_InvalidLap = 12, PenaltyType_InvalidNextLap = 11, "Invalid Lap" in the
     * English table). No notice with either type has been seen yet, but their meaning is
     * plain, so a notice of the first marks this lap and one of the second the lap that follows.
     */
    const INVALID_LAP_TYPE = "PenaltyType_InvalidLap";
    const INVALID_NEXT_LAP_TYPE = "PenaltyType_InvalidNextLap";
    /**
     * The flag is the truth about the lap; the reason comes only from what the game itself
     * ties to the lap's validity, and never from timing. The game states two facts about a
     * lap: `ModelTiming.invalid` (at once) and session-penalty notices (car, reason, type; no
     * lap number, no clock). The penalty-state model holds real penalties only and stayed
     * empty through every cut measured, and the engine's log says nothing at all. So a
     * notice names the reason for the flag on the lap it arrives on when, and only when, the
     * game's own words make it about the lap:
     *
     *   - a type that IS an invalidation: LAP_INVALIDATED (practice), InvalidLap, InvalidNextLap;
     *   - the type NO_GAIN: the game's verdict on a cut ("no time gained"), which in a race
     *     replaces LAP_INVALIDATED and arrives seconds after the flag (measured 2026-09-23,
     *     Road Atlanta, three cuts: 4.4, 4.8 and 9.8 s; a cut followed by a stop on the track
     *     never got its verdict at all), reason Racecar_Cut;
     *   - any type whose reason is Racecar_Cut: a cut that did gain time draws a time penalty,
     *     and the lap is void either way (the game kept a faster cut lap off `best`).
     *
     * Anything else for our car (a collision, an unsafe rejoin, a warning, pit-lane speeding)
     * is not tied to the lap by anything the game sends, so it never names the tag: the lap
     * reads plain INVALID, which is what the game said. Delay plays no part: a verdict seconds after the flag names it. Order does, for a
     * verdict: one arriving with no flag of this lap's up is dropped and logged (the flag is
     * the truth), while an invalidation notice (LAP_INVALIDATED, InvalidLap) before the flag
     * marks the lap and the tag shows once the flag rises. "The same lap" is structural (a
     * new lap forgets the cut), so a verdict arriving after the line is dropped, and logged,
     * rather than pinned on the lap that follows. Before 2026-09-23 this was a
     * 500 ms window either side of the flag, tuned on practice; a race cut then read plain
     * INVALID for the whole lap.
     */
    const NO_GAIN_TYPE = "lblNotificationPenalty_NO_GAIN";
    const CUT_REASON = "InvestigationType_Racecar_Cut";
    /**
     * Diagnostics, kept on because every line is rare and each one has answered a question:
     * the game's penalty-state model (UIPenaltyState: penalties[] of { type, time_penalty,
     * lap_count, is_active }) is in the stock's "disabled" model group -- fetched only when a
     * stock template binds it, which the HUD's never do -- so the widget fetches it itself
     * through the same engine call the stock uses, every two seconds, and logs it when it
     * changes. Every notification that is not the car-status kind is logged whole, and the
     * car's location and the low-frequency state's race-cut fields when they change.
     */
    const PENALTY_MODEL_CALL = "getModelUIPenaltyState";
    /** Every two seconds: the model held only real penalties in every session measured, and never a cut, so it is not on any path the tag needs. */
    const PENALTY_POLL_MS = 2000;
    /** A fetch the engine has not answered in this long is given up, and the next poll asks again (a promise the engine never settles would otherwise end the polling for good). */
    const PENALTY_ANSWER_MS = 5000;
    const CAR_NOTIFICATION = "UINotificationType_Car";
    const VS_TEXT = "vs ";
    const OPTIMAL_LABEL = "SESSION OPTIMAL";
    const BEST_LABEL = "SESSION BEST";
    const LAST_LABEL = "LAST LAP";
    const PRED_LABEL = "PREDICTED LAP";

    /** Slots across the lap trace; each holds one delta, written when the car passes it. */
    const TRACE_N = 120;
    /** The position wrapping back by more than this many slots is a new lap. */
    const TRACE_WRAP_SLOTS = TRACE_N / 2;
    /** A slow frame skips a slot or two, which are filled in; a longer gap (a delta outage, a hidden HUD) had no data and stays blank. */
    const TRACE_BACKFILL_MAX = 3;
    /**
     * The trace so far is kept in the library's local store (persist.writeLocal: it survives Escape/resume, which reloads the HUD
     * page and loses everything the page held), written each time the car reaches a new slot, a
     * little under once a second, and put back on the first frame after a reload when that frame
     * is on the same lap of the same car in the same session. The slots passed during the reload
     * had no data and stay blank.
     */
    const TRACE_STORE_KEY = "acebetterdeltabar.trace";
    /** The scripted lap's slots are drawn from the middle of each slot's stretch of the lap. */
    const TRACE_SLOT_MIDDLE = 0.5;
    /**
     * Attract mode lasts a game session at most: the option is kept like every other, but it is
     * only honoured at attach while this flag, in the library's local store (which the game
     * clears when it closes), says the demo was switched on in this session. Left on at a
     * restart, it would put scripted laps on a real HUD; through Escape/resume it stays on, so a
     * recording can go on across a pause.
     */
    const ATTRACT_SESSION_KEY = "acebetterdeltabar.attract";
    /** The predicted lap's colour: quicker or slower than the best by this much to colour, half of it to keep the colour (a prediction hovering at the best must not flicker). */
    const PRED_BAND_MS = 20;
    const PRED_FASTER = -1;
    const PRED_EVEN = 0;
    const PRED_SLOWER = 1;

    /**
     * Panel scale: the root's font-size in rem, everything inside sized in em, applied
     * by `me.scale`. Below 0.6 the figure is unreadable; above 2 the bar spans the screen.
     */
    const SCALE_MIN = 0.6;
    const SCALE_MAX = 2;
    const SCALE_STEP = 0.1;

    const LAYOUT_FULL = "full";
    const LAYOUT_COMPACT = "compact";
    const WIDTH_NARROW = "narrow";
    const WIDTH_NORMAL = "normal";
    const WIDTH_WIDE = "wide";
    /**
     * The figure's point is kept on the bar's centre mark while its tag hugs the text: the row holding
     * the tag is moved by the distance between the middle of the text and the point, which in the
     * game's mono font depends only on the glyphs either side of it. The lean is that difference in
     * half glyphs (the width after the point less the width before, a NARROW glyph counting one and
     * any other two), and the stylesheet holds the distance for each lean in LEAN_CLASSES, LEAN_MIN
     * first: from "+10:02.34" (-7) to "0.000" (4).
     */
    const POINT = ".";
    const NARROW = ":.";
    /** A narrow glyph (the point, the colon) is one half glyph wide, any other two. */
    const NARROW_HALF_GLYPHS = 1;
    const WIDE_HALF_GLYPHS = 2;
    const LEAN_MIN = -7;
    const LEAN_MAX = 4;
    const LEAN_CLASSES = ["bd-lean-n7", "bd-lean-n6", "bd-lean-n5", "bd-lean-n4", "bd-lean-n3", "bd-lean-n2", "bd-lean-n1", "bd-lean-0", "bd-lean-1", "bd-lean-2", "bd-lean-3", "bd-lean-4"];

    const SIDE_RIGHT = "right";
    const SIDE_LEFT = "left";
    const COLOUR_TREND = "trend";
    const COLOUR_OVERALL = "overall";
    const COLOUR_WHITE = "white";
    const BACKGROUND_DARK = "dark";
    const BACKGROUND_LIGHT = "light";
    const BACKGROUND_NONE = "none";

    /** Class names shared with betterdeltabar.css. */
    const CLASS = {
        root: "ace-betterdeltabar",
        /** The line above the bar: who the delta is against and the no-reference note on the left, the invalid tag on the right. */
        top: "bd-top",
        topLeft: "bd-top-left",
        topRight: "bd-top-right",
        vs: "bd-vs",
        status: "bd-status",
        invalidTag: "bd-invalid-tag",
        /** The bar and the figure share this box: the figure sits on the bar (full) or under it (compact). */
        stack: "bd-stack",
        bar: "bd-bar",
        fill: "bd-fill",
        left: "bd-left",
        right: "bd-right",
        mid: "bd-mid",
        /** A full-width track moved by the fill's share, carrying the bright tick at the fill's end. */
        tickTrack: "bd-ticktrack",
        tick: "bd-tick",
        main: "bd-main",
        /** The tag and its chevrons, moved together by the lean so the point is on the centre mark. */
        group: "bd-group",
        delta: "bd-delta",
        arrow: "bd-arrow",
        arrowLeft: "bd-arrow-l",
        arrowRight: "bd-arrow-r",
        trace: "bd-trace",
        zero: "bd-zero",
        slot: "bd-slot",
        up: "bd-up",
        down: "bd-down",
        /** The row of lap times under the bar. */
        cells: "bd-cells",
        cell: "bd-cell",
        cellOptimal: "bd-cell-optimal",
        cellBest: "bd-cell-best",
        cellLast: "bd-cell-last",
        cellPred: "bd-cell-pred",
        time: "bd-time",
        label: "bd-label",
        /** On the root, per frame: the trend, its strength, the overall sign, no reference. */
        gain: "bd-gain",
        lose: "bd-lose",
        flat: "bd-flat",
        strong: "bd-strong",
        faster: "bd-faster",
        slower: "bd-slower",
        zero: "bd-zero",
        noRef: "bd-noref",
        invalid: "bd-invalid",
        /** On the root: the quiet tag (PIT LANE / OUTLAP) is up. */
        pit: "bd-pit",
        hasDriver: "bd-hasdriver",
        /** On the root: whether the top line has anything to show. */
        topOn: "bd-top-on",
        /** On the predicted cell: the predicted lap against the best. */
        predFaster: "bd-pred-faster",
        predSlower: "bd-pred-slower",
        /** On the root: the layout, what the options hide, and the looks they choose. */
        compact: "bd-compact",
        /** On the root: the bar grows left for time gained (the option); the chevrons follow it. */
        fasterLeft: "bd-faster-left",
        noArrows: "bd-noarrows",
        noOptimal: "bd-nooptimal",
        noBest: "bd-nobest",
        noLast: "bd-nolast",
        noPred: "bd-nopred",
        noTrace: "bd-notrace",
        noInvalid: "bd-noinvalid",
        /** On the root: the option to hide the whole widget while there is no reference lap. */
        hideNoRef: "bd-hide-noref",
        narrow: "bd-narrow",
        wide: "bd-wide",
        numOverall: "bd-num-overall",
        numWhite: "bd-num-white",
        barTrend: "bd-bar-trend",
        bgLight: "bd-bg-light",
        bgNone: "bd-bg-none"
    };

    const el = ACEUIAppLoader.el;
    const close = ACEUIAppLoader.close;
    const toArray = ACEUIAppLoader.toArray;
    const setClass = ACEUIAppLoader.dom.setClass;
    const settings = ACEUIAppLoader.settings;
    const log = me.log;

    /** The live attached state, so the demo can be toggled from the dev console. */
    let current = null;

    /** The options, declared once at load so the drawer offers OPTIONS and the values are there before attach. */
    const SETTING = {
        layout: "layout",
        width: "width",
        side: "fasterSide",
        range: "range",
        decimals: "decimals",
        follow: "followFill",
        numberColour: "numberColour",
        barColour: "barColour",
        trendWindow: "trendWindow",
        trendBand: "trendBand",
        arrows: "showArrows",
        optimal: "showOptimal",
        best: "showBest",
        last: "showLast",
        pred: "showPredicted",
        trace: "showTrace",
        invalid: "showInvalid",
        hideNoRef: "hideWithoutReference",
        bg: "background",
        attract: "attract",
        attractTag: "attractTag"
    };

    const section = function (key, label, columns, collapsed) {
        return { key: key, type: "section", label: label, columns: columns, collapsed: collapsed };
    };

    /** A choice drawn as a row of pills, every option on show, the current one lit. */
    const choice = function (key, label, value, options, hint) {
        return { key: key, type: "choice", label: label, value: value, options: options, hint: hint, segmented: true };
    };

    /** A toggle; `when` (optional) is the layout it belongs to, and the loader draws it only in that layout. */
    const toggle = function (key, label, value, hint, when) {
        return { key: key, type: "toggle", label: label, value: value, hint: hint, when: when };
    };

    /** A section whose toggles are chips in a wrapping row. */
    const chips = function (key, label, collapsed) {
        return { key: key, type: "section", label: label, flow: "chips", collapsed: collapsed };
    };

    /**
     * Which layout is on. Every option applies to both layouts except the ones that
     * only exist in one: the lap-time cells and the trace are the full layout's, the
     * figure following the fill is the compact one's. Those carry one of these, so the
     * settings window shows only what the layout on screen has, and swaps when it changes.
     * Read from the store rather than from `options`: the loader may draw the window (a
     * reopen after the HUD reload) before `define` below has returned that object.
     */
    const inCompact = function () { return settings.get(me.name, SETTING.layout) === LAYOUT_COMPACT; };
    const inFull = function () { return !inCompact(); };
    /** Attract mode is on: its own options are drawn only then. From the store, as above. */
    const inAttract = function () { return settings.get(me.name, SETTING.attract) === true; };

    /** The settings window: wide, two controls to a row, hints in one line at the foot for the row under the pointer. */
    const SECTION_COLUMNS = 2;
    const PANE_WIDTH = "36rem";
    const PANE_LAYOUT = { width: PANE_WIDTH, hints: "footer" };

    const options = settings.define(me.name, [
        // the section's key must differ from the layout option's: the store keys both alike
        section("shape", "Layout", SECTION_COLUMNS, false),
        choice(SETTING.layout, "Layout", LAYOUT_FULL, [LAYOUT_FULL, LAYOUT_COMPACT],
            "full: the figure on the bar and the lap times under it; compact: a thin bar with the figure in a tag"),
        choice(SETTING.width, "Width", WIDTH_NORMAL, [WIDTH_NARROW, WIDTH_NORMAL, WIDTH_WIDE]),
        // the pills are shown in the order given, so a left-right choice is listed left first, whatever the default is
        choice(SETTING.side, "Faster side", SIDE_RIGHT, [SIDE_LEFT, SIDE_RIGHT], "which way the bar grows for time gained; the game's own grows right"),
        choice(SETTING.range, "Bar range", RANGE_DEFAULT, Object.keys(RANGES), "the delta that fills the bar from the centre to its end, and the trace"),
        choice(SETTING.decimals, "Decimals", DECIMALS_DEFAULT, Object.keys(DECIMALS)),
        me.scaleSpec({ min: SCALE_MIN, max: SCALE_MAX, step: SCALE_STEP }),
        section("colour", "Colour", SECTION_COLUMNS, false),
        choice(SETTING.numberColour, "Number", COLOUR_TREND, [COLOUR_TREND, COLOUR_OVERALL, COLOUR_WHITE],
            "trend: green while gaining, red while losing, white while steady; overall: the game's own rule"),
        choice(SETTING.barColour, "Bar", COLOUR_OVERALL, [COLOUR_OVERALL, COLOUR_TREND],
            "overall: green ahead of the reference, red behind"),
        choice(SETTING.trendWindow, "Trend window", TREND_WINDOW_DEFAULT, Object.keys(TREND_WINDOWS), "how far back the trend looks"),
        choice(SETTING.trendBand, "Trend sensitivity", TREND_BAND_DEFAULT, Object.keys(TREND_BANDS), "fine reacts to less, coarse waits for more"),
        chips("show", "Show", false),
        toggle(SETTING.arrows, "Trend chevrons", true, "point the way the end of the bar is moving"),
        toggle(SETTING.invalid, "Lap tags", true, "INVALID with the game's reason for it; OUTLAP and PIT LANE, quietly, on a lap that does not count"),
        toggle(SETTING.hideNoRef, "Hide until a reference lap", false, "nothing on screen until there is a delta to show"),
        toggle(SETTING.optimal, "Session optimal", true, "your best sectors added up", inFull),
        toggle(SETTING.best, "Session best", true, null, inFull),
        toggle(SETTING.pred, "Predicted lap", true, "green when it beats the best by " + PRED_BAND_MS + " ms, red when it trails it by " + PRED_BAND_MS + " ms", inFull),
        toggle(SETTING.last, "Last lap", false, null, inFull),
        toggle(SETTING.trace, "Lap trace", false, "the delta across the lap, under the bar", inFull),
        toggle(SETTING.follow, "Figure follows the fill", true, "the tag moves with the end of the bar", inCompact),
        section("look", "Look", SECTION_COLUMNS, true),
        choice(SETTING.bg, "Background", BACKGROUND_DARK, [BACKGROUND_DARK, BACKGROUND_LIGHT, BACKGROUND_NONE],
            "full: the panel; compact: the bar and the tag"),
        toggle(SETTING.attract, "Attract mode", false, "a scripted lap, for recording without driving"),
        // a cycle button, not pills: two dozen tags do not fit in a row. Shown only while attract is on
        { key: SETTING.attractTag, type: "choice", label: "Demo tag", value: ATTRACT_TAG_OFF, options: ATTRACT_TAGS,
            hint: "the tag the scripted lap shows; click to go through them", when: inAttract }
    ], PANE_LAYOUT);

    /** The option keys that change what is drawn or how, and nothing else. */
    const VIEW_KEYS = [SETTING.layout, SETTING.width, SETTING.side, SETTING.range, SETTING.decimals, SETTING.follow,
        SETTING.numberColour, SETTING.barColour, SETTING.trendWindow, SETTING.trendBand, SETTING.arrows, SETTING.optimal,
        SETTING.best, SETTING.last, SETTING.pred, SETTING.trace, SETTING.invalid, SETTING.hideNoRef, SETTING.bg];

    // ---- formatting --------------------------------------------------------------

    /** `n` as a string of at least `width` digits. */
    const pad = function (n, width) {
        let s = String(n);

        while (s.length < width) { s = "0" + s; }

        return s;
    };

    /**
     * A delta rounded to the decimals shown, away from zero on a half both ways (Math.round
     * alone takes -23.5 to -23). The bar and the sign are drawn from this, not the raw delta,
     * so a figure reading 0.00 never has a green sign or a sliver of fill beside it (review
     * 2026-09-23: with two decimals a delta of -4 ms read "0.00" and painted the faster side).
     */
    const roundDelta = function (ms, decimals) {
        const unit = Math.pow(DECIMAL_BASE, MS_DIGITS - decimals);

        return (ms < 0 ? -1 : 1) * Math.round(Math.abs(ms) / unit) * unit;
    };

    /**
     * A delta in ms as "-0.235", "+0.24" or "+1:02.345": the sign only when there is one,
     * seconds without padding, minutes only past sixty seconds. Rounded to the decimals
     * shown, so a figure never reads 0.1 while the bar shows time lost.
     */
    const formatDelta = function (ms, decimals) {
        const rounded = roundDelta(ms, decimals);
        const abs = Math.abs(rounded);
        const secs = Math.floor(abs / MS_PER_S);
        const frac = pad(abs % MS_PER_S, MS_DIGITS).substring(0, decimals);
        let sign = "";
        let whole = String(secs);

        if (rounded < 0) { sign = "-"; }

        if (rounded > 0) { sign = "+"; }

        if (secs >= S_PER_MIN) { whole = Math.floor(secs / S_PER_MIN) + ":" + pad(secs % S_PER_MIN, TWO_DIGITS); }

        return sign + whole + "." + frac;
    };

    /** A lap time in ms as "1:43.210"; anything that is not a lap time as the placeholder. */
    const formatLap = function (ms) {
        if (typeof ms !== "number" || !(ms > 0) || ms >= MAX_TIME_MS) { return NO_TIME_TEXT; }

        const whole = Math.round(ms);

        return Math.floor(whole / MS_PER_MIN) + ":" + pad(Math.floor((whole % MS_PER_MIN) / MS_PER_S), TWO_DIGITS)
            + "." + pad(whole % MS_PER_S, MS_DIGITS);
    };

    /** A running lap time to the tenth, "0:34.2": what the no-reference line counts with. */
    const formatLapTenths = function (ms) {
        const tenths = Math.floor(ms / TENTH_MS);
        const secs = Math.floor(tenths / (MS_PER_S / TENTH_MS));

        return Math.floor(secs / S_PER_MIN) + ":" + pad(secs % S_PER_MIN, TWO_DIGITS) + "." + (tenths % (MS_PER_S / TENTH_MS));
    };

    /** The groups of the lap-time pattern below: hours (optional), minutes, seconds, the fraction. */
    const LAP_GROUP_HOURS = 1;
    const LAP_GROUP_MINUTES = 2;
    const LAP_GROUP_SECONDS = 3;
    const LAP_GROUP_FRACTION = 4;

    /** The game's lap time strings ("1:43.445", "01:43.445", "1:02:03.456") back to ms; null for anything else. */
    const parseLap = function (text) {
        const m = /^(?:(\d+):)?(\d+):(\d+)\.(\d+)$/.exec(text || "");

        if (!m) { return null; }

        const hours = m[LAP_GROUP_HOURS] ? parseInt(m[LAP_GROUP_HOURS], DECIMAL_BASE) * MIN_PER_HOUR * MS_PER_MIN : 0;
        const fraction = parseInt((m[LAP_GROUP_FRACTION] + pad(0, MS_DIGITS)).substring(0, MS_DIGITS), DECIMAL_BASE);

        return hours + parseInt(m[LAP_GROUP_MINUTES], DECIMAL_BASE) * MS_PER_MIN + parseInt(m[LAP_GROUP_SECONDS], DECIMAL_BASE) * MS_PER_S + fraction;
    };

    /** A lap time string from the game, shown as it came when it is one, as the placeholder otherwise. */
    const lapText = function (text) {
        return parseLap(text) === null ? NO_TIME_TEXT : text;
    };

    const scaleXTransform = function (share) {
        return "scaleX(" + share.toFixed(SCALE_DECIMALS) + ")";
    };

    const scaleYTransform = function (share) {
        return "scaleY(" + share.toFixed(SCALE_DECIMALS) + ")";
    };

    /** Moving a full-width track to the fill's end: half the width times the share, signed by the side. */
    const shiftTransform = function (signedShare) {
        return "translateX(" + (signedShare * HALF_PERCENT).toFixed(SHIFT_DECIMALS) + "%)";
    };

    // ---- markup ------------------------------------------------------------------

    /** The lap trace: TRACE_N slots laid out once in whole shares, each with an up (faster) and a down (slower) bar. */
    const traceMarkup = function () {
        const slotW = PERCENT / TRACE_N;
        const width = slotW.toFixed(LAYOUT_DECIMALS) + "%";
        const slots = [];
        let i;

        for (i = 0; i < TRACE_N; i += 1) {
            slots.push(el("div", CLASS.slot, { style: "left:" + (i * slotW).toFixed(LAYOUT_DECIMALS) + "%;width:" + width })
                + el("div", CLASS.up) + close("div") + el("div", CLASS.down) + close("div") + close("div"));
        }

        return el("div", CLASS.trace) + el("div", CLASS.zero) + close("div") + slots.join("") + close("div");
    };

    /** One lap-time cell: the time over its label. */
    const cellMarkup = function (className, label) {
        return el("div", CLASS.cell + " " + className)
            + el("div", CLASS.time) + NO_TIME_TEXT + close("div")
            + el("div", CLASS.label) + label + close("div")
            + close("div");
    };

    /** A string's width in half glyphs of the figure's font. */
    const halfGlyphs = function (text) {
        return text.split("").reduce(function (sum, glyph) { return sum + (NARROW.indexOf(glyph) >= 0 ? NARROW_HALF_GLYPHS : WIDE_HALF_GLYPHS); }, 0);
    };

    /** The figure's lean (see LEAN_CLASSES): how far its point is from the middle of the text, in half glyphs. */
    const leanOf = function (text) {
        const at = text.lastIndexOf(POINT);
        const lean = at < 0 ? 0 : halfGlyphs(text.slice(at + 1)) - halfGlyphs(text.slice(0, at));

        return Math.min(LEAN_MAX, Math.max(LEAN_MIN, lean));
    };

    /** Put the class for a lean on the root, taking the last one off. */
    const setLean = function (state, lean) {
        if (lean === state.lean) {
            return;
        }

        if (state.lean !== null) {
            setClass(state.root, LEAN_CLASSES[state.lean - LEAN_MIN], false);
        }

        state.lean = lean;
        setClass(state.root, LEAN_CLASSES[lean - LEAN_MIN], true);
    };

    /** The widget's markup: top line, the bar with the figure, the lap trace, the lap-time cells. */
    const markup = function () {
        // two groups that are always there, so the tag sits at the right even when the left
        // group is empty (an auto margin did not do that in the game's Cohtml)
        return el("div", CLASS.top)
            + el("div", CLASS.topLeft)
            + el("div", CLASS.vs) + close("div")
            + el("div", CLASS.status) + NO_REFERENCE_TEXT + close("div")
            + close("div")
            + el("div", CLASS.topRight)
            + el("div", CLASS.invalidTag) + INVALID_TEXT + close("div")
            + close("div")
            + close("div")
            + el("div", CLASS.stack)
            + el("div", CLASS.bar)
            + el("div", CLASS.fill + " " + CLASS.left) + close("div")
            + el("div", CLASS.fill + " " + CLASS.right) + close("div")
            + el("div", CLASS.mid) + close("div")
            + el("div", CLASS.tickTrack) + el("div", CLASS.tick) + close("div") + close("div")
            + close("div")
            + el("div", CLASS.main)
            + el("div", CLASS.group)
            + el("div", CLASS.arrow + " " + CLASS.arrowLeft) + close("div")
            + el("div", CLASS.delta) + NO_DELTA_TEXTS[DECIMALS_DEFAULT] + close("div")
            + el("div", CLASS.arrow + " " + CLASS.arrowRight) + close("div")
            + close("div")
            + close("div")
            + close("div")
            + traceMarkup()
            + el("div", CLASS.cells)
            + cellMarkup(CLASS.cellOptimal, OPTIMAL_LABEL)
            + cellMarkup(CLASS.cellBest, BEST_LABEL)
            + cellMarkup(CLASS.cellLast, LAST_LABEL)
            + cellMarkup(CLASS.cellPred, PRED_LABEL)
            + close("div");
    };

    /** An empty trend ring. */
    /** The trace's values: one per slot, none written yet. */
    const emptyTrace = function () {
        const values = [];
        let i;

        for (i = 0; i < TRACE_N; i += 1) { values.push(null); }

        return values;
    };

    const emptyRing = function () {
        const samples = [];
        let i;

        for (i = 0; i < TREND_N; i += 1) { samples.push(0); }

        return samples;
    };

    /**
     * Build (or, on a root that already carries the markup, re-use) the DOM and return
     * the widget's state. Everything the loop touches is looked up once.
     */
    const create = function (root) {
        root.classList.add(CLASS.root);
        // a root used before may still carry a lean; the first figure drawn puts the right one on
        LEAN_CLASSES.forEach(function (lean) { setClass(root, lean, false); });

        if (!root.querySelector("." + CLASS.bar)) { root.innerHTML = markup(); }

        const q = function (selector) { return root.querySelector(selector); };

        return {
            root: root,
            vs: q("." + CLASS.vs),
            status: q("." + CLASS.status),
            invalidTag: q("." + CLASS.invalidTag),
            leftFill: q("." + CLASS.left),
            rightFill: q("." + CLASS.right),
            tickTrack: q("." + CLASS.tickTrack),
            main: q("." + CLASS.main),
            figure: q("." + CLASS.delta),
            lean: null,                 // the lean whose class is on the root
            predCell: q("." + CLASS.cellPred),
            optimalTime: q("." + CLASS.cellOptimal + " ." + CLASS.time),
            bestTime: q("." + CLASS.cellBest + " ." + CLASS.time),
            lastTime: q("." + CLASS.cellLast + " ." + CLASS.time),
            predTime: q("." + CLASS.cellPred + " ." + CLASS.time),
            ups: toArray(root.querySelectorAll("." + CLASS.up)),
            downs: toArray(root.querySelectorAll("." + CLASS.down)),
            unsubscribeSettings: null,
            // the trend ring
            samples: emptyRing(),
            head: -1,                   // index of the newest sample
            count: 0,                   // samples held, up to TREND_N
            sampler: ACEUIAppLoader.loop.sampler(TREND_HZ, TREND_GAP_MS),
            trend: TREND_FLAT,
            strong: false,
            // what the options resolve to (applyView)
            rangeMs: RANGES[RANGE_DEFAULT],
            decimals: DECIMALS[DECIMALS_DEFAULT],
            noDeltaText: NO_DELTA_TEXTS[DECIMALS_DEFAULT],
            windowSamples: TREND_HZ,
            windowMs: MS_PER_S,
            band: TREND_BANDS[TREND_BAND_DEFAULT],
            fasterRight: true,          // time gained grows to the right (the game's own convention)
            followOn: false,            // compact layout with the figure following the fill
            traceOn: false,
            invalidOn: true,
            // per-frame caches: the last thing written, so unchanged values are not rewritten
            lastText: "",
            lastLeft: "",
            lastRight: "",
            lastTick: "",
            lastFollow: "",
            lastOptimal: null,          // the ModelTiming strings last seen
            lastBestText: null,
            lastLast: null,
            lastPred: "",
            lastStatus: "",
            bestMs: null,
            lastVs: "",
            lastDriver: null,           // whose delta the ring holds: another reference is another ring
            lastUps: [],
            lastDowns: [],
            sign: 0,                    // the overall sign last put on the root: -1 faster, 0 none, 1 slower
            zero: false,                // the figure read zero last frame (CLASS.zero on the root)
            hasRef: null,               // whether a delta was there last frame (null: never rendered)
            invalid: null,
            pit: null,
            hasDriver: null,
            topOn: null,
            predState: 0,               // -1 faster than best, 0 unknown, 1 slower
            traceSlot: -1,              // the last slot written this lap
            traceValues: emptyTrace(),  // the delta each slot was written with this lap, null where none was
            started: false,             // a frame with a car has run: the first one restores the lap's record and takes the flag as found
            lapMs: null,                // the last lap time seen; it going backwards is a new lap
            lapCount: null,             // the car's lap count last seen, the lap's identity for a remembered cut
            lapClockSeen: false,        // this lap has shown a lap clock (a boundary frame may lack it: then its first moments are not over)
            boundaryClock: null,        // the lap clock on the frame the last boundary was taken: a count moving just after it is the same boundary
            carId: "",                  // the focused car last seen: another car is another lap
            sessionKey: "",             // the session last seen, filed with the lap's record
            lapStartedInvalid: true,    // the invalid flag was already up when this lap began (a pit exit): not a cut
            lapCut: false,              // this lap is invalidated: the game's notice, or the flag rising on a lap driven wholly on the track
            cutReason: "",              // why, in the game's words, when its notice said ("TRACK LIMITS"); empty for the flag alone
            pitLap: false,              // the car has been in the pit lane during this lap: the flag rising on it is the pit exit, not a cut
            pitLate: false,             // and the car had been seen on the track this lap before it: an in-lap, whose flag is the pit entry's
            trackSeen: false,           // the car has been on the track (car_location Track) during this lap
            hiddenCut: false,           // on the track after the pit lane this lap, under the pit exit's flag: a cut there leaves no trace
            hiddenOwed: false,          // the lap before may have hidden a cut: a verdict that would otherwise mark this lap is its
            verdictOwed: false,         // the lap before ended cut with no reason yet: the next verdict is its, not this lap's
            heldVerdict: null,          // a verdict that came while the remembered lap waited for its count: judged once the record is settled
            nextLapInvalid: false,      // the game announced the lap that follows invalid (PenaltyType_InvalidNextLap)
            nextLapReason: "",          // and why
            cutAt: 0,                   // when this lap was marked cut (frame clock), for a reason arriving just after
            lastLocation: null,         // the car's location last seen, so a change is logged once
            nextPenaltyPoll: 0,         // frame clock time of the next fetch of the penalty-state model
            penaltyPolling: false,      // a fetch is in flight
            pollStartedAt: 0,           // frame clock time that fetch was sent
            pollId: 0,                  // the fetch in flight: an answer to an earlier, given-up one is ignored
            pollGaveUp: false,          // a fetch went unanswered (said once per attach)
            modelAsked: {},             // per model name: asked the game to stream it, and not seen streaming since
            detached: false,            // detach ran: an answer arriving after it touches nothing
            lastPenaltyText: "",        // the penalty-state model as last logged
            lastCutGained: null,        // the race-cut fields as last logged, and when
            lastCutDeadline: null,
            lastCutDelta: null,
            lastCutLogAt: 0,
            loggedBest: null,           // the three lap strings as last logged, and when
            loggedOptimal: null,
            loggedLast: null,
            lastLapsLogAt: 0,
            restorePending: false,      // a record filed under a lap number waits for a frame that has the count
            lastTag: "",                // the invalid tag's text last written
            notifications: null,        // the engine.on handle for the notification event, cleared in detach
            lastRawInvalid: null,       // the game's flag last seen, so a change is logged once
            lapRemembered: false,       // the store holds this lap's record (so forgetting is only done when there is something to forget)
            lastFrameAt: 0,             // when the last frame ran; a long gap is a stall the ring must not span
            lastLog: 0,
            attract: false,
            scaler: null,               // me.scale handle: the loader owns panel scaling
            ui: null                    // me.panel handle: the panel and its frame loop
        };
    };

    // ---- options -----------------------------------------------------------------

    /** Seconds of trend window the stored choice means; the default when the value is unknown. */
    const windowSeconds = function (choice) {
        return TREND_WINDOWS[choice] || TREND_WINDOWS[TREND_WINDOW_DEFAULT];
    };

    /**
     * Put the options on the widget: a class per hidden thing on a fixed element, and the
     * numbers the loop reads. The per-frame caches are cleared so the next frame rewrites
     * every visible value: a decimals change must reformat a figure that did not move.
     */
    const applyView = function (state) {
        const root = state.root;
        const decimals = options[SETTING.decimals];
        const numberColour = options[SETTING.numberColour];
        const compact = options[SETTING.layout] === LAYOUT_COMPACT;
        const traceWasOn = state.traceOn;
        const rangeWas = state.rangeMs;

        state.rangeMs = RANGES[options[SETTING.range]] || RANGES[RANGE_DEFAULT];
        state.decimals = DECIMALS[decimals] || DECIMALS[DECIMALS_DEFAULT];
        state.noDeltaText = NO_DELTA_TEXTS[decimals] || NO_DELTA_TEXTS[DECIMALS_DEFAULT];
        state.windowMs = windowSeconds(options[SETTING.trendWindow]) * MS_PER_S;
        state.windowSamples = Math.round(windowSeconds(options[SETTING.trendWindow]) * TREND_HZ);
        state.band = TREND_BANDS[options[SETTING.trendBand]] || TREND_BANDS[TREND_BAND_DEFAULT];
        state.fasterRight = options[SETTING.side] !== SIDE_LEFT;
        state.followOn = compact && options[SETTING.follow] !== false;
        // the trace is the full layout's: compact has no strip for it, and writing 120 hidden
        // slots a lap for nothing is what the switch left on would otherwise cost there
        state.traceOn = options[SETTING.trace] === true && !compact;
        state.invalidOn = options[SETTING.invalid] !== false;

        setClass(root, CLASS.compact, compact);
        setClass(root, CLASS.fasterLeft, !state.fasterRight);
        setClass(root, CLASS.noArrows, options[SETTING.arrows] === false);
        setClass(root, CLASS.noOptimal, options[SETTING.optimal] === false);
        setClass(root, CLASS.noBest, options[SETTING.best] === false);
        setClass(root, CLASS.noLast, options[SETTING.last] !== true);
        setClass(root, CLASS.noPred, options[SETTING.pred] === false);
        setClass(root, CLASS.noTrace, !state.traceOn);
        setClass(root, CLASS.noInvalid, !state.invalidOn);
        setClass(root, CLASS.hideNoRef, options[SETTING.hideNoRef] === true);
        setClass(root, CLASS.narrow, options[SETTING.width] === WIDTH_NARROW);
        setClass(root, CLASS.wide, options[SETTING.width] === WIDTH_WIDE);
        setClass(root, CLASS.numOverall, numberColour === COLOUR_OVERALL);
        setClass(root, CLASS.numWhite, numberColour === COLOUR_WHITE);
        setClass(root, CLASS.barTrend, options[SETTING.barColour] === COLOUR_TREND);
        setClass(root, CLASS.bgLight, options[SETTING.bg] === BACKGROUND_LIGHT);
        setClass(root, CLASS.bgNone, options[SETTING.bg] === BACKGROUND_NONE);

        // the trace switched on mid-lap: its slots still hold whatever lap was driven while it
        // was off, which is not this lap; blank them and let this lap draw from here
        if (state.traceOn && !traceWasOn) { clearTrace(state); }

        // the range changed mid-lap: the slots drawn so far are at the old scale, and a trace
        // half at one scale and half at another reads as a step in the delta that never was
        if (state.traceOn && traceWasOn && state.rangeMs !== rangeWas) { clearTrace(state); }

        state.lastText = "";
        state.lastLeft = "";
        state.lastRight = "";
        state.lastTick = "";
        state.lastFollow = "";
        state.lastOptimal = null;
        state.lastBestText = null;
        state.lastLast = null;
        state.lastPred = "";
        state.lastStatus = "";
        state.lastVs = "";
        // the trace caches are left alone: clearTrace above kept them true to the slots, and emptying
        // them made the next clear write all 240 transforms for nothing (fifth pass, 2026-09-23)
        state.hasRef = null;
        state.invalid = null;
        state.hasDriver = null;
        state.topOn = null;
        // the predicted cell's state is not a string cache: it carries the dead band's memory, and
        // applyView never takes the cell's classes off, so it is left alone (it was cleared here,
        // which dropped a colour the half band was holding on any option change; review 2026-09-23)
    };

    /** Turn the self-running demo on or off, and remember it. */
    const setAttract = function (state, on) {
        if (Boolean(on) !== state.attract) {
            // the scripted lap and the real one share nothing: the lap being followed is dropped
            // from memory (the store is left alone, and blind to attract), and the next frame of
            // the other mode is a first frame that reads its own lap afresh
            state.started = false;
            forgetLap(state);
            state.nextLapInvalid = false;
            state.nextLapReason = "";
            state.restorePending = false;
            state.heldVerdict = null;
            state.lapMs = null;
            state.lapCount = null;
            state.lapClockSeen = false;
            state.boundaryClock = null;
            state.carId = "";
            state.lastRawInvalid = null;
            state.lapStartedInvalid = true;   // a flag found up before the lap is joined is not a cut
        }

        state.attract = Boolean(on);

        if (state.attract) {
            ACEUIAppLoader.persist.writeLocal(ATTRACT_SESSION_KEY, true);
        } else {
            ACEUIAppLoader.persist.removeLocal(ATTRACT_SESSION_KEY);
        }

        settings.set(me.name, SETTING.attract, state.attract);
        log("attract " + (state.attract ? "on" : "off"));

        return state.attract;
    };

    /** What the settings window changed, applied to the live widget. */
    const onSetting = function (state, key, value) {
        if (key === SETTING.attract) {
            if (value !== state.attract) { setAttract(state, value); }

            return;
        }

        // the scale is me.scale's to apply; anything else drawn is a class or a number
        if (VIEW_KEYS.indexOf(key) >= 0) { applyView(state); }
    };

    // ---- data ------------------------------------------------------------------

    /** A delta field as a number, or null when it is missing or the game's sentinel. */
    const deltaOf = function (x) {
        if (typeof x !== "number" || isNaN(x) || Math.abs(x) >= MAX_TIME_MS) { return null; }

        return x;
    };

    /** A lap time field as a number, or null: the game sends 0 or -1 for "none" (the stock clamps it to 0), and a lap is never negative. */
    const lapTimeOf = function (x) {
        const ms = deltaOf(x);

        return ms !== null && ms > 0 ? ms : null;
    };

    /** A model field as a finite number, or null. */
    const numberOf = function (x) {
        return typeof x === "number" && isFinite(x) ? x : null;
    };

    /** The running lap clock as a number, or null: 0 is a clock at the line, anything negative is no clock (a -1 would read as a lap boundary). */
    const lapClockOf = function (x) {
        // not a delta: the clock runs on past the hour while the car sits in the pit lane, and a
        // widget attached then must still draw; only the sentinel and nonsense are no clock
        return typeof x === "number" && isFinite(x) && x >= 0 && x < INT32_SENTINEL ? x : null;
    };

    /** A timing string as the game sends it, or "" when the field is not a string. */
    const timeString = function (timing, key) {
        return timing && typeof timing[key] === "string" ? timing[key] : "";
    };

    /** A lap is being timed: the current lap reads as a time, not "Outlap" and not nothing. */
    const isTimedLap = function (current) {
        return current !== "" && current !== OUTLAP_TEXT;
    };

    /**
     * What the widget shows, read from the game's models, or null when there is no focused
     * car. The delta is the raw `delta_time_ms` when it is sane (the same number as the UI
     * field in all 70 pairs measured, 57 of them not multiples of ten: there is no UI rounding)
     * and the UI delta otherwise; either way the UI field's sentinel means none.
     */
    const readModel = function () {
        const car = window.ModelCurrentCar;
        const timing = window.ModelTiming;

        if (!car || car.has_focused_car === false) { return null; }

        let delta = null;
        let npos = null;

        // screened like every number: a NaN gate would read as a reference with a delta of nothing
        if (numberOf(car.delta_time_ms_ui) !== null && car.delta_time_ms_ui !== NO_DELTA_MS) {
            delta = deltaOf(car.delta_time_ms);

            if (delta === null) { delta = deltaOf(car.delta_time_ms_ui); }
        }

        if (typeof car.npos === "number" && car.npos >= 0 && car.npos <= 1) {
            npos = car.npos;
        } else if (typeof car.npos_perc === "number" && car.npos_perc >= 0 && car.npos_perc <= PERCENT) {
            npos = car.npos_perc / PERCENT;
        }

        return {
            delta: delta,
            predicted: lapTimeOf(car.predicted_lap_time_ms),
            lapMs: lapClockOf(car.current_lap_time_ms),
            // screened like every other number: a NaN here would read as the count moving every frame
            lapCount: car.low_frequency ? lapCountOf(car.low_frequency.total_lap_count) : null,
            carId: typeof car.focused_car_id === "string" ? car.focused_car_id : "",
            sessionKey: sessionKeyOf(),
            cutGained: numberOf(car.low_frequency && car.low_frequency.race_cut_gained_time_ms),
            cutDeadline: numberOf(car.low_frequency && car.low_frequency.distance_to_deadline),
            cutDelta: numberOf(car.low_frequency && car.low_frequency.race_cut_current_delta),
            npos: npos,
            driver: typeof car.delta_time_drivername === "string" ? car.delta_time_drivername : "",
            location: typeof car.car_location === "string" ? car.car_location : "",
            inPits: typeof car.car_location === "string" && PIT_LOCATIONS[car.car_location] === true,
            onTrack: car.car_location === TRACK_LOCATION,
            current: timeString(timing, "current"),
            best: timeString(timing, "best"),
            optimal: timeString(timing, "ideal"),
            last: timeString(timing, "last"),
            // the outlap is flagged invalid before any lap is timed; only a timed lap's flag is news
            invalid: Boolean(timing && timing.invalid === true) && isTimedLap(timeString(timing, "current")),
            rawInvalid: Boolean(timing && timing.invalid === true)
        };
    };

    /**
     * The session a lap record belongs to, from the session model's event and session ids when
     * it gives numbers, else "": a record kept from an earlier session must not fit a lap of
     * this one just because the lap number and the clock happen to.
     */
    const sessionKeyOf = function () {
        const session = window.ModelUISessionState;

        // screened like every number: a NaN id would make a key that matches its own record
        if (!session || numberOf(session.event_id) === null || numberOf(session.session_id) === null) { return ""; }

        return session.event_id + "/" + session.session_id;
    };

    /** A lap count as a number, or null: a count is a small non-negative integer, never the sentinel. */
    const lapCountOf = function (x) {
        const n = numberOf(x);

        return n !== null && n >= 0 && n < INT32_SENTINEL ? n : null;
    };

    /**
     * The focused car's number comes from the cars-on-track model and nothing else. The
     * stock UI fetches a model from the engine every frame only while it is in its enabled
     * list (ksUI.Models): the track map switches this one on and nothing in the stock ever
     * switches it off, so once on it is fresh every frame. The leaderboard models were
     * consulted as a fallback until 2026-09-23: the stock's MFD leaderboard page disables
     * them when it closes and leaves the stale globals on the window (a race that day held
     * lines from an earlier attempt), so a fallback to them could match a foreign notice
     * against a stale focused line. Null when the model does not say.
     *
     * The widget enables the model itself, at attach and again at any poll after it has been
     * seen streaming (a stock page could switch it off); a game that does not take the switch
     * is asked once. It never disables it (the list is not reference counted, and
     * the track map may be relying on the same entry). Cheap: one getter a frame that the
     * HUD usually runs anyway.
     */
    const OWN_CAR_MODELS = ["ModelCarsOnTrack"];
    /** With this many drivers or fewer there is nobody else a notice could be about. */
    const SOLO_DRIVERS = 1;

    /** Switches the own-car model on (see OWN_CAR_MODELS for why and when). */
    const enableOwnCarModels = function (state) {
        const models = window.ksUI && window.ksUI.Models;

        if (!models || typeof models.enable !== "function" || !Array.isArray(models.Disabled)) { return; }

        OWN_CAR_MODELS.forEach(function (name) {
            if (models.Disabled.indexOf(name) < 0) {
                state.modelAsked[name] = false;   // streaming: a later switch-off by a stock page is asked about again

                return;
            }

            // asked and not taken: not asked again, and not a line in the log every poll
            if (state.modelAsked[name] === true) { return; }

            state.modelAsked[name] = true;
            ACEUIAppLoader.safely(me.prefix + " model switch", function () { models.enable(name); });
            log(models.Disabled.indexOf(name) < 0
                ? "asked the game to stream " + name + ", to know which car is ours"
                : "asked the game to stream " + name + " and it stayed switched off: not asked again");
        });
    };

    /** How many drivers the session has: the car's low-frequency count or the cars-on-track list, whichever says more; 0 when neither says. */
    const driversInSession = function () {
        const car = window.ModelCurrentCar;
        const lf = car && car.low_frequency;
        const onTrack = window.ModelCarsOnTrack;
        const counted = lf && typeof lf.total_drivers === "number" ? lf.total_drivers : 0;
        const listed = onTrack && Array.isArray(onTrack.cars_on_track) ? onTrack.cars_on_track.length : 0;

        return Math.max(counted, listed);
    };

    /** The focused car's number from the cars-on-track model (see OWN_CAR_MODELS), or null. */
    const ownCarNumber = function () {
        const models = window.ksUI && window.ksUI.Models;

        // a model on the switched-off list keeps its last values on the window: stale, so unknown (second review, 2026-09-24)
        if (models && Array.isArray(models.Disabled) && models.Disabled.indexOf(OWN_CAR_MODELS[0]) >= 0) { return null; }

        const onTrack = window.ModelCarsOnTrack;
        const cars = onTrack && Array.isArray(onTrack.cars_on_track) ? onTrack.cars_on_track : [];
        let found = null;

        cars.forEach(function (c) {
            if (found === null && c && c.is_focused === true && typeof c.car_number === "number") { found = c.car_number; }
        });

        return found;
    };

    /**
     * A session-penalty notification, read: `{ car, type, reason }` with the car number after
     * the "#" (null when there is none), or null for any other message.
     */
    const readPenalty = function (message) {
        if (!message || message.type !== PENALTY_NOTIFICATION || !Array.isArray(message.tuples) || !message.tuples[0]) { return null; }

        const values = Array.isArray(message.tuples[0].values) ? message.tuples[0].values : [];
        const head = String(values[PENALTY_HEAD_INDEX] || "");
        const at = head.indexOf(CAR_NUMBER_MARK);
        const car = at >= 0 ? parseInt(head.slice(at + 1), DECIMAL_BASE) : NaN;

        return {
            car: isNaN(car) ? null : car,
            reason: String(values[PENALTY_REASON_INDEX] || ""),
            type: String(values[PENALTY_TYPE_INDEX] || "")
        };
    };

    /**
     * The game's reason for an invalidation, as its own notification box would print it: the
     * key put through the engine's translation table when the engine offers one and knows
     * the key, else the key itself with its prefix and underscores dropped. Upper-cased in
     * the script (the stylesheet cannot: text-transform is not supported here).
     */
    const reasonText = function (key) {
        let text = "";

        if (!key) { return ""; }

        if (window.engine && typeof window.engine.translate === "function") {
            try {
                text = String(window.engine.translate(key) || "");
            } catch (e) {
                text = "";
            }
        }

        if (!text || text === key) {
            text = Object.prototype.hasOwnProperty.call(REASONS, key) ? REASONS[key] : key.replace(REASON_PREFIX, "").replace(/_/g, " ");
        }

        return text.toUpperCase();
    };

    /**
     * Whether a penalty notification is about OUR car. The notice's number against ours when
     * both are known. When either is missing, a notice is ours only if the session is known to
     * have one driver: with no number to compare and other drivers about, or nothing to count
     * them by, it is nobody's. A false INVALID from another car's cut is the one thing this tag
     * must never do; a tag missed in a state no session has shown is the lesser wrong. With
     * the models above enabled the number is known in every session measured (cars 0 to 10, 42).
     */
    const isOwnCar = function (penalty) {
        const own = ownCarNumber();
        const drivers = driversInSession();

        if (penalty.car !== null && own !== null) { return penalty.car === own; }

        return drivers > 0 && drivers <= SOLO_DRIVERS;
    };

    /** A notice the game itself ties to the validity of the lap it comes on: its reason may name the tag. */
    const isLapVerdict = function (penalty) {
        return penalty.type === LAP_INVALIDATED_TYPE || penalty.type === INVALID_LAP_TYPE || penalty.type === NO_GAIN_TYPE || penalty.reason === CUT_REASON;
    };

    const THIS_LAP = "this";
    const NEXT_LAP = "next";
    /** Which lap a penalty notification for OUR car invalidates: THIS_LAP, NEXT_LAP, or "" for none. */
    const invalidates = function (penalty) {
        if (!isOwnCar(penalty)) { return ""; }

        if (penalty.type === LAP_INVALIDATED_TYPE || penalty.type === INVALID_LAP_TYPE) { return THIS_LAP; }

        return penalty.type === INVALID_NEXT_LAP_TYPE ? NEXT_LAP : "";
    };

    /**
     * Attract mode: scripted driving for previews and recordings, made to read like a real
     * session, and worked out the way a real delta is. Every lap is driven corner by corner on
     * a twelve-corner track (about 1:43, a Road Atlanta lap): each braking zone, each corner and
     * each straight after it takes the time it takes that lap, a little more or less than the
     * last, and on most laps one corner goes wrong (a lock-up, a slide). The best lap so far is
     * the reference, and the delta is this lap's time through each part of the track minus the
     * reference's through the same part. So it moves where real deltas move, in the braking
     * zones and the corners, and hardly on the straights; it swings hard the other way where the
     * reference lap had its own moment; and the best improves when a lap beats it, and less and
     * less often. The session optimal is the best of each sector added up. Every lap is
     * different and every lap is the same each time it is played: each comes from its number
     * through a hash.
     */
    /** The time of a lap driven with no part lost anywhere, ms: the laps are this plus what each part loses. */
    /** The best lap the demo starts against, ms (1:43.445): the laps are set around it at every bar range. */
    const ATTRACT_REFERENCE_TARGET_MS = 103445;
    /**
     * The script drives to the bar it is shown on: every gain and loss is sized for the default
     * range and stretched by the range set, the lap times shown with them, so a recording at a
     * 5 s range swings as far across its bar as one at 1 s (at 5 s the laps are those of a driver
     * five times less consistent). The laps are planned once: a change of range mid-demo only
     * stretches what is shown, it does not jump to another lap.
     */
    const ATTRACT_SCALE_RANGE_MS = RANGES[RANGE_DEFAULT];
    /** The laps shown as last before a lap of the demo is done, ms. */
    const ATTRACT_LAST_BEFORE_MS = 103987;
    /**
     * The corners, as shares of the lap: where the braking starts, and how strongly this corner
     * decides a lap time (a heavy stop weighs more than a kink).
     */
    const ATTRACT_CORNERS = [
        { at: 0.055, weight: 1.3 }, { at: 0.12, weight: 0.7 }, { at: 0.165, weight: 0.6 },
        { at: 0.215, weight: 0.9 }, { at: 0.3, weight: 1.1 }, { at: 0.395, weight: 0.8 },
        { at: 0.49, weight: 1.2 }, { at: 0.575, weight: 0.5 }, { at: 0.635, weight: 0.5 },
        { at: 0.845, weight: 1.4 }, { at: 0.885, weight: 0.7 }, { at: 0.955, weight: 0.9 }
    ];
    /** The sectors a lap is timed in, for the optimal: equal thirds of the lap. */
    const ATTRACT_SECTORS = 3;
    /** Samples across a lap for its centring, and the height of a half-wave per unit of its mean (pi / 2). */
    const ATTRACT_CENTRE_SAMPLES = 200;
    const ATTRACT_HUMP_MEAN_TO_PEAK = Math.PI / 2;
    /** How much of what the delta does inside a sector counts towards that sector's time (see attractLap). */
    const ATTRACT_SECTOR_SWING = 0.3;
    /** How long a braking zone lasts, and the corner after it, as shares of the lap (about 1.5 s and 2 s). */
    const ATTRACT_BRAKE_SHARE = 0.015;
    const ATTRACT_CORNER_SHARE = 0.02;
    /**
     * What each part of a corner gains or loses against the best lap at most, ms, before the corner's
     * weight: the braking zone the most (braking a metre later or earlier), the corner itself less,
     * the straight after it a little (the speed carried out of the corner).
     */
    const ATTRACT_BRAKE_SPREAD_MS = 45;
    const ATTRACT_CORNER_SPREAD_MS = 35;
    const ATTRACT_STRAIGHT_SPREAD_MS = 15;
    /**
     * The chance a lap has a moment, what it is worth, ms (not weighted: a slide is a slide), and
     * the chance it is a gain (the best lap had its moment there) rather than a loss.
     */
    const ATTRACT_MOMENT_CHANCE = 0.85;
    const ATTRACT_MOMENT_MIN_MS = 150;
    const ATTRACT_MOMENT_MAX_MS = 500;
    const ATTRACT_MOMENT_GAIN_CHANCE = 0.45;
    /** How a lap ends against the best, ms: this lean to slower, and this much either way at most. */
    const ATTRACT_FINAL_LEAN_MS = 20;
    const ATTRACT_FINAL_SPREAD_MS = 150;
    /** The best lap's sectors before the demo began, ms, adding up to ATTRACT_REFERENCE_TARGET_MS. */
    const ATTRACT_REFERENCE_SECTORS_MS = [34420, 34610, 34415];
    /**
     * The wander on top of the corners: a real delta is never still, it drifts all the way round
     * as the line, the braking and the speed carried differ from the reference's a little
     * everywhere. Made of half-waves across the lap (whole numbers of them, so it is 0 at both
     * lines and changes no lap time). The ones that cross the line four to eight times a lap are
     * the largest, so a lap has green and red in it; the slowest are small, as they held a whole
     * lap on one side. Each its most in ms at the default range, drawn per lap between plus and minus.
     */
    const ATTRACT_WANDER_MS = [30, 70, 120, 160, 170, 150, 120, 90, 60, 40, 25, 15];
    /** The draws of a lap: one per corner, then the wander's, then the moment's four (whether, where, how much, which way), then how it ends. */
    const ATTRACT_WANDER_DRAW = ATTRACT_CORNERS.length;
    const ATTRACT_MOMENT_DRAW = ATTRACT_WANDER_DRAW + ATTRACT_WANDER_MS.length;
    const ATTRACT_FINAL_DRAW = ATTRACT_MOMENT_DRAW + 4;
    /** A spread is the sum of two draws, each from its own slot. */
    const DRAWS_PER_SPREAD = 2;
    /** An integer hash (the multipliers of the murmur3 finaliser and the golden ratio), to a share in [0, 1). */
    const HASH_GOLDEN = 0x9E3779B1;
    const HASH_MIX_A = 0x85EBCA77;
    const HASH_MIX_B = 0x2C1B3C6D;
    const HASH_MIX_C = 0x297A2D39;
    const HASH_SHIFT_A = 15;
    const HASH_SHIFT_B = 12;
    const HASH_RANGE = 4294967296;
    const TWO_PI = 2 * Math.PI;
    /** The classic smoothstep polynomial, 3k^2 - 2k^3. */
    const SMOOTHSTEP_SQUARE = 3;
    const SMOOTHSTEP_CUBE = 2;

    /** A smooth 0->1 step from `from` to `to`. */
    const smoothStep = function (x, from, to) {
        const k = Math.max(0, Math.min(1, (x - from) / (to - from)));

        return k * k * (SMOOTHSTEP_SQUARE - SMOOTHSTEP_CUBE * k);
    };

    /** Draw number `n` of lap `lap`, a share in [0, 1): the same every time it is asked for. */
    const attractDraw = function (lap, n) {
        let h = Math.imul(lap + 1, HASH_GOLDEN) ^ Math.imul(n + 1, HASH_MIX_A);

        h = Math.imul(h ^ (h >>> HASH_SHIFT_A), HASH_MIX_B);
        h = Math.imul(h ^ (h >>> HASH_SHIFT_B), HASH_MIX_C);

        return ((h ^ (h >>> HASH_SHIFT_A)) >>> 0) / HASH_RANGE;
    };

    /** Draw `n` as a share in [0, 1). */
    const attractShare = function (lap, n) {
        return attractDraw(lap, n * DRAWS_PER_SPREAD);
    };

    /** Draw `n` as a share in [0, 1), commoner near the middle (the mean of two, as small variations are). */
    const attractMiddling = function (lap, n) {
        return (attractDraw(lap, n * DRAWS_PER_SPREAD) + attractDraw(lap, n * DRAWS_PER_SPREAD + 1)) / DRAWS_PER_SPREAD;
    };

    /**
     * Lap `n`'s corners: where each part of each corner starts and ends as shares of the lap, and
     * what it gains (negative) or loses there against the best lap, ms. The braking, the corner and
     * the straight after it go the same way, as a corner is taken well or badly as a whole (drawn
     * apart, a gain on the brakes and a loss a second later flicked the bar there and back, which
     * reads as a spring). On most laps one corner is a moment: a lock-up or a slide that loses, or
     * the best lap's own moment there, which this lap gains back.
     */
    const attractEvents = function (n) {
        const events = [];
        const hasMoment = attractShare(n, ATTRACT_MOMENT_DRAW) < ATTRACT_MOMENT_CHANCE;
        const momentCorner = Math.floor(attractShare(n, ATTRACT_MOMENT_DRAW + 1) * ATTRACT_CORNERS.length);
        const momentSize = ATTRACT_MOMENT_MIN_MS + (ATTRACT_MOMENT_MAX_MS - ATTRACT_MOMENT_MIN_MS) * attractShare(n, ATTRACT_MOMENT_DRAW + 2);
        const momentMs = attractShare(n, ATTRACT_MOMENT_DRAW + 3) < ATTRACT_MOMENT_GAIN_CHANCE ? -momentSize : momentSize;

        ATTRACT_CORNERS.forEach(function (corner, c) {
            const next = c + 1 < ATTRACT_CORNERS.length ? ATTRACT_CORNERS[c + 1].at : 1;
            const brakeEnd = corner.at + ATTRACT_BRAKE_SHARE;
            const cornerEnd = brakeEnd + ATTRACT_CORNER_SHARE;
            // one draw for the whole corner, -1..1, commoner near 0
            const how = DRAWS_PER_SPREAD * attractMiddling(n, c) - 1;
            const part = function (spread) { return corner.weight * spread * how; };
            const moment = hasMoment && c === momentCorner ? momentMs : 0;

            // the braking and the corner as one ramp, and the straight's ramp begun while the corner is still under way:
            // ramps laid end to end both stand still where they meet, and a wave moving the other way at that moment
            // flicked the bar back for a fraction of a second (a spring, again)
            events.push({ from: corner.at, to: cornerEnd, ms: part(ATTRACT_BRAKE_SPREAD_MS) + part(ATTRACT_CORNER_SPREAD_MS) + moment });
            events.push({ from: brakeEnd, to: Math.max(cornerEnd, next), ms: part(ATTRACT_STRAIGHT_SPREAD_MS) });
        });

        return events;
    };

    /**
     * Lap `k` of the script: its corners, its wander, how it ends against the best lap, the best
     * lap's time and sectors it is measured against, its own time and sectors, its start on the
     * demo's clock, and the last lap and optimal shown while it runs. Worked out once per lap, in
     * order, since each lap's best and start follow from the laps before it.
     */
    const attractLaps = [];
    /** The best lap before the demo began: its time and its sectors. */
    const attractBefore = { time: ATTRACT_REFERENCE_TARGET_MS, sectors: ATTRACT_REFERENCE_SECTORS_MS };
    /** The lap the last frame was on: the next is looked for from there, not from the first lap every frame. */
    let attractCursor = 0;

    const attractLap = function (k) {
        while (attractLaps.length <= k) {
            const n = attractLaps.length;
            const before = n > 0 ? attractLaps[n - 1] : null;
            // the best lap so far is the reference
            const reference = !before ? attractBefore : (before.own.time < before.reference.time ? before.own : before.reference);
            const bestSectors = before ? before.bestSectors : attractBefore.sectors;
            const events = attractEvents(n);
            let total = 0;
            let optimal = 0;

            events.forEach(function (e) { total += e.ms; });
            bestSectors.forEach(function (ms) { optimal += ms; });

            const lap = {
                events: events,
                // what the corners add up to is spread back over the lap, so they shape it without dragging it to one side
                detrend: total,
                // how the lap ends against the best: a little either way, a little more often slower
                final: ATTRACT_FINAL_LEAN_MS + ATTRACT_FINAL_SPREAD_MS * (DRAWS_PER_SPREAD * attractMiddling(n, ATTRACT_FINAL_DRAW) - 1),
                wander: ATTRACT_WANDER_MS.map(function (ms, i) { return ms * (DRAWS_PER_SPREAD * attractShare(n, ATTRACT_WANDER_DRAW + i) - 1); }),
                reference: reference,
                referenceMs: reference.time,
                start: before ? before.start + before.time : 0,
                last: before ? before.time : ATTRACT_LAST_BEFORE_MS,
                optimal: Math.round(optimal)
            };

            lap.time = Math.round(reference.time + lap.final);

            // Centred: what the lap does between the lines, its own ending aside, is shifted by one hump (a half-wave,
            // 0 at both lines) so that it spends as much above the line as below it. Uncentred, a moment or a large
            // wave held most of a lap on one side and its trace was nearly all one colour (the user, 2026-09-24)
            lap.centre = 0;
            let sum = 0;
            let i;

            for (i = 1; i < ATTRACT_CENTRE_SAMPLES; i += 1) { sum += attractDelta(lap, i / ATTRACT_CENTRE_SAMPLES) - lap.final * i / ATTRACT_CENTRE_SAMPLES; }

            lap.centre = (sum / (ATTRACT_CENTRE_SAMPLES - 1)) * ATTRACT_HUMP_MEAN_TO_PEAK;

            // the lap's own sectors: the best lap's, each with its share of how the lap ended, and part of what the
            // delta did across it. All of it, and the best of each sector over a few laps left the optimal a second
            // and a half under the best, which no session shows; the shares still add up to the lap time
            const sectorEnds = [0, 1 / ATTRACT_SECTORS, 2 / ATTRACT_SECTORS, 1];
            const sectors = reference.sectors.map(function (ms, i) {
                const across = attractDelta(lap, sectorEnds[i + 1]) - attractDelta(lap, sectorEnds[i]);

                return ms + lap.final / ATTRACT_SECTORS + ATTRACT_SECTOR_SWING * (across - lap.final / ATTRACT_SECTORS);
            });

            lap.own = { time: lap.time, sectors: sectors };
            // the best of each sector once this lap is done, for the laps after it
            lap.bestSectors = bestSectors.map(function (ms, i) { return Math.min(ms, sectors[i]); });
            attractLaps.push(lap);
        }

        return attractLaps[k];
    };

    /**
     * The scripted delta on lap `lap` at lap share `phase` (0..1), stretched by `scale` (1 when not
     * given): 0 at the line, the lap's own result against the best by the next. The wander crosses
     * the line a few times a lap and the corners shape it, so a lap is green in places and red in
     * others (built from the corners alone, each lap drifted to one side and its trace was one colour).
     */
    const attractDelta = function (lap, phase, scale) {
        const stretch = typeof scale === "number" ? scale : 1;
        let delta = (lap.final - lap.detrend) * phase - lap.centre * Math.sin(phase * Math.PI);

        // half-wave i + 1 of the wander: sin(pi (i + 1) phase), 0 at both lines
        lap.wander.forEach(function (ms, i) { delta += ms * Math.sin(phase * Math.PI * (i + 1)); });
        lap.events.forEach(function (e) { delta += e.ms * smoothStep(phase, e.from, e.to); });
        // (a quick flutter of a few ms was tried on top: on a 0.5 s bar it rocked the fill back and forth twice a
        // second, which reads as a spring, 2026-09-24; the delta moves only as a car's does)
        return delta * stretch;
    };

    /** The scripted values at `now`, driven for a bar of `rangeMs` (the default range when not given). */
    const attractValues = function (now, rangeMs) {
        const scale = typeof rangeMs === "number" && rangeMs > 0 ? rangeMs / ATTRACT_SCALE_RANGE_MS : 1;
        // a lap time as shown at this range: its difference from the demo's best stretched like the delta
        const shown = function (ms) { return Math.round(ATTRACT_REFERENCE_TARGET_MS + scale * (ms - ATTRACT_REFERENCE_TARGET_MS)); };
        const clock = Math.max(0, now);
        let k = clock >= attractLap(attractCursor).start ? attractCursor : 0;

        while (attractLap(k).start + attractLap(k).time <= clock) { k += 1; }

        attractCursor = k;

        const lap = attractLap(k);
        const lapMs = Math.round(clock - lap.start);
        const phase = lapMs / lap.time;
        // not rounded to whole ms: the game's own delta comes in ms, but a scripted one moving a few ms a second
        // would creep across a short bar in visible steps; the figure rounds it as it rounds the game's
        const delta = attractDelta(lap, phase, scale);
        const best = shown(lap.referenceMs);

        return {
            delta: delta,
            predicted: best + delta,
            lapMs: lapMs,
            lapCount: k,
            npos: phase,
            cutGained: null,
            cutDeadline: null,
            cutDelta: null,
            carId: "",
            sessionKey: "",
            driver: "",
            current: formatLap(lapMs),
            best: formatLap(best),
            optimal: formatLap(shown(lap.optimal)),
            last: formatLap(shown(lap.last)),
            invalid: false,
            rawInvalid: false
        };
    };

    // ---- rendering -----------------------------------------------------------------

    /** Empty the ring: the trend reads flat until a window of new samples is in. */
    const resetRing = function (state) {
        state.head = -1;
        state.count = 0;
    };

    /** Forget the trend and its clock (the delta went away or a new lap started). */
    const resetTrend = function (state) {
        resetRing(state);
        ACEUIAppLoader.loop.reset(state.sampler);
    };

    /**
     * Put one sample into the ring. A jump no driving could make starts the ring over. Only
     * the ring: this runs inside the sampler's own advance, whose clock must not be reset
     * under it (a reset there made it replay every period since the epoch in one frame).
     */
    const pushSample = function (state, delta) {
        if (state.count > 0 && Math.abs(delta - state.samples[state.head]) > JUMP_MS) { resetRing(state); }

        state.head = (state.head + 1) % TREND_N;
        state.samples[state.head] = delta;

        if (state.count < TREND_N) { state.count += 1; }
    };

    /** The delta's rate of change in ms per second over the window, or null with too few samples. */
    const trendRate = function (state) {
        const back = state.windowSamples;

        if (state.count <= back) { return null; }

        return (state.samples[state.head] - state.samples[(state.head - back + TREND_N) % TREND_N]) * MS_PER_S / state.windowMs;
    };

    /**
     * The trend the rate means, given the trend we are in: staying in the trend we are in needs
     * half the band, entering one (from flat, or from the other side) needs the whole band, so
     * jitter smaller than the band cannot flip the colour once a trend has been on (found by
     * review 2026-09-23: the half band was applied to either direction). A rate that crosses the
     * whole band in one step does go straight from one colour to the other, which is a real
     * change of pace, not jitter.
     */
    const classify = function (state, rate) {
        if (rate === null) { return TREND_FLAT; }

        const want = rate < 0 ? TREND_GAIN : TREND_LOSE;
        const enter = state.trend === want ? state.band * HYSTERESIS : state.band;

        return Math.abs(rate) < enter ? TREND_FLAT : want;
    };

    /** The trend's classes on the root, written only when they change. */
    const renderTrend = function (state) {
        const rate = trendRate(state);
        const trend = classify(state, rate);
        // the glow has a one-sided hysteresis of its own: entered at the threshold, kept to four
        // fifths of it while the trend stays the same (a rate hovering at five bands blinked it)
        const strongAt = state.band * STRONG_FACTOR;
        const strongEnter = state.strong && trend === state.trend ? strongAt * STRONG_KEEP : strongAt;
        const strong = trend !== TREND_FLAT && Math.abs(rate) >= strongEnter;

        if (trend !== state.trend) {
            state.trend = trend;
            setClass(state.root, CLASS.gain, trend === TREND_GAIN);
            setClass(state.root, CLASS.lose, trend === TREND_LOSE);
            setClass(state.root, CLASS.flat, trend === TREND_FLAT);
        }

        if (strong !== state.strong) {
            state.strong = strong;
            setClass(state.root, CLASS.strong, strong);
        }
    };

    /** The share of the range a delta fills: 0..1. */
    const shareOf = function (state, delta) {
        return Math.min(1, Math.abs(delta) / state.rangeMs);
    };

    /** Write a transform when it differs from the last one written. */
    const setTransform = function (state, cacheKey, node, value) {
        if (state[cacheKey] !== value) {
            state[cacheKey] = value;
            node.style.transform = value;
        }
    };

    /**
     * The bar: the fill grows out from the centre on the faster side for time gained and on
     * the other for time lost; the tick rides its end, and so does the figure when it follows.
     * Then the figure's text and the overall sign.
     */
    const renderDelta = function (state, delta) {
        const hasRef = delta !== null;
        // The fill, its side and its colour are the delta itself, every frame, so it runs smoothly into the centre
        // line and out the other side. Drawn from the figure as rounded, it moved in steps of the last digit shown
        // (10 ms at two decimals, a jump every few frames on a short bar range: a recording from the game,
        // 2026-09-24) and snapped to the centre as the figure reached 0.00. Only the figure's own colour goes by
        // what it reads: a figure reading 0.00 takes neither sign's colour (CLASS.zero)
        const shown = hasRef ? roundDelta(delta, state.decimals) : 0;
        const share = hasRef ? shareOf(state, delta) : 0;
        const sign = hasRef && delta !== 0 ? (delta < 0 ? -1 : 1) : 0;
        const zero = hasRef && shown === 0;
        // the fill on the right when the delta is on the side the right stands for
        const onRight = sign !== 0 && (sign < 0) === state.fasterRight;
        const signedShare = onRight ? share : -share;
        const text = hasRef ? formatDelta(delta, state.decimals) : state.noDeltaText;
        const shift = sign === 0 ? NO_SHIFT : shiftTransform(signedShare);

        setTransform(state, "lastRight", state.rightFill, scaleXTransform(onRight ? share : 0));
        setTransform(state, "lastLeft", state.leftFill, scaleXTransform(sign !== 0 && !onRight ? share : 0));
        setTransform(state, "lastTick", state.tickTrack, shift);
        setTransform(state, "lastFollow", state.main, state.followOn ? shift : NO_SHIFT);

        if (text !== state.lastText) {
            state.lastText = text;
            state.figure.textContent = text;
            setLean(state, leanOf(text));
        }

        if (sign !== state.sign) {
            state.sign = sign;
            setClass(state.root, CLASS.faster, sign < 0);
            setClass(state.root, CLASS.slower, sign > 0);
        }

        if (zero !== state.zero) {
            state.zero = zero;
            setClass(state.root, CLASS.zero, zero);
        }

        if (hasRef !== state.hasRef) {
            state.hasRef = hasRef;
            setClass(state.root, CLASS.noRef, !hasRef);
        }
    };

    /** Blank every slot of the trace (a new lap). */
    const clearTrace = function (state) {
        state.ups.forEach(function (up, i) {
            if (state.lastUps[i] !== HIDDEN_Y) {
                state.lastUps[i] = HIDDEN_Y;
                up.style.transform = HIDDEN_Y;
            }

            if (state.lastDowns[i] !== HIDDEN_Y) {
                state.lastDowns[i] = HIDDEN_Y;
                state.downs[i].style.transform = HIDDEN_Y;
            }

            state.traceValues[i] = null;
        });
        state.traceSlot = -1;
    };

    /** Write one slot of the trace: up for time gained, down for time lost. */
    const writeSlot = function (state, slot, delta) {
        const share = shareOf(state, delta);

        state.traceValues[slot] = delta;
        const up = scaleYTransform(delta < 0 ? share : 0);
        const down = scaleYTransform(delta > 0 ? share : 0);

        if (state.lastUps[slot] !== up) {
            state.lastUps[slot] = up;
            state.ups[slot].style.transform = up;
        }

        if (state.lastDowns[slot] !== down) {
            state.lastDowns[slot] = down;
            state.downs[slot].style.transform = down;
        }
    };

    /** Keep the trace so far, with the lap it belongs to (see TRACE_STORE_KEY). */
    const saveTrace = function (state, slot) {
        ACEUIAppLoader.persist.writeLocal(TRACE_STORE_KEY, {
            car: state.carId, sess: state.sessionKey, lap: state.lapCount, at: state.lapMs, slot: slot, values: state.traceValues
        });
    };

    /**
     * After a reload, the trace kept for this lap, drawn again. Only for the same lap: the same
     * car and session, a lap count to match (none, no restore), and the clock no earlier than the
     * mark it was kept at (within the clock's own corrections) with the car no further back along
     * the lap. Anything else is another lap's, and is left to be written over.
     */
    const restoreTrace = function (state, m) {
        if (!state.traceOn || state.attract || m.lapCount === null || m.lapMs === null || m.npos === null) { return; }

        const kept = ACEUIAppLoader.persist.readLocal(TRACE_STORE_KEY);

        if (!kept || typeof kept !== "object" || !Array.isArray(kept.values) || kept.values.length !== TRACE_N) { return; }

        if (kept.lap !== m.lapCount || kept.car !== m.carId || kept.sess !== m.sessionKey || typeof kept.at !== "number" || typeof kept.slot !== "number") { return; }

        if (m.lapMs < kept.at - LAP_CLOCK_JITTER_MS || Math.floor(m.npos * TRACE_N) < kept.slot) { return; }

        kept.values.forEach(function (value, i) {
            if (typeof value === "number" && isFinite(value)) { writeSlot(state, i, value); }
        });
        state.traceSlot = kept.slot;
        log("the lap trace kept from before the reload is back, to slot " + kept.slot);
    };

    /**
     * The lap trace: the slot under the car takes the current delta, and up to TRACE_BACKFILL_MAX
     * slots skipped since the last frame take it too, so a slow frame leaves no gap (a longer gap
     * had no data and stays blank). The position wrapping
     * back to the start is a new lap.
     */
    const renderTrace = function (state, delta, npos) {
        if (!state.traceOn || npos === null) { return; }

        const slot = Math.min(TRACE_N - 1, Math.floor(npos * TRACE_N));
        let from = slot;

        if (state.traceSlot >= 0 && slot < state.traceSlot - TRACE_WRAP_SLOTS) { clearTrace(state); }

        // no delta: nothing to draw, and the slots passed meanwhile are not filled in later either
        if (delta === null) {
            state.traceSlot = slot;

            return;
        }

        // a slow frame skips a slot or two, filled in with this delta; a longer gap (a delta
        // outage, the HUD hidden for a stretch) had no data, and a block painted over it would
        // say the delta held there, so it stays blank
        if (state.traceSlot >= 0 && slot > state.traceSlot) { from = Math.max(state.traceSlot + 1, slot - TRACE_BACKFILL_MAX); }

        // the scripted lap has its whole past: the stretch driven before attract came on (or before the reload)
        // is drawn at once from the script, so a recording starts with a trace, not an empty strip
        if (state.attract && state.traceSlot < 0) {
            const lap = attractLap(state.lapCount);

            from = 0;

            while (from < slot) {
                writeSlot(state, from, Math.round(attractDelta(lap, (from + TRACE_SLOT_MIDDLE) / TRACE_N, state.rangeMs / ATTRACT_SCALE_RANGE_MS)));
                from += 1;
            }
        }

        while (from <= slot) {
            writeSlot(state, from, delta);
            from += 1;
        }

        if (slot !== state.traceSlot && !state.attract) { saveTrace(state, slot); }

        state.traceSlot = slot;
    };

    /** The lap-time cells, who the delta is against, the invalid tag, the top line. */
    const renderInfo = function (state, m) {
        const pred = formatLap(m.predicted);
        // shown whenever the game names a driver, as the stock bar does; there is no switch, since
        // the field is empty in every mode measured so far and a switch for it did nothing visible
        const hasDriver = m.driver !== "";
        // INVALID: the game's flag is up now, and either the game said why (a notification for
        // this lap) or the flag rose during a lap that started valid and kept to the track. The
        // flag is the truth: a notice, or a remembered cut, never paints a lap the game calls
        // valid. Otherwise a lap the pit lane is part of gets the quiet tag: PIT LANE while in it,
        // OUTLAP once out with the flag still up. A lap flagged from its start with no
        // notification and no location to go by is a pit exit too, unnamed.
        // While a remembered record waits for the lap count (restorePending) it may yet say this lap has the
        // pit lane in it, and a flag rising meanwhile would be the pit exit's: a cut from the flag alone is not
        // painted until it has spoken; a cut the game named is (second review, 2026-09-24)
        const flagOnly = state.lapCut ? state.cutReason === "" : true;
        // attract mode shows the tag picked for it and nothing the lap state says (it has none of its own there)
        const demoTag = state.attract ? settings.get(me.name, SETTING.attractTag) : ATTRACT_TAG_OFF;
        const demo = demoTag !== ATTRACT_TAG_OFF;
        const demoInvalid = demoTag.indexOf(INVALID_TEXT) === 0;
        const invalid = state.invalidOn && (demo ? demoInvalid : !(state.restorePending && flagOnly)
            && (state.lapCut ? m.rawInvalid : (m.invalid && !state.lapStartedInvalid && !state.pitLap)));
        const pit = state.invalidOn && !invalid && (demo ? !demoInvalid : (m.inPits === true || (m.rawInvalid && state.pitLap)));
        const topOn = hasDriver || invalid || pit || state.hasRef === false;
        let predState = PRED_EVEN;

        if (m.best !== state.lastBestText) {
            state.lastBestText = m.best;
            state.bestMs = parseLap(m.best);
            state.bestTime.textContent = lapText(m.best);
        }

        if (m.optimal !== state.lastOptimal) {
            state.lastOptimal = m.optimal;
            state.optimalTime.textContent = lapText(m.optimal);
        }

        if (m.last !== state.lastLast) {
            state.lastLast = m.last;
            state.lastTime.textContent = lapText(m.last);
        }

        if (pred !== state.lastPred) {
            state.lastPred = pred;
            state.predTime.textContent = pred;
        }

        // no reference: the line counts the lap, to the tenth, so the widget is visibly alive
        if (state.hasRef === false) {
            const status = m.lapMs !== null && m.lapMs > 0 ? NO_REFERENCE_LAP_TEXT + formatLapTenths(m.lapMs) : NO_REFERENCE_TEXT;

            if (status !== state.lastStatus) {
                state.lastStatus = status;
                state.status.textContent = status;
            }
        }

        // the prediction moves every frame: within the band of the best it is neither colour,
        // and a colour once on is kept to half the band, or it would flicker at the best
        if (m.predicted !== null && state.bestMs !== null) {
            const gap = m.predicted - state.bestMs;
            const want = gap < 0 ? PRED_FASTER : PRED_SLOWER;
            const enter = state.predState === want ? PRED_BAND_MS * HYSTERESIS : PRED_BAND_MS;

            predState = Math.abs(gap) < enter ? PRED_EVEN : want;
        }

        if (predState !== state.predState) {
            state.predState = predState;
            setClass(state.predCell, CLASS.predFaster, predState === PRED_FASTER);
            setClass(state.predCell, CLASS.predSlower, predState === PRED_SLOWER);
        }

        if (hasDriver && m.driver !== state.lastVs) {
            state.lastVs = m.driver;
            state.vs.textContent = VS_TEXT + m.driver;
        }

        if (hasDriver !== state.hasDriver) {
            state.hasDriver = hasDriver;
            setClass(state.root, CLASS.hasDriver, hasDriver);
        }

        if (invalid !== state.invalid) {
            state.invalid = invalid;
            setClass(state.root, CLASS.invalid, invalid);
        }

        if (pit !== state.pit) {
            state.pit = pit;
            setClass(state.root, CLASS.pit, pit);
        }

        // "INVALID · TRACK LIMITS" when the game's notice gave a reason, plain INVALID from the flag alone
        if (invalid || pit) {
            let tag = PIT_LANE_TAG;

            if (demo) {
                tag = demoTag;
            } else if (invalid) {
                tag = state.cutReason ? INVALID_TEXT + REASON_SEPARATOR + state.cutReason : INVALID_TEXT;
            } else if (m.inPits !== true) {
                tag = OUTLAP_TAG;
            }

            if (tag !== state.lastTag) {
                state.lastTag = tag;
                state.invalidTag.textContent = tag;
            }
        }

        if (topOn !== state.topOn) {
            state.topOn = topOn;
            setClass(state.root, CLASS.topOn, topOn);
        }
    };

    /**
     * What is known about the lap under way, kept through the HUD reload (LAP_KEY); nothing
     * known, nothing kept. The store is the stock's layout container and it persists on every
     * write, so a lap with nothing to remember costs nothing here: the record is dropped only
     * when one was written. The store cannot be allowed to fail the frame either way.
     */
    const rememberLap = function (state) {
        // a record still waiting to be judged (no lap count yet) is neither overwritten nor
        // forgotten; and the scripted lap has no record worth keeping, nor may it touch the real one
        if (state.restorePending || state.attract) { return; }

        const known = state.lapCut || state.pitLap || state.nextLapInvalid || state.verdictOwed || state.hiddenCut || state.hiddenOwed;

        if (!known && !state.lapRemembered) { return; }

        ACEUIAppLoader.safely(me.prefix + " lap record", function () {
            if (!known) {
                me.forget(LAP_KEY);
                state.lapRemembered = false;

                return;
            }

            me.remember(LAP_KEY, {
                sess: state.sessionKey,
                car: state.carId,
                lap: state.lapCount,
                // a lap whose clock has not come yet is at its start: stamping the clock kept from
                // the lap before would put the mark beyond anything this lap can reach, and every
                // later restore would refuse the record (fourth pass, 2026-09-23)
                at: state.lapClockSeen ? state.lapMs : 0,
                cut: state.lapCut,
                reason: state.cutReason,
                pit: state.pitLap,
                pitLate: state.pitLate,
                track: state.trackSeen,
                next: state.nextLapInvalid,
                nextReason: state.nextLapReason,
                owed: state.verdictOwed,
                hidden: state.hiddenCut,
                hiddenOwed: state.hiddenOwed
            });
            state.lapRemembered = true;
        });
    };

    /** The lap the widget was following is over: the trace starts over, so does the trend, and the cut and the pit-lane visit are forgotten. */
    const forgetLap = function (state) {
        clearTrace(state);
        resetTrend(state);
        state.lapCut = false;
        state.cutReason = "";
        state.pitLap = false;
        state.pitLate = false;
        state.trackSeen = false;
        state.hiddenCut = false;
        state.hiddenOwed = false;
        state.verdictOwed = false;
    };

    /**
     * A new lap started: the trace starts over, so does the trend, the cut and the pit-lane
     * visit are forgotten, and an invalidation the game announced for this lap takes effect.
     */
    const newLap = function (state, anotherCar) {
        // A lap that ends cut with no reason yet (a race: the NO GAIN comes 4 to 10 s after the flag)
        // is owed its verdict: the next one to arrive is that lap's, whatever lap the car is on by then.
        // Not when the lap ends because another car came under focus: its verdicts are not ours.
        // A debt not yet paid survives a lap that never reached the track (a return to the pits two
        // seconds after the line): no cut can have happened on it, so the verdict still due is the
        // older lap's (eighth round).
        const owed = !anotherCar && ((state.lapCut && state.cutReason === "") || (state.verdictOwed && !state.trackSeen));
        // a lap that was not cut but had the car on the track under a flag that was not a cut's (an out-lap) may
        // have hidden a cut there. That is a weaker debt: it takes only a verdict that would otherwise mark a lap
        // with no cut of its own, never one that names a cut this lap's flag showed (ninth and tenth rounds: as a
        // full debt it took the reason from the first cut lap after every pit stop, and every cut lap after that)
        const hiddenOwed = !anotherCar && ((state.hiddenCut && !state.lapCut) || (state.hiddenOwed && !state.trackSeen));

        forgetLap(state);
        state.verdictOwed = owed;
        state.hiddenOwed = hiddenOwed;
        // a reason belongs to the lap its notice came on

        if (state.nextLapInvalid) {
            state.lapCut = true;
            state.cutReason = state.nextLapReason;
            state.nextLapInvalid = false;
            state.nextLapReason = "";
            log("the invalidation announced for this lap takes effect" + (state.cutReason ? " (" + state.cutReason + ")" : ""));
        }

        rememberLap(state);
    };

    /** Mark this lap cut, with the game's reason, and remember both through the HUD reload. */
    const markCut = function (state, reason) {
        state.lapCut = true;
        state.cutReason = reason || "";
        state.cutAt = state.lastFrameAt;
        rememberLap(state);
    };

    /**
     * A remembered lap of our car in this session, as far as the frame can tell, that is owed a verdict: cut
     * with no reason yet, or still carrying an unpaid debt of its own. Which lap it is, is for the caller to say.
     */
    const owesVerdict = function (kept, m) {
        // a debt the record carries is passed on only if its lap never reached the track, as newLap passes one on
        return Boolean(kept) && typeof kept === "object" && ((kept.cut === true && kept.reason === "") || (kept.owed === true && kept.track !== true))
            && !(typeof kept.sess === "string" && kept.sess !== "" && m.sessionKey !== "" && kept.sess !== m.sessionKey)
            && !(typeof kept.car === "string" && kept.car !== "" && m.carId !== "" && kept.car !== m.carId);
    };

    /** The same for the weaker debt: a remembered out-lap that may have hidden a cut, or a lap still carrying that debt. */
    const owesHiddenVerdict = function (kept, m) {
        return Boolean(kept) && typeof kept === "object" && ((kept.hidden === true && kept.cut !== true) || (kept.hiddenOwed === true && kept.track !== true))
            && !(typeof kept.sess === "string" && kept.sess !== "" && m.sessionKey !== "" && kept.sess !== m.sessionKey)
            && !(typeof kept.car === "string" && kept.car !== "" && m.carId !== "" && kept.car !== m.carId);
    };

    /**
     * What was remembered before a HUD reload, if it belongs to the lap now running. The lap
     * time must not have gone backwards since (a lap's clock only runs forward; a new
     * session's first lap starts from zero, so a record kept from the last session does not
     * match it), and when the game gives a lap count it must be the same lap. With no lap
     * count, the flag must still be up as well.
     */
    const restoreLap = function (state, m) {
        if (state.attract) { return; }   // the scripted lap neither restores the real record nor judges it

        const kept = me.recall(LAP_KEY, null);
        let same = false;

        // a record filed under a lap number is matched against a lap number and nothing else: the
        // model that gave the widget the count gives it again. A frame without the count cannot
        // decide, and must not throw the record away either: the decision waits for a frame that
        // has it (the car coming back after a spell away can lack the low-frequency block for a
        // frame), or for the lap to end, which settles it. For a record the count never reached,
        // the clock decides how far the lap has run and the flag whether it is this one; the clock
        // is the one kept from the last frame that had it, as everywhere else
        const clock = m.lapMs !== null ? m.lapMs : state.lapMs;

        if (kept && typeof kept === "object" && typeof kept.lap === "number" && m.lapCount === null) {
            state.restorePending = true;
            state.lapRemembered = true;   // the store holds a record: the lap that settles this may forget it
            log("a lap is remembered from before, and this frame has no lap count to match it against: waiting for one");

            return;
        }

        state.restorePending = false;

        // the clock must have reached the mark the record was written at: within a session a lap's
        // clock only goes forward, so the same lap number at an earlier clock is another session's.
        // Forward but for the multiplayer clock's own corrections (back by up to 54 ms measured): a step
        // back no bigger than the boundary's jitter, well into the lap, is still the lap that wrote the
        // mark (second review, 2026-09-24: a one-frame spell without the car across a correction lost the red)
        const reached = kept && typeof kept === "object" && typeof kept.at === "number" && clock !== null
            && (clock >= kept.at || (clock >= LAP_CLOCK_LANDING_MS && kept.at - clock <= LAP_CLOCK_JITTER_MS));

        if (reached) {
            same = typeof kept.lap === "number" ? kept.lap === m.lapCount : m.rawInvalid;
        }

        // another session's record is never this lap's, however well its numbers fit
        if (same && typeof kept.sess === "string" && kept.sess !== "" && m.sessionKey !== "" && kept.sess !== m.sessionKey) {
            same = false;
            log("the lap remembered from before the reload belongs to another session");
        }

        // nor another car's: a reload that comes back with another car under focus, on a lap with
        // the same number and the flag up (its pit exit), must not paint our cut on it (fifth pass,
        // 2026-09-23). Judged only when both frames named the car
        if (same && typeof kept.car === "string" && kept.car !== "" && m.carId !== "" && kept.car !== m.carId) {
            same = false;
            log("the lap remembered from before the reload belongs to another car");
        }

        // a cut is only ever restored under the game's flag: a record left by an earlier session
        // whose lap count and clock happen to fit (the app switched on mid-lap) must not paint a
        // clean lap red. The flag is the truth; the record is the reason
        if (same && kept.cut === true && !m.rawInvalid) {
            same = false;
            log("the cut remembered from before the reload is not this lap: the flag is down");
        }

        // (a pit record of this lap is kept even when the car is found on the track with the flag down:
        // a reload between the pit exit and the flag rising a moment later lands exactly there, and
        // dropping the pit lane then read the pit exit's flag as a cut; sixth round. Kept, the worst it
        // can do is quieten a real cut on a lap that shares a number with an out-lap: a tag missing)

        // a cut lap that never saw the pit lane cannot be found in the pit lane after a reload
        // without a teleport (a reset to the pits): that lap is over, whatever the clock says
        if (same && kept.cut === true && kept.pit !== true && m.inPits === true) {
            same = false;
            log("the cut lap remembered from before the reload is over: the car is back in the pit lane");
        }

        // a lap refused here as over, cut with no reason yet: the lap just before (the line crossed while no
        // lap was followed), or the same lap number found over (back in the pit lane, the clock behind its
        // mark). newLap never ran for it, so its debt comes with it, whatever the numbers: a debt can only
        // swallow a verdict, never paint one (fifth pass fifth round; seventh round for the same number).
        // Same car and session when both are known, as for a restore
        if (!same && owesVerdict(kept, m)) {
            state.verdictOwed = true;
            log("the lap before, remembered cut with no verdict yet, owes it: the next verdict is that lap's");
        }

        if (!same && owesHiddenVerdict(kept, m)) {
            state.hiddenOwed = true;
            log("the lap before, remembered as an out-lap that may have hidden a cut, owes a verdict that would mark a lap with no cut of its own");
        }

        if (same) {
            // the record adds to what this lap has gathered meanwhile (a notice, the pit lane, while
            // the record waited for the count) and never takes it away; the one exception is a cut
            // from the flag alone on a lap the record knows as a pit lap: that rise was the pit exit
            // (a verdict arriving while the record waited is held, not judged, so a cut with a reason here
            // came from a notice that names this lap)
            state.lapCut = kept.cut === true || (state.lapCut && (state.cutReason !== "" || kept.pit !== true));
            state.cutReason = state.lapCut ? (state.cutReason !== "" ? state.cutReason : (typeof kept.reason === "string" ? kept.reason : "")) : "";
            state.pitLap = state.pitLap || kept.pit === true;
            state.pitLate = state.pitLate || kept.pitLate === true;
            state.trackSeen = state.trackSeen || kept.track === true;
            state.verdictOwed = state.verdictOwed || kept.owed === true;
            state.hiddenCut = state.hiddenCut || kept.hidden === true;
            state.hiddenOwed = state.hiddenOwed || kept.hiddenOwed === true;
            state.nextLapInvalid = state.nextLapInvalid || kept.next === true;
            state.nextLapReason = state.nextLapInvalid ? (state.nextLapReason !== "" ? state.nextLapReason : (typeof kept.nextReason === "string" ? kept.nextReason : "")) : "";
            log("remembered from before the reload, still this lap: cut " + state.lapCut + (state.cutReason ? " (" + state.cutReason + ")" : "")
                + ", pit lap " + state.pitLap + (state.nextLapInvalid ? ", the next lap invalid" + (state.nextLapReason ? " (" + state.nextLapReason + ")" : "") : ""));
        }

        // written back either way: a stale record goes, the pit lane seen this frame stays
        state.lapRemembered = Boolean(kept);
        rememberLap(state);
    };

    /** The penalty-state model, or why it did not come, said once: the same text again is not a second line. */
    const sayPenaltyState = function (state, text) {
        if (text === state.lastPenaltyText) { return; }

        state.lastPenaltyText = text;
        log("penalty state: " + text);
    };

    /**
     * Fetch the penalty-state model the stock never asks for, and log it when it changes.
     * The engine answers with a promise; a page without an engine (the preview) has none
     * of this. Only one fetch is in flight at a time, and one the engine never answers is
     * given up so the next poll can ask again.
     */
    const pollPenaltyState = function (state, now) {
        // a fetch the engine never answers must not end the polling: after a while it is given
        // up and the next poll asks again; its answer, should it ever come, is ignored by id
        if (state.penaltyPolling && now - state.pollStartedAt > PENALTY_ANSWER_MS) {
            state.penaltyPolling = false;

            if (!state.pollGaveUp) {
                state.pollGaveUp = true;
                log("penalty state: no answer in " + PENALTY_ANSWER_MS + " ms; asking again each poll (said once)");
            }
        }

        if (state.penaltyPolling || !window.engine || typeof window.engine.call !== "function") { return; }

        state.penaltyPolling = true;
        state.pollStartedAt = now;
        state.pollId += 1;

        const id = state.pollId;
        let sent = false;
        let answer = null;

        // not wrapped in safely: an engine that throws on every call would have it say so every
        // poll for the whole session, and a throw means the same thing as a refusal below
        try {
            answer = window.engine.call(PENALTY_MODEL_CALL);
        } catch (e) {
            sayPenaltyState(state, "not available (" + ACEUIAppLoader.errorText(e) + ")");
        }

        if (answer && typeof answer.then === "function") {
            sent = true;

            // an answer to a fetch that was given up, or one arriving after detach, touches nothing
            answer.then(function (model) {
                if (state.detached || id !== state.pollId) { return; }

                state.penaltyPolling = false;
                sayPenaltyState(state, ACEUIAppLoader.console.format(model));
            }, function (e) {
                if (state.detached || id !== state.pollId) { return; }

                state.penaltyPolling = false;
                sayPenaltyState(state, "not available (" + ACEUIAppLoader.errorText(e) + ")");
            });
        }

        // no promise came back (an engine call that answered nothing, or threw): nothing is in flight
        if (!sent) { state.penaltyPolling = false; }
    };

    /** The game's verdict (NO GAIN, a penalty for a cut) for our car, judged against the lap being followed. */
    const judgeVerdict = function (state, penalty) {
        if (state.verdictOwed) {
            // the lap before ended cut with no reason: this is its verdict, arriving on the lap that
            // followed (begun in the pit lane with the flag still up, say, where nothing else could
            // tell it from a verdict on this lap; fifth pass, fourth round). Taken as owed, painted nowhere
            state.verdictOwed = false;
            rememberLap(state);
            log("the verdict (" + penalty.type + ", " + penalty.reason + ") owed by the lap before: not this lap's");
        } else if (state.lapCut) {
            if (state.cutReason === "") {
                state.cutReason = reasonText(penalty.reason);
                rememberLap(state);
                log("the verdict arrived " + (state.lastFrameAt - state.cutAt) + " ms after the flag: " + state.cutReason);
            }
        } else if (state.pitLap && state.pitLate) {
            // an in-lap: the car was on the track when the lap began and came into the pit lane
            // since, which is what raised the flag. A cut on this lap would have raised it on the
            // track first and be on record; this verdict is the lap before's, arriving late (a race's
            // NO GAIN comes 4 to 10 s after the flag: a last-corner cut and a pit entry; fifth pass).
            // Judged on the pit lane's timing alone, not on how the lap started: after a reload on
            // the in-lap the first frame finds the flag up and cannot tell, but the record can
            log("a verdict (" + penalty.type + ", " + penalty.reason + ") on an in-lap whose flag is the pit entry's: the lap it is about is over");
        } else if (!state.trackSeen) {
            // the car has not been on the track this lap (in the box, on its way out): no cut can have happened
            // on it, so the verdict is an older lap's, whatever the debts say (eighth round)
            log("a verdict (" + penalty.type + ", " + penalty.reason + ") on a lap the car has not been on the track on: not this lap's");
        } else if (state.lastRawInvalid && !(state.lapStartedInvalid && (!state.lapClockSeen || state.lapMs === null || state.lapMs < LAP_START_GRACE_MS))) {
            // the flag is up but was not a cut's: the pit exit's on a pit lap (OUTLAP), or up since the lap began. The
            // game now says this lap had a cut (Road Atlanta 2026-09-23 01:18:24, a NO GAIN on the out-lap), and a cut
            // wins over the quiet tag: the lap is void for a reason the driver should see. Not inside the first moments
            // of a lap the flag has not yet been seen down on: that flag is the lap before's, still standing across the
            // line (the two models tick apart), and so is the verdict
            if (state.hiddenOwed) {
                // unless the lap before was an out-lap that may have hidden a cut under its own flag: then this
                // verdict, which would mark a lap with no cut of its own, is that lap's
                state.hiddenOwed = false;
                rememberLap(state);
                log("the verdict (" + penalty.type + ", " + penalty.reason + ") owed by the out-lap before, which may have hidden a cut: not this lap's");
            } else {
                markCut(state, reasonText(penalty.reason));
                log("the verdict on a lap flagged " + (state.pitLap ? "at the pit exit" : "from its start") + ": a cut after all, " + state.cutReason);
            }
        } else {
            log("a verdict (" + penalty.type + ", " + penalty.reason + ") with no flag of this lap's up: the lap it is about is over, or the game did not void it");
        }
    };

    /** A verdict held while the record waited for its count, judged now that it is settled; one that can no longer be placed is let go. */
    const settleHeldVerdict = function (state, placeable) {
        const penalty = state.heldVerdict;

        if (!penalty) { return; }

        state.heldVerdict = null;

        if (placeable) {
            judgeVerdict(state, penalty);
        } else {
            log("the verdict held for the remembered lap is let go: that lap is no longer being followed");
        }
    };

    /** A UI notification from the game: a lap invalidation for our car marks this lap cut. */
    const onNotification = function (state, message) {
        if (state.detached) { return; }   // the hook is cleared at detach; should one slip through, it is nobody's lap

        const penalty = readPenalty(message);

        // everything but the car-status notices (which come in bursts), whole, for the record
        if (message && message.type !== CAR_NOTIFICATION) { log("notification: " + ACEUIAppLoader.console.format(message)); }

        if (!penalty) { return; }

        // the scripted lap takes no notices: they are about the real car, whose lap is joined afresh when the demo ends
        if (state.attract) { return; }

        // the tuple's values, every one, as the game sent them: the schema says "repeated string" and nothing more
        if (Array.isArray(message.tuples[0].values)) { log("penalty values: " + message.tuples[0].values.map(function (v) { return "\"" + v + "\""; }).join(", ")); }

        const which = invalidates(penalty);

        log("penalty notification: car " + penalty.car + ", type " + penalty.type + ", reason " + penalty.reason
            + (which === THIS_LAP ? ": our lap invalidated" : (which === NEXT_LAP ? ": our next lap invalidated" : ": not ours, or not an invalidation")));

        // a notice names no lap: it is about the lap under way as it arrives, which is only known
        // while a lap is being followed. With no car to read, or before the first frame after a
        // reload, it is dropped: the flag will still show on the lap the game voided
        if (!state.started) {
            log("no lap is being followed: the notice is not pinned on the lap the car comes back on");

            return;
        }

        if (which === THIS_LAP) { markCut(state, reasonText(penalty.reason)); }

        if (which === NEXT_LAP) {
            state.nextLapInvalid = true;
            state.nextLapReason = reasonText(penalty.reason);
            rememberLap(state);
        }

        // the game's verdict on this lap (a race's NO GAIN, or a penalty for a cut) names the flag that rose before it.
        // While the remembered lap waits for its count, which lap this is cannot be told yet: the verdict is held
        // and judged once the record is settled (fifth pass, fifth round: judged at once, it was pinned on the
        // lap the record then showed owed it to the lap before)
        if (which === "" && isOwnCar(penalty) && isLapVerdict(penalty)) {
            if (state.restorePending) {
                state.heldVerdict = penalty;
                log("a verdict (" + penalty.type + ", " + penalty.reason + ") while the remembered lap waits for its count: held until it is settled");
            } else {
                judgeVerdict(state, penalty);
            }
        }
    };

    /** What the timing model says right now, for the log: rare, event-driven lines that explain the tag. */
    const timingText = function (state, m) {
        return "lap time " + m.lapMs + " ms, current \"" + m.current + "\", invalid " + m.rawInvalid + ", lap started invalid "
            + state.lapStartedInvalid + ", cut " + state.lapCut + ", pit lap " + state.pitLap + ", location " + (m.location || "?")
            + ", reference " + (m.delta === null ? "none" : "yes");
    };

    /** With no car to read, the line above the bar says nothing: a tag left standing would be another car's, or stale. */
    const renderNoCar = function (state) {
        if (state.invalid !== false) { state.invalid = false; setClass(state.root, CLASS.invalid, false); }

        if (state.pit !== false) { state.pit = false; setClass(state.root, CLASS.pit, false); }

        if (state.hasDriver !== false) { state.hasDriver = false; setClass(state.root, CLASS.hasDriver, false); }

        if (state.topOn !== false) { state.topOn = false; setClass(state.root, CLASS.topOn, false); }

        // the last car's prediction, and its colour, are not this moment's (second review, 2026-09-24)
        if (state.lastPred !== NO_TIME_TEXT) { state.lastPred = NO_TIME_TEXT; state.predTime.textContent = NO_TIME_TEXT; }

        if (state.predState !== PRED_EVEN) {
            state.predState = PRED_EVEN;
            setClass(state.predCell, CLASS.predFaster, false);
            setClass(state.predCell, CLASS.predSlower, false);
        }
    };

    /** Everything on screen, from the state and this frame's model. */
    const draw = function (state, m) {
        ACEUIAppLoader.section("render", function () {
            renderTrend(state);
            renderDelta(state, m.delta);
            renderTrace(state, m.delta, m.npos);
            renderInfo(state, m);
        });
    };

    /** One animation frame: sample the trend, then draw. */
    const tick = function (state, now) {
        const m = state.attract ? attractValues(now, state.rangeMs) : readModel();
        const shouldLog = now - state.lastLog > LOG_EVERY_MS;

        if (!m) {
            resetTrend(state);
            // the bar too: the last car's figure, fill and trend colour left standing read as
            // live (review 2026-09-23); with no car there is no reference, and the trend is flat
            renderTrend(state);
            renderDelta(state, null);
            renderNoCar(state);

            // the lap the widget was following ends here: the car that comes back may be on any
            // lap, so the next frame with one joins its lap afresh, by the remembered record's
            // rules. The state forgets the lap; the store keeps its record for that frame to judge
            if (state.started) {
                state.started = false;
                forgetLap(state);
                state.nextLapInvalid = false;
                state.nextLapReason = "";
                state.heldVerdict = null;
                // the identity too: a count or a car id kept from before would make the one the car
                // comes back with look like a boundary a frame after it joined (a late count on the
                // return frame turned a cut on the new lap into a forgotten one)
                state.lapMs = null;
                state.lapCount = null;
                state.lapClockSeen = false;
                state.boundaryClock = null;
                state.carId = "";
                // until a lap is joined again, a flag found up is taken as found and not as a cut:
                // the lap that flag belongs to is over (fuzzing found the tag painted from the old
                // lap's start on a frame that had the car back but no clock yet, 2026-09-23)
                state.lapStartedInvalid = true;
                log("no car to read: the next frame with one joins its lap afresh");
            }

            if (shouldLog) {
                state.lastLog = now;
                log("ModelCurrentCar not available yet");
            }

            return;
        }

        const firstFrame = !state.started;
        // a new lap: the lap clock going back (by more than a tick), the lap count moving, or another
        // car under focus (a replay, spectating): any one of the three, so a frame that loses the
        // clock cannot let a cut leak onto the lap that follows
        // a lap that has not yet shown a clock has no clock to have gone back from: the boundary was
        // taken by the count on a frame that lacked the field, and the first clock of the new lap would
        // otherwise be read as a second boundary, throwing away everything the new lap had gathered
        const clockWrapped = state.lapClockSeen && m.lapMs !== null && state.lapMs !== null && m.lapMs < state.lapMs - LAP_CLOCK_JITTER_MS
            && (m.lapMs < LAP_CLOCK_LANDING_MS || state.lapMs - m.lapMs > LAP_CLOCK_DROP_MS);
        const countMoved = m.lapCount !== null && state.lapCount !== null && m.lapCount !== state.lapCount;
        const carChanged = m.carId !== "" && state.carId !== "" && m.carId !== state.carId;
        // the count has moved in the same frame as the clock in every boundary measured; should it
        // ever come a frame late, the lap is in its first moments and it is the boundary just seen.
        // The grace is the count's alone: another car under focus is always another lap to follow,
        // and suppressing it would carry one car's cut onto another's lap
        const clockNow = m.lapMs !== null ? m.lapMs : state.lapMs;
        const justStarted = clockNow !== null && clockNow < LAP_START_GRACE_MS;
        // the count moving within the first moments AFTER the clock's boundary is that boundary too:
        // a clock that landed past the grace (a stall over the line) with the count a frame or two
        // behind it would otherwise make a second lap and throw away what the first gathered (fifth
        // pass, 2026-09-23). Measured on the lap clock, as the grace is; a count a frame AHEAD of the
        // clock is still two boundaries (never seen: the two have moved together in every measurement)
        const justWrapped = state.boundaryClock !== null && clockNow !== null && clockNow >= state.boundaryClock
            && clockNow - state.boundaryClock < LAP_START_GRACE_MS;
        const lapWrapped = !firstFrame && (clockWrapped || carChanged || (countMoved && !justStarted && !justWrapped));

        // the first frame waits for a lap clock: the record can only be matched against one, and a
        // frame without it must not be the one that throws the record away. The screen does not
        // wait: what the model gives is drawn (attract switched off with no clock about left the
        // scripted frame standing until the clock came, found by review 2026-09-23)
        if (firstFrame && m.lapMs === null) {
            state.lastFrameAt = now;

            if (shouldLog) {
                state.lastLog = now;
                log("waiting for a lap clock before joining a lap; drawing what the car model gives: " + timingText(state, m));
            }

            if (!ACEUIAppLoader.hudHidden()) { draw(state, m); }

            return;
        }

        state.started = true;

        // the lap's identity first, so whatever is remembered below is filed under this lap; the
        // clock is kept from the last frame that had it, so its coming back smaller is still a wrap
        // what this frame first brings to a lap that did not have it: the count (the block was
        // missing, or the game moved it a frame after the clock), and the clock itself (the boundary
        // was taken by the count alone)
        const countChanged = m.lapCount !== null && m.lapCount !== state.lapCount;
        const clockArrived = !state.lapClockSeen && m.lapMs !== null;

        if (m.lapMs !== null) { state.lapMs = m.lapMs; state.lapClockSeen = true; }

        if (m.lapCount !== null) { state.lapCount = m.lapCount; }

        if (m.carId !== "") { state.carId = m.carId; }

        if (m.sessionKey !== "") { state.sessionKey = m.sessionKey; }

        // the first frame takes the flag as it finds it (a HUD reload mid-lap joins a lap that may
        // be valid); a new lap assumes the flag is up until the first moments show it is not. The
        // raw flag, not the timed one: a lap the game has not started timing can carry the flag
        // too, and a flag found up is a flag found up
        if (firstFrame) {
            state.lapStartedInvalid = m.rawInvalid;
            state.pitLap = m.inPits === true;
            restoreLap(state, m);
            restoreTrace(state, m);
            log("first frame: " + timingText(state, m));
        } else if (lapWrapped) {
            // a boundary before the record waiting for its count was settled: the lap that ended is the one
            // the record was about, never merged, so if it was cut with no verdict yet the debt is taken
            // here, as a refusal takes it (sixth round: the record was forgotten with the debt in it)
            // A debt the record merely carries (not the ended lap's own cut) passes on only if the ended lap never
            // reached the track, as newLap passes one on; the record cannot say so, since it is not written while
            // it waits, so the lap's own trackSeen decides (review, 2026-09-24)
            const pendingRecord = state.restorePending && !carChanged ? me.recall(LAP_KEY, null) : null;
            const pendingDebt = pendingRecord !== null && owesVerdict(pendingRecord, m) && (pendingRecord.cut === true || !state.trackSeen);
            const pendingHidden = pendingRecord !== null && owesHiddenVerdict(pendingRecord, m) && (pendingRecord.hidden === true || !state.trackSeen);
            // a verdict held for the record came before the line: it was the ended lap's, so it pays that lap's debt
            const heldPays = state.heldVerdict !== null;

            state.restorePending = false;
            settleHeldVerdict(state, false);
            state.lapClockSeen = m.lapMs !== null;
            state.boundaryClock = m.lapMs;

            // an invalidation the game announced for our car's next lap is our car's: the lap another
            // car under focus is on is not that lap (fifth pass, 2026-09-23: it was applied to any
            // boundary, and painted a pit-exit lap of the car spectated red with our reason)
            if (carChanged && state.nextLapInvalid) {
                state.nextLapInvalid = false;
                state.nextLapReason = "";
                log("the invalidation announced for the next lap is dropped: another car is under focus");
            }

            newLap(state, carChanged);

            if (pendingDebt && !state.verdictOwed && heldPays) {
                log("the lap that ended while its record waited owed a verdict, and the one held for it paid it");
            } else if (pendingDebt && !state.verdictOwed) {
                state.verdictOwed = true;
                rememberLap(state);
                log("the lap that ended while its record waited, cut with no verdict yet, owes it");
            }

            if (pendingHidden && !state.hiddenOwed) {
                state.hiddenOwed = true;
                rememberLap(state);
                log("the lap that ended while its record waited may have hidden a cut: it owes the weaker debt");
            }
            // assumed up until the first moments show otherwise; when the first frame of the lap is
            // already past those moments (a stall over the line), the flag as found is the lap's start
            // Another car under focus: the timing model may still be the old car's on this frame, so its flag says
            // nothing about the new car's lap, which is taken as flagged from its start (a red missing, never a red
            // wrong: a lagging model showed the old car's clean flag, and the new car's pit exit then rose red;
            // second review, 2026-09-24)
            state.lapStartedInvalid = !carChanged && m.lapMs !== null && m.lapMs >= LAP_START_GRACE_MS ? m.rawInvalid : true;
            log("new lap" + (carChanged ? " (another car under focus)" : (countMoved && !clockWrapped ? " (the lap count moved)" : "")) + ": " + timingText(state, m));
        }

        // the lap's first clock, on a lap the count alone opened: it is already past the first
        // moments, so the flag as found is this lap's start, exactly as for a stall over the line
        if (clockArrived && !firstFrame && !lapWrapped && m.lapMs >= LAP_START_GRACE_MS) {
            state.lapStartedInvalid = m.rawInvalid;
            log("the lap's first clock reads " + m.lapMs + " ms: the flag as found is its start; " + timingText(state, m));
        }

        // a record left waiting for the lap count is judged on the first frame that has it
        if (state.restorePending && !firstFrame && !lapWrapped && m.lapCount !== null) {
            restoreLap(state, m);
            settleHeldVerdict(state, true);
        }

        // the count this lap is filed under, first known or newly moved (the grace let it arrive a
        // frame after the clock), or the lap's own clock arriving after a boundary the count made:
        // whatever the lap holds is filed under them again, so a record stamped at the lap's start
        // does not keep that stamp (which any later frame of any lap would clear) for the whole lap
        if ((countChanged || clockArrived) && !firstFrame && !lapWrapped) { rememberLap(state); }

        // the car on the track: this lap reached it
        if (m.onTrack && !state.trackSeen) {
            state.trackSeen = true;

            // a lap carrying a debt records that it reached the track: a refused record then passes the debt on no further
            if (state.verdictOwed || state.hiddenOwed) { rememberLap(state); }
        }

        // only after the pit lane was seen first this lap (an out-lap past its exit): the flag rising at a pit
        // entry, or the lap before's flag standing across the line, meets the car still reading Track for a
        // frame, and neither hides a cut (the recorded Road Atlanta race lost its out-lap verdict otherwise)
        if (m.onTrack && m.rawInvalid && state.pitLap && !state.pitLate && !state.lapCut && !state.hiddenCut) {
            state.hiddenCut = true;
            // kept in the record, so a reload or a spell without the car cannot lose it (tenth round)
            rememberLap(state);
        }

        // the car in the pit lane: this lap has the pit lane in it, whatever the flag does later
        if (m.inPits === true && !state.pitLap) {
            state.pitLap = true;
            // the car was out on the track earlier this lap and has come in (an in-lap): the flag that
            // rises with the pit lane is the pit entry's and a verdict arriving now is the lap before's.
            // Where the car was, not the clock: a stall over a line that lies inside the pit lane
            // lands the out-lap's first frame past the grace with the car still in the pit lane
            state.pitLate = state.trackSeen;
            rememberLap(state);
            log("in the pit lane: a pit lap; " + timingText(state, m));
        }

        // the raw flag: a lap the game is not timing yet can carry it, and a flag found up is up
        if (m.lapMs !== null && m.lapMs < LAP_START_GRACE_MS && !m.rawInvalid) { state.lapStartedInvalid = false; }

        if (m.rawInvalid !== state.lastRawInvalid) {
            state.lastRawInvalid = m.rawInvalid;
            log("invalid flag changed: " + timingText(state, m));

            // the flag rising on a lap that started clean and has kept to the track, with no notice
            // of its own: an invalidation the game gave no reason for, marked like a cut so it too
            // survives a reload; on a pit lap the rise is the pit exit (or entry) and is nothing
            if (m.invalid && !state.lapStartedInvalid && !state.lapCut && !state.pitLap) {
                markCut(state, "");
            }
        }

        // where the car is, once per change: the pit lane, its exit, the track (four lines per pit visit)
        if (typeof m.location === "string" && m.location !== state.lastLocation) {
            state.lastLocation = m.location;
            log("car location: " + (m.location || "(none)") + "; " + timingText(state, m));
        }

        if (now >= state.nextPenaltyPoll) {
            state.nextPenaltyPoll = now + PENALTY_POLL_MS;
            pollPenaltyState(state, now);
            enableOwnCarModels(state);   // a stock page may have switched the model off meanwhile
        }

        // three numbers that could move every frame once the rule they belong to is live: on
        // change, and no more than once a second, or the game log would take a line per frame
        if ((m.cutGained !== state.lastCutGained || m.cutDeadline !== state.lastCutDeadline || m.cutDelta !== state.lastCutDelta) && now - state.lastCutLogAt >= CHANGE_LOG_MS) {
            state.lastCutGained = m.cutGained;
            state.lastCutDeadline = m.cutDeadline;
            state.lastCutDelta = m.cutDelta;
            state.lastCutLogAt = now;
            log("race-cut fields (gained ms | distance to deadline | current delta): " + m.cutGained + " | " + m.cutDeadline + " | " + m.cutDelta);
        }

        // the lap strings as the game sends them, once per change: what `ideal` means (the best
        // sectors added up, or something else) is read off these lines against the sectors driven
        // compared field by field, so no key is built per frame, and on the same gate as the race-cut
        // fields: what `ideal` means is still unknown, and a rolling value would take a line a frame
        if ((m.best !== state.loggedBest || m.optimal !== state.loggedOptimal || m.last !== state.loggedLast) && now - state.lastLapsLogAt >= CHANGE_LOG_MS) {
            state.loggedBest = m.best;
            state.loggedOptimal = m.optimal;
            state.loggedLast = m.last;
            state.lastLapsLogAt = now;
            log("laps: best \"" + m.best + "\", ideal \"" + m.optimal + "\", last \"" + m.last + "\", at " + timingText(state, m));
        }

        state.lastFrameAt = now;

        // the delta's reference changed mid-lap (another car under comparison): a step in the delta
        // that no driving made, under the jump threshold or not, and the ring is about the old one
        if (m.driver !== state.lastDriver) {
            if (state.lastDriver !== null) { resetTrend(state); }

            state.lastDriver = m.driver;
        }

        if (m.delta === null) {
            resetTrend(state);
        } else {
            // a stall longer than the sampler's gap (alt-tab, a loading hitch): the sampler
            // restarts its clock, and the ring must restart too, or the next rate spans the
            // stall as if it were a second of driving. Measured off the sampler's own clock,
            // as the sampler measures it: off the frame clock a stall a few ms short of the gap
            // restarted the sampler and kept the ring (found by review 2026-09-23)
            if (state.sampler.lastSampleAt !== 0 && now - state.sampler.lastSampleAt > TREND_GAP_MS) { resetRing(state); }

            ACEUIAppLoader.loop.advance(state.sampler, now, function () { pushSample(state, m.delta); });
        }

        // nothing to draw while the HUD is toggled off; the trend keeps sampling
        if (ACEUIAppLoader.hudHidden()) { return; }

        draw(state, m);

        if (shouldLog) {
            state.lastLog = now;
            log("delta ok " + state.lastText + " trend " + state.trend + (m.npos === null ? ", no npos" : "") + "; " + timingText(state, m));
        }
    };

    // ---- lifecycle ---------------------------------------------------------------

    /**
     * Build the widget inside `root`, make it a persistent draggable panel, put the
     * stored options on it and start the frame loop. Returns the state `detach` needs.
     */
    const attach = function (root) {
        // attached twice to one root (the console, a harness): two loops would write the same
        // nodes and the first could never be stopped, so it is stopped here first
        if (current && current.root === root) {
            log("attached again to the same root: the earlier widget is stopped first");
            detach(current);
        }

        const state = create(root);

        // the demo carries across Escape/resume, never across a restart (see ATTRACT_SESSION_KEY)
        state.attract = Boolean(options[SETTING.attract]) && ACEUIAppLoader.persist.readLocal(ATTRACT_SESSION_KEY) === true;

        if (Boolean(options[SETTING.attract]) && !state.attract) {
            settings.set(me.name, SETTING.attract, false);
            log("attract mode was left on from an earlier game session: switched off, so the HUD shows the real lap");
        }
        applyView(state);
        clearTrace(state);
        // the root may carry the markup and classes of an earlier life (the drawer switching the
        // app off and on reuses it): put every per-frame class where the fresh state says it is,
        // or a stale colour stays until that state next changes
        [CLASS.gain, CLASS.lose, CLASS.strong, CLASS.faster, CLASS.slower].forEach(function (name) { setClass(root, name, false); });
        setClass(root, CLASS.flat, true);
        setClass(state.predCell, CLASS.predFaster, false);
        setClass(state.predCell, CLASS.predSlower, false);

        // everything acquired below is released again if any step throws (a root with no
        // parent, a game whose model switch or event hook fails): a half-attached widget would
        // otherwise keep its loop and listeners with no handle left to stop them by
        try {
            state.ui = me.panel(root, function (now) { tick(state, now); });
            state.scaler = me.scale(root, { min: SCALE_MIN, max: SCALE_MAX, step: SCALE_STEP });

            // kept, because attach runs again every time the app drawer switches this app back
            // on: a listener per attach would pile up, each holding a state nobody draws any more
            state.unsubscribeSettings = settings.onChange(me.name, function (key, value) {
                onSetting(state, key, value);
            });

            enableOwnCarModels(state);

            // the game's notifications, for lap invalidations; a plain browser has no engine
            if (window.engine && typeof window.engine.on === "function") {
                state.notifications = window.engine.on(NOTIFICATION_EVENT, function (message) {
                    ACEUIAppLoader.safely(me.prefix + " notification", function () { onNotification(state, message); });
                });
            }
        } catch (e) {
            release(state);
            // as after detach: an engine answer or a notice that still reaches this state is nobody's
            state.detached = true;
            throw e;
        }

        current = state;
        log("widget attached, layout " + (options[SETTING.layout] || LAYOUT_FULL) + ", range " + state.rangeMs + " ms, trend window "
            + state.windowMs + " ms, band " + state.band + " ms/s, faster " + (state.fasterRight ? SIDE_RIGHT : SIDE_LEFT)
            + ", trace " + (state.traceOn ? "on" : "off") + ", scale " + state.scaler.value() + ", attract " + (state.attract ? "on" : "off"));

        return state;
    };

    /** Let go of whatever the state holds: the loop, the notification hook, the scaler, the settings listener. Each only if it was acquired. */
    const release = function (state) {
        if (state.ui) {
            state.ui.stop();
            state.ui = null;
        }

        if (state.notifications && typeof state.notifications.clear === "function") {
            state.notifications.clear();
            state.notifications = null;
        }

        if (state.scaler) {
            state.scaler.stop();
            state.scaler = null;
        }

        if (state.unsubscribeSettings) {
            state.unsubscribeSettings();
            state.unsubscribeSettings = null;
        }
    };

    /** Stop the loop and release the listeners. The DOM is left in place; an engine answer arriving later touches nothing. */
    const detach = function (state) {
        release(state);
        state.detached = true;

        if (current === state) { current = null; }
    };

    return {
        NO_DELTA_MS: NO_DELTA_MS,
        TREND_HZ: TREND_HZ,
        TREND_N: TREND_N,
        TREND_BANDS: TREND_BANDS,
        TREND_WINDOWS: TREND_WINDOWS,
        RANGES: RANGES,
        TRACE_N: TRACE_N,
        JUMP_MS: JUMP_MS,
        LAP_CLOCK_JITTER_MS: LAP_CLOCK_JITTER_MS,
        LAP_CLOCK_LANDING_MS: LAP_CLOCK_LANDING_MS,
        LAP_CLOCK_DROP_MS: LAP_CLOCK_DROP_MS,
        PRED_BAND_MS: PRED_BAND_MS,
        HYSTERESIS: HYSTERESIS,
        TRACE_BACKFILL_MAX: TRACE_BACKFILL_MAX,
        CLASS: CLASS,
        SETTING: SETTING,
        formatDelta: formatDelta,
        formatLap: formatLap,
        parseLap: parseLap,
        readModel: readModel,
        attractValues: attractValues,
        attractDelta: attractDelta,
        attractLap: attractLap,
        create: create,
        applyView: applyView,
        setAttract: setAttract,
        /** Toggle the self-running demo on the live widget from the dev console: BetterDeltaBar.attract(true). */
        attract: function (on) { return current ? setAttract(current, on) : false; },
        pushSample: pushSample,
        trendRate: trendRate,
        REASONS: REASONS,
        PIT_LOCATIONS: PIT_LOCATIONS,
        readPenalty: readPenalty,
        reasonText: reasonText,
        invalidates: invalidates,
        isLapVerdict: isLapVerdict,
        isOwnCar: isOwnCar,
        onNotification: onNotification,
        tick: tick,
        attach: attach,
        detach: detach
    };
}());

/* Attach to #betterdeltabar: the loader creates it in game, the preview page carries it. */
ACEUIAppLoader.app("betterdeltabar").mount(BetterDeltaBar.attach, BetterDeltaBar.detach);
