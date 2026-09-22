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
 * chevron on the side the time is going. Under it, optionally, the predicted lap against
 * the best, and a trace of the delta across the lap so the corner that cost the time is
 * still on the screen at the end of the straight.
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
 *     ModelTiming.best        string "1:43.445", "" when there is none; .invalid the lap flag
 *
 * A positive delta is time lost (slower than the reference), as everywhere in the game.
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
    const LAYOUT_DECIMALS = 4;
    const PERCENT = 100;
    /** Digits of a millisecond fraction, and of a padded seconds field. */
    const MS_DIGITS = 3;
    const TWO_DIGITS = 2;
    /** What a bar that must not show is set to: the stylesheet's own initial transform. */
    const HIDDEN_X = "scaleX(0)";
    const HIDDEN_Y = "scaleY(0)";

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
    const INVALID_TEXT = "INVALID";
    const VS_TEXT = "vs ";
    const PRED_LABEL = "PRED";
    const BEST_LABEL = "BEST";

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

    const WIDTH_NARROW = "narrow";
    const WIDTH_NORMAL = "normal";
    const WIDTH_WIDE = "wide";
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
        /** The line above the bar: who the delta is against, the no-reference note, the invalid tag. */
        top: "bd-top",
        vs: "bd-vs",
        status: "bd-status",
        invalidTag: "bd-invalid-tag",
        bar: "bd-bar",
        fill: "bd-fill",
        left: "bd-left",
        right: "bd-right",
        mid: "bd-mid",
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
        info: "bd-info",
        item: "bd-item",
        pred: "bd-pred",
        best: "bd-best",
        value: "bd-val",
        /** On the root, per frame: the trend, its strength, the overall sign, no reference. */
        gain: "bd-gain",
        lose: "bd-lose",
        flat: "bd-flat",
        strong: "bd-strong",
        faster: "bd-faster",
        slower: "bd-slower",
        noRef: "bd-noref",
        invalid: "bd-invalid",
        hasDriver: "bd-hasdriver",
        /** On the root: whether the top line has anything to show. */
        topOn: "bd-top-on",
        /** On the predicted item: the predicted lap against the best. */
        predFaster: "bd-pred-faster",
        predSlower: "bd-pred-slower",
        /** On the root: what the options hide, and the looks they choose. */
        noArrows: "bd-noarrows",
        noPred: "bd-nopred",
        noBest: "bd-nobest",
        noTrace: "bd-notrace",
        noInvalid: "bd-noinvalid",
        noDriver: "bd-nodriver",
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
        width: "width",
        range: "range",
        decimals: "decimals",
        numberColour: "numberColour",
        barColour: "barColour",
        trendWindow: "trendWindow",
        trendBand: "trendBand",
        arrows: "showArrows",
        pred: "showPredicted",
        best: "showBest",
        trace: "showTrace",
        invalid: "showInvalid",
        driver: "showDriver",
        bg: "background",
        attract: "attract"
    };

    const section = function (key, label, columns, collapsed) {
        return { key: key, type: "section", label: label, columns: columns, collapsed: collapsed };
    };

    const choice = function (key, label, value, options, hint) {
        return { key: key, type: "choice", label: label, value: value, options: options, hint: hint };
    };

    const toggle = function (key, label, value, hint) {
        return { key: key, type: "toggle", label: label, value: value, hint: hint };
    };

    const options = settings.define(me.name, [
        section("layout", "Layout", 1, false),
        me.scaleSpec({ min: SCALE_MIN, max: SCALE_MAX, step: SCALE_STEP }),
        choice(SETTING.width, "Width", WIDTH_NORMAL, [WIDTH_NARROW, WIDTH_NORMAL, WIDTH_WIDE]),
        choice(SETTING.range, "Bar range", RANGE_DEFAULT, Object.keys(RANGES), "the delta that fills the bar, and the trace"),
        choice(SETTING.decimals, "Decimals", DECIMALS_DEFAULT, Object.keys(DECIMALS)),
        section("colour", "Colour", 1, false),
        choice(SETTING.numberColour, "Number colour", COLOUR_TREND, [COLOUR_TREND, COLOUR_OVERALL, COLOUR_WHITE],
            "trend: green while gaining, red while losing, white while steady"),
        choice(SETTING.barColour, "Bar colour", COLOUR_OVERALL, [COLOUR_OVERALL, COLOUR_TREND],
            "overall: green ahead of the reference, red behind"),
        choice(SETTING.trendWindow, "Trend window", TREND_WINDOW_DEFAULT, Object.keys(TREND_WINDOWS), "how far back the trend looks"),
        choice(SETTING.trendBand, "Trend sensitivity", TREND_BAND_DEFAULT, Object.keys(TREND_BANDS), "fine reacts to less"),
        section("show", "Show", 2, false),
        toggle(SETTING.arrows, "Trend chevrons", true),
        toggle(SETTING.trace, "Lap trace", true),
        toggle(SETTING.pred, "Predicted lap", true),
        toggle(SETTING.best, "Best lap", true),
        toggle(SETTING.invalid, "Invalid lap tag", true),
        toggle(SETTING.driver, "Driver name", true, "when the delta is against another driver"),
        section("look", "Look", 2, true),
        choice(SETTING.bg, "Background", BACKGROUND_DARK, [BACKGROUND_DARK, BACKGROUND_LIGHT, BACKGROUND_NONE]),
        section("demo", "Demo", 1, true),
        toggle(SETTING.attract, "Attract mode", false, "a scripted lap, for recording without driving")
    ]);

    /** The option keys that change what is drawn or how, and nothing else. */
    const VIEW_KEYS = [SETTING.width, SETTING.range, SETTING.decimals, SETTING.numberColour, SETTING.barColour,
        SETTING.trendWindow, SETTING.trendBand, SETTING.arrows, SETTING.pred, SETTING.best, SETTING.trace,
        SETTING.invalid, SETTING.driver, SETTING.bg];

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

    /** The game's lap time strings ("1:43.445", "01:43.445", "1:02:03.456") back to ms; null for anything else. */
    const parseLap = function (text) {
        const m = /^(?:(\d+):)?(\d+):(\d+)\.(\d+)$/.exec(text || "");

        if (!m) { return null; }

        return (m[1] ? parseInt(m[1], 10) * S_PER_MIN * MS_PER_MIN : 0) + parseInt(m[2], 10) * MS_PER_MIN + parseInt(m[3], 10) * MS_PER_S
            + parseInt((m[4] + "000").substring(0, MS_DIGITS), 10);
    };

    const scaleXTransform = function (share) {
        return "scaleX(" + share.toFixed(SCALE_DECIMALS) + ")";
    };

    const scaleYTransform = function (share) {
        return "scaleY(" + share.toFixed(SCALE_DECIMALS) + ")";
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

    /** The widget's markup: top line, bar, figure with chevrons, lap trace, predicted and best. */
    const markup = function () {
        return el("div", CLASS.top)
            + el("div", CLASS.vs) + close("div")
            + el("div", CLASS.status) + NO_REFERENCE_TEXT + close("div")
            + el("div", CLASS.invalidTag) + INVALID_TEXT + close("div")
            + close("div")
            + el("div", CLASS.bar)
            + el("div", CLASS.fill + " " + CLASS.left) + close("div")
            + el("div", CLASS.fill + " " + CLASS.right) + close("div")
            + el("div", CLASS.mid) + close("div")
            + close("div")
            + el("div", CLASS.main)
            + el("div", CLASS.arrow + " " + CLASS.arrowLeft) + close("div")
            + el("div", CLASS.delta) + NO_DELTA_TEXTS[DECIMALS_DEFAULT] + close("div")
            + el("div", CLASS.arrow + " " + CLASS.arrowRight) + close("div")
            + close("div")
            + traceMarkup()
            + el("div", CLASS.info)
            + el("div", CLASS.item + " " + CLASS.pred) + PRED_LABEL + el("div", CLASS.value) + NO_TIME_TEXT + close("div") + close("div")
            + el("div", CLASS.item + " " + CLASS.best) + BEST_LABEL + el("div", CLASS.value) + NO_TIME_TEXT + close("div") + close("div")
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
            leftFill: q("." + CLASS.left),
            rightFill: q("." + CLASS.right),
            figure: q("." + CLASS.delta),
            predItem: q("." + CLASS.pred),
            predValue: q("." + CLASS.pred + " ." + CLASS.value),
            bestValue: q("." + CLASS.best + " ." + CLASS.value),
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
            traceOn: true,
            invalidOn: true,
            driverOn: true,
            // per-frame caches: the last thing written, so unchanged values are not rewritten
            lastText: "",
            lastLeft: "",
            lastRight: "",
            lastPred: "",
            lastBestText: null,         // the ModelTiming.best string last parsed
            bestMs: null,
            lastVs: "",
            lastUps: [],
            lastDowns: [],
            sign: 0,                    // the overall sign last put on the root: -1 faster, 0 none, 1 slower
            hasRef: null,               // whether a delta was there last frame (null: never rendered)
            invalid: null,
            hasDriver: null,
            topOn: null,
            predState: 0,               // -1 faster than best, 0 unknown, 1 slower
            traceSlot: -1,              // the last slot written this lap
            lapMs: null,                // the last lap time seen; it going backwards is a new lap
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

        state.rangeMs = RANGES[options[SETTING.range]] || RANGES[RANGE_DEFAULT];
        state.decimals = DECIMALS[decimals] || DECIMALS[DECIMALS_DEFAULT];
        state.noDeltaText = NO_DELTA_TEXTS[decimals] || NO_DELTA_TEXTS[DECIMALS_DEFAULT];
        state.windowMs = windowSeconds(options[SETTING.trendWindow]) * MS_PER_S;
        state.windowSamples = Math.round(windowSeconds(options[SETTING.trendWindow]) * TREND_HZ);
        state.band = TREND_BANDS[options[SETTING.trendBand]] || TREND_BANDS[TREND_BAND_DEFAULT];
        state.traceOn = options[SETTING.trace] !== false;
        state.invalidOn = options[SETTING.invalid] !== false;
        state.driverOn = options[SETTING.driver] !== false;

        setClass(root, CLASS.noArrows, options[SETTING.arrows] === false);
        setClass(root, CLASS.noPred, options[SETTING.pred] === false);
        setClass(root, CLASS.noBest, options[SETTING.best] === false);
        setClass(root, CLASS.noTrace, !state.traceOn);
        setClass(root, CLASS.noInvalid, !state.invalidOn);
        setClass(root, CLASS.noDriver, !state.driverOn);
        setClass(root, CLASS.narrow, options[SETTING.width] === WIDTH_NARROW);
        setClass(root, CLASS.wide, options[SETTING.width] === WIDTH_WIDE);
        setClass(root, CLASS.numOverall, numberColour === COLOUR_OVERALL);
        setClass(root, CLASS.numWhite, numberColour === COLOUR_WHITE);
        setClass(root, CLASS.barTrend, options[SETTING.barColour] === COLOUR_TREND);
        setClass(root, CLASS.bgLight, options[SETTING.bg] === BACKGROUND_LIGHT);
        setClass(root, CLASS.bgNone, options[SETTING.bg] === BACKGROUND_NONE);

        state.lastText = "";
        state.lastLeft = "";
        state.lastRight = "";
        state.lastPred = "";
        state.lastBestText = null;
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
            predicted: deltaOf(car.predicted_lap_time_ms),
            lapMs: deltaOf(car.current_lap_time_ms),
            npos: npos,
            driver: typeof car.delta_time_drivername === "string" ? car.delta_time_drivername : "",
            best: timing && typeof timing.best === "string" ? timing.best : "",
            invalid: Boolean(timing && timing.invalid === true)
        };
    };

    /**
     * Attract mode: a scripted lap for previews and recordings. A short lap so the trace
     * fills quickly; the delta swings both ways so every colour shows: gaining down the
     * straights, losing through three corners, a net gain by the line.
     */
    const ATTRACT_LAP_S = 40;
    const ATTRACT_BEST_MS = 103445;
    const ATTRACT_BEST_TEXT = "1:43.445";
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
            npos: phase,
            driver: "",
            best: ATTRACT_BEST_TEXT,
            invalid: false
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

    /** The bar: the faster half grows left, the slower half right; the figure; the overall sign. */
    const renderDelta = function (state, delta) {
        const hasRef = delta !== null;
        const share = hasRef ? shareOf(state, delta) : 0;
        const left = scaleXTransform(hasRef && delta < 0 ? share : 0);
        const right = scaleXTransform(hasRef && delta > 0 ? share : 0);
        const text = hasRef ? formatDelta(delta, state.decimals) : state.noDeltaText;
        const sign = hasRef && delta !== 0 ? (delta < 0 ? -1 : 1) : 0;

        if (left !== state.lastLeft) {
            state.lastLeft = left;
            state.leftFill.style.transform = left;
        }

        if (right !== state.lastRight) {
            state.lastRight = right;
            state.rightFill.style.transform = right;
        }

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

    /** Predicted lap against the best, the best itself, who the delta is against, the invalid tag, the top line. */
    const renderInfo = function (state, m) {
        const pred = formatLap(m.predicted);
        const hasDriver = state.driverOn && m.driver !== "";
        const invalid = state.invalidOn && m.invalid;
        const topOn = hasDriver || invalid || state.hasRef === false;
        let predState = 0;

        if (m.best !== state.lastBestText) {
            state.lastBestText = m.best;
            state.bestMs = parseLap(m.best);
            state.bestValue.textContent = state.bestMs === null ? NO_TIME_TEXT : m.best;
        }

        if (pred !== state.lastPred) {
            state.lastPred = pred;
            state.predValue.textContent = pred;
        }

        if (m.predicted !== null && state.bestMs !== null && m.predicted !== state.bestMs) {
            predState = m.predicted < state.bestMs ? -1 : 1;
        }

        if (predState !== state.predState) {
            state.predState = predState;
            setClass(state.predItem, CLASS.predFaster, predState < 0);
            setClass(state.predItem, CLASS.predSlower, predState > 0);
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

        if (topOn !== state.topOn) {
            state.topOn = topOn;
            setClass(state.root, CLASS.topOn, topOn);
        }
    };

    /** A new lap started: the trace starts over and so does the trend. */
    const newLap = function (state) {
        clearTrace(state);
        resetTrend(state);
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

        if (state.lapMs !== null && m.lapMs !== null && m.lapMs < state.lapMs) { newLap(state); }

        state.lapMs = m.lapMs;

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
            log("delta ok " + state.lastText + " trend " + state.trend + (m.npos === null ? ", no npos" : ""));
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
        setClass(root, CLASS.flat, true);

        // kept, because attach runs again every time the app drawer switches this app back
        // on: a listener per attach would pile up, each holding a state nobody draws any more
        state.unsubscribeSettings = settings.onChange(me.name, function (key, value) {
            onSetting(state, key, value);
        });
        state.scaler = me.scale(root, { min: SCALE_MIN, max: SCALE_MAX, step: SCALE_STEP });
        state.ui = me.panel(root, function (now) { tick(state, now); });
        current = state;
        log("widget attached, range " + state.rangeMs + " ms, trend window " + state.windowMs + " ms, band " + state.band
            + " ms/s, trace " + (state.traceOn ? "on" : "off") + ", scale " + state.scaler.value() + ", attract " + (state.attract ? "on" : "off"));

        return state;
    };

    /** Stop the loop and release the listeners. The DOM is left in place. */
    const detach = function (state) {
        state.ui.stop();

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
        tick: tick,
        attach: attach,
        detach: detach
    };
}());

/* Attach to #betterdeltabar: the loader creates it in game, the preview page carries it. */
ACEUIAppLoader.app("betterdeltabar").mount(BetterDeltaBar.attach, BetterDeltaBar.detach);
