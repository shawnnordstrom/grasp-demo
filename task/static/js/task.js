/*
 * task.js -- soft-object experiment: three tasks on one skeleton
 *
 *   grasp   pick up each of the 12 objects (3 shapes x slouch/soft/middle/hard), one try each
 *   judge   pick up each of 9 objects (soft/middle/hard), then match-to-sample: which of A / B is
 *           the same material
 *   watch   match-to-sample only, no grasping
 *
 * Same shape as cloth-psiturk's task.js: page constants up top, a preloaded `pages` list,
 * then InstructionRunner -> Quiz -> Experiment, each a function constructor that drives
 * psiTurk.showPage and hands off by callback. The task is chosen by the page that loads this
 * file (window.TASK, or ?task= on the static site).
 *
 * Every stimulus is one <iframe> running static/viewer/index.html (a fresh document per
 * object; the viewer holds a lot of module-scope state and reloading is the cheapest clean
 * slate). A grasp object is settle (prerecorded) -> place fingers -> lift (simulated live on
 * AWS, logged server-side by aws/lambda_fn/attempt.py). A match screen is three viewers
 * playing prerecorded falls (sample on the flat floor, match and foil on one uneven floor).
 *
 * The viewer reports back over postMessage:
 *   loaded          the object is ready (watch viewers then wait for {type:'play'})
 *   ready_to_place  settle finished; the participant may click the object
 *   go              participant committed; the sim request goes out
 *   grasp_done      maneuver finished playing -- carries outcome, clicks, lattice sites
 *   sim_error       the sim request failed; the viewer lets the participant press GO again
 *   played          a watch viewer finished its first full fall
 *   error           the object could not load
 *
 * Two ways to run it:
 *   psiTurk   exp.html (psiturk.js, its own ad + consent routes, data saved to its database)
 *   static    experiment.html?task=... (psiturk_stub.js; GitHub Pages / Prolific). Shows
 *             consent.html first and complete.html last itself. Grasps are logged by the sim
 *             server; the recorded rows stay in the page (data button in test mode).
 */

/* global $, psiTurk, condition, isMobileTablet */

// ---- element ids, as in cloth-psiturk -------------------------------------
var FULL_CONTAINER = "full-container";
var TRIALFRAME     = "trialframe";
var TRIAL_INST     = "qspan";
var NEXTBUTTON     = "nextbutton";
var PROGRESS       = "progress";

// ---- experiment parameters ------------------------------------------------
var Q = new URLSearchParams(window.location.search);
var STATIC_SITE = !!window.STATIC_SITE;
var TASK = window.TASK || Q.get("task") || "grasp";
if (["grasp", "judge", "watch"].indexOf(TASK) < 0) TASK = "grasp";
var DATA_BASE = "../data";       // blobs + web_config.json, relative to the viewer document
var VIEWER = "static/viewer/index.html";
var N_CONDITIONS = 6;            // condlist_<task>_<k>.json, k = 0..N-1
var PRACTICE_RUN = "blob_demo";
var STIM_PREFIX = "blob_stim_";  // + <shape>_<material>: recorded until the object comes to rest
var GRIP = Q.get("grip");        // null = the viewer's default (0.5); the slider is hidden
var SHOW_GRIP = Q.get("showgrip") === "1";
// The sim: an explicit ?api= wins; a local preview server (localhost) proxies /simulate* on its
// own origin; anywhere else (GitHub Pages, a psiTurk server) uses the deployed Lambda.
var SIM_API = Q.has("api") ? Q.get("api")
            : (/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname) ? window.location.origin : null);

// who: Prolific participant, else ?who= (testing), else the psiTurk id
var PID = Q.get("PROLIFIC_PID");
var MODE = PID ? "participant" : "test";
var WHO = PID || Q.get("who") || (typeof uniqueId !== "undefined" ? uniqueId : null);
var SESSION = Q.get("SESSION_ID") || Math.random().toString(36).slice(2, 14);

function hashString(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}
// psiturk provides `condition`; the static site derives it from the participant
var CONDITION = Q.has("condition") ? parseInt(Q.get("condition"), 10)
              : (STATIC_SITE ? hashString(WHO || SESSION) % N_CONDITIONS
                             : ((typeof condition !== "undefined") ? condition : 0));

var INSTRUCT_SEQ = {
    grasp: ["instructions_grasp/instruct-1.html", "instructions_grasp/instruct-2.html",
            "instructions_grasp/instruct-3.html"],
    judge: ["instructions_judge/instruct-1.html", "instructions_judge/instruct-2.html",
            "instructions_judge/instruct-3.html", "instructions_judge/instruct-4.html"],
    watch: ["instructions_watch/instruct-1.html", "instructions_watch/instruct-2.html"],
}[TASK];
var QUIZ_PAGE = "quiz_" + TASK + ".html";
var QUIZ_ANSWERS = { trueFalse1: "c", trueFalse2: "a" };    // same keys in all three quizzes

// ---- all pages to be loaded ----------------------------------------------
var pages = ["instructions_" + TASK + "/instructions.html"].concat(INSTRUCT_SEQ,
    [QUIZ_PAGE, "ready.html", "stage.html", "stage_match.html", "postquestionnaire.html"]);
if (STATIC_SITE) pages.push("consent.html", "complete.html");
psiTurk.preloadPages(pages);

psiTurk.recordUnstructuredData && psiTurk.recordUnstructuredData("session_info", {
    task: TASK, condition: CONDITION, mode: MODE, participant: WHO, session: SESSION,
    study: Q.get("STUDY_ID"), static_site: STATIC_SITE, screen: [window.innerWidth, window.innerHeight],
});


/********************
 * VIEWER FRAMES    *
 ********************/
function viewerURL(p) {
    var u = new URLSearchParams({ base: DATA_BASE, mode: MODE, session: SESSION });
    if (WHO) u.set("pid", WHO);
    if (SIM_API !== null) u.set("api", SIM_API);
    if (GRIP !== null) u.set("grip", GRIP);
    if (SHOW_GRIP) u.set("showgrip", "1");
    $.each(p, function(k, v) { u.set(k, v); });
    return VIEWER + "?" + u.toString();
}

// one listener for every viewer; messages are routed by the iframe they come from
var frameHandlers = [];
window.addEventListener("message", function(ev) {
    for (var i = 0; i < frameHandlers.length; i++) {
        var h = frameHandlers[i];
        if (h.frame.contentWindow === ev.source) { h.fn(ev.data || {}); return; }
    }
});
function loadFrame(frame, src, fn) {
    frameHandlers = frameHandlers.filter(function(h) { return h.frame !== frame && document.body.contains(h.frame); });
    frameHandlers.push({ frame: frame, fn: fn });
    frame.src = src;
}

// warm the HTTP cache for the next screen; the body must be read, or Chrome holds the cache
// entry and the viewer's own fetch of the same file waits on it forever
function prefetch(runs) {
    runs.forEach(function(r) {
        fetch("static/data/" + r + ".json").then(function(res) { return res.json(); })
            .then(function(m) { return fetch("static/data/" + m.bin).then(function(b) { return b.arrayBuffer(); }); })
            .catch(function() {});
    });
}


/********************
 * CONSENT (static) *
 ********************/
// Under psiTurk, consent.html is its own route before exp.html. The static site shows the
// same page first and continues on "I agree".
var Consent = function(onDone) {
    if (!STATIC_SITE || Q.get("skip") === "1") { onDone(); return; }
    psiTurk.showPage("consent.html");
    $("button.btn-primary").attr("onclick", null).off("click").click(function() { onDone(); });
    $("button.btn-danger").attr("onclick", null).off("click").click(function() {
        $("body").html("<p style='margin:40px'>You chose not to take part. You can close this window.</p>");
    });
};


/********************
 * INSTRUCTIONS     *
 ********************/
var InstructionRunner = function(onDone) {
    if (Q.get("skip") === "1") { onDone(); return; }
    var i = -1;   // -1 = the instructions.html splash

    var step = function() {
        if (i < 0) {
            psiTurk.showPage("instructions_" + TASK + "/instructions.html");
        } else if (i < INSTRUCT_SEQ.length) {
            psiTurk.showPage(INSTRUCT_SEQ[i]);
        } else {
            Quiz(onDone);
            return;
        }
        i += 1;
        $("#" + NEXTBUTTON).click(step);
    };

    step();
};


/********************
 * QUIZ             *
 ********************/
// Wrong answers send the participant back to the start of the instructions,
// as in cloth-psiturk.
var Quiz = function(onDone) {
    psiTurk.showPage(QUIZ_PAGE);

    $("#" + NEXTBUTTON).click(function() {
        var allRight = true;
        $.each(QUIZ_ANSWERS, function(id, want) {
            var got = $("#" + id).val();
            psiTurk.recordTrialData({
                phase: "INSTRUCTQUIZ",
                question: id,
                answer: got,
                IsInstruction: true,
            });
            if (got !== want) allRight = false;
        });

        if (allRight) {
            onDone();
        } else {
            alert("At least one answer was incorrect. "
                + "Please read the instructions again.");
            InstructionRunner(onDone);
        }
    });
};


/********************
 * GRASP SCREEN     *
 ********************/
// One object on stage.html. Calls onDone(row) after the maneuver has played. practice:
// feedback after each try and as many tries as wanted.
var GraspScreen = function(opts, onDone) {
    psiTurk.showPage("stage.html");
    $("#" + FULL_CONTAINER).removeClass("hide_elements");
    $("#" + PROGRESS).html(opts.progress);
    var frame = document.getElementById(TRIALFRAME);
    var next = $("#" + NEXTBUTTON).prop("disabled", true);
    var tries = 0, last = null, t0 = Date.now();

    function setPrompt(text) { $("#" + TRIAL_INST).html(text); }

    function mount() {
        next.prop("disabled", true);
        setPrompt("Watch the object settle&hellip;");
        loadFrame(frame, viewerURL({ kind: "grasp", run: opts.run, trial: opts.trialId, page: "psiturk-" + TASK,
                                     feedback: opts.practice ? "simple" : (Q.get("feedback") === "1" ? "full" : "none"),
                                     attempt0: tries }),
            function(m) {
                switch (m.type) {
                case "ready_to_place": setPrompt("Click the object to place your fingers, then press GO."); break;
                case "go":             setPrompt("Lifting&hellip;"); break;
                case "sim_error":      setPrompt("Connection problem. Press GO to try again."); break;
                case "error":
                    last = { error: "could not load" };
                    setPrompt("This object could not load. Press Next to continue.");
                    next.prop("disabled", false);
                    break;
                case "grasp_done":
                    tries += 1; last = m;
                    next.prop("disabled", false);
                    if (opts.practice) {
                        setPrompt("Press Next to continue, or <a href='#' id='again'>try again</a>.");
                        $("#again").click(function(e) { e.preventDefault(); mount(); });
                    } else {
                        setPrompt(opts.after || "Press Next to continue.");
                    }
                    break;
                }
            });
    }

    next.click(function() {
        var m = last || {};
        onDone({
            run: opts.run, tries: tries, screen_ms: Date.now() - t0,
            n_fingers: m.n_fingers, probes_ijk: m.probes, clicks: m.clicks, grip: m.grip,
            outcome: m.outcome || null, logged: m.logged || null, error: m.error,
        });
    });
    mount();
};


/********************
 * MATCH SCREEN     *
 ********************/
// stage_match.html: sample (blob_stim_ recording, flat floor) on top, match and foil (same uneven
// floor) as A / B. The three falls start together and play once; the answer unlocks once all
// have played. Replay restarts all three together (counted).
var MatchScreen = function(item, progress, onDone) {
    psiTurk.showPage("stage_match.html");
    $("#" + FULL_CONTAINER).removeClass("hide_elements");
    $("#" + PROGRESS).html(progress);
    $("#" + TRIAL_INST).html("Loading&hellip;");
    var runs = { S: STIM_PREFIX + item.cell,
                 match: "mts_" + item.cell + "_" + item.floor + "_match",
                 foil: "mts_" + item.cell + "_" + item.floor + "_" + item.foil };
    var sides = item.match_side === "A" ? { A: "match", B: "foil" } : { A: "foil", B: "match" };
    var frames = { S: runs.S, A: runs[sides.A], B: runs[sides.B] };
    var loaded = {}, played = {}, tEnabled = null, replays = 0;
    var next = $("#" + NEXTBUTTON).prop("disabled", true);
    var replay = $("#replaybutton").prop("disabled", true);

    function playAll() {
        played = {};
        replay.prop("disabled", true);
        $.each(frames, function(k) {
            document.getElementById("frame" + k).contentWindow.postMessage({ type: "play" }, "*");
        });
    }
    replay.click(function() { replays += 1; playAll(); });

    function count(o) { return Object.keys(o).length; }
    $.each(frames, function(key, run) {
        loadFrame(document.getElementById("frame" + key), viewerURL({ kind: "watch", run: run }), function(m) {
            if (m.type === "loaded") {
                loaded[key] = true;
                if (count(loaded) === 3) {
                    $("#" + TRIAL_INST).html("Watch all three objects&hellip;");
                    playAll();
                }
            } else if (m.type === "played") {
                played[key] = true;
                if (count(played) < 3) return;
                replay.prop("disabled", false);
                if (tEnabled === null) {
                    tEnabled = Date.now();
                    $("input[name=mts]").prop("disabled", false);
                    $("#" + TRIAL_INST).html("Which object, A or B, is made of the same material as the top object?");
                }
            }
        });
    });
    $("input[name=mts]").change(function() { next.prop("disabled", false); });
    next.click(function() {
        var choice = $("input[name=mts]:checked").val();
        onDone({ choice: choice, chosen: sides[choice], correct: sides[choice] === "match",
                 rt_ms: Date.now() - tEnabled, replays: replays, floor: item.floor, foil: item.foil,
                 match_side: item.match_side, run_A: frames.A, run_B: frames.B, run_sample: frames.S });
    });
};


/********************
 * EXPERIMENT       *
 ********************/
// grasp: triallist = run names. judge / watch: triallist = {cell, floor, foil, match_side}.
var Experiment = function(triallist, onDone) {
    var cIdx = 0;
    var n = triallist.length;

    function save() { psiTurk.saveData(); }     // incrementally: a session that dies at trial 3 keeps 1-2

    function startTrial() {
        if (cIdx >= n) { onDone(); return; }
        var item = triallist[cIdx], progress = (cIdx + 1) + "/" + n;
        var base = { phase: "TEST", IsInstruction: false, task: TASK, trial_index: cIdx, condition: CONDITION };
        var nextRun = triallist[cIdx + 1];
        if (nextRun) prefetch(TASK === "grasp" ? [nextRun] : [STIM_PREFIX + nextRun.cell]);

        if (TASK === "grasp") {
            GraspScreen({ run: item, trialId: TASK + "-" + (cIdx + 1) + "-" + item, progress: progress },
                function(row) {
                    psiTurk.recordTrialData($.extend(base, { TrialName: item }, row));
                    save(); cIdx += 1; startTrial();
                });
        } else if (TASK === "judge") {
            var gridRun = STIM_PREFIX + item.cell;
            prefetch(["mts_" + item.cell + "_" + item.floor + "_match", "mts_" + item.cell + "_" + item.floor + "_" + item.foil]);
            GraspScreen({ run: gridRun, trialId: TASK + "-" + (cIdx + 1) + "-" + item.cell, progress: progress,
                          after: "Press Next to judge this object&rsquo;s material." },
                function(grasp) {
                    MatchScreen(item, progress, function(judgment) {
                        psiTurk.recordTrialData($.extend(base, { TrialName: item.cell, cell: item.cell, grasp: grasp }, judgment));
                        save(); cIdx += 1; startTrial();
                    });
                });
        } else {
            if (nextRun) prefetch(["mts_" + nextRun.cell + "_" + nextRun.floor + "_match",
                                   "mts_" + nextRun.cell + "_" + nextRun.floor + "_" + nextRun.foil]);
            MatchScreen(item, progress, function(judgment) {
                psiTurk.recordTrialData($.extend(base, { TrialName: item.cell, cell: item.cell }, judgment));
                save(); cIdx += 1; startTrial();
            });
        }
    }
    startTrial();
};

// Grasp practice on an object that is not one of the stimuli; then the "ready" page.
var Practice = function(onDone) {
    if (TASK === "watch") { onDone(); return; }
    GraspScreen({ run: PRACTICE_RUN, trialId: TASK + "-practice", progress: "practice", practice: true },
        function(row) {
            psiTurk.recordTrialData($.extend({ phase: "PRACTICE", IsInstruction: true, task: TASK }, row));
            psiTurk.showPage("ready.html");
            $("#" + NEXTBUTTON).click(onDone);
        });
};


/********************
 * DEBRIEF / END    *
 ********************/
var PostQuestionnaire = function(onDone) {
    psiTurk.showPage("postquestionnaire.html");
    $("#next").click(function() {
        psiTurk.recordUnstructuredData && psiTurk.recordUnstructuredData("comments", $("#comments").val());
        onDone();
    });
};

var Finish = function() {
    // cloth-psiturk calls psiTurk.computeBonus here; this task pays a flat rate
    // and records no per-trial 'hit' field, so there is nothing to compute.
    psiTurk.saveData({
        success: function() { psiTurk.completeHIT(); },
        error:   function() { psiTurk.completeHIT(); },
    });
};


/********************
 * ENTRY            *
 ********************/
$(window).load(function() {
    if (isMobileTablet()) {          // utils.js, as in cloth-psiturk
        console.log("mobile browser detected");
        alert("Sorry, but mobile or tablet browsers are not supported. "
            + "Please switch to a desktop browser.");
        return;
    }
    $.getJSON("static/data/fixed_condlist/condlist_" + TASK + "_" + CONDITION + ".json")
        .done(function(list) {
            var trials = list.condition;
            var n = parseInt(Q.get("n") || "0", 10);
            if (n > 0) trials = trials.slice(0, n);
            Consent(function() { InstructionRunner(function() { Practice(function() {
                Experiment(trials, function() { PostQuestionnaire(Finish); });
            }); }); });
        })
        .fail(function() {
            $("body").html("<p>Could not load the condition list for condition "
                           + CONDITION + ".</p>");
        });
});
