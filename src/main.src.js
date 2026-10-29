"use strict";
/**
 * Terminal — embedded PTY terminal for the PI-Desktop work panel.
 *
 * The panel (xterm.js) talks to this process through pluginBridge.invoke("term.*") -> onPanelInvoke.
 * Output is delivered by long-polling "term.poll" (the host has no plugin->panel push API). Each
 * chunk carries a monotonic seq, so the panel resumes at the exact chunk it last rendered instead of
 * replaying a prefix or silently missing output the ring had to drop.
 * The shell runs behind a tiny python3 PTY relay (embedded below, no native modules).
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { RingBuffer } = require("./ring-buffer.js");

const RELAY_SRC = __RELAY_SRC__;
const RING_MAX = 1024 * 1024; // output retained per session; also the replay cap when a panel reattaches
const PAUSE_ABOVE = 512 * 1024; // pause the pty when an attached, actively polling reader is this far behind
const RESUME_BELOW = 128 * 1024; // resume it once that reader has caught up to here
const READER_IDLE_MS = 5000; // no poll for this long means nobody is reading: trim instead of pausing
const POLL_HOLD_MS = 1500;
const POLL_CHUNK = 256 * 1024;

// Input method switching (macOS only). im-select reads/writes the current input source through the
// Carbon TIS API, so it needs no TCC grant and no extra plugin permission; it is optional, and the
// feature degrades to a no-op without it.
const IME_DEFAULT_TARGET = "com.apple.keylayout.ABC";
const IME_CANDIDATES = [
  "/opt/homebrew/bin/im-select",
  "/usr/local/bin/im-select",
  "/opt/local/bin/im-select",
  "/usr/bin/im-select",
];
const IME_TIMEOUT_MS = 1500;
const SETTINGS_TTL_MS = 3000;
const IME_BIN_RETRY_MS = 5000;
let imeBin; // undefined: not resolved yet, null: not found (rechecked after IME_BIN_RETRY_MS)
let imeBinMissAt = 0;
let imeSaved = ""; // input source to put back when the terminal loses focus
let imeWanted = false; // the owning panel document says the terminal holds the keyboard
let imeApplied = false; // the focus side has been handled (and not yet undone) for imeWanted
let imeOwner = ""; // document that reported focus last; only its blur counts
const SETTINGS_EVENT = "plugin:settingsChanged";
let settingsLive = false; // subscribed to SETTINGS_EVENT: the cache is pushed, no TTL needed
let settingsVer = 0; // bumped by every pushed value, so a slower read cannot overwrite it
let settingsCache = { at: 0, value: {} };

const sessions = new Map();
let seq = 0;

function wakeAll(s) {
  const w = s.waiters;
  s.waiters = [];
  for (const fn of w) fn();
}

// Which project a session belongs to: projectId when the host provides one, else the primary folder path.
function wsKey(ws) {
  if (ws && typeof ws.projectId === "string" && ws.projectId) return "p:" + ws.projectId;
  return "r:" + ((ws && ws.path) || "");
}

// Sessions belong to the host's current workspace: the panel and this process read the same value,
// so there is no per-call workspace hint to pass around.
async function currentWorkspace() {
  try {
    const ws = await pi.workspace.get();
    if (ws && ws.path) return { cwd: ws.path, key: wsKey(ws) };
  } catch (_) {
    /* no workspace: fall back to home inside the relay */
  }
  return { cwd: "", key: wsKey(null) };
}

// ---- tmux (optional persistence) --------------------------------------------
//
// With tmuxMode on, every tab is a session on a private tmux server (own socket; it loads the user's
// tmux config, with a minimal fallback in relay.py when there is none). The relay only runs the
// attaching tmux client, so closing the panel or unloading the plugin just detaches it and the shell
// keeps running; term.list finds such sessions again by name. Off by default: it is the only mode in
// which a shell outlives this process.
const TMUX_PREFIX = "pit_";
// tmux prints control characters (a tab) as "_" in -F output, so fields are split on printable text.
const TMUX_SEP = "|~|";
const TMUX_CANDIDATES = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/opt/local/bin/tmux", "/usr/bin/tmux"];
const TMUX_TIMEOUT_MS = 5000;
let tmuxBin; // undefined: not resolved yet, null: not found (rechecked after TMUX_BIN_RETRY_MS)
let tmuxBinMissAt = 0;
const TMUX_BIN_RETRY_MS = 5000;

// Environment for the relay and for tmux calls. Tests point HOME at a scratch directory (so the real
// ~/.tmux.conf is not picked up); normally HOME is left to the relay, which takes it from the passwd entry.
function relayEnv(pathVar) {
  const env = { PATH: pathVar };
  if (process.env.PI_TERMINAL_TMUX_HOME) env.HOME = process.env.PI_TERMINAL_TMUX_HOME;
  return env;
}

function tmuxSocket() {
  return process.env.PI_TERMINAL_TMUX_SOCK || "pi-terminal";
}

function tmuxBinary() {
  if (tmuxBin) return tmuxBin;
  if (tmuxBin === null && Date.now() - tmuxBinMissAt < TMUX_BIN_RETRY_MS) return null;
  tmuxBin = null;
  tmuxBinMissAt = Date.now();
  if (process.platform === "win32") return tmuxBin;
  // An explicit override is the only candidate: it must never be silently replaced by another binary.
  const override = process.env.PI_TERMINAL_TMUX;
  for (const p of override ? [override] : TMUX_CANDIDATES) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      tmuxBin = p;
      break;
    } catch (_) {
      /* try the next one */
    }
  }
  return tmuxBin;
}

// The tmuxMode switch (default off). Test builds stored "on" / "auto" as text; those still count as on.
async function tmuxOn() {
  const v = (await rawSettings()).tmuxMode;
  return v === true || v === "on" || v === "auto";
}

// One tmux call against the private server; resolves {ok, out, err} and never rejects on a non-zero exit.
function tmuxRun(args) {
  return new Promise((resolve, reject) => {
    const bin = tmuxBinary();
    if (!bin) return reject(new Error("tmux not found"));
    let out = "", err = "", settled = false, child;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { if (child) child.kill("SIGKILL"); } catch (_) {}
      done({ ok: false, out, err: "tmux timed out" });
    }, TMUX_TIMEOUT_MS);
    timer.unref?.();
    try {
      // -u: assume a UTF-8 terminal, or tmux replaces non-ASCII text (a Chinese project path) with "_".
      child = spawn(bin, ["-u", "-L", tmuxSocket(), ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: relayEnv("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"),
      });
    } catch (e) {
      clearTimeout(timer);
      return reject(e);
    }
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.on("error", (e) => done({ ok: false, out, err: String((e && e.message) || e) }));
    child.on("close", (code) => done({ ok: code === 0, out, err: err.trim() }));
  });
}

// tmux session names may not contain "." or ":", so the project key is hashed into the name; the exact
// key is stored on the session (@pi_key) and read back by discoverTmux.
function tmuxName(key, n) {
  const h = require("node:crypto").createHash("sha1").update(String(key)).digest("hex").slice(0, 8);
  return TMUX_PREFIX + h + "_" + Date.now().toString(36) + n.toString(36);
}

function tmuxSpec(name, key, create) {
  const bin = tmuxBinary();
  if (!bin) throw new Error("tmux mode is on but tmux was not found (install tmux or turn the setting off)");
  return { tmux: bin, sock: tmuxSocket(), name, key, create };
}

async function tmuxHas(name) {
  try {
    return (await tmuxRun(["has-session", "-t", "=" + name])).ok;
  } catch (_) {
    return false;
  }
}

// Whether leftover sessions were looked up since the switch last went on (term.list does it, once per
// off -> on change). With the switch off they stay invisible; killTmux still removes them.
let discovered = false;

// Register the sessions an earlier run left on the tmux server. They have no relay yet: the first
// term.attach starts one.
async function discoverTmux() {
  if (!tmuxBinary()) return;
  discovered = true;
  const r = await tmuxRun(["list-sessions", "-F", ["#{session_name}", "#{@pi_key}", "#{session_path}"].join(TMUX_SEP)]);
  if (!r.ok) return; // no server running: nothing survived
  for (const line of r.out.split("\n")) {
    const [name, key, cwd] = line.split(TMUX_SEP);
    if (!name || !name.startsWith(TMUX_PREFIX) || sessions.has(name)) continue;
    sessions.set(name, newSession(name, cwd || "", key || "", 80, 24, true));
  }
}

async function killAllTmux() {
  if (tmuxBinary()) await tmuxRun(["kill-server"]);
  // Sessions with a relay notice by themselves (the client exits, has-session fails). The ones that
  // were only discovered have no relay to notice anything, so drop them here.
  for (const [id, s] of [...sessions]) if (s.tmux && !s.proc) closeSession(id, false);
}

// ---- sessions ------------------------------------------------------------------

function clampDim(v, fallback) {
  return Math.max(2, Math.min(1000, (v | 0) || fallback || 80));
}

function newSession(id, cwd, key, cols, rows, tmux) {
  return {
    id, proc: null, cwd, key, cols, rows, tmux: !!tmux,
    gone: false, // tmux only: the tmux session itself no longer exists
    ring: new RingBuffer(RING_MAX),
    cursor: 1, // seq the current reader wants next
    lastPollAt: 0,
    exited: false, exitCode: null, err: "",
    waiters: [], paused: false, pauseTimer: null, gen: 0,
  };
}

/**
 * (Re)start the relay process of a session with a fresh output ring. Handlers compare against the
 * process they were made for, so a client that is being replaced cannot touch the new state.
 */
function startRelay(s, cols, rows, spec) {
  stopRelay(s);
  s.cols = cols;
  s.rows = rows;
  s.ring = new RingBuffer(RING_MAX);
  s.cursor = 1;
  s.lastPollAt = 0;
  s.exited = false;
  s.exitCode = null;
  s.err = "";
  s.gone = false;
  const args = ["-c", RELAY_SRC, s.cwd, String(cols), String(rows)];
  if (spec) args.push(JSON.stringify(spec));
  const proc = spawn("python3", args, {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: relayEnv("/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"),
  });
  s.proc = proc;
  proc.stdout.on("data", (d) => {
    if (s.proc !== proc) return;
    s.ring.push(d);
    // Back-pressure is measured against the reader's position, not against a byte queue: pause only
    // when somebody is actually reading. With no reader (panel closed, another project open) the pty
    // keeps running and the ring trims - that is what lets a background shell survive.
    if (!s.paused && readerActive(s) && s.ring.bytesAfter(s.cursor) > PAUSE_ABOVE) {
      s.paused = true;
      proc.stdout.pause();
      armPauseTimer(s);
    }
    wakeAll(s);
  });
  proc.stderr.on("data", (d) => {
    if (s.proc !== proc) return;
    s.err = (s.err + d.toString("utf8")).slice(-2000);
  });
  proc.stdin.on("error", () => {});
  proc.stdio[3].on("error", () => {});
  proc.on("error", (e) => {
    if (s.proc !== proc) return;
    s.exited = true;
    s.exitCode = -1;
    s.err = String(e && e.message ? e.message : e);
    wakeAll(s);
  });
  proc.on("close", async (code) => {
    if (s.proc !== proc) return;
    // A tmux client also exits when it is merely detached (prefix + d). Find out whether the session
    // survived before announcing it, so term.list does not hide a shell that is still alive.
    if (s.tmux) {
      const alive = await tmuxHas(s.id);
      if (s.proc !== proc) return;
      s.gone = !alive;
    }
    s.exited = true;
    s.exitCode = code;
    wakeAll(s);
  });
}

async function openSession({ cols, rows }) {
  const { cwd, key } = await currentWorkspace();
  const c = clampDim(cols, 80);
  const r = clampDim(rows, 24);
  const n = ++seq;
  let id = "t" + n;
  let spec = null;
  if (await tmuxOn()) {
    // On means tmux: a missing binary is an error (thrown by tmuxSpec), not a fall back to a plain shell.
    id = tmuxName(key, n);
    spec = tmuxSpec(id, key, true);
  }
  const s = newSession(id, cwd, key, c, r, !!spec);
  sessions.set(id, s);
  startRelay(s, c, r, spec);
  return { id, cwd, key, gen: 0, tmux: !!spec };
}

function need(id) {
  const s = sessions.get(id);
  if (!s) throw new Error("no such terminal session: " + id);
  return s;
}

/**
 * True while a reader is polling often enough that pausing the pty would be noticed and undone.
 * A fresh session counts too (gen 0, polled right after term.open): the signal is "someone polled
 * recently", not "someone attached" — otherwise a first tab would never get back-pressure.
 */
function readerActive(s) {
  return s.lastPollAt > 0 && Date.now() - s.lastPollAt < READER_IDLE_MS;
}

/**
 * (Re-)arm the safety net that releases a paused pty.
 *
 * A single shot is not enough: the reader can still look active when the timer fires (it polled 4s
 * ago) while staying behind, so maybeResume keeps the pause and nothing would ever check again —
 * the pty would stay paused forever, the exact failure this rewrite exists to prevent. So for as
 * long as the pty is paused, a timer stays armed.
 */
function armPauseTimer(s) {
  if (s.pauseTimer) clearTimeout(s.pauseTimer);
  s.pauseTimer = setTimeout(() => {
    s.pauseTimer = null;
    maybeResume(s);
    if (s.paused) armPauseTimer(s);
  }, READER_IDLE_MS + 250);
  s.pauseTimer.unref?.();
}

/** Let a paused pty run again. */
function resumeProc(s) {
  if (!s.paused) return;
  s.paused = false;
  if (s.pauseTimer) { clearTimeout(s.pauseTimer); s.pauseTimer = null; }
  try { s.proc.stdout.resume(); } catch (_) {}
}

/** Resume a paused pty once the reader has caught up, or once the reader is gone. */
function maybeResume(s) {
  if (!s.paused) return;
  if (readerActive(s) && s.ring.bytesAfter(s.cursor) >= RESUME_BELOW) return;
  resumeProc(s);
}

/**
 * Serve the next chunk at or after `from` (default: the session's own cursor).
 *
 * The response always names the seq it ended at, so the panel resumes exactly there. `truncated`
 * means that position had already been trimmed away — the caller is told, instead of being handed a
 * shorter stream that looks complete.
 */
async function poll(s, gen, from) {
  if (gen !== s.gen) return { data: "", exited: false, superseded: true, nextSeq: s.cursor };
  // The read position belongs to this call, not to the session: two polls can be in flight at once
  // (the host times out and the panel retries while the first call is still waiting), and a shared
  // cursor would let the second one read past the block the first one owns — the retry would come
  // back empty and that output would be lost. Reading the same position twice yields the same block,
  // which is the safe direction: a duplicate is harmless, a gap is not.
  let start = s.cursor;
  if (Number.isFinite(from) && from > 0) start = Math.min(Math.floor(from), s.ring.latestSeq + 1);
  s.cursor = Math.max(s.cursor, start);
  s.lastPollAt = Date.now();
  if (s.ring.latestSeq < start && !s.exited) {
    await new Promise((resolve) => {
      const t = setTimeout(done, POLL_HOLD_MS);
      function done() {
        clearTimeout(t);
        resolve();
      }
      s.waiters.push(done);
    });
  }
  // a newer attach (panel reload / second panel) took over this session while we were waiting
  if (gen !== s.gen) return { data: "", exited: false, superseded: true, nextSeq: s.cursor };
  const r = s.ring.read(start, POLL_CHUNK);
  s.cursor = Math.max(s.cursor, r.nextSeq);
  s.lastPollAt = Date.now();
  maybeResume(s);
  return {
    data: Buffer.concat(r.chunks.map((c) => c.bytes)).toString("base64"),
    nextSeq: r.nextSeq,
    truncated: r.truncated,
    exited: s.exited && s.cursor > s.ring.latestSeq,
    exitCode: s.exitCode,
    // tmux only: the session itself is gone (the shell exited), not just this client (prefix + d)
    gone: s.gone,
    error: s.exited ? s.err : "",
  };
}

/** Stop this session's relay process. For a tmux session that only detaches the client. */
function stopRelay(s) {
  const proc = s.proc;
  s.proc = null;
  if (s.pauseTimer) { clearTimeout(s.pauseTimer); s.pauseTimer = null; }
  s.paused = false;
  if (!proc) return;
  try { proc.stdin.end(); } catch (_) {}
  try { proc.kill("SIGHUP"); } catch (_) {}
  setTimeout(() => { try { proc.kill("SIGKILL"); } catch (_) {} }, 1500).unref?.();
}

/**
 * kill=true ends the session: the shell dies, and so does its tmux session. kill=false only lets go
 * of it (plugin unload), which for a tmux session leaves the shell running on the tmux server.
 */
function closeSession(id, kill) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  if (s.tmux && kill) tmuxRun(["kill-session", "-t", "=" + s.id]).catch(() => {});
  stopRelay(s);
  wakeAll(s);
}

// ---- input method ---------------------------------------------------------

// Settings: read once and then kept current by the host's change event (see onLoad); without that
// event they are re-read at most once per TTL. The first focus waits for the real value so a plugin
// with the switch turned off never flips the layout even once.
async function rawSettings() {
  // Once subscribed to the host's change event the cache is pushed to us and never goes stale.
  const fresh = settingsCache.at > 0 && (settingsLive || Date.now() - settingsCache.at <= SETTINGS_TTL_MS);
  if (!fresh) {
    const ver = settingsVer; // an event that lands while the read is in flight wins over the read
    try {
      const read = typeof pi !== "undefined" && pi.plugin && pi.plugin.getSettings;
      const v = read ? await pi.plugin.getSettings() : null;
      if (ver === settingsVer) settingsCache = { at: Date.now(), value: v && typeof v === "object" ? v : {} };
    } catch (_) {
      // A failed read must not be cached: keep the last known value and retry on the next edge.
      if (ver === settingsVer) settingsCache = { at: 0, value: settingsCache.value };
    }
  }
  return settingsCache.value || {};
}

async function imeSettings() {
  const v = await rawSettings();
  return {
    enabled: v.imeAutoSwitch === true, // off unless the user turns it on
    target: typeof v.imeTarget === "string" && v.imeTarget ? v.imeTarget : IME_DEFAULT_TARGET,
  };
}

// Appearance / behaviour settings for the panel. The panel has no settings API of its own, so it asks
// for them here (cheap: served from the same cache) and applies them without a reload. Whatever is
// stored is cleaned here, so the panel only ever sees values it can use.
//
// Only the three switches (linkNeedsModifier, pasteSingleLine, imeAutoSwitch) have a form in the host's
// settings dialog. fontSize, fontFamily and imeTarget are deliberately not declared in the manifest (the
// host draws text boxes much taller than its switches), but they are still real settings: they have the
// defaults below, and they are read from the plugin's settings.json, so they can be set by hand there.
// fontSize is also written back by saveFontSize when the user zooms the panel.
const FONT_DEFAULT = 13;
const FONT_MIN = 8;
const FONT_MAX = 32;
// A usable font size, or null for "not set": 0 and below (the host's number box writes 0 when cleared),
// NaN, and non-numbers all mean the default.
function cleanFontSize(raw) {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n))) : null;
}
async function panelSettings() {
  const v = await rawSettings();
  const family = typeof v.fontFamily === "string" ? v.fontFamily.replace(/[;{}<>\\\r\n]/g, " ").trim().slice(0, 200) : "";
  return {
    fontSize: cleanFontSize(v.fontSize) ?? FONT_DEFAULT,
    fontFamily: family,
    linkNeedsModifier: v.linkNeedsModifier === true,
    pasteSingleLine: v.pasteSingleLine === true,
  };
}

// Persist the size the user zoomed to. The host only pushes its change event for saves made in its own
// dialog, so a plugin-side save has to update the shared cache itself; otherwise the next read would
// still hand out the old value. The previous cache is put back when the write fails, so what the panel
// sees stays what is actually stored.
async function saveFontSize(p) {
  const size = cleanFontSize(p && p.fontSize);
  if (size === null) throw new Error("fontSize must be a positive number");
  const write = typeof pi !== "undefined" && pi.plugin && pi.plugin.setSettings;
  if (!write) throw new Error("this host cannot save plugin settings");
  const before = await rawSettings();
  const prev = settingsCache;
  settingsVer++;
  settingsCache = { at: Date.now(), value: { ...before, fontSize: size } };
  try {
    await pi.plugin.setSettings({ fontSize: size });
  } catch (e) {
    settingsVer++;
    settingsCache = prev;
    throw e;
  }
  return { ok: true, fontSize: size };
}

// im-select on a non-standard prefix, or the stub a test points us at. A hit is kept; a miss is only
// remembered briefly, so installing im-select later does not need a plugin reload.
function imeBinary() {
  if (imeBin) return imeBin;
  if (imeBin === null && Date.now() - imeBinMissAt < IME_BIN_RETRY_MS) return null;
  imeBin = null;
  imeBinMissAt = Date.now();
  if (process.platform !== "darwin") return imeBin;
  // An explicit override is the only candidate: it must never be silently replaced by another binary.
  const override = process.env.PI_TERMINAL_IM_SELECT;
  const candidates = override ? [override] : IME_CANDIDATES;
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      imeBin = p;
      break;
    } catch (_) {
      /* try the next one */
    }
  }
  return imeBin;
}

// One im-select call: no argument reads the current input source, an id sets it.
function imeRun(arg) {
  return new Promise((resolve) => {
    const bin = imeBinary();
    if (!bin) return resolve({ ok: false, error: "im-select not installed" });
    let out = "", err = "", settled = false, child;
    let timer = null;
    const done = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    timer = setTimeout(() => {
      try { if (child) child.kill("SIGKILL"); } catch (_) {}
      done({ ok: false, error: "im-select timed out" });
    }, IME_TIMEOUT_MS);
    timer.unref?.();
    try {
      child = spawn(bin, arg ? [arg] : [], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
      });
    } catch (e) {
      return done({ ok: false, error: String((e && e.message) || e) });
    }
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.on("error", (e) => {
      if (e && e.code === "ENOENT") imeBin = undefined; // im-select was removed: look again next time
      done({ ok: false, error: String((e && e.message) || e) });
    });
    child.on("close", (code) => done({
      ok: code === 0,
      id: out.trim(),
      error: code === 0 ? "" : err.trim() || "im-select exited with " + code,
    }));
  });
}

// One queue for every edge: a blur that lands while a focus is still talking to im-select has to run
// after it, not race it, or the restore reads the pre-switch source and leaves the user on English.
let imeChain = Promise.resolve();
function imeEnqueue(run) {
  imeChain = imeChain.then(run, run);
  return imeChain;
}
function imeSync(focused, client) {
  return imeEnqueue(() => imeSyncNow(focused === true, client));
}

/**
 * A panel document reports a focus edge; we only record what the terminal wants and let
 * imeReconcile bring the system input source in line with it.
 *
 * Ownership: the document that reported focus last owns the state. A blur from any other document
 * (a reloaded or second panel whose edge arrives late) is ignored, so it cannot restore the old
 * source underneath the panel that actually holds the keyboard. Nothing is reference-counted: a
 * view that vanished without a blur cannot pin the state, the next focus simply takes over.
 */
async function imeSyncNow(focused, client) {
  client = typeof client === "string" && client ? client : "default";
  if (focused) {
    imeOwner = client;
    imeWanted = true;
  } else {
    if (imeOwner && imeOwner !== client) return { ok: true, switched: false, reason: "not-owner", focused: imeWanted };
    imeOwner = "";
    imeWanted = false;
  }
  return imeReconcile();
}

/**
 * Focus (wanted and usable): remember the input source the user was on, then switch to English.
 * Blur, or the feature turned off while focused: put that source back, unless the current one is no
 * longer our target (the user changed it by hand while the terminal had focus - leave it alone).
 * Edges are compared with what was already applied, so repeats cost nothing and the remembered
 * value cannot be overwritten with our own switch.
 */
async function imeReconcile() {
  const cfg = await imeSettings();
  let off = "";
  if (process.platform !== "darwin") off = "unsupported-platform";
  else if (!cfg.enabled) off = "disabled";
  else if (!imeBinary()) off = "im-select-missing";
  const want = imeWanted && !off;
  if (want === imeApplied) return { ok: true, switched: false, reason: off || "unchanged", focused: imeWanted };

  if (want) {
    // Marked applied before the first spawn: a failure is reported once, not retried in a loop.
    imeApplied = true;
    const cur = await imeRun("");
    if (!cur.ok) return { ok: false, error: cur.error || "im-select read failed" };
    const from = cur.id || "";
    if (!from || from === cfg.target) return { ok: true, switched: false, focused: true, id: from };
    imeSaved = from;
    const set = await imeRun(cfg.target);
    if (!set.ok) imeSaved = "";
    return { ok: set.ok, switched: set.ok, from, to: cfg.target, error: set.error };
  }

  imeApplied = false;
  const restore = imeSaved;
  if (!restore) return { ok: true, switched: false, reason: "nothing-to-restore" };
  const cur = await imeRun("");
  if (cur.ok && cur.id && cur.id !== cfg.target) {
    imeSaved = ""; // the user picked another source by hand: forget ours
    return { ok: true, switched: false, reason: "user-changed", id: cur.id };
  }
  const set = await imeRun(restore);
  if (set.ok) imeSaved = ""; // keep the memory when the restore failed, so the next edge retries
  return { ok: set.ok, switched: set.ok, to: restore, error: set.error };
}

async function imeState() {
  const cfg = await imeSettings();
  return {
    supported: process.platform === "darwin",
    binary: imeBinary(),
    enabled: cfg.enabled,
    target: cfg.target,
    focused: imeWanted,
    applied: imeApplied,
    saved: imeSaved,
  };
}

async function onPanelInvoke(channel, p) {
  p = p || {};
  switch (channel) {
    case "ime.sync":
      return imeSync(p.focused === true, p.client);
    case "ime.state":
      return imeState();
    case "term.settings":
      return panelSettings();
    case "term.saveFont":
      return saveFontSize(p);
    case "term.open":
      return openSession(p);
    case "term.attach": {
      const s = need(p.id);
      s.gen++;
      wakeAll(s); // release any stale long-poll from the previous owner
      if (s.tmux) {
        // The screen lives in tmux, not in our ring: start a fresh client and let tmux repaint it.
        // -d on the attach also detaches the previous client, so the window follows this panel's size.
        const cols = clampDim(p.cols, s.cols), rows = clampDim(p.rows, s.rows);
        startRelay(s, cols, rows, tmuxSpec(s.id, "", false));
        s.lastPollAt = Date.now();
        return { replay: "", gen: s.gen, nextSeq: s.ring.nextSeq, tmux: true };
      }
      // A new reader starts at the oldest retained output: the replay below carries everything the
      // ring still holds, and nextSeq says where to resume so no output is served twice.
      s.cursor = s.ring.earliestSeq;
      s.lastPollAt = Date.now();
      resumeProc(s);
      const r = s.ring.read(s.cursor, RING_MAX);
      s.cursor = r.nextSeq;
      return {
        replay: Buffer.concat(r.chunks.map((c) => c.bytes)).toString("base64"),
        gen: s.gen,
        nextSeq: r.nextSeq,
      };
    }
    case "term.list": {
      const cur = await currentWorkspace();
      const on = await tmuxOn();
      if (!on) discovered = false;
      else if (!discovered) await discoverTmux().catch(() => {});
      return {
        key: cur.key,
        // New tabs are tmux ones right now (mode on and a tmux binary exists). The panel uses it to move a
        // project that only has plain shells (opened while the mode was off) over to tmux.
        tmuxWanted: on && !!tmuxBinary(),
        // For a tmux session "exited" means the session is gone, not that this client left: a session
        // detached with the tmux prefix is still alive and gets re-attached.
        sessions: [...sessions.values()].map((s) => ({ id: s.id, key: s.key, exited: s.tmux ? s.gone : s.exited, tmux: !!s.tmux })),
      };
    }
    case "term.write": {
      const s = need(p.id);
      if (!s.exited && s.proc && typeof p.data === "string") s.proc.stdin.write(Buffer.from(p.data, "utf8"));
      return { ok: true };
    }
    case "term.resize": {
      const s = need(p.id);
      const c = clampDim(p.cols, s.cols), r = clampDim(p.rows, s.rows);
      s.cols = c;
      s.rows = r;
      if (!s.exited && s.proc) s.proc.stdio[3].write(`R ${c} ${r}\n`);
      return { ok: true };
    }
    case "term.poll":
      return poll(need(p.id), p.gen | 0, p.from);
    case "term.close":
      closeSession(p.id, true); // the user closed the tab: that ends a tmux session too
      return { ok: true };
    default:
      throw new Error("unsupported panel channel: " + channel);
  }
}

// The host pushes the merged settings to the plugin process whenever the user saves them. Listening
// is what makes toggling the feature immediate without polling; a host without pi.events falls back
// to the TTL read in imeSettings and picks the change up at the next focus edge.
function onSettingsChanged(next) {
  if (!next || typeof next !== "object") return;
  settingsVer++;
  settingsCache = { at: Date.now(), value: next };
  imeEnqueue(imeReconcile).catch(() => {});
}

// Window shortcut (⌘T by default): the manifest's `openShortcut` setting names this command and the
// main window runs it on the keypress. The work-panel tab belongs to the host, so the command can
// only ask it to reveal our view. With no active session the host refuses; a keypress stays quiet.
// The host drops the command itself when the plugin unloads.
const COMMAND_OPEN = "local.terminal.open";

function registerOpenCommand() {
  return pi.commands.register({
    id: COMMAND_OPEN,
    title: "打开终端",
    category: "terminal",
    keywords: ["terminal", "shell", "终端"],
    run: async () => { try { await pi.ui.revealView({ viewId: "terminal" }); } catch (_) {} },
  });
}

// Ends every session on the plugin's private tmux server, including ones no panel shows any more
// (another project's, or left over from an earlier run). Works whatever tmuxMode is, so turning the
// feature off never strands background shells.
const COMMAND_KILL_TMUX = "local.terminal.killTmux";

function registerKillTmuxCommand() {
  return pi.commands.register({
    id: COMMAND_KILL_TMUX,
    title: "结束所有 tmux 后台会话",
    category: "terminal",
    keywords: ["tmux", "kill", "终端", "结束"],
    run: async () => { try { await killAllTmux(); } catch (_) {} },
  });
}

async function onLoad() {
  try {
    if (typeof pi !== "undefined" && pi.events && typeof pi.events.on === "function") {
      pi.events.on(SETTINGS_EVENT, onSettingsChanged);
      settingsLive = true;
    }
  } catch (_) {
    /* no event API: the TTL read still works */
  }
  await registerOpenCommand();
  await registerKillTmuxCommand();
}

async function onUnload() {
  try {
    if (settingsLive) pi.events.off(SETTINGS_EVENT, onSettingsChanged);
  } catch (_) {}
  settingsLive = false;
  // detach, not kill: a tmux-backed shell is meant to outlive the plugin process.
  for (const id of [...sessions.keys()]) closeSession(id, false);
  // Never leave the user stuck on the English layout because the plugin went away: let any queued
  // edge finish first, then put the remembered source back.
  await imeChain.catch(() => {});
  imeWanted = false;
  imeApplied = false;
  imeOwner = "";
  if (imeSaved) {
    const restore = imeSaved;
    imeSaved = "";
    await imeRun(restore);
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };
