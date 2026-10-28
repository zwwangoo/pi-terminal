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

async function openSession({ cols, rows }) {
  const { cwd, key } = await currentWorkspace();
  const id = "t" + ++seq;
  const c = Math.max(2, Math.min(1000, cols | 0 || 80));
  const r = Math.max(2, Math.min(1000, rows | 0 || 24));
  const proc = spawn("python3", ["-c", RELAY_SRC, cwd, String(c), String(r)], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" },
  });
  const s = {
    id, proc, cwd, key,
    ring: new RingBuffer(RING_MAX),
    cursor: 1, // seq the current reader wants next
    lastPollAt: 0,
    exited: false, exitCode: null, err: "",
    waiters: [], paused: false, pauseTimer: null, gen: 0,
  };
  sessions.set(id, s);
  proc.stdout.on("data", (d) => {
    s.ring.push(d);
    // Back-pressure is measured against the reader's position, not against a byte queue: pause only
    // when somebody is actually reading. With no reader (panel closed, another project open) the pty
    // keeps running and the ring trims — that is what lets a background shell survive.
    if (!s.paused && readerActive(s) && s.ring.bytesAfter(s.cursor) > PAUSE_ABOVE) {
      s.paused = true;
      proc.stdout.pause();
      armPauseTimer(s);
    }
    wakeAll(s);
  });
  proc.stderr.on("data", (d) => {
    s.err = (s.err + d.toString("utf8")).slice(-2000);
  });
  proc.stdin.on("error", () => {});
  proc.stdio[3].on("error", () => {});
  proc.on("error", (e) => {
    s.exited = true;
    s.exitCode = -1;
    s.err = String(e && e.message ? e.message : e);
    wakeAll(s);
  });
  proc.on("close", (code) => {
    s.exited = true;
    s.exitCode = code;
    wakeAll(s);
  });
  return { id, cwd, key, gen: 0 };
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

/** Resume a paused pty once the reader has caught up, or once the reader is gone. */
function maybeResume(s) {
  if (!s.paused) return;
  if (readerActive(s) && s.ring.bytesAfter(s.cursor) >= RESUME_BELOW) return;
  s.paused = false;
  if (s.pauseTimer) { clearTimeout(s.pauseTimer); s.pauseTimer = null; }
  try { s.proc.stdout.resume(); } catch (_) {}
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
    error: s.exited ? s.err : "",
  };
}

function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { s.proc.stdin.end(); } catch (_) {}
  try { s.proc.kill("SIGHUP"); } catch (_) {}
  setTimeout(() => { try { s.proc.kill("SIGKILL"); } catch (_) {} }, 1500).unref?.();
  wakeAll(s);
}

// ---- input method ---------------------------------------------------------

// Settings: read once and then kept current by the host's change event (see onLoad); without that
// event they are re-read at most once per TTL. The first focus waits for the real value so a plugin
// with the switch turned off never flips the layout even once.
async function imeSettings() {
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
  const v = settingsCache.value || {};
  return {
    enabled: v.imeAutoSwitch === true, // off unless the user turns it on
    target: typeof v.imeTarget === "string" && v.imeTarget ? v.imeTarget : IME_DEFAULT_TARGET,
  };
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
    case "term.open":
      return openSession(p);
    case "term.attach": {
      const s = need(p.id);
      s.gen++;
      wakeAll(s); // release any stale long-poll from the previous owner
      // A new reader starts at the oldest retained output: the replay below carries everything the
      // ring still holds, and nextSeq says where to resume so no output is served twice.
      s.cursor = s.ring.earliestSeq;
      s.lastPollAt = Date.now();
      if (s.paused) {
        s.paused = false;
        if (s.pauseTimer) { clearTimeout(s.pauseTimer); s.pauseTimer = null; }
        try { s.proc.stdout.resume(); } catch (_) {}
      }
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
      return {
        key: cur.key,
        sessions: [...sessions.values()].map((s) => ({ id: s.id, key: s.key, exited: s.exited })),
      };
    }
    case "term.write": {
      const s = need(p.id);
      if (!s.exited && typeof p.data === "string") s.proc.stdin.write(Buffer.from(p.data, "utf8"));
      return { ok: true };
    }
    case "term.resize": {
      const s = need(p.id);
      if (!s.exited) {
        const c = Math.max(2, Math.min(1000, p.cols | 0));
        const r = Math.max(2, Math.min(1000, p.rows | 0));
        s.proc.stdio[3].write(`R ${c} ${r}\n`);
      }
      return { ok: true };
    }
    case "term.poll":
      return poll(need(p.id), p.gen | 0, p.from);
    case "term.close":
      closeSession(p.id);
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

async function onLoad() {
  try {
    if (typeof pi !== "undefined" && pi.events && typeof pi.events.on === "function") {
      pi.events.on(SETTINGS_EVENT, onSettingsChanged);
      settingsLive = true;
    }
  } catch (_) {
    /* no event API: the TTL read still works */
  }
}

async function onUnload() {
  try {
    if (settingsLive) pi.events.off(SETTINGS_EVENT, onSettingsChanged);
  } catch (_) {}
  settingsLive = false;
  for (const id of [...sessions.keys()]) closeSession(id);
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
