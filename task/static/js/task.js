/*
 * task.js, soft-object experiment: three tasks
 *
 * grasp pick up each of the 12 objects (3 shapes x slouch/soft/middle/hard), one try each
 * judge pick up each of 9 objects (soft/middle/hard), then match-to-sample: which of A / B is the same material
 * watch match-to-sample only, no grasping
 * 
/* global $, psiTurk, condition, isMobileTablet */

// element ids 
var FULL_CONTAINER = "full-container";
var TRIALFRAME     = "trialframe";
var TRIAL_INST     = "qspan";
var NEXTBUTTON     = "nextbutton";
var PROGRESS       = "progress";

// experiment parameters
var Q = new URLSearchParams(window.location.search);
var STATIC_SITE = !!window.STATIC_SITE;
var TASK = window.TASK || Q.get("task") || "grasp";
if (["grasp", "judge", "watch"].indexOf(TASK) < 0) TASK = "grasp";
var DATA_BASE = "../data"; // blobs + web_config.json, relative to the viewer document
var VIEWER = "static/viewer/index.html";
var N_CONDITIONS = { grasp: 12, judge: 6, watch: 20 }[TASK]; // condlist_<task>_<k>.json, k = 0..N-1
var PRACTICE_RUN = TASK === "grasp" ? "blob_stim_cube_middle" : "blob_demo";
var STIM_PREFIX = "blob_stim_"; // + <shape>_<material>: recorded until the object comes to rest
var GRIP = Q.get("grip"); // null = the viewer's default (0.5); the slider is hidden
var SHOW_GRIP = Q.get("showgrip") === "1";
var SIM_API = Q.has("api") ? Q.get("api")
            : (/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname) ? window.location.origin : null);

// who: Prolific participant, else ?who= (testing)
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
var QUIZ_ANSWERS = {
    grasp: { trueFalse1: "c", trueFalse2: "a", trueFalse3: "a" },
    judge: { trueFalse1: "c", trueFalse2: "a" },
    watch: { trueFalse1: "c", trueFalse2: "b" },
}[TASK];
var CONSENT_PAGE = TASK === "watch" ? "consent_watch.html" : "consent.html";
var FULLSCREEN_PAGE = TASK === "watch" ? "instructions_watch/fullscreen.html" : null;

// all pages to be loaded
// grasp and watch: their own page before practice and their own "ready" page
var PRACTICE_PAGE = TASK === "judge" ? null : INSTRUCT_DIR + "/practice.html";
var READY_PAGE = TASK === "judge" ? "ready.html" : INSTRUCT_DIR + "/ready.html";
// what the participant places: "contact points" in the grasp contact version, "fingers" otherwise
var CONTACT_TERMS = VERSION === "contact";
var PAGE_ID = "psiturk-" + TASK + (VERSION ? "-" + VERSION : "");
var pages = [INSTRUCT_DIR + "/instructions.html"].concat(INSTRUCT_SEQ,
    [QUIZ_PAGE, READY_PAGE, "stage.html", "stage_match.html", "postquestionnaire.html"]);
if (PRACTICE_PAGE) pages.push(PRACTICE_PAGE);
if (FULLSCREEN_PAGE) pages.push(FULLSCREEN_PAGE);
if (STATIC_SITE) pages.push(CONSENT_PAGE, "complete.html");
psiTurk.preloadPages(pages);

psiTurk.recordUnstructuredData && psiTurk.recordUnstructuredData("session_info", {
    task: TASK, version: VERSION, condition: CONDITION, mode: MODE, participant: WHO, session: SESSION,
    study: Q.get("STUDY_ID"), static_site: STATIC_SITE, screen: [window.innerWidth, window.innerHeight],
    display: [window.screen.width, window.screen.height], pixel_ratio: window.devicePixelRatio,
    browser: navigator.userAgent, language: navigator.language,
});


// VIEWER FRAMES
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


//consent
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


// fullscreen
var fullscreenActive = false, fullscreenExits = 0, fullscreenHeight = 0, fullscreenLog = [];
var hiddenMs = 0, hiddenAt = null;
psiTurk.recordUnstructuredData && psiTurk.recordUnstructuredData("fullscreen_log", fullscreenLog);

function inFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
function fullscreenPaused() { return $("#fullscreenpause").length > 0; }

function openFullscreen() {
    var el = document.documentElement, open = el.requestFullscreen || el.webkitRequestFullscreen;
    var opened = open ? open.call(el) : Promise.reject();
    if (opened) opened.catch(function() { $("#fullscreenerror").removeClass("hide_elements"); });
}

function leaveFullscreen() {
    var close = document.exitFullscreen || document.webkitExitFullscreen;
    return close.call(document);
}

function closeFullscreen() {
    fullscreenActive = false;
    if (inFullscreen()) leaveFullscreen();
}

function returnToFullscreen() {
    if (!inFullscreen()) { openFullscreen(); return; }
    var left = leaveFullscreen();
    if (left) left.then(openFullscreen);
}

function pauseViewers(on) {
    $("iframe").each(function() { this.contentWindow.postMessage({ type: "pause", on: on }, "*"); });
}

function pauseForFullscreen() {
    if (fullscreenPaused()) return;
    fullscreenExits += 1;
    fullscreenLog.push({ event: "exit", at: Date.now() });
    pauseViewers(true);
    $("body").append("<div id='fullscreenpause' style='position:fixed; top:0; left:0; right:0; bottom:0; z-index:10000; background:#fff; color:#000; text-align:center; padding-top:30vh;'>"
        + "<h1>The experiment is paused</h1><p>Please return to full screen to continue.</p><br>"
        + "<button type='button' class='btn btn-success btn-lg'>Return to full screen</button></div>");
    $("#fullscreenpause button").click(returnToFullscreen);
}

function fullscreenChanged() {
    if (inFullscreen()) {
        if (fullscreenPaused()) fullscreenLog.push({ event: "return", at: Date.now() });
        fullscreenActive = true;
        fullscreenHeight = window.innerHeight;
        $("#fullscreenbutton").addClass("hide_elements").siblings("#" + NEXTBUTTON).removeClass("hide_elements");
        $("#fullscreenpause").remove();
        pauseViewers(false);
    } else if (fullscreenActive) {
        pauseForFullscreen();
    }
}

function fullscreenResized() {
    if (!fullscreenActive) return;
    fullscreenHeight = Math.max(fullscreenHeight, window.innerHeight);
    if (window.innerHeight < fullscreenHeight - 40) pauseForFullscreen();
}
document.addEventListener("onfullscreenchange" in document ? "fullscreenchange" : "webkitfullscreenchange", fullscreenChanged);
window.addEventListener("resize", fullscreenResized);
document.addEventListener("visibilitychange", function() {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt !== null) { hiddenMs += Date.now() - hiddenAt; hiddenAt = null; }
});

var Fullscreen = function(onDone) {
    if (!FULLSCREEN_PAGE || Q.get("skip") === "1") { onDone(); return; }
    psiTurk.showPage(FULLSCREEN_PAGE);
    $("#fullscreenbutton").click(openFullscreen);
    $("#" + NEXTBUTTON).click(onDone);
};


// instructions
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


//QUIZ
// Wrong answers send the participant back to the start of the instructions
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
        psiTurk.saveData();

        if (allRight) {
            onDone();
        } else {
            alert("At least one answer was incorrect. "
                + "Please read the instructions again.");
            InstructionRunner(onDone);
        }
    });
};


// GRASP SCREEN
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


// match screen
// stage_match.html: the sample (blob_stim_ recording, flat floor) plays alone once, with no replay;
// then match and foil (same uneven floor) appear as A / B. The answer is open as soon as A and B
// start, and every click is logged; Next and Replay unlock once both have played to the end, and
// Replay restarts A and B together (counted). practice: "Correct!" / "Wrong!" after each choice,
// and Next stays off until the choice is right.
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
    var onFloor = function(floor) { return item.camera ? $.extend({ floor: floor }, view) : view; };
    var loaded = {}, played = {}, sampleAt = null, t0 = null, doneMs = null, log = [], replayLog = [], replays = 0,
        firstChoice = null, exits0 = fullscreenExits, hidden0 = hiddenMs, retries = {}, loadError = null;
    if (item.camera) $("#frameS").removeClass("mts-target");
    var next = $("#" + NEXTBUTTON).prop("disabled", true);
    var replay = $("#replaybutton").prop("disabled", true);
    prefetch([pair.A, pair.B]);

    function count(o) { return Object.keys(o).length; }
    function playPair() {
        played = {};
        replay.prop("disabled", true);
        $.each(pair, function(k) {
            document.getElementById("frame" + k).contentWindow.postMessage({ type: "play", paused: fullscreenPaused() }, "*");
        });
    }
    replay.click(function() { replays += 1; replayLog.push(Date.now() - t0); playPair(); });

    function refreshNext() {
        var c = $("input[name=mts]:checked").val();
        next.prop("disabled", !(loadError || (c && doneMs !== null && (!practice || sides[c] === "match"))));
    }

    function load(key, run, floor, fn) {
        loadFrame(document.getElementById("frame" + key), viewerURL($.extend({ kind: "watch", run: run, attempt: retries[key] || 0 }, onFloor(floor))), function(m) {
            if (m.type !== "error") { fn(m); return; }
            retries[key] = (retries[key] || 0) + 1;
            if (retries[key] <= 2) { setTimeout(function() { load(key, run, floor, fn); }, 1500); return; }
            loadError = key + ": " + (m.error || "could not load");
            $("#" + TRIAL_INST).html("This clip could not load. Press Next to continue.");
            refreshNext();
        });
    }

    function showPair() {
        $(".mts-sample").addClass("hide_elements");
        $(".mts-choices, #mts-answer, #replaybutton").removeClass("hide_elements");
        $("#" + TRIAL_INST).html("Loading&hellip;");
        $.each(pair, function(key, run) {
            load(key, run, item.floor, function(m) {
                if (m.type === "loaded") {
                    loaded[key] = true;
                    if (count(loaded) === 2) {
                        t0 = Date.now();
                        $("input[name=mts]").prop("disabled", false);
                        $("#" + TRIAL_INST).html("Which object, A or B, is made of the same material as the object you saw first?");
                        playPair();
                    }
                } else if (m.type === "played") {
                    played[key] = true;
                    if (count(played) < 2) return;
                    replay.prop("disabled", false);
                    if (doneMs === null) { doneMs = Date.now() - t0; refreshNext(); }
                }
            });
        });
    }

    load("S", runs.S, "flat", function(m) {
        if (m.type === "loaded") {
            $("#" + TRIAL_INST).html("Watch the object&hellip;");
            sampleAt = Date.now();
            document.getElementById("frameS").contentWindow.postMessage({ type: "play", paused: fullscreenPaused() }, "*");
        } else if (m.type === "played") {
            setTimeout(showPair, 500);
        }
    });
    $("input[name=mts]").click(function() {
        log.push({ choice: this.value, t_ms: Date.now() - t0 });
        if (firstChoice === null) firstChoice = this.value;
        if (practice) {
            var right = sides[this.value] === "match";
            $("#" + TRIAL_INST).html(right ? "<span style='color:green;'>Correct!</span> Click Next to move on."
                                           : "<span style='color:red;'>Wrong!</span> Choose again.");
        }
        refreshNext();
    });
    next.click(function() {
        if (loadError) {
            onDone({ load_error: loadError, load_retries: retries, floor: item.floor, foil: item.foil, match_side: item.match_side,
                     run_A: pair.A, run_B: pair.B, run_sample: runs.S, sample_start_at: sampleAt, ab_start_at: t0 });
            return;
        }
        var choice = $("input[name=mts]:checked").val();
        var k = log.length - 1;
        while (k > 0 && log[k - 1].choice === choice) k -= 1;
        var switches = log.filter(function(c, i) { return i > 0 && c.choice !== log[i - 1].choice; }).length;
        onDone({ choice: choice, chosen: sides[choice], correct: sides[choice] === "match", first_choice: firstChoice,
                 choice_log: log, first_choice_ms: log[0].t_ms, final_choice_ms: log[k].t_ms, n_switches: switches,
                 clips_done_ms: doneMs, next_ms: Date.now() - t0, sample_start_at: sampleAt, ab_start_at: t0,
                 replays: replays, replay_log: replayLog, floor: item.floor, foil: item.foil,
                 match_side: item.match_side, run_A: pair.A, run_B: pair.B, run_sample: runs.S, camera: item.camera || null,
                 fullscreen_exits: fullscreenExits - exits0, tab_hidden_ms: hiddenMs - hidden0 });
    });
};


// EXPERIMENT
 
// grasp: triallist = run names. judge / watch: triallist = {cell, floor, foil, match_side}.
var Experiment = function(triallist, onDone) {
    var cIdx = 0;
    var n = triallist.length;

    function save() { psiTurk.saveData(); }

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
            psiTurk.saveData();
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


// DEBRIEF / END
var PostQuestionnaire = function(onDone) {
    psiTurk.showPage("postquestionnaire.html");
    $("#next").click(function() {
        $(this).prop("disabled", true).text("Saving...");
        psiTurk.recordUnstructuredData && psiTurk.recordUnstructuredData("comments", $("#comments").val());
        onDone();
    });
};

var Finish = function() {
    if (FULLSCREEN_PAGE) {
        psiTurk.recordUnstructuredData && psiTurk.recordUnstructuredData("fullscreen_exits", fullscreenExits);
        closeFullscreen();
    }
    psiTurk.saveData({
        success: function(reply) {
            if (reply && reply.code) window.location.href = "https://app.prolific.com/submissions/complete?cc=" + encodeURIComponent(reply.code);
            else psiTurk.completeHIT();
        },
        error:   function() { psiTurk.completeHIT(); },
    });
};


// entry
$(window).load(function() {
    if (isMobileTablet()) {
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
            Consent(function() { Fullscreen(function() { InstructionRunner(function() { Practice(list.practice, function() {
                Experiment(trials, function() { PostQuestionnaire(Finish); });
            }); }); }); });
        })
        .fail(function() {
            $("body").html("<p>Could not load the condition list for condition "
                           + CONDITION + ".</p>");
        });
});
