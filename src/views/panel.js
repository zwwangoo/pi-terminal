(function () {
  "use strict";
  var bridge = window.pluginBridge;
  var tabsEl = document.getElementById("tabs");
  var hostEl = document.getElementById("terms");
  var statusEl = document.getElementById("status");
  var tabs = []; // {id, gen, term, fit, el, btn, alive, pending, sending}
  var active = null;
  var curKey = null; // project key the visible tabs belong to (from the backend)
  var switching = false;

  function invoke(ch, p) {
    return bridge.invoke(ch, p || {});
  }
  function b64ToBytes(s) {
    if (!s) return new Uint8Array(0);
    var bin = atob(s), n = bin.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  var statusTimer = 0;
  // Any new status text cancels a pending auto-clear, so a persistent error (failed start, no bridge) is
  // never wiped by the timer of an earlier transient message.
  function setStatus(msg) {
    clearTimeout(statusTimer);
    statusEl.textContent = msg || "";
  }
  var ctxEl = document.getElementById("ctx");
  // Transient message (clipboard / open-link failures): shown on the status line, then cleared.
  function flash(msg) {
    setStatus(msg);
    statusTimer = setTimeout(function () { setStatus(""); }, 4000);
  }
  var ZH = /^zh/i.test((navigator.language || "") + "");
  var L = ZH
    ? { copy: "\u590d\u5236", paste: "\u7c98\u8d34", pasteLine: "\u7c98\u8d34\u4e3a\u5355\u884c", pasteRaw: "\u7c98\u8d34\uff08\u4fdd\u7559\u6362\u884c\uff09", selectAll: "\u5168\u9009", clear: "\u6e05\u9664\u6eda\u52a8\u7f13\u51b2", newTab: "\u65b0\u5efa\u6807\u7b7e", closeTab: "\u5173\u95ed\u6807\u7b7e", openLink: "\u6253\u5f00\u94fe\u63a5", copyLink: "\u590d\u5236\u94fe\u63a5\u5730\u5740", linkHint: "\u6309\u4f4f \u2318 \u70b9\u51fb\u94fe\u63a5\u624d\u4f1a\u6253\u5f00", copyFail: "\u65e0\u6cd5\u590d\u5236: ", pasteFail: "\u65e0\u6cd5\u7c98\u8d34: ", openFail: "\u65e0\u6cd5\u6253\u5f00 " }
    : { copy: "Copy", paste: "Paste", pasteLine: "Paste as Single Line", pasteRaw: "Paste with Line Breaks", selectAll: "Select All", clear: "Clear Scrollback", newTab: "New Tab", closeTab: "Close Tab", openLink: "Open Link", copyLink: "Copy Link Address", linkHint: "Hold \u2318 and click to open the link", copyFail: "Cannot copy: ", pasteFail: "Cannot paste: ", openFail: "Cannot open " };
  function errText(e) { return (e && e.message) || e || "unknown error"; }
  // Clipboard goes through the host channels (manifest permissions clipboard.write / clipboard.read);
  // navigator.clipboard is only a fallback, and a refusal on both lands on the status line.
  async function copyText(text) {
    if (!text) return false;
    try {
      await invoke("clipboard.writeText", { text: text });
      return true;
    } catch (e) {
      try { await navigator.clipboard.writeText(text); return true; } catch (e2) { flash(L.copyFail + errText(e)); return false; }
    }
  }
  async function readClipboard() {
    try {
      var r = await invoke("clipboard.readText");
      return typeof r === "string" ? r : (r && typeof r.text === "string" ? r.text : "");
    } catch (e) {
      try { return await navigator.clipboard.readText(); } catch (e2) { flash(L.pasteFail + errText(e)); return null; }
    }
  }
  // term.paste (not a raw write) so bracketed-paste mode and newline normalisation apply. Single-line
  // mode folds every line break into one space first, so a copied multi-line command cannot run by itself.
  // mode: "line" / "raw" force one way for this paste; anything else follows the setting.
  async function pasteInto(t, mode) {
    if (!t || !t.alive) return;
    var text = await readClipboard();
    var fold = mode === "line" || (mode !== "raw" && cfg.pasteSingleLine);
    if (text && fold) text = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
    if (text) t.term.paste(text);
    if (tabs.indexOf(t) >= 0) t.term.focus();
  }
  var FONT_DEFAULT = 13, FONT_MIN = 8, FONT_MAX = 32;
  var DEFAULT_FAMILY = 'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", monospace';
  var cfg = { fontSize: FONT_DEFAULT, fontFamily: "", linkNeedsModifier: false, pasteSingleLine: false };
  var fontSize = FONT_DEFAULT; // shared by every tab; a tab that is not visible refits when it is activated
  // A bare name like `JetBrains Mono` or `3270 Nerd Font` is quoted so it is valid CSS; a list the user
  // wrote themselves (commas / quotes) is kept as it is. The built-in stack always follows as fallback.
  // A value the browser would reject as a whole must not reach xterm (an invalid font-family silently
  // drops the terminal to a proportional font), so it is checked and falls back to a safely quoted
  // form, and finally to the built-in stack.
  function familyOf(name) {
    name = (name || "").trim();
    if (!name) return DEFAULT_FAMILY;
    var candidates = [
      /[,"']/.test(name) ? name : '"' + name + '"',
      '"' + name.replace(/["'\\]/g, "") + '"',
    ];
    for (var i = 0; i < candidates.length; i++) {
      var full = candidates[i] + ", " + DEFAULT_FAMILY;
      if (!window.CSS || !CSS.supports || CSS.supports("font-family", full)) return full;
    }
    return DEFAULT_FAMILY;
  }
  var fontEpoch = 0; // bumped by every local zoom and every finished save, see applySettings
  var fontSaveTimer = 0, fontPending = null;
  L.saveFail = ZH ? "\u65e0\u6cd5\u4fdd\u5b58\u5b57\u4f53\u5927\u5c0f: " : "Cannot save font size: ";
  // persist=true for a zoom the user did (it is kept across restarts); false when the value came from the
  // stored settings, which must not be written straight back.
  function setFont(n, persist) {
    n = Math.max(FONT_MIN, Math.min(FONT_MAX, n));
    if (n === fontSize) return;
    fontSize = n;
    tabs.forEach(function (t) { t.term.options.fontSize = n; });
    refit(active);
    if (persist) saveFontSoon(n);
  }
  // Cmd +/- can fire many times in a row: only the last size is written, shortly after the user stops.
  function saveFontSoon(n) {
    fontEpoch++;
    fontPending = n;
    clearTimeout(fontSaveTimer);
    fontSaveTimer = setTimeout(flushFont, 600);
  }
  function flushFont() {
    clearTimeout(fontSaveTimer);
    if (fontPending === null || !bridge || !bridge.invoke) return;
    var n = fontPending;
    fontPending = null;
    invoke("term.saveFont", { fontSize: n }).then(function () {
      cfg.fontSize = n; // the stored value is now ours: a poll that returns it is not a change
      fontEpoch++;
    }, function (err) {
      flash(L.saveFail + errText(err));
    });
  }
  // Apply what the backend hands back. The stored size is adopted only when it really differs from the
  // last known stored one AND the user has not zoomed since this read began (or has a save still pending);
  // otherwise a read that was already in flight would pull the font back to the old size.
  function applySettings(next, epoch) {
    if (!next || typeof next !== "object") return;
    var prev = cfg;
    var size = typeof next.fontSize === "number" ? Math.max(FONT_MIN, Math.min(FONT_MAX, next.fontSize)) : FONT_DEFAULT;
    cfg = {
      fontSize: prev.fontSize,
      fontFamily: typeof next.fontFamily === "string" ? next.fontFamily : "",
      linkNeedsModifier: next.linkNeedsModifier === true,
      pasteSingleLine: next.pasteSingleLine === true,
    };
    if (epoch === fontEpoch && fontPending === null) {
      cfg.fontSize = size;
      if (size !== prev.fontSize) setFont(size, false);
    }
    if (cfg.fontFamily !== prev.fontFamily) {
      var fam = familyOf(cfg.fontFamily);
      tabs.forEach(function (t) { t.term.options.fontFamily = fam; });
      refit(active);
    }
  }
  // Never rejects: an old backend without the channel, or a bridge that is still loading, just keeps
  // the defaults / the last values.
  function refreshSettings() {
    if (!bridge || !bridge.invoke || document.visibilityState === "hidden") return Promise.resolve();
    var epoch = fontEpoch;
    return invoke("term.settings").then(function (s) { applySettings(s, epoch); }, function () {});
  }
  function openLink(uri) {
    invoke("shell.openExternal", { url: uri }).catch(function (err) {
      flash(L.openFail + uri + ": " + errText(err));
    });
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

  function makeTab(id, replayB64, gen, nextSeq) {
    var el = document.createElement("div");
    el.className = "term";
    hostEl.appendChild(el);
    var term = new window.Terminal({
      fontFamily: familyOf(cfg.fontFamily),
      fontSize: fontSize,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: THEMES[base],
    });
    var fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    if (window.WebLinksAddon) {
      // Clicking an http(s) link hands the URL to the host bridge channel `shell.openExternal`,
      // which the host gates on the manifest permission of the same name. A refusal is not silent:
      // it lands on the status line instead of vanishing into an empty catch. hover/leave remember
      // which link the mouse is over so the right-click menu can offer it.
      term.loadAddon(new window.WebLinksAddon.WebLinksAddon(function (e, uri) {
        // Optional guard against opening the browser while merely selecting text near a link.
        if (cfg.linkNeedsModifier && !(e && (e.metaKey || e.ctrlKey))) { flash(L.linkHint); return; }
        openLink(uri);
      }, {
        hover: function (e, text) { t.link = text; },
        leave: function () { t.link = ""; },
      }));
    }
    // Copy / paste / select-all / clear. Cmd+C only counts as "copy" while there is a selection, so it can
    // never be mistaken for an interrupt; Ctrl+C (no Shift) is left alone and still reaches the shell.
    term.attachCustomKeyEventHandler(function (e) {
      if (e.type !== "keydown" || e.altKey) return true;
      if (!(e.metaKey || (e.ctrlKey && e.shiftKey))) return true;
      var k = (e.key || "").toLowerCase();
      if (k === "c" && term.hasSelection()) { e.preventDefault(); copyText(term.getSelection()); return false; }
      if (k === "v") { e.preventDefault(); pasteInto(t); return false; }
      if (k === "a" && e.metaKey) { e.preventDefault(); term.selectAll(); return false; }
      if (k === "k" && e.metaKey) { e.preventDefault(); term.clear(); return false; }
      return true;
    });
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

    var t = { id: id, gen: gen | 0, nextSeq: nextSeq | 0, term: term, fit: fit, el: el, btn: btn, alive: true, pending: "", sending: false, link: "" };
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

  // One in-flight write per tab: keys that arrive mid-write are batched into the next one, so order is
  // kept and a paste never starts N overlapping calls.
  async function send(t, d) {
    t.pending += d;
    if (t.sending) return;
    t.sending = true;
    try {
      while (t.pending) {
        var chunk = t.pending;
        t.pending = "";
        await invoke("term.write", { id: t.id, data: chunk }).catch(function () {});
      }
    } finally {
      t.sending = false;
    }
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
      // Ask for the chunk after the last one this screen rendered. The backend keeps whole chunks and
      // answers truncated when that position is already gone, instead of handing back a shorter
      // stream that looks like the whole output.
      var req = { id: t.id, gen: t.gen };
      if (t.nextSeq > 0) req.from = t.nextSeq;
      try {
        r = await invoke("term.poll", req);
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
      if (r.truncated) {
        t.term.write("\r\n\x1b[2m[output dropped: this panel fell too far behind to keep it]\x1b[0m\r\n");
      }
      if (r.data) t.term.write(b64ToBytes(r.data));
      if (r.nextSeq > 0) t.nextSeq = r.nextSeq;
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
      var r = await invoke("term.open", { cols: size.cols, rows: size.rows });
      var t = makeTab(r.id, null, r.gen, r.nextSeq);
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
      var l = await invoke("term.list");
      curKey = l.key || null;
      live = l.sessions.filter(function (s) { return !s.exited && s.key === l.key; });
    } catch (e) {}
    for (var i = 0; i < live.length; i++) {
      try {
        var a = await invoke("term.attach", { id: live[i].id });
        var t = makeTab(live[i].id, a.replay, a.gen, a.nextSeq);
        pollLoop(t);
      } catch (e) {}
    }
    if (tabs.length) { activate(tabs[0]); } else { await newTab(); }
  }

  // The panel can stay alive across project switches: notice the change and swap in that project's terminals.
  async function checkWorkspace() {
    if (switching || document.visibilityState === "hidden") return;
    try {
      var l = await invoke("term.list");
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
    // Font zoom: Cmd + / Cmd - / Cmd 0. Cmd only: Ctrl+- is readline's undo and must reach the shell.
    if (e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === "=" || e.key === "+") { e.preventDefault(); setFont(fontSize + 1, true); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); setFont(fontSize - 1, true); }
      else if (e.key === "0") { e.preventDefault(); setFont(FONT_DEFAULT, true); }
    }
  });
  // Clicking anywhere keeps the keyboard on the terminal, except inside the context menu (its items
  // restore focus themselves once they have run).
  document.addEventListener("click", function (e) {
    if (ctxEl.contains(e.target)) return;
    if (active) active.term.focus();
  });

  // ---- Right-click menu ----
  var ctxTab = null; // tab the open menu belongs to
  function ctxIsOpen() { return !ctxEl.hidden; }
  function closeMenu(refocus) {
    if (!ctxIsOpen()) return;
    ctxEl.hidden = true;
    ctxEl.textContent = "";
    var t = ctxTab;
    ctxTab = null;
    if (refocus && t && tabs.indexOf(t) >= 0) t.term.focus();
  }
  function openMenu(x, y, t, sel, link) {
    closeMenu(false);
    ctxTab = t;
    var items = [];
    if (link) {
      items.push({ label: L.openLink, run: function () { openLink(link); } });
      items.push({ label: L.copyLink, run: function () { copyText(link); } });
      items.push({ sep: true });
    }
    items.push(
      { label: L.copy, hint: "\u2318C", disabled: !sel, run: function () { copyText(sel); } },
      { label: L.paste, hint: "\u2318V", disabled: !t.alive, run: function () { pasteInto(t); } },
      // The default paste follows the "fold to a single line" setting; the second entry is the other way.
      cfg.pasteSingleLine
        ? { label: L.pasteRaw, disabled: !t.alive, run: function () { pasteInto(t, "raw"); } }
        : { label: L.pasteLine, disabled: !t.alive, run: function () { pasteInto(t, "line"); } },
      { label: L.selectAll, hint: "\u2318A", run: function () { t.term.selectAll(); } },
      { sep: true },
      { label: L.clear, hint: "\u2318K", run: function () { t.term.clear(); } },
      { sep: true },
      { label: L.newTab, hint: "\u2318T", run: function () { newTab(); } },
      { label: L.closeTab, hint: "\u2318W", run: function () { closeTab(t); } }
    );
    items.forEach(function (it) {
      if (it.sep) {
        var s = document.createElement("div");
        s.className = "ctx-sep";
        s.setAttribute("role", "separator");
        ctxEl.appendChild(s);
        return;
      }
      var b = document.createElement("button");
      b.type = "button";
      b.className = "ctx-item";
      b.setAttribute("role", "menuitem");
      b.disabled = !!it.disabled;
      var l = document.createElement("span");
      l.textContent = it.label;
      var h = document.createElement("span");
      h.className = "ctx-hint";
      h.textContent = it.hint || "";
      b.appendChild(l);
      b.appendChild(h);
      b.addEventListener("click", function (ev) {
        ev.stopPropagation();
        closeMenu(true);
        it.run();
      });
      ctxEl.appendChild(b);
    });
    ctxEl.hidden = false;
    var w = ctxEl.offsetWidth, hgt = ctxEl.offsetHeight;
    ctxEl.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + "px";
    ctxEl.style.top = Math.max(4, Math.min(y, window.innerHeight - hgt - 4)) + "px";
    var first = ctxEl.querySelector(".ctx-item:not(:disabled)");
    if (first) first.focus();
  }
  hostEl.addEventListener("contextmenu", function (e) {
    var t = active;
    if (!t || !t.el.contains(e.target)) return;
    // A program that asked for mouse reporting (vim, tmux...) owns the right button; Shift takes it back.
    var mm = t.term.modes && t.term.modes.mouseTrackingMode;
    if (mm && mm !== "none" && !e.shiftKey) return;
    e.preventDefault();
    // The addon's hover state can outlive the link (output scrolled it away under a still mouse), so it
    // only counts while xterm is also showing the pointer cursor, which it does exactly over a link.
    var link = t.link && t.el.querySelector(".xterm-cursor-pointer") ? t.link : "";
    openMenu(e.clientX, e.clientY, t, t.term.getSelection(), link);
  });
  ctxEl.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  ctxEl.addEventListener("keydown", function (e) {
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
      return;
    }
    var btns = Array.prototype.slice.call(ctxEl.querySelectorAll(".ctx-item:not(:disabled)"));
    if (!btns.length) return;
    var i = btns.indexOf(document.activeElement), n = -1;
    if (e.key === "ArrowDown") n = (i + 1) % btns.length;
    else if (e.key === "ArrowUp") n = (i - 1 + btns.length) % btns.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = btns.length - 1;
    if (n >= 0) { e.preventDefault(); btns[n].focus(); }
  });
  window.addEventListener("pointerdown", function (e) { if (ctxIsOpen() && !ctxEl.contains(e.target)) closeMenu(false); }, true);
  window.addEventListener("wheel", function (e) { if (ctxIsOpen() && !ctxEl.contains(e.target)) closeMenu(false); }, { capture: true, passive: true });
  window.addEventListener("blur", function () { closeMenu(false); });
  window.addEventListener("resize", function () { closeMenu(false); });

  // Input method: "focus" here means this panel document actually holds the keyboard. The host docks
  // the view and never focuses it for us, so clicking into the terminal is what raises focus, and
  // clicking into chat / another tab / another app lowers it. The backend owns the switching itself;
  // this side only reports edges, and only believes one once the backend has answered.
  var imeOn = false; // what the backend has confirmed
  var imeWant = false; // what this document says it should be
  var imeBusy = false;
  // Identifies this document to the backend: after a reload or with a second panel, only the document
  // that reported focus last may report the blur that restores the previous input source.
  var imeClient = Math.random().toString(36).slice(2) + Date.now().toString(36);
  function docFocused() {
    try { return document.hasFocus() === true && document.visibilityState !== "hidden"; } catch (e) { return false; }
  }
  function imePump() {
    if (imeBusy || imeWant === imeOn || !bridge || !bridge.invoke) return;
    var target = imeWant;
    imeBusy = true;
    invoke("ime.sync", { focused: target, client: imeClient }).then(function () {
      imeOn = target;
    }, function () {
      /* bridge rejected the send (plugin still loading): leave imeOn alone so the reconciler re-sends */
    }).then(function () {
      imeBusy = false;
      imePump();
    });
  }
  function imeSync(focused) {
    imeWant = focused === true;
    imePump();
  }
  window.addEventListener("focus", function () { imeSync(docFocused()); });
  window.addEventListener("blur", function () { imeSync(docFocused()); });
  document.addEventListener("visibilitychange", function () { imeSync(docFocused()); });
  window.addEventListener("pagehide", function () { imeSync(false); flushFont(); });
  // Reconcile: a detached view may never deliver a blur, and a send the bridge rejected (plugin still
  // loading) was never delivered. A reply of {ok:false} (im-select failed) counts as delivered: the
  // backend keeps what it needs to undo a half-done switch, so it is not retried every 500ms.
  setInterval(function () { imeSync(docFocused()); }, 500);
  setInterval(checkWorkspace, 1500);
  // Plugin settings are pushed to the backend by the host, the panel picks them up from there.
  setInterval(refreshSettings, 2000);
  window.addEventListener("focus", function () { refreshSettings(); });
  document.addEventListener("visibilitychange", function () { refreshSettings(); });

  if (!bridge || !bridge.invoke) { setStatus("pluginBridge unavailable"); }
  else {
    applyAppearance(null);
    if (bridge.on) bridge.on("appearance:changed", applyAppearance);
    invoke("app.getAppearance").then(applyAppearance).catch(function () {});
    // Settings first, so the first terminal already opens with the user's font instead of flashing the default.
    refreshSettings().then(restore);
  }
})();
