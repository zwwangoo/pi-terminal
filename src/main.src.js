"use strict";
/**
 * Terminal — embedded PTY terminal for the PI-Desktop work panel.
 *
 * The panel (xterm.js) talks to this process through pluginBridge.invoke("term.*") -> onPanelInvoke.
 * Output is delivered by long-polling "term.poll" (the host has no plugin->panel push API).
 * The shell runs behind a tiny python3 PTY relay (embedded below, no native modules).
 */
const { spawn } = require("node:child_process");

const RELAY_SRC = __RELAY_SRC__;
const MAX_PENDING = 4 * 1024 * 1024; // pause the shell when the panel falls this far behind
const RING_MAX = 256 * 1024; // scrollback replayed when the panel reattaches
const POLL_HOLD_MS = 1500;
const POLL_CHUNK = 256 * 1024;

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

// The panel may pass the workspace it is showing (p.ws); otherwise use the host's current one.
async function currentWorkspace(hint) {
  if (hint && typeof hint.path === "string" && hint.path) return { cwd: hint.path, key: wsKey(hint) };
  try {
    const ws = await pi.workspace.get();
    if (ws && ws.path) return { cwd: ws.path, key: wsKey(ws) };
  } catch (_) {
    /* no workspace: fall back to home inside the relay */
  }
  return { cwd: "", key: wsKey(null) };
}

async function openSession({ cols, rows, ws }) {
  const { cwd, key } = await currentWorkspace(ws);
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
  if (gen !== s.gen) return { data: "", more: false, exited: false, superseded: true };
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
  if (gen !== s.gen) return { data: "", more: false, exited: false, superseded: true };
  const buf = drain(s);
  return {
    data: buf.toString("base64"),
    more: s.pendingBytes > 0,
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

async function onPanelInvoke(channel, p) {
  p = p || {};
  switch (channel) {
    case "term.open":
      return openSession(p);
    case "term.attach": {
      const s = need(p.id);
      s.gen++;
      wakeAll(s); // release any stale long-poll from the previous owner
      s.pending = [];
      s.pendingBytes = 0;
      if (s.paused) { s.paused = false; s.proc.stdout.resume(); }
      return { replay: s.ring.toString("base64"), cwd: s.cwd, exited: s.exited, gen: s.gen };
    }
    case "term.list": {
      const cur = await currentWorkspace(p.ws);
      return {
        key: cur.key,
        sessions: [...sessions.values()].map((s) => ({ id: s.id, cwd: s.cwd, key: s.key, exited: s.exited })),
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
}

module.exports = { onLoad, onUnload, onPanelInvoke };
