(function () {
  "use strict";
  var bridge = window.pluginBridge;
  var tabsEl = document.getElementById("tabs");
  var hostEl = document.getElementById("terms");
  var statusEl = document.getElementById("status");
  var tabs = []; // {id, gen, term, fit, el, btn, label, alive, pending, sending}
  var active = null;
  var curKey = null; // project key the visible tabs belong to (from the backend)
  var switching = false;

  function invoke(ch, p) {
    return bridge.invoke(ch, p || {});
  }
  // The workspace this panel is showing; backend falls back to the host's current one if unavailable.
  async function getWs() {
    try {
      var w = await invoke("workspace.get");
      if (w && typeof w.path === "string" && w.path) {
        return { path: w.path, projectId: typeof w.projectId === "string" ? w.projectId : undefined };
      }
    } catch (e) {}
    return null;
  }
  function b64ToBytes(s) {
    if (!s) return new Uint8Array(0);
    var bin = atob(s), n = bin.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }
  // Palette follows the host: same base colors as the built-in panels, switched by the app's own light/dark setting.
  var THEMES = {
    dark: {
      background: "#181818", foreground: "#d4d4d4", cursor: "#ffffff", cursorAccent: "#181818",
      selectionBackground: "rgba(255,255,255,0.18)",
    },
    light: {
      background: "#fafafa", foreground: "#1a1c1f", cursor: "#1a1c1f", cursorAccent: "#fafafa",
      selectionBackground: "rgba(0,0,0,0.15)",
      black: "#1a1c1f", red: "#c4352b", green: "#1f7a3d", yellow: "#8a6a00",
      blue: "#1d5fbf", magenta: "#9b3fa8", cyan: "#0f7c8a", white: "#5d5d5d",
      brightBlack: "#6b6b6b", brightRed: "#d9453a", brightGreen: "#2a9650", brightYellow: "#a07d00",
      brightBlue: "#2f74da", brightMagenta: "#b44fc2", brightCyan: "#1796a6", brightWhite: "#3a3a3a",
    },
  };
  var base = "dark";
  function themeObj() {
    return THEMES[base];
  }
  function applyAppearance(a) {
    var b = a && a.base;
    if (b !== "light" && b !== "dark") {
      b = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    base = b;
    document.documentElement.dataset.base = b;
    tabs.forEach(function (t) { t.term.options.theme = THEMES[b]; });
  }

  function updateChrome() {
    document.querySelector(".app").classList.toggle("single", tabs.length < 2);
  }

  function makeTab(id, replayB64, gen) {
    var el = document.createElement("div");
    el.className = "term";
    hostEl.appendChild(el);
    var term = new window.Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: themeObj(),
    });
    var fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    if (window.WebLinksAddon) {
      term.loadAddon(new window.WebLinksAddon.WebLinksAddon(function (e, uri) {
        invoke("shell.openExternal", { url: uri }).catch(function () {});
      }));
    }
    term.open(el);

    var btn = document.createElement("button");
    btn.className = "tab";
    btn.type = "button";
    var label = document.createElement("span");
    label.textContent = "shell";
    var x = document.createElement("span");
    x.className = "x";
    x.textContent = "\u00d7";
    btn.appendChild(label);
    btn.appendChild(x);
    tabsEl.insertBefore(btn, document.getElementById("add"));

    var t = { id: id, gen: gen | 0, term: term, fit: fit, el: el, btn: btn, label: label, alive: true, pending: "", sending: false };
    tabs.push(t);
    btn.addEventListener("click", function (ev) {
      if (ev.target === x) closeTab(t); else activate(t);
    });
    term.onTitleChange(function (title) { label.textContent = (title || "shell").slice(-24); });
    term.onData(function (d) { send(t, d); });
    if (replayB64) term.write(b64ToBytes(replayB64));
    updateChrome();
    return t;
  }

  // Coalesce keystrokes: one in-flight write per tab, the rest batched (keeps order, bounded latency).
  function send(t, d) {
    t.pending += d;
    if (t.sending) return;
    t.sending = true;
    (function pump() {
      if (!t.pending) { t.sending = false; return; }
      var chunk = t.pending;
      t.pending = "";
      invoke("term.write", { id: t.id, data: chunk }).catch(function () {}).then(pump);
    })();
  }

  function sendSize(t) {
    if (!t.alive) return;
    invoke("term.resize", { id: t.id, cols: t.term.cols, rows: t.term.rows }).catch(function () {});
  }

  function refit(t) {
    if (!t || t.el.offsetParent === null) return;
    try {
      var before = t.term.cols + "x" + t.term.rows;
      t.fit.fit();
      if (before !== t.term.cols + "x" + t.term.rows) sendSize(t);
    } catch (e) {}
  }

  function activate(t) {
    active = t;
    tabs.forEach(function (o) {
      var on = o === t;
      o.el.classList.toggle("on", on);
      o.btn.classList.toggle("on", on);
    });
    requestAnimationFrame(function () { refit(t); t.term.focus(); });
  }

  async function pollLoop(t) {
    var fails = 0;
    while (t.alive) {
      var r;
      try {
        r = await invoke("term.poll", { id: t.id, gen: t.gen });
        fails = 0;
      } catch (e) {
        if (++fails > 3) { t.alive = false; t.term.write("\r\n\x1b[31m[terminal backend lost: " + (e && e.message || e) + "]\x1b[0m\r\n"); break; }
        await new Promise(function (res) { setTimeout(res, 300); });
        continue;
      }
      if (!t.alive) break; // tab closed or project switched while this poll was in flight
      if (r.superseded) {
        t.alive = false;
        t.btn.classList.add("dead");
        t.term.write("\r\n\x1b[2m[this terminal is now attached to another panel]\x1b[0m\r\n");
        break;
      }
      if (r.data) t.term.write(b64ToBytes(r.data));
      if (r.exited) {
        t.alive = false;
        t.btn.classList.add("dead");
        var msg = "\r\n\x1b[2m[process exited" + (r.exitCode != null ? " with code " + r.exitCode : "") + "]\x1b[0m\r\n";
        if (r.error) msg += "\x1b[31m" + r.error.replace(/\n/g, "\r\n") + "\x1b[0m\r\n";
        t.term.write(msg);
        break;
      }
    }
  }

  async function newTab() {
    var size = estimateSize();
    try {
      var ws = await getWs();
      var r = await invoke("term.open", { cols: size.cols, rows: size.rows, ws: ws });
      var t = makeTab(r.id, null, r.gen);
      activate(t);
      await new Promise(function (res) { requestAnimationFrame(res); });
      refit(t);
      pollLoop(t);
      setStatus("");
    } catch (e) {
      setStatus("Failed to start terminal: " + (e && e.message || e));
    }
  }

  function estimateSize() {
    var w = hostEl.clientWidth || 800, h = hostEl.clientHeight || 400;
    return { cols: Math.max(20, Math.floor(w / 8)), rows: Math.max(5, Math.floor(h / 17)) };
  }

  function closeTab(t) {
    t.alive = false;
    invoke("term.close", { id: t.id }).catch(function () {});
    t.term.dispose();
    t.el.remove();
    t.btn.remove();
    tabs.splice(tabs.indexOf(t), 1);
    updateChrome();
    if (!tabs.length) newTab();
    else if (active === t) activate(tabs[tabs.length - 1]);
  }

  // Drop the visible tabs without killing their shells (they stay in the backend for their project).
  function detachAll() {
    tabs.forEach(function (t) {
      t.alive = false;
      t.term.dispose();
      t.el.remove();
      t.btn.remove();
    });
    tabs = [];
    active = null;
  }

  // Attach only the live sessions that belong to the current project; open a fresh one if there is none.
  async function restore() {
    var live = [];
    try {
      var l = await invoke("term.list", { ws: await getWs() });
      curKey = l.key || null;
      live = l.sessions.filter(function (s) { return !s.exited && s.key === l.key; });
    } catch (e) {}
    for (var i = 0; i < live.length; i++) {
      try {
        var a = await invoke("term.attach", { id: live[i].id });
        var t = makeTab(live[i].id, a.replay, a.gen);
        pollLoop(t);
      } catch (e) {}
    }
    if (tabs.length) { activate(tabs[0]); } else { await newTab(); }
  }

  // The panel can stay alive across project switches: notice the change and swap in that project's terminals.
  async function checkWorkspace() {
    if (switching || document.visibilityState === "hidden") return;
    try {
      var l = await invoke("term.list", { ws: await getWs() });
      if (l.key === curKey) return;
    } catch (e) { return; }
    switching = true;
    try {
      detachAll();
      await restore();
    } finally {
      switching = false;
    }
  }

  document.getElementById("add").addEventListener("click", newTab);
  document.getElementById("float-add").addEventListener("click", function (e) { e.stopPropagation(); newTab(); });
  window.addEventListener("resize", function () { refit(active); });
  if (window.ResizeObserver) new ResizeObserver(function () { refit(active); }).observe(hostEl);
  document.addEventListener("keydown", function (e) {
    if (e.metaKey && e.key === "t") { e.preventDefault(); newTab(); }
    if (e.metaKey && e.key === "w" && active) { e.preventDefault(); closeTab(active); }
  });
  document.addEventListener("click", function () { if (active) active.term.focus(); });
  setInterval(checkWorkspace, 1500);

  if (!bridge || !bridge.invoke) { setStatus("pluginBridge unavailable"); }
  else {
    applyAppearance(null);
    if (bridge.on) bridge.on("appearance:changed", applyAppearance);
    invoke("app.getAppearance").then(applyAppearance).catch(function () {});
    restore();
  }
})();
