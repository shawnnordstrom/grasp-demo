/*
 * psiturk_stub.js -- preview-only stand-in for psiturk.js.
 *
 * Loaded by preview.html instead of /static/js/psiturk.js so the experiment can
 * be run and iterated on with no psiturk install, no database and no HIT.
 * task.js is NOT aware of this file: under real psiturk, exp.html loads the
 * genuine psiturk.js and this one is never fetched.
 *
 * preloadPages uses synchronous XHR on purpose -- that is what psiturk's own
 * implementation does ($.ajax with async:false), and it means showPage can stay
 * synchronous, exactly as task.js expects.
 *
 * The one visible addition is the data panel (bottom-left, "data"): every
 * recordTrialData row is shown live, which is the point of a self-preview. It is
 * hidden for real participants (PROLIFIC_PID in the URL).
 *
 * Also the runtime of the static site (experiment.html, e.g. on GitHub Pages), so
 * template paths are relative to the page, not to the server root.
 */
/* global $ */
(function () {
    var pages = {};
    var rows = [];
    var unstructured = {};
    var hidePanel = new URLSearchParams(window.location.search).has("PROLIFIC_PID");

    function panel() {
        if (hidePanel) return null;
        var el = document.getElementById("__stubdata");
        if (el) return el;
        var css = document.createElement("style");
        css.textContent =
            "#__stubdata{position:fixed;left:10px;bottom:10px;z-index:9999;" +
            "font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}" +
            "#__stubtoggle{background:#eee;color:#333;border:1px solid #bbb;" +
            "border-radius:4px;padding:3px 9px;font:inherit;cursor:pointer}" +
            "#__stubpre{display:none;margin:6px 0 0;max-height:42vh;max-width:46vw;" +
            "overflow:auto;background:#fff;border:1px solid #bbb;border-radius:6px;" +
            "padding:9px 11px;color:#333;white-space:pre-wrap}" +
            "#__stubpre.open{display:block}";
        document.head.appendChild(css);
        el = document.createElement("div");
        el.id = "__stubdata";
        el.innerHTML = '<button id="__stubtoggle">data</button><pre id="__stubpre"></pre>';
        document.documentElement.appendChild(el);
        el.querySelector("#__stubtoggle").onclick = function () {
            el.querySelector("#__stubpre").classList.toggle("open");
        };
        return el;
    }

    function repaint() {
        if (hidePanel) return;
        var pre = panel().querySelector("#__stubpre");
        pre.textContent = rows.length
            ? rows.map(function (r, i) { return "#" + i + " " + JSON.stringify(r, null, 1); })
                  .join("\n\n")
            : "(nothing recorded yet)";
    }

    window.psiTurk = {
        taskdata: { get: function (k) { return k === "condition" ? 0 : null; } },

        preloadPages: function (list) {
            list.forEach(function (p) {
                var xhr = new XMLHttpRequest();
                xhr.open("GET", "templates/" + p, false);    // sync, as psiturk does
                try {
                    xhr.send(null);
                    pages[p] = xhr.status === 200 ? xhr.responseText
                        : '<p style="color:#c00">missing template: ' + p +
                          " (HTTP " + xhr.status + ")</p>";
                } catch (e) {
                    pages[p] = '<p style="color:#c00">could not load ' + p + "</p>";
                }
            });
        },

        showPage: function (page) {
            var html = pages[page];
            if (!html) { document.body.innerHTML =
                '<p style="color:#c00">page not preloaded: ' + page + "</p>"; return; }
            // psiturk swaps only the body content; the templates are full
            // documents, so pull the <body> out the same way it does
            var m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
            document.body.innerHTML = m ? m[1] : html;
            panel(); repaint();
        },

        recordUnstructuredData: function (k, v) {
            unstructured[k] = v;
            console.log("[recordUnstructuredData]", k, v);
        },

        recordTrialData: function (d) {
            rows.push(d);
            console.log("[recordTrialData]", d);
            repaint();
        },

        // no server to save to; succeed on the next tick so the flow is
        // async-shaped exactly as it is against real psiturk
        saveData: function (opts) {
            setTimeout(function () {
                if (opts && opts.success) opts.success();
            }, 0);
        },

        computeBonus: function (route, cb) { if (cb) cb(); },

        // Renders the real complete.html, the same way showPage() does for
        // every other template -- so this is what a participant actually sees,
        // not a preview-only summary.
        completeHIT: function () {
            var xhr = new XMLHttpRequest();
            xhr.open("GET", "templates/complete.html", false);    // sync, as psiturk does
            var html = null;
            try {
                xhr.send(null);
                if (xhr.status === 200) html = xhr.responseText;
            } catch (e) {}
            var m = html && /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
            document.body.innerHTML = m ? m[1] :
                '<p style="color:#c00">could not load complete.html</p>';
            panel(); repaint();
        },
    };
})();
