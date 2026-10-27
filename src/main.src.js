"use strict";
/**
 * Terminal — embedded PTY terminal for the PI-Desktop work panel.
 *
 * The panel (xterm.js) talks to this process through pluginBridge.invoke("term.*") -> onPanelInvoke.
 * Output is delivered by long-polling "term.poll" (the host has no plugin->panel push API).
 * The shell runs behind a tiny python3 PTY relay (embedded below, no native modules).
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const RELAY_SRC = __RELAY_SRC__;
const MAX_PENDING = 4 * 1024 * 1024; // pause the shell when the panel falls this far behind
const RING_MAX = 256 * 1024; // scrollback replayed when the panel reattaches
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
let imeBin; // undefined: not resolved yet, null: unavailable
let imeSaved = ""; // input source to put back when the panel loses focus
let imeFocused = false; // what this process believes the panel's focus state is
let imeSeq = 0; // newer focus/blur edge wins over one still in flight
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
    pending: [], pendingBytes: 0,
    ring: Buffer.alloc(0),
    exited: false, exitCode: null, err: "",
    waiters: [], paused: false, gen: 0,
  };
  sessions.set(id, s);
  proc.stdout.on("data", (d) => {
    s.pending.push(d);
    s.pendingBytes += d.length;
    s.ring = Buffer.concat([s.ring, d]);
    if (s.ring.length > RING_MAX) s.ring = s.ring.subarray(s.ring.length - RING_MAX);
    if (s.pendingBytes > MAX_PENDING && !s.paused) {
      s.paused = true;
      proc.stdout.pause();
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

function drain(s) {
  let buf = Buffer.concat(s.pending);
  let rest = null;
  if (buf.length > POLL_CHUNK) {
    rest = buf.subarray(POLL_CHUNK);
    buf = buf.subarray(0, POLL_CHUNK);
  }
  s.pending = rest ? [rest] : [];
  s.pendingBytes = rest ? rest.length : 0;
  if (s.paused && s.pendingBytes < MAX_PENDING / 2) {
    s.paused = false;
    s.proc.stdout.resume();
  }
  return buf;
}

async function poll(s, gen) {
  if (gen !== s.gen) return { data: "", exited: false, superseded: true };
  if (!s.pending.length && !s.exited) {
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
  if (gen !== s.gen) return { data: "", exited: false, superseded: true };
  const buf = drain(s);
  return {
    data: buf.toString("base64"),
    exited: s.exited && s.pendingBytes === 0,
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

// Settings are read at most once per TTL; the first focus waits for the real value so a plugin
// with the switch turned off never flips the layout even once.
async function imeSettings() {
  if (Date.now() - settingsCache.at > SETTINGS_TTL_MS) {
    try {
      const read = typeof pi !== "undefined" && pi.plugin && pi.plugin.getSettings;
      const v = read ? await pi.plugin.getSettings() : null;
      settingsCache = { at: Date.now(), value: v && typeof v === "object" ? v : {} };
    } catch (_) {
      // A failed read must not be cached: keep the last known value and retry on the next edge.
      settingsCache = { at: 0, value: settingsCache.value };
    }
  }
  const v = settingsCache.value || {};
  return {
    enabled: v.imeAutoSwitch === true, // off unless the user turns it on
    target: typeof v.imeTarget === "string" && v.imeTarget ? v.imeTarget : IME_DEFAULT_TARGET,
  };
}

// im-select on a non-standard prefix, or the stub a test points us at.
function imeBinary() {
  if (imeBin !== undefined) return imeBin;
  imeBin = null;
  if (process.platform !== "darwin") return imeBin;
  const candidates = [process.env.PI_TERMINAL_IM_SELECT]
    .concat(IME_CANDIDATES)
    .filter((p) => typeof p === "string" && p);
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
    child.on("error", (e) => done({ ok: false, error: String((e && e.message) || e) }));
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
function imeSync(focused) {
  const run = () => imeSyncNow(focused === true);
  imeChain = imeChain.then(run, run);
  return imeChain;
}

/**
 * The panel reports a focus edge; we own the state machine.
 *
 * Focus: remember the input source the user was on, then switch to English.
 * Blur: put that source back, unless the current one is no longer our target
 * (the user changed it by hand while the terminal had focus - leave it alone).
 * Duplicate edges are ignored so the remembered value cannot be overwritten
 * with our own switch.
 */
async function imeSyncNow(focused) {
  const cfg = await imeSettings();
  if (!cfg.enabled) return { ok: true, switched: false, reason: "disabled" };
  if (process.platform !== "darwin") return { ok: true, switched: false, reason: "unsupported-platform" };
  if (!imeBinary()) return { ok: true, switched: false, reason: "im-select-missing" };
  focused = focused === true;
  if (focused === imeFocused && !(focused && !imeSaved)) {
    return { ok: true, switched: false, reason: "unchanged", focused };
  }
  const mine = ++imeSeq;
  if (focused) {
    imeFocused = true;
    const cur = await imeRun("");
    if (mine !== imeSeq) return { ok: true, switched: false, reason: "superseded" };
    if (!cur.ok) return { ok: false, error: cur.error || "im-select read failed" };
    const from = cur.id || "";
    if (!from || from === cfg.target) return { ok: true, switched: false, focused: true, id: from };
    imeSaved = from;
    const set = await imeRun(cfg.target);
    if (mine !== imeSeq) return { ok: true, switched: false, reason: "superseded" };
    if (!set.ok) imeSaved = "";
    return { ok: set.ok, switched: set.ok, from, to: cfg.target, error: set.error };
  }
  imeFocused = false;
  const restore = imeSaved;
  if (!restore) return { ok: true, switched: false, reason: "nothing-to-restore" };
  const cur = await imeRun("");
  if (mine !== imeSeq) return { ok: true, switched: false, reason: "superseded" };
  if (cur.ok && cur.id && cur.id !== cfg.target) {
    imeSaved = ""; // the user picked another source by hand: forget ours
    return { ok: true, switched: false, reason: "user-changed", id: cur.id };
  }
  const set = await imeRun(restore);
  if (mine !== imeSeq) return { ok: true, switched: false, reason: "superseded" };
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
    focused: imeFocused,
    saved: imeSaved,
  };
}

async function onPanelInvoke(channel, p) {
  p = p || {};
  switch (channel) {
    case "ime.sync":
      return imeSync(p.focused === true);
    case "ime.state":
      return imeState();
    case "term.open":
      return openSession(p);
    case "term.attach": {
      const s = need(p.id);
      s.gen++;
      wakeAll(s); // release any stale long-poll from the previous owner
      s.pending = [];
      s.pendingBytes = 0;
      if (s.paused) { s.paused = false; s.proc.stdout.resume(); }
      return { replay: s.ring.toString("base64"), gen: s.gen };
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
      return poll(need(p.id), p.gen | 0);
    case "term.close":
      closeSession(p.id);
      return { ok: true };
    default:
      throw new Error("unsupported panel channel: " + channel);
  }
}

async function onLoad() {}

async function onUnload() {
  for (const id of [...sessions.keys()]) closeSession(id);
  // Never leave the user stuck on the English layout because the plugin went away: let any queued
  // edge finish first, then put the remembered source back.
  await imeChain.catch(() => {});
  if (imeSaved) {
    const restore = imeSaved;
    imeSaved = "";
    imeFocused = false;
    imeSeq++;
    await imeRun(restore);
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };
