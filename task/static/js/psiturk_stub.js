/* global $ */
(function () {
    var pages = {};
    var rows = [];
    var unstructured = {};
    var Q = new URLSearchParams(window.location.search);
    var hidePanel = Q.has("PROLIFIC_PID") || Q.get("data") !== "1";
    var SAVE_URL = (Q.has("api") ? Q.get("api").replace(/\/+$/, "")
                  : /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname) ? window.location.origin
                  : "https://0fh9f5n0mc.execute-api.us-east-2.amazonaws.com") + "/save";
    var SAVE_TOKEN = "2ipvFHPifLffuihBhY7KQIU5dK-7ixfe";
    var LOAD = Math.random().toString(36).slice(2, 10);
    var STARTED = Date.now();
    var queue = Promise.resolve();

    function post(done) {
        var info = unstructured.session_info || {};
        var body = JSON.stringify({ token: SAVE_TOKEN, load: LOAD, started: STARTED, done: done, participant: info.participant,
                                    session: info.session, study: info.study, task: info.task, rows: rows, unstructured: unstructured });
        var stop = new AbortController();
        var timer = setTimeout(function () { stop.abort(); }, 20000);
        return fetch(SAVE_URL, { method: "POST", body: body, keepalive: done && body.length < 60000, signal: stop.signal })
            .then(function (r) {
                clearTimeout(timer);
                if (!r.ok) throw new Error("save failed: " + r.status);
            });
    }

    function send(done, tries) {
        return post(done).catch(function (e) {
            if (tries <= 1) throw e;
            return new Promise(function (ok) { setTimeout(ok, 2000); })
                .then(function () { return send(done, tries - 1); });
        });
    }

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
                xhr.open("GET", "templates/" + p, false);
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
            var m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
            document.body.innerHTML = m ? m[1] : html;
            panel(); repaint();
        },

        recordUnstructuredData: function (k, v) {
            unstructured[k] = v;
            console.log("[recordUnstructuredData]", k, v);
        },

        recordTrialData: function (d) {
            rows.push(Object.assign({ dateTime: Date.now() }, d));
            console.log("[recordTrialData]", d);
            repaint();
        },

        // one save at a time and in order, so a slow one can't land after a newer one
        saveData: function (opts) {
            var sent = queue.catch(function () {}).then(function () { return send(!!opts, opts ? 3 : 1); });
            queue = sent;
            sent.then(function () { if (opts && opts.success) opts.success(); },
                      function () { if (opts && opts.error) opts.error(); });
        },

        computeBonus: function (route, cb) { if (cb) cb(); },

        // Renders the real complete.html, the same way showPage() does for
        // all template.
        completeHIT: function () {
            var xhr = new XMLHttpRequest();
            xhr.open("GET", "templates/complete.html", false);
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
