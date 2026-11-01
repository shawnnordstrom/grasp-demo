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
 *   grasp_done      maneuver finished playing -- carries outcome, in_target, clicks, lattice sites
 *   sim_error       the sim request failed; the viewer lets the participant press GO again
 *   unlock          a watch viewer reached UNLOCK_S seconds of simulation, or ended sooner
 *   played          a watch viewer finished a full fall
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
var N_CONDITIONS = { grasp: 12, judge: 6, watch: 20 }[TASK];   // condlist_<task>_<k>.json, k = 0..N-1
var PRACTICE_RUN = TASK === "grasp" ? "blob_stim_cube_middle" : "blob_demo";
var UNLOCK_S = 4;               // A/B screen: seconds of simulation before answering (10 s on screen)
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

var VERSION = TASK === "grasp" ? (Q.get("version") === "fingertip" ? "fingertip" : "contact") : null;
var GRASP_DIR = VERSION === "fingertip" ? "instructions_grasp_fingertip" : "instructions_grasp";
var INSTRUCT_DIR = TASK === "grasp" ? GRASP_DIR : "instructions_" + TASK;
var INSTRUCT_SEQ = {
    grasp: [1, 2, 3, 4, 5, 6].map(function(k) { return GRASP_DIR + "/instruct-" + k + ".html"; }),
    judge: ["instructions_judge/instruct-1.html", "instructions_judge/instruct-2.html",
            "instructions_judge/instruct-3.html", "instructions_judge/instruct-4.html"],
    watch: ["instructions_watch/instruct-1.html", "instructions_watch/instruct-2.html"],
}[TASK];
var QUIZ_PAGE = "quiz_" + TASK + (VERSION === "fingertip" ? "_fingertip" : "") + ".html";
var QUIZ_ANSWERS = TASK === "grasp" ? { trueFalse1: "c", trueFalse2: "a", trueFalse3: "a" } : { trueFalse1: "c", trueFalse2: "a" };
var CONSENT_PAGE = TASK === "watch" ? "consent_watch.html" : "consent.html";

// ---- all pages to be loaded ----------------------------------------------
// grasp and watch: their own page before practice and their own "ready" page
var PRACTICE_PAGE = TASK === "judge" ? null : INSTRUCT_DIR + "/practice.html";
var READY_PAGE = TASK === "judge" ? "ready.html" : INSTRUCT_DIR + "/ready.html";
// what the participant places: "contact points" in the grasp contact version, "fingers" otherwise
var CONTACT_TERMS = VERSION === "contact";
var PAGE_ID = "psiturk-" + TASK + (VERSION ? "-" + VERSION : "");
var pages = [INSTRUCT_DIR + "/instructions.html"].concat(INSTRUCT_SEQ,
    [QUIZ_PAGE, READY_PAGE, "stage.html", "stage_match.html", "postquestionnaire.html"]);
if (PRACTICE_PAGE) pages.push(PRACTICE_PAGE);
if (STATIC_SITE) pages.push(CONSENT_PAGE, "complete.html");
psiTurk.preloadPages(pages);

psiTurk.recordUnstructuredData && psiTurk.recordUnstructuredData("session_info", {
    task: TASK, version: VERSION, condition: CONDITION, mode: MODE, participant: WHO, session: SESSION,
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
    if (CONTACT_TERMS) u.set("terms", "contact");
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
    psiTurk.showPage(CONSENT_PAGE);
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
            psiTurk.showPage(INSTRUCT_DIR + "/instructions.html");
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
        loadFrame(frame, viewerURL({ kind: "grasp", run: opts.run, trial: opts.trialId, page: PAGE_ID,
                                     feedback: opts.practice ? "simple" : (Q.get("feedback") === "1" ? "full" : "none"),
                                     attempt0: tries }),
            function(m) {
                switch (m.type) {
                case "ready_to_place": setPrompt("Click the object to place your " + (CONTACT_TERMS ? "contact points" : "fingers")
                                                 + ", then press GO."); break;
                case "go":             setPrompt("Watch what happens&hellip;"); break;
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
            outcome: m.outcome || null, in_target: m.in_target, logged: m.logged || null, error: m.error,
        });
    });
    mount();
};


/********************
 * MATCH SCREEN     *
 ********************/
// stage_match.html: the sample (blob_stim_ recording, flat floor) plays alone once, with no replay;
// then match and foil (same uneven floor) appear as A / B. The answer and Replay unlock once both
// have played UNLOCK_S seconds of simulation or ended, whichever is first; Replay restarts A and B
// together (counted) and unlocks again on the same rule. practice: "Correct!" / "Wrong!" after each
// choice, and Next stays off until the choice is right.
function matchRuns(item) {
    var foil = TASK === "watch" ? "mts_" + item.cell.split("_")[0] + "_" + item.foil + "_" + item.floor + "_match"
                                : "mts_" + item.cell + "_" + item.floor + "_" + item.foil;
    return { S: STIM_PREFIX + item.cell, match: "mts_" + item.cell + "_" + item.floor + "_match", foil: foil };
}

var MatchScreen = function(item, progress, onDone, practice) {
    psiTurk.showPage("stage_match.html");
    $("#" + FULL_CONTAINER).removeClass("hide_elements");
    $("#" + PROGRESS).html(progress);
    $("#" + TRIAL_INST).html("Loading&hellip;");
    var runs = matchRuns(item);
    var sides = item.match_side === "A" ? { A: "match", B: "foil" } : { A: "foil", B: "match" };
    var pair = { A: runs[sides.A], B: runs[sides.B] };
    var view = item.camera ? { aim: item.camera.aim.join(","), az: item.camera.az, zoom: item.camera.zoom } : {};
    var loaded = {}, unlocked = {}, tEnabled = null, replays = 0, firstChoice = null;
    if (item.camera) $("#frameS").removeClass("mts-target");
    var next = $("#" + NEXTBUTTON).prop("disabled", true);
    var replay = $("#replaybutton").prop("disabled", true);
    prefetch([pair.A, pair.B]);

    function count(o) { return Object.keys(o).length; }
    function playPair() {
        unlocked = {};
        replay.prop("disabled", true);
        $.each(pair, function(k) {
            document.getElementById("frame" + k).contentWindow.postMessage({ type: "play" }, "*");
        });
    }
    replay.click(function() { replays += 1; playPair(); });

    function showPair() {
        $(".mts-sample").addClass("hide_elements");
        $(".mts-choices, #mts-answer, #replaybutton").removeClass("hide_elements");
        $("#" + TRIAL_INST).html("Loading&hellip;");
        $.each(pair, function(key, run) {
            loadFrame(document.getElementById("frame" + key), viewerURL($.extend({ kind: "watch", run: run, unlock: UNLOCK_S }, view)), function(m) {
                if (m.type === "loaded") {
                    loaded[key] = true;
                    if (count(loaded) === 2) {
                        $("#" + TRIAL_INST).html("Watch both objects&hellip;");
                        playPair();
                    }
                } else if (m.type === "unlock") {
                    unlocked[key] = true;
                    if (count(unlocked) < 2) return;
                    replay.prop("disabled", false);
                    if (tEnabled === null) {
                        tEnabled = Date.now();
                        $("input[name=mts]").prop("disabled", false);
                        $("#" + TRIAL_INST).html("Which object, A or B, is made of the same material as the object you saw first?");
                    }
                }
            });
        });
    }

    loadFrame(document.getElementById("frameS"), viewerURL($.extend({ kind: "watch", run: runs.S }, view)), function(m) {
        if (m.type === "loaded") {
            $("#" + TRIAL_INST).html("Watch the object&hellip;");
            document.getElementById("frameS").contentWindow.postMessage({ type: "play" }, "*");
        } else if (m.type === "played") {
            setTimeout(showPair, 500);
        }
    });
    $("input[name=mts]").change(function() {
        if (firstChoice === null) firstChoice = this.value;
        if (!practice) { next.prop("disabled", false); return; }
        var right = sides[this.value] === "match";
        next.prop("disabled", !right);
        $("#" + TRIAL_INST).html(right ? "<span style='color:green;'>Correct!</span> Click Next to move on."
                                       : "<span style='color:red;'>Wrong!</span> Choose again.");
    });
    next.click(function() {
        var choice = $("input[name=mts]:checked").val();
        onDone({ choice: choice, chosen: sides[choice], correct: sides[choice] === "match", first_choice: firstChoice,
                 rt_ms: Date.now() - tEnabled, replays: replays, floor: item.floor, foil: item.foil,
                 match_side: item.match_side, run_A: pair.A, run_B: pair.B, run_sample: runs.S, camera: item.camera || null });
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
        var base = { phase: "TEST", IsInstruction: false, task: TASK, version: VERSION, trial_index: cIdx, condition: CONDITION,
                     repetition: triallist.slice(0, cIdx + 1).filter(function(x) { return JSON.stringify(x) === JSON.stringify(item); }).length };
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
            if (nextRun) { var upcoming = matchRuns(nextRun); prefetch([upcoming.match, upcoming.foil]); }
            MatchScreen(item, progress, function(judgment) {
                psiTurk.recordTrialData($.extend(base, { TrialName: item.cell, cell: item.cell }, judgment));
                save(); cIdx += 1; startTrial();
            });
        }
    }
    startTrial();
};

// Grasp practice, or the watch task's match-to-sample practice trials (grasp and watch: introduced
// by their own page after the quiz); then the "ready" page.
var Practice = function(items, onDone) {
    function ready() {
        psiTurk.showPage(READY_PAGE);
        $("#" + NEXTBUTTON).click(onDone);
    }
    function watchPractice(i) {
        if (i >= items.length) { ready(); return; }
        MatchScreen(items[i], "practice " + (i + 1) + "/" + items.length, function(row) {
            psiTurk.recordTrialData($.extend({ phase: "PRACTICE", IsInstruction: true, task: TASK, trial_index: i,
                                               TrialName: items[i].cell, cell: items[i].cell }, row));
            watchPractice(i + 1);
        }, true);
    }
    function practice() {
        if (TASK === "watch") { watchPractice(0); return; }
        GraspScreen({ run: PRACTICE_RUN, trialId: TASK + "-practice", progress: "practice", practice: true },
            function(row) {
                psiTurk.recordTrialData($.extend({ phase: "PRACTICE", IsInstruction: true, task: TASK, version: VERSION }, row));
                ready();
            });
    }
    if (!PRACTICE_PAGE) { practice(); return; }
    psiTurk.showPage(PRACTICE_PAGE);
    $("#" + NEXTBUTTON).click(practice);
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
            Consent(function() { InstructionRunner(function() { Practice(list.practice, function() {
                Experiment(trials, function() { PostQuestionnaire(Finish); });
            }); }); });
        })
        .fail(function() {
            $("body").html("<p>Could not load the condition list for condition "
                           + CONDITION + ".</p>");
        });
});
