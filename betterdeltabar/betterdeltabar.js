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
 * of the fill. Either can add a trace of the delta across the lap.
 *
 * Loaded into the stock HUD page by the ACEUIAppLoader (see app.json). It knows nothing
 * of the stock ks-* component framework; it only reads the global model objects the game
 * refreshes every frame and draws into one plain <div>. Styling lives in
 * betterdeltabar.css; this file writes no colours or sizes, only transforms, classes
 * and text.
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
 *     delta_time_ms           int ms, the same delta before the UI rounding; used for the trend
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
 * and past several bands strongly so. Leaving a trend needs the rate to fall to half the
 * band, so the colour does not flicker at the threshold. A jump between two samples
 * bigger than any driving could make (a new lap, a new reference) resets the ring rather
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
    /** A delta or lap time beyond an hour is a sentinel or garbage, not a time. */
    const MAX_TIME_MS = 3600000;
    const MS_PER_S = 1000;
    const MS_PER_MIN = 60000;
    const S_PER_MIN = 60;
    const LOG_EVERY_MS = 60000;
    /** Decimals kept when writing transforms; more only churns strings. */
    const SCALE_DECIMALS = 3;
    const SHIFT_DECIMALS = 2;
    const LAYOUT_DECIMALS = 4;
    const PERCENT = 100;
    /** The fill's end sits at half the bar's width times the share: the tick and the tag move by that. */
    const HALF_PERCENT = 50;
    /** Digits of a millisecond fraction, and of a padded seconds field. */
    const MS_DIGITS = 3;
    const TWO_DIGITS = 2;
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
    const TREND_N = TREND_HZ * TREND_MAX_S;
    /** The window choices, label to seconds. The label is the stored value. */
    const TREND_WINDOWS = { "0.5 s": 0.5, "1 s": 1, "2 s": 2 };
    const TREND_WINDOW_DEFAULT = "1 s";
    /** Dead band choices, label to ms of delta per second. */
    const TREND_BANDS = { fine: 5, normal: 15, coarse: 40 };
    const TREND_BAND_DEFAULT = "normal";
    const STRONG_FACTOR = 5;
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
     * `ModelCurrentCar.car_location`: CarLocation.Type as a string (Unassigned, Pitlane,
     * Pitentry, Pitexit, Track; the stock pit-limiter warning compares it to "Pitlane" and
     * "Pitentry"). These three are the pit lane; anything else says nothing either way.
     */
    const PIT_LOCATIONS = { Pitlane: true, Pitentry: true, Pitexit: true };
    /**
     * What ModelTiming.current reads on the lap out of the pits, before a timed lap has
     * begun. The game flags that lap invalid from the start; the stock lap-time widget hides
     * itself while current reads this (or nothing), so the flag is only shown on a lap that
     * is actually being timed. Same rule here.
     */
    const OUTLAP_TEXT = "Outlap";
    /**
     * The first lap out of the pits is flagged invalid from its first metre, and in a fresh
     * session `current` already reads a running time then, so the text rule above does not
     * catch it. What tells a cut from a pit exit is the flag going up DURING the lap: the
     * flag's state is latched over the first moments of every lap, and the tag shows only
     * when the lap started valid and the flag rose later. The window is short so a cut in
     * the first corner still counts, and long enough for the game to clear the flag at the
     * line, which need not happen in the same frame the lap time resets.
     */
    const LAP_START_GRACE_MS = 500;
    /**
     * The other source, and the decisive one: the game announces a lap invalidation as a UI
     * notification, the same event the stock notification panel draws its top-right box from
     * (`engine.on("UINotification")`, components.js NotificationPanel). A session-penalty
     * message carries `tuples[0].values`: "[{PENALTY_..._KEY} #<car number>", the reason key,
     * the penalty type key]; a track-limits cut in practice came as "{PENALTY_CLEARED_KEY}
     * #666", "InvestigationType_Racecar_Cut", "lblNotificationPenalty_LAP_INVALIDATED"] for a
     * track-limits cut in practice (2026-09-22). The type key is matched exactly and the car
     * number against the focused leaderboard line, so another car's penalty online is not
     * ours. The timing flag alone cannot tell this apart from a pit exit (see above), so this
     * is what makes the tag appear on a first lap.
     */
    const NOTIFICATION_EVENT = "UINotification";
    const PENALTY_NOTIFICATION = "UINotificationType_SessionPenalty";
    /** The penalty type key the game sends for a lap invalidation (measured in game: a track-limits cut, reason InvestigationType_Racecar_Cut). A l10n id, so the same in every language. */
    const LAP_INVALIDATED_TYPE = "lblNotificationPenalty_LAP_INVALIDATED";
    const CAR_NUMBER_MARK = "#";
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
     * The flag is the truth about the lap; the notice is the reason. The game decides per
     * session which penalties also void the lap, and nothing in the notice's type says so
     * for the dozen real penalty types (a drive-through for a collision, say), so a flag
     * rising on a lap driven wholly on the track takes its reason from the last notice for
     * our car within this window, and a notice arriving within it after the flag fills the
     * reason in. Measured: a cut's notice and its flag 19 ms apart, one game tick. The window
     * is many ticks and still far short of anything a driver does twice: a notice in the pit
     * lane cannot name a pit exit (a pit lap's flag is never a cut), and a warning followed
     * by a real cut has the cut's own notice, which always wins.
     */
    const NOTICE_WINDOW_MS = 500;
    /**
     * Diagnostics, kept on because every line is rare and each one has answered a question:
     * the game's penalty-state model (UIPenaltyState: penalties[] of { type, time_penalty,
     * lap_count, is_active }) is in the stock's "disabled" model group -- fetched only when a
     * stock template binds it, which the HUD's never do -- so the widget fetches it itself
     * through the same engine call the stock uses, twice a second, and logs it when it
     * changes. Every notification that is not the car-status kind is logged whole, and the
     * car's location and the low-frequency state's race-cut fields when they change.
     */
    const PENALTY_MODEL_CALL = "getModelUIPenaltyState";
    const PENALTY_POLL_MS = 500;
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
        dragging: "dragging",
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
        scale: "scale",
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
        attract: "attract"
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

    /** The settings window: wide, two controls to a row, hints in one line at the foot for the row under the pointer. */
    const PANE_WIDTH = "36rem";
    const PANE_LAYOUT = { width: PANE_WIDTH, hints: "footer" };

    const options = settings.define(me.name, [
        // the section's key must differ from the layout option's: the store keys both alike
        section("shape", "Layout", 2, false),
        choice(SETTING.layout, "Layout", LAYOUT_FULL, [LAYOUT_FULL, LAYOUT_COMPACT],
            "full: the figure on the bar and the lap times under it; compact: a thin bar with the figure in a tag"),
        choice(SETTING.width, "Width", WIDTH_NORMAL, [WIDTH_NARROW, WIDTH_NORMAL, WIDTH_WIDE]),
        choice(SETTING.side, "Faster side", SIDE_RIGHT, [SIDE_RIGHT, SIDE_LEFT], "which way the bar grows for time gained; the game's own grows right"),
        choice(SETTING.range, "Bar range", RANGE_DEFAULT, Object.keys(RANGES), "the delta that fills the bar, and the trace"),
        choice(SETTING.decimals, "Decimals", DECIMALS_DEFAULT, Object.keys(DECIMALS)),
        me.scaleSpec({ min: SCALE_MIN, max: SCALE_MAX, step: SCALE_STEP }),
        section("colour", "Colour", 2, false),
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
        toggle(SETTING.pred, "Predicted lap", true, "green when it beats the best, red when not", inFull),
        toggle(SETTING.last, "Last lap", false, null, inFull),
        toggle(SETTING.trace, "Lap trace", false, "the delta across the lap, under the bar", inFull),
        toggle(SETTING.follow, "Figure follows the fill", true, "the tag moves with the end of the bar", inCompact),
        section("look", "Look", 2, true),
        choice(SETTING.bg, "Background", BACKGROUND_DARK, [BACKGROUND_DARK, BACKGROUND_LIGHT, BACKGROUND_NONE],
            "full: the panel; compact: the bar and the tag"),
        toggle(SETTING.attract, "Attract mode", false, "a scripted lap, for recording without driving")
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
     * A delta in ms as "-0.235", "+0.24" or "+1:02.345": the sign only when there is one,
     * seconds without padding, minutes only past sixty seconds. Rounded to the decimals
     * shown, so a figure never reads 0.1 while the bar shows time lost.
     */
    const formatDelta = function (ms, decimals) {
        const unit = Math.pow(10, MS_DIGITS - decimals);
        // rounded away from zero on a half, both ways: Math.round alone takes -23.5 to -23
        const rounded = (ms < 0 ? -1 : 1) * Math.round(Math.abs(ms) / unit) * unit;
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

    /** The game's lap time strings ("1:43.445", "01:43.445", "1:02:03.456") back to ms; null for anything else. */
    const parseLap = function (text) {
        const m = /^(?:(\d+):)?(\d+):(\d+)\.(\d+)$/.exec(text || "");

        if (!m) { return null; }

        return (m[1] ? parseInt(m[1], 10) * S_PER_MIN * MS_PER_MIN : 0) + parseInt(m[2], 10) * MS_PER_MIN + parseInt(m[3], 10) * MS_PER_S
            + parseInt((m[4] + "000").substring(0, MS_DIGITS), 10);
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
            + el("div", CLASS.arrow + " " + CLASS.arrowLeft) + close("div")
            + el("div", CLASS.delta) + NO_DELTA_TEXTS[DECIMALS_DEFAULT] + close("div")
            + el("div", CLASS.arrow + " " + CLASS.arrowRight) + close("div")
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
            lastUps: [],
            lastDowns: [],
            sign: 0,                    // the overall sign last put on the root: -1 faster, 0 none, 1 slower
            hasRef: null,               // whether a delta was there last frame (null: never rendered)
            invalid: null,
            pit: null,
            hasDriver: null,
            topOn: null,
            predState: 0,               // -1 faster than best, 0 unknown, 1 slower
            traceSlot: -1,              // the last slot written this lap
            lapMs: null,                // the last lap time seen; it going backwards is a new lap
            lapCount: null,             // the car's lap count last seen, the lap's identity for a remembered cut
            lapStartedInvalid: true,    // the invalid flag was already up when this lap began (a pit exit): not a cut
            lapCut: false,              // this lap is invalidated: the game's notice, or the flag rising on a lap driven wholly on the track
            cutReason: "",              // why, in the game's words, when its notice said ("TRACK LIMITS"); empty for the flag alone
            pitLap: false,              // the car has been in the pit lane during this lap: the flag rising on it is the pit exit, not a cut
            nextLapInvalid: false,      // the game announced the lap that follows invalid (PenaltyType_InvalidNextLap)
            nextLapReason: "",          // and why
            recentNotice: { reason: "", at: 0 },  // the last penalty notice for our car that was not itself an invalidation, and when (frame clock)
            cutAt: 0,                   // when this lap was marked cut (frame clock), for a reason arriving just after
            lastLocation: null,         // the car's location last seen, so a change is logged once
            nextPenaltyPoll: 0,         // frame clock time of the next fetch of the penalty-state model
            penaltyPolling: false,      // a fetch is in flight
            lastPenaltyText: "",        // the penalty-state model as last logged
            lastCutText: "",            // the race-cut fields as last logged
            lastTag: "",                // the invalid tag's text last written
            notifications: null,        // the engine.on handle for the notification event, cleared in detach
            lastRawInvalid: null,       // the game's flag last seen, so a change is logged once
            lastLapsKey: "",            // the three lap strings last logged, so they are logged once per change
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

        state.rangeMs = RANGES[options[SETTING.range]] || RANGES[RANGE_DEFAULT];
        state.decimals = DECIMALS[decimals] || DECIMALS[DECIMALS_DEFAULT];
        state.noDeltaText = NO_DELTA_TEXTS[decimals] || NO_DELTA_TEXTS[DECIMALS_DEFAULT];
        state.windowMs = windowSeconds(options[SETTING.trendWindow]) * MS_PER_S;
        state.windowSamples = Math.round(windowSeconds(options[SETTING.trendWindow]) * TREND_HZ);
        state.band = TREND_BANDS[options[SETTING.trendBand]] || TREND_BANDS[TREND_BAND_DEFAULT];
        state.fasterRight = options[SETTING.side] !== SIDE_LEFT;
        state.followOn = compact && options[SETTING.follow] !== false;
        state.traceOn = options[SETTING.trace] === true;
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
        state.lastUps = [];
        state.lastDowns = [];
        state.hasRef = null;
        state.invalid = null;
        state.hasDriver = null;
        state.topOn = null;
        state.predState = 0;
    };

    /** Turn the self-running demo on or off, and remember it. */
    const setAttract = function (state, on) {
        state.attract = Boolean(on);
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
     * car. The delta is the raw `delta_time_ms` when it is sane (finer than the UI one for
     * the trend) and the UI delta otherwise; either way the UI field's sentinel means none.
     */
    const readModel = function () {
        const car = window.ModelCurrentCar;
        const timing = window.ModelTiming;

        if (!car || car.has_focused_car === false) { return null; }

        let delta = null;
        let npos = null;

        if (typeof car.delta_time_ms_ui === "number" && car.delta_time_ms_ui !== NO_DELTA_MS) {
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
            lapMs: deltaOf(car.current_lap_time_ms),
            lapCount: car.low_frequency && typeof car.low_frequency.total_lap_count === "number" ? car.low_frequency.total_lap_count : null,
            cutFields: car.low_frequency ? [car.low_frequency.race_cut_gained_time_ms, car.low_frequency.distance_to_deadline, car.low_frequency.race_cut_current_delta].join("|") : "",
            npos: npos,
            driver: typeof car.delta_time_drivername === "string" ? car.delta_time_drivername : "",
            location: typeof car.car_location === "string" ? car.car_location : "",
            inPits: typeof car.car_location === "string" && PIT_LOCATIONS[car.car_location] === true,
            current: timeString(timing, "current"),
            best: timeString(timing, "best"),
            optimal: timeString(timing, "ideal"),
            last: timeString(timing, "last"),
            // the outlap is flagged invalid before any lap is timed; only a timed lap's flag is news
            invalid: Boolean(timing && timing.invalid === true) && isTimedLap(timeString(timing, "current")),
            rawInvalid: Boolean(timing && timing.invalid === true)
        };
    };

    /** The focused car's number from the leaderboards, or null when neither says. */
    const ownCarNumber = function () {
        const boards = [window.ModelUIRealtimeLeaderboard, window.ModelLeaderboard];
        let found = null;

        boards.forEach(function (board) {
            const lines = board && Array.isArray(board.lines) ? board.lines : [];

            lines.forEach(function (line) {
                if (found === null && line && line.focused === true && typeof line.car_number === "number") { found = line.car_number; }
            });
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
        const head = String(values[0] || "");
        const at = head.indexOf(CAR_NUMBER_MARK);
        const car = at >= 0 ? parseInt(head.slice(at + 1), 10) : NaN;

        return {
            car: isNaN(car) ? null : car,
            reason: String(values[1] || ""),
            type: String(values[2] || "")
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

        if (!text || text === key) { text = REASONS[key] || key.replace(REASON_PREFIX, "").replace(/_/g, " "); }

        return text.toUpperCase();
    };

    /** Whether a penalty notification is about OUR car: the numbers match, or one side has none to compare (single player, one car). */
    const isOwnCar = function (penalty) {
        const own = ownCarNumber();

        return penalty.car === null || own === null || penalty.car === own;
    };

    /** Which lap a penalty notification for OUR car invalidates: THIS_LAP, NEXT_LAP, or "" for none. */
    const THIS_LAP = "this";
    const NEXT_LAP = "next";
    const invalidates = function (penalty) {
        if (!isOwnCar(penalty)) { return ""; }

        if (penalty.type === LAP_INVALIDATED_TYPE || penalty.type === INVALID_LAP_TYPE) { return THIS_LAP; }

        return penalty.type === INVALID_NEXT_LAP_TYPE ? NEXT_LAP : "";
    };

    /**
     * Attract mode: a scripted lap for previews and recordings. A short lap so the trace
     * fills quickly; the delta swings both ways so every colour shows: gaining down the
     * straights, losing through three corners, a net gain by the line.
     */
    const ATTRACT_LAP_S = 40;
    const ATTRACT_BEST_MS = 103445;
    const ATTRACT_BEST_TEXT = "1:43.445";
    const ATTRACT_OPTIMAL_TEXT = "1:43.102";
    const ATTRACT_LAST_TEXT = "1:43.987";
    /** Corners in the scripted lap: where (share of the lap), how long, and the time each costs (ms). */
    const ATTRACT_CORNERS = [
        { at: 0.18, width: 0.08, cost: 420 },
        { at: 0.52, width: 0.06, cost: 260 },
        { at: 0.8, width: 0.1, cost: 380 }
    ];
    /** Time gained per lap on the straights, ms, spread evenly. */
    const ATTRACT_GAIN_MS = 1250;
    const TWO_PI = 2 * Math.PI;

    /** A smooth 0->1 step from `from` to `to`. */
    const smoothStep = function (x, from, to) {
        const k = Math.max(0, Math.min(1, (x - from) / (to - from)));

        return k * k * (3 - 2 * k);
    };

    /** The scripted delta at lap share `phase` (0..1): a continuous function, no state. */
    const attractDelta = function (phase) {
        let delta = -ATTRACT_GAIN_MS * phase;

        ATTRACT_CORNERS.forEach(function (corner) {
            delta += corner.cost * smoothStep(phase, corner.at, corner.at + corner.width);
        });

        // a little ripple, so the trend is never perfectly flat for long
        return delta + 25 * Math.sin(phase * TWO_PI * 9);
    };

    const attractValues = function (now) {
        const lapS = (now / MS_PER_S) % ATTRACT_LAP_S;
        const phase = lapS / ATTRACT_LAP_S;
        const delta = Math.round(attractDelta(phase));

        return {
            delta: delta,
            predicted: ATTRACT_BEST_MS + Math.round(attractDelta(1) * phase + delta * (1 - phase)),
            lapMs: Math.round(lapS * MS_PER_S),
            lapCount: Math.floor(now / (ATTRACT_LAP_S * MS_PER_S)),
            npos: phase,
            cutFields: "",
            driver: "",
            current: formatLap(lapS * MS_PER_S),
            best: ATTRACT_BEST_TEXT,
            optimal: ATTRACT_OPTIMAL_TEXT,
            last: ATTRACT_LAST_TEXT,
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

    /** The trend the rate means, given the trend we are in (leaving one needs less rate than entering). */
    const classify = function (state, rate) {
        if (rate === null) { return TREND_FLAT; }

        const leave = state.trend === TREND_FLAT ? state.band : state.band * HYSTERESIS;

        if (Math.abs(rate) < leave) { return TREND_FLAT; }

        return rate < 0 ? TREND_GAIN : TREND_LOSE;
    };

    /** The trend's classes on the root, written only when they change. */
    const renderTrend = function (state) {
        const rate = trendRate(state);
        const trend = classify(state, rate);
        const strong = trend !== TREND_FLAT && Math.abs(rate) >= state.band * STRONG_FACTOR;

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
        const share = hasRef ? shareOf(state, delta) : 0;
        const sign = hasRef && delta !== 0 ? (delta < 0 ? -1 : 1) : 0;
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
        }

        if (sign !== state.sign) {
            state.sign = sign;
            setClass(state.root, CLASS.faster, sign < 0);
            setClass(state.root, CLASS.slower, sign > 0);
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
        });
        state.traceSlot = -1;
    };

    /** Write one slot of the trace: up for time gained, down for time lost. */
    const writeSlot = function (state, slot, delta) {
        const share = shareOf(state, delta);
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

    /**
     * The lap trace: the slot under the car takes the current delta, and any slots skipped
     * since the last frame take it too, so a slow frame leaves no gap. The position wrapping
     * back to the start is a new lap.
     */
    const renderTrace = function (state, delta, npos) {
        if (!state.traceOn || npos === null) { return; }

        const slot = Math.min(TRACE_N - 1, Math.floor(npos * TRACE_N));
        let from = slot;

        if (state.traceSlot >= 0 && slot < state.traceSlot - TRACE_WRAP_SLOTS) { clearTrace(state); }

        if (delta === null) { return; }

        if (state.traceSlot >= 0 && slot > state.traceSlot) { from = state.traceSlot + 1; }

        while (from <= slot) {
            writeSlot(state, from, delta);
            from += 1;
        }

        state.traceSlot = slot;
    };

    /** The lap-time cells, who the delta is against, the invalid tag, the top line. */
    const renderInfo = function (state, m) {
        const pred = formatLap(m.predicted);
        // shown whenever the game names a driver, as the stock bar does; there is no switch, since
        // the field is empty in every mode measured so far and a switch for it did nothing visible
        const hasDriver = m.driver !== "";
        // INVALID: the game said so (a notification), or the flag rose during a lap that started
        // valid and kept to the track. Otherwise a lap the pit lane is part of gets the quiet
        // tag: PIT LANE while in it, OUTLAP once out with the flag still up. A lap flagged from
        // its start with no notification and no location to go by is a pit exit too, unnamed.
        const invalid = state.invalidOn && (state.lapCut || (m.invalid && !state.lapStartedInvalid && !state.pitLap));
        const pit = state.invalidOn && !invalid && (m.inPits === true || (m.rawInvalid && state.pitLap));
        const topOn = hasDriver || invalid || pit || state.hasRef === false;
        let predState = 0;

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

        if (m.predicted !== null && state.bestMs !== null && m.predicted !== state.bestMs) {
            predState = m.predicted < state.bestMs ? -1 : 1;
        }

        if (predState !== state.predState) {
            state.predState = predState;
            setClass(state.predCell, CLASS.predFaster, predState < 0);
            setClass(state.predCell, CLASS.predSlower, predState > 0);
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

            if (invalid) {
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

    /** What is known about the lap under way, kept through the HUD reload (LAP_KEY); nothing known, nothing kept. */
    const rememberLap = function (state) {
        if (!state.lapCut && !state.pitLap && !state.nextLapInvalid) {
            me.forget(LAP_KEY);

            return;
        }

        me.remember(LAP_KEY, {
            lap: state.lapCount,
            at: state.lapMs,
            cut: state.lapCut,
            reason: state.cutReason,
            pit: state.pitLap,
            next: state.nextLapInvalid,
            nextReason: state.nextLapReason
        });
    };

    /**
     * A new lap started: the trace starts over, so does the trend, the cut and the pit-lane
     * visit are forgotten, and an invalidation the game announced for this lap takes effect.
     */
    const newLap = function (state) {
        clearTrace(state);
        resetTrend(state);
        state.lapCut = false;
        state.cutReason = "";
        state.pitLap = false;
        // a reason belongs to the lap its notice came on
        state.recentNotice = { reason: "", at: 0 };

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
     * What was remembered before a HUD reload, if it belongs to the lap now running. The lap
     * time must not have gone backwards since (a lap's clock only runs forward; a new
     * session's first lap starts from zero, so a record kept from the last session does not
     * match it), and when the game gives a lap count it must be the same lap. With no lap
     * count, the flag must still be up as well.
     */
    const restoreLap = function (state, m) {
        const kept = me.recall(LAP_KEY, null);
        let same = false;

        if (kept && typeof kept === "object" && typeof kept.at === "number" && m.lapMs !== null && m.lapMs >= kept.at) {
            same = typeof kept.lap === "number" && m.lapCount !== null ? kept.lap === m.lapCount : m.rawInvalid;
        }

        // a cut lap that never saw the pit lane cannot be found in the pit lane after a reload
        // without a teleport (a reset to the pits): that lap is over, whatever the clock says
        if (same && kept.cut === true && kept.pit !== true && m.inPits === true) {
            same = false;
            log("the cut lap remembered from before the reload is over: the car is back in the pit lane");
        }

        if (same) {
            state.lapCut = kept.cut === true;
            state.cutReason = state.lapCut && typeof kept.reason === "string" ? kept.reason : "";
            state.pitLap = state.pitLap || kept.pit === true;
            state.nextLapInvalid = kept.next === true;
            state.nextLapReason = state.nextLapInvalid && typeof kept.nextReason === "string" ? kept.nextReason : "";
            log("remembered from before the reload, still this lap: cut " + state.lapCut + (state.cutReason ? " (" + state.cutReason + ")" : "")
                + ", pit lap " + state.pitLap + (state.nextLapInvalid ? ", the next lap invalid" + (state.nextLapReason ? " (" + state.nextLapReason + ")" : "") : ""));
        }

        // written back either way: a stale record goes, the pit lane seen this frame stays
        rememberLap(state);
    };

    /**
     * Fetch the penalty-state model the stock never asks for, and log it when it changes.
     * The engine answers with a promise; a page without an engine (the preview) has none
     * of this. Only one fetch is in flight at a time.
     */
    const pollPenaltyState = function (state) {
        if (state.penaltyPolling || !window.engine || typeof window.engine.call !== "function") { return; }

        state.penaltyPolling = true;

        ACEUIAppLoader.safely(me.prefix + " penalty state", function () {
            const answer = window.engine.call(PENALTY_MODEL_CALL);

            if (!answer || typeof answer.then !== "function") {
                state.penaltyPolling = false;

                return;
            }

            answer.then(function (model) {
                const text = ACEUIAppLoader.console.format(model);

                state.penaltyPolling = false;

                if (text !== state.lastPenaltyText) {
                    state.lastPenaltyText = text;
                    log("penalty state: " + text);
                }
            }, function (e) {
                state.penaltyPolling = false;
                log("penalty state: not available (" + ACEUIAppLoader.errorText(e) + ")");
            });
        });
    };

    /** A UI notification from the game: a lap invalidation for our car marks this lap cut. */
    const onNotification = function (state, message) {
        const penalty = readPenalty(message);

        // everything but the car-status notices (which come in bursts), whole, for the record
        if (message && message.type !== CAR_NOTIFICATION) { log("notification: " + ACEUIAppLoader.console.format(message)); }

        if (!penalty) { return; }

        const which = invalidates(penalty);

        log("penalty notification: car " + penalty.car + ", type " + penalty.type + ", reason " + penalty.reason
            + (which === THIS_LAP ? ": our lap invalidated" : (which === NEXT_LAP ? ": our next lap invalidated" : ": not ours, or not an invalidation")));

        if (which === THIS_LAP) { markCut(state, reasonText(penalty.reason)); }

        if (which === NEXT_LAP) {
            state.nextLapInvalid = true;
            state.nextLapReason = reasonText(penalty.reason);
            rememberLap(state);
        }

        // any other notice for our car: the reason for a flag that rose just before, or rises just after
        if (which === "" && isOwnCar(penalty)) {
            state.recentNotice = { reason: reasonText(penalty.reason), at: state.lastFrameAt };

            if (state.lapCut && state.cutReason === "" && state.recentNotice.reason !== "" && state.lastFrameAt - state.cutAt <= NOTICE_WINDOW_MS) {
                state.cutReason = state.recentNotice.reason;
                rememberLap(state);
                log("the reason arrived after the flag: " + state.cutReason);
            }
        }
    };

    /** What the timing model says right now, for the log: rare, event-driven lines that explain the tag. */
    const timingText = function (state, m) {
        return "lap time " + m.lapMs + " ms, current \"" + m.current + "\", invalid " + m.rawInvalid + ", lap started invalid "
            + state.lapStartedInvalid + ", cut " + state.lapCut + ", pit lap " + state.pitLap + ", location " + (m.location || "?")
            + ", reference " + (m.delta === null ? "none" : "yes");
    };

    /** One animation frame: sample the trend, then draw. */
    const tick = function (state, now) {
        const m = state.attract ? attractValues(now) : readModel();
        const shouldLog = now - state.lastLog > LOG_EVERY_MS;

        if (!m) {
            resetTrend(state);

            if (shouldLog) {
                state.lastLog = now;
                log("ModelCurrentCar not available yet");
            }

            return;
        }

        const firstFrame = state.lapMs === null;
        const lapWrapped = !firstFrame && m.lapMs !== null && m.lapMs < state.lapMs;

        // the lap's identity first, so whatever is remembered below is filed under this lap
        state.lapMs = m.lapMs;
        state.lapCount = m.lapCount;

        // the first frame takes the flag as it finds it (a HUD reload mid-lap joins a lap that may
        // be valid); a new lap assumes the flag is up until the first moments show it is not
        if (firstFrame) {
            state.lapStartedInvalid = m.invalid;
            state.pitLap = m.inPits === true;
            restoreLap(state, m);
            log("first frame: " + timingText(state, m));
        } else if (lapWrapped) {
            newLap(state);
            state.lapStartedInvalid = true;
            log("new lap: " + timingText(state, m));
        }

        // the car in the pit lane: this lap has the pit lane in it, whatever the flag does later
        if (m.inPits === true && !state.pitLap) {
            state.pitLap = true;
            rememberLap(state);
            log("in the pit lane: a pit lap; " + timingText(state, m));
        }

        if (m.lapMs !== null && m.lapMs < LAP_START_GRACE_MS && !m.invalid) { state.lapStartedInvalid = false; }

        if (m.rawInvalid !== state.lastRawInvalid) {
            state.lastRawInvalid = m.rawInvalid;
            log("invalid flag changed: " + timingText(state, m));

            // the flag rising on a lap that started clean and has kept to the track, with no notice
            // of its own: an invalidation the game gave no reason for, marked like a cut so it too
            // survives a reload; on a pit lap the rise is the pit exit (or entry) and is nothing
            if (m.invalid && !state.lapStartedInvalid && !state.lapCut && !state.pitLap) {
                markCut(state, now - state.recentNotice.at <= NOTICE_WINDOW_MS ? state.recentNotice.reason : "");
            }
        }

        // where the car is, once per change: the pit lane, its exit, the track (four lines per pit visit)
        if (typeof m.location === "string" && m.location !== state.lastLocation) {
            state.lastLocation = m.location;
            log("car location: " + (m.location || "(none)") + "; " + timingText(state, m));
        }

        if (now >= state.nextPenaltyPoll) {
            state.nextPenaltyPoll = now + PENALTY_POLL_MS;
            pollPenaltyState(state);
        }

        if (m.cutFields !== state.lastCutText) {
            state.lastCutText = m.cutFields;
            log("race-cut fields (gained ms | distance to deadline | current delta): " + m.cutFields);
        }

        // the lap strings as the game sends them, once per change: what `ideal` means (the best
        // sectors added up, or something else) is read off these lines against the sectors driven
        if (m.best + "|" + m.optimal + "|" + m.last !== state.lastLapsKey) {
            state.lastLapsKey = m.best + "|" + m.optimal + "|" + m.last;
            log("laps: best \"" + m.best + "\", ideal \"" + m.optimal + "\", last \"" + m.last + "\", at " + timingText(state, m));
        }

        // a stall longer than the sampler's gap (alt-tab, a loading hitch): the sampler restarts
        // its clock, and the ring must restart too, or the next rate spans the stall as if it
        // were a second of driving
        if (state.lastFrameAt !== 0 && now - state.lastFrameAt > TREND_GAP_MS) { resetRing(state); }

        state.lastFrameAt = now;

        if (m.delta === null) {
            resetTrend(state);
        } else {
            ACEUIAppLoader.loop.advance(state.sampler, now, function () { pushSample(state, m.delta); });
        }

        // nothing to draw while the HUD is toggled off; the trend keeps sampling
        if (ACEUIAppLoader.hudHidden()) { return; }

        ACEUIAppLoader.section("render", function () {
            renderTrend(state);
            renderDelta(state, m.delta);
            renderTrace(state, m.delta, m.npos);
            renderInfo(state, m);
        });

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
        const state = create(root);

        state.attract = Boolean(options[SETTING.attract]);
        applyView(state);
        clearTrace(state);
        // the root may carry the markup and classes of an earlier life (the drawer switching the
        // app off and on reuses it): put every per-frame class where the fresh state says it is,
        // or a stale colour stays until that state next changes
        [CLASS.gain, CLASS.lose, CLASS.strong, CLASS.faster, CLASS.slower].forEach(function (name) { setClass(root, name, false); });
        setClass(root, CLASS.flat, true);
        setClass(state.predCell, CLASS.predFaster, false);
        setClass(state.predCell, CLASS.predSlower, false);

        // kept, because attach runs again every time the app drawer switches this app back
        // on: a listener per attach would pile up, each holding a state nobody draws any more
        state.unsubscribeSettings = settings.onChange(me.name, function (key, value) {
            onSetting(state, key, value);
        });
        state.scaler = me.scale(root, { min: SCALE_MIN, max: SCALE_MAX, step: SCALE_STEP });
        state.ui = me.panel(root, function (now) { tick(state, now); });

        // the game's notifications, for lap invalidations; a plain browser has no engine
        if (window.engine && typeof window.engine.on === "function") {
            state.notifications = window.engine.on(NOTIFICATION_EVENT, function (message) {
                ACEUIAppLoader.safely(me.prefix + " notification", function () { onNotification(state, message); });
            });
        }

        current = state;
        log("widget attached, layout " + (options[SETTING.layout] || LAYOUT_FULL) + ", range " + state.rangeMs + " ms, trend window "
            + state.windowMs + " ms, band " + state.band + " ms/s, faster " + (state.fasterRight ? SIDE_RIGHT : SIDE_LEFT)
            + ", trace " + (state.traceOn ? "on" : "off") + ", scale " + state.scaler.value() + ", attract " + (state.attract ? "on" : "off"));

        return state;
    };

    /** Stop the loop and release the listeners. The DOM is left in place. */
    const detach = function (state) {
        state.ui.stop();

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
        CLASS: CLASS,
        SETTING: SETTING,
        formatDelta: formatDelta,
        formatLap: formatLap,
        parseLap: parseLap,
        readModel: readModel,
        attractValues: attractValues,
        attractDelta: attractDelta,
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
        onNotification: onNotification,
        tick: tick,
        attach: attach,
        detach: detach
    };
}());

/* Attach to #betterdeltabar: the loader creates it in game, the preview page carries it. */
ACEUIAppLoader.app("betterdeltabar").mount(BetterDeltaBar.attach, BetterDeltaBar.detach);
