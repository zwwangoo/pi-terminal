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
const os = require("node:os");
const path = require("node:path");
const { RingBuffer } = require("./ring-buffer.js");

const REMOTE_PREFIX = "remote-project:"; // path token of a project that lives on a remote host

const RELAY_SRC = __RELAY_SRC__;
const RING_MAX = 1024 * 1024; // output retained per session; also the replay cap when a panel reattaches
const PAUSE_ABOVE = 512 * 1024; // pause the pty when an attached, actively polling reader is this far behind
const RESUME_BELOW = 128 * 1024; // resume it once that reader has caught up to here
const READER_IDLE_MS = 5000; // no poll for this long means nobody is reading: trim instead of pausing
const POLL_HOLD_MS = 1500;
const WATCH_HOLD_MS = 1200; // shorter than the host's per-call budget, like POLL_HOLD_MS
const WATCH_TICK_MS = 300;
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
const SESSION_EVENT = "session:activated";
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

// Which conversation a terminal belongs to: the host's selected session ("s:<sessionId>"), else the project
// (projectId when the host provides one, else the primary folder path).
function wsKey(ws, sessionId) {
  if (sessionId) return "s:" + sessionId;
  if (ws && typeof ws.projectId === "string" && ws.projectId) return "p:" + ws.projectId;
  return "r:" + ((ws && ws.path) || "");
}

// The session on screen, or null: getActive refuses when the plugin is not active in the project.
async function activeSession() {
  try {
    return await pi.session.getActive();
  } catch (_) {
    return null;
  }
}

// Terminals belong to the host's selected session; the project is the fallback.
async function currentWorkspace() {
  const snap = await activeSession();
  let ws = null;
  try {
    ws = await pi.workspace.get();
  } catch (_) {
    /* no workspace: the relay falls back to home */
  }
  const key = wsKey(ws, snap && snap.sessionId);
  // A remote project is never a local directory: its path is a "remote-project:<id>" token and the real
  // directory lives on the host (ws.remote.path). It must never fall back to a local shell.
  if (ws && ((typeof ws.path === "string" && ws.path.startsWith(REMOTE_PREFIX)) || ws.remote)) {
    return { cwd: "", key, remote: { projectPath: ws.path || "", path: (ws.remote && ws.remote.path) || "" } };
  }
  return { cwd: (ws && ws.path) || "", key, remote: null };
}

// Shells are tied to conversations now, and the host reports no event when one is deleted, so the
// number of live background shells is capped: past the cap the one nobody has touched for longest goes.
// tmux sessions are exempt: keeping a shell alive across restarts is what that mode is for, and the user
// ends those by closing the tab or with the "end all tmux sessions" command.
const MAX_LIVE = 32;
function evictIdle(keepKey) {
  const live = [...sessions.values()].filter((s) => !s.exited && !s.tmux);
  if (live.length < MAX_LIVE) return;
  let victim = null;
  for (const s of live) {
    if (s.key === keepKey) continue;
    const at = s.lastPollAt;
    if (!victim || at < victim.at) victim = { s, at };
  }
  if (victim) closeSession(victim.s.id, true);
}

// The answer to term.list / term.watch. Looking up tmux sessions an earlier run left behind happens here,
// once per off -> on change of the tmuxMode switch (with the switch off they stay invisible).
async function listPayload(cur) {
  const on = await tmuxOn();
  if (!on) {
    discovered = false;
    remoteDiscovered.clear();
  } else {
    if (!discovered) await discoverTmux().catch(() => {});
    if (cur.remote) {
      const r = await resolveRemote(cur.remote);
      // Never wait for the host longer than the panel can: an unreachable one must not hold up the list.
      if (r.target) await withinMs(discoverRemoteTmux(r).catch(() => {}), REMOTE_LIST_WAIT_MS);
    }
  }
  return {
    key: cur.key,
    // New tabs are tmux ones right now (mode on and a tmux binary exists; on a remote host tmux is looked
    // for there, when the tab is opened). The panel uses it to move a conversation that only has plain
    // shells (opened while the mode was off) over to tmux.
    tmuxWanted: on && (cur.remote ? true : !!tmuxBinary()),
    // For a tmux session "exited" means the session is gone, not that this client left: a session
    // detached with the tmux prefix is still alive and gets re-attached.
    // In a remote project only remote shells belong to the conversation. A local one under the same key is
    // left over from before the project was remote (or from a plugin version without remote support): it
    // is not offered, so the panel opens a remote tab instead of silently reattaching to a local shell.
    // It keeps running until its tab is ended with "end all tmux sessions".
    sessions: [...sessions.values()].filter((s) => !cur.remote || s.remote || s.key !== cur.key).map((s) => ({
      id: s.id, key: s.key, exited: s.tmux ? s.gone : s.exited, tmux: !!s.tmux, remote: s.remote ? s.remote.target.label : "",
    })),
  };
}

// Long-poll for "the selection moved away from `key`": answers the moment it does, or with changed:false
// after WATCH_HOLD_MS so the panel just asks again. The host's session event wakes it at once; the
// WATCH_TICK_MS re-read is only the safety net for a host that does not deliver that event. The panel
// gets the full list back, so it does not need a second round trip to restore the new key's terminals.
const watchWaiters = [];
function wakeWatchers() {
  const w = watchWaiters.splice(0);
  for (const fn of w) fn();
}
async function watchKey(key) {
  const until = Date.now() + WATCH_HOLD_MS;
  for (;;) {
    const cur = await currentWorkspace();
    if (cur.key !== key) return { changed: true, ...(await listPayload(cur)) };
    const left = until - Date.now();
    if (left <= 0) return { changed: false, ...(await listPayload(cur)) };
    await new Promise((resolve) => {
      const t = setTimeout(done, Math.min(WATCH_TICK_MS, left));
      function done() {
        clearTimeout(t);
        const i = watchWaiters.indexOf(done);
        if (i >= 0) watchWaiters.splice(i, 1);
        resolve();
      }
      watchWaiters.push(done);
    });
  }
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

// Run a program to completion and collect its output; resolves {ok, out, err}, never rejects.
function spawnCapture(bin, args, env, timeoutMs) {
  return new Promise((resolve) => {
    let out = "", err = "", settled = false, child;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { if (child) child.kill("SIGKILL"); } catch (_) {}
      done({ ok: false, out, err: "timed out" });
    }, timeoutMs);
    timer.unref?.();
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
    } catch (e) {
      return done({ ok: false, out, err: String((e && e.message) || e) });
    }
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.on("error", (e) => done({ ok: false, out, err: String((e && e.message) || e) }));
    child.on("close", (code) => done({ ok: code === 0, code, out, err: err.trim() }));
  });
}

// One tmux call against the private server; resolves {ok, out, err} and never rejects on a non-zero exit.
function tmuxRun(args) {
  const bin = tmuxBinary();
  if (!bin) return Promise.reject(new Error("tmux not found"));
  // -u: assume a UTF-8 terminal, or tmux replaces non-ASCII text (a Chinese project path) with "_".
  return spawnCapture(bin, ["-u", "-L", tmuxSocket(), ...args], relayEnv("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"), TMUX_TIMEOUT_MS).then(
    (r) => (r.err === "timed out" ? { ...r, err: "tmux timed out" } : r),
  );
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

// Whether the tmux session of `s` exists (on its remote host when it has one).
async function tmuxHas(s) {
  try {
    const args = ["has-session", "-t", "=" + s.id];
    if (!s.remote) return (await tmuxRun(args)).ok;
    // Only an answer from tmux counts: 1 is its "no such session", 127 means tmux is gone from the host.
    // An ssh failure (255) or a timeout says nothing about the session, and a dropped network must not
    // close the tab of a shell that is still alive.
    const r = await remoteTmuxRun(s.remote.target, args, REMOTE_CHECK_TIMEOUT_MS);
    return r.ok || (r.code !== 1 && r.code !== 127);
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

// The same for a remote host's tmux server. Looked up once per host: concurrent callers share the one ssh
// call (a second term.list must not conclude "nothing there" while the first is still asking), and after a
// failure it is retried only after a pause, because an unreachable host would stall every term.list by the
// ssh timeout.
const remoteDiscovered = new Map(); // hostKey -> { ok, at, p }
function discoverRemoteTmux(remote) {
  const h = remote.target.hostKey;
  const prev = remoteDiscovered.get(h);
  if (prev && (prev.p || prev.ok || Date.now() - prev.at < REMOTE_DISCOVER_RETRY_MS)) return prev.p || Promise.resolve();
  const entry = { ok: false, at: Date.now(), p: null };
  remoteDiscovered.set(h, entry);
  entry.p = (async () => {
    const r = await remoteTmuxRun(remote.target, ["list-sessions", "-F", ["#{session_name}", "#{@pi_key}", "#{session_path}"].join(TMUX_SEP)]);
    if (remoteDiscovered.get(h) !== entry) return; // forgotten meanwhile (end-all, tmuxMode switched off)
    entry.at = Date.now();
    // exit 1 with no server is "nothing survived"; any other failure (ssh, timeout) is retried later
    if (!r.ok && r.code !== 1) return;
    entry.ok = true;
    for (const line of r.ok ? r.out.split("\n") : []) {
      const [name, key, cwd] = line.split(TMUX_SEP);
      if (!name || !name.startsWith(TMUX_PREFIX) || sessions.has(name)) continue;
      sessions.set(name, newSession(name, cwd || "", key || "", 80, 24, true, { target: remote.target, path: cwd || remote.path }));
    }
  })().finally(() => { entry.p = null; });
  return entry.p;
}

// Waits for a lookup, but not for longer than the panel should wait to draw: on a slow or unreachable host
// the list is answered without it, and the sessions it finds show up in a later list.
function withinMs(p, ms) {
  let t;
  return Promise.race([p, new Promise((resolve) => { t = setTimeout(resolve, ms); })]).finally(() => clearTimeout(t));
}

async function killAllTmux() {
  if (tmuxBinary()) await tmuxRun(["kill-server"]);
  // Remote hosts: the ones that still have a session here, and the current project's host. This ends every
  // session on the plugin's private socket there, also ones another computer opened on the same host.
  const targets = new Map();
  for (const s of sessions.values()) if (s.tmux && s.remote) targets.set(s.remote.target.hostKey, s.remote.target);
  const cur = await currentWorkspace().catch(() => null);
  if (cur && cur.remote) {
    const r = await resolveRemote(cur.remote);
    if (r.target) targets.set(r.target.hostKey, r.target);
  }
  for (const h of targets.keys()) remoteDiscovered.delete(h);
  await Promise.all([...targets.values()].map((t) => remoteTmuxRun(t, ["kill-server"])));
  // Sessions with a relay notice by themselves (the client exits, has-session fails). The ones that
  // were only discovered have no relay to notice anything, so drop them here.
  for (const [id, s] of [...sessions]) if (s.tmux && !s.proc) closeSession(id, false);
}

// ---- remote projects (ssh) ----------------------------------------------------
//
// A project that lives on a remote host has the path token "remote-project:<id>" and the host reports
// the real directory as workspace.remote.path. The shell then runs on that host, behind ssh: the relay
// still owns a local pty, it just runs `ssh -tt ...` on it instead of a login shell. Which host the
// project belongs to is not part of the workspace info, so it is looked up in the host's own data:
//   1. the plugin setting remoteHost (hostKey or label), when set;
//   2. the project group record (kv "projectGroups" in pi.sqlite, read-only through the sqlite3 CLI);
//   3. the only host with SSH connection info in remote-hosts.json.
// Anything else is an error shown in the terminal. A remote project never falls back to a local shell.
const SSH_CONNECT_TIMEOUT = 10;
const REMOTE_TTL_MS = 10000;
const REMOTE_FAIL_TTL_MS = 3000;
const REMOTE_DISCOVER_RETRY_MS = 30000;
const REMOTE_LIST_WAIT_MS = 3000; // how long a term.list waits for a host's tmux lookup before answering without it
const REMOTE_CHECK_TIMEOUT_MS = 8000; // one quick ssh check (has-session, tmux -V)
const SQLITE_CANDIDATES = ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"];
// The remote command line is parsed by the remote login shell, which may be fish: every value goes
// into single quotes and may contain neither ' nor \ (both mean something different in fish and sh).
// PATH is extended because a non-interactive ssh command often lacks Homebrew's directories.
const R_PATH = 'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; export PATH; ';

function dataDir() {
  return process.env.PI_TERMINAL_DATA_DIR || process.env.PI_DESKTOP_DATA_DIR || path.join(os.homedir(), ".pi-desktop");
}

function expandHome(p) {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

function shq(s) {
  s = String(s);
  if (/['\\\u0000-\u001f\u007f]/.test(s)) throw new Error("unsupported character (quote, backslash or control) in remote value: " + JSON.stringify(s));
  return "'" + s + "'";
}

function cleanKey(k) {
  return String(k || "").replace(/['\\\u0000-\u001f\u007f]/g, "_");
}

// Hosts with SSH connection info in the host's remote-hosts.json (the file the desktop app keeps). The file
// is parsed whole, but only these connection fields are picked out: nothing else in it (the stored device
// tokens included) is kept or used. `invalid` lists hosts whose address or user cannot be put on a command line.
function readSshHosts() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dataDir(), "remote-hosts.json"), "utf8"));
  } catch (_) {
    return { hosts: [], invalid: [] };
  }
  const hosts = [], invalid = [];
  for (const h of raw && Array.isArray(raw.hosts) ? raw.hosts : []) {
    const ssh = h && h.metadata && h.metadata.ssh;
    if (!h || typeof h.hostKey !== "string" || !ssh || typeof ssh.host !== "string") continue;
    // These go onto an ssh command line: no leading "-" (option injection), no odd characters.
    const user = typeof ssh.user === "string" ? ssh.user : "";
    if (!/^[A-Za-z0-9._:\-]+$/.test(ssh.host) || ssh.host.startsWith("-") || (user && (!/^[A-Za-z0-9._\-]+$/.test(user) || user.startsWith("-")))) {
      invalid.push(h.hostKey);
      continue;
    }
    hosts.push({
      hostKey: h.hostKey,
      label: typeof h.label === "string" && h.label ? h.label : h.hostKey,
      host: ssh.host,
      port: Number.isInteger(ssh.port) && ssh.port > 0 && ssh.port < 65536 ? ssh.port : 22,
      user,
      identityFile: typeof ssh.identityFile === "string" ? ssh.identityFile : "",
    });
  }
  return { hosts, invalid };
}

function sqliteBinary() {
  const override = process.env.PI_TERMINAL_SQLITE;
  for (const p of override ? [override] : SQLITE_CANDIDATES) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) {
      /* try the next one */
    }
  }
  return null;
}

// The project group record of a remote project: {hostKey, path}, or null when it cannot be read.
async function lookupProjectBinding(projectPath) {
  if (!projectPath.startsWith(REMOTE_PREFIX)) return null;
  const id = projectPath.slice(REMOTE_PREFIX.length);
  const bin = sqliteBinary();
  const db = path.join(dataDir(), "pi.sqlite");
  if (!bin || !/^[A-Za-z0-9_\-]{1,80}$/.test(id) || !fs.existsSync(db)) return null;
  const r = await spawnCapture(
    bin,
    ["-readonly", "-cmd", ".timeout 1500", db, "select value_json from kv where ns='projectGroups' and key='" + id + "'"],
    { PATH: "/usr/bin:/bin" },
    4000,
  );
  if (!r.ok || !r.out.trim()) return null;
  try {
    const remote = JSON.parse(r.out.trim()).remote;
    if (remote && typeof remote.hostKey === "string") {
      return { hostKey: remote.hostKey, path: typeof remote.path === "string" ? remote.path : "" };
    }
  } catch (_) {
    /* unreadable record */
  }
  return null;
}

// Which host a remote project runs on. The project's own binding (what the desktop app recorded when the
// project was added) is authoritative. The remoteHost setting only stands in when the binding cannot be
// read; it never overrides it, so a project is never sent to a machine other than its own. There is
// deliberately no "the only SSH host" guess either: with the binding unreadable that guess can pick the
// wrong machine, and the commands would run there.
async function resolveRemoteNow(remote, pref) {
  const { hosts, invalid } = readSshHosts();
  const names = hosts.map((h) => h.label + " (" + h.hostKey + ")").join(", ") || "none";
  const b = await lookupProjectBinding(remote.projectPath).catch(() => null);
  let hostKey = b ? b.hostKey : "";
  const rpath = remote.path || (b ? b.path : "");
  if (!hostKey) {
    if (!pref) {
      throw new Error("cannot tell which remote host this project belongs to (its binding could not be read); set the plugin setting remoteHost (hosts with SSH info: " + names + ")");
    }
    const h = hosts.find((x) => x.hostKey === pref) || hosts.find((x) => x.label.toLowerCase() === pref.toLowerCase());
    if (!h) throw new Error('setting remoteHost "' + pref + '" matches no SSH host in remote-hosts.json (hosts with SSH info: ' + names + ")");
    hostKey = h.hostKey;
  }
  const target = hosts.find((x) => x.hostKey === hostKey);
  if (!target) {
    if (invalid.includes(hostKey)) {
      throw new Error("remote host " + hostKey + " has SSH connection info with characters this plugin refuses to put on a command line (host or user name)");
    }
    throw new Error("remote host " + hostKey + " has no SSH connection info in remote-hosts.json (it was not added over SSH), so the terminal cannot reach it");
  }
  if (!rpath) throw new Error("the remote project has no directory on " + target.label);
  shq(rpath); // refuses a directory the remote command line cannot carry safely
  return { target, path: rpath };
}

const remoteCache = new Map();
// Resolved once per project for a few seconds: term.watch asks every second, and every miss reads
// files and spawns sqlite3.
async function resolveRemote(remote) {
  const v = (await rawSettings()).remoteHost;
  const pref = typeof v === "string" ? v.trim() : "";
  const ck = remote.projectPath + "\n" + remote.path + "\n" + pref;
  const hit = remoteCache.get(ck);
  if (hit && Date.now() < hit.until) return hit.value;
  let value;
  try {
    value = await resolveRemoteNow(remote, pref);
  } catch (e) {
    value = { error: String((e && e.message) || e) };
  }
  if (remoteCache.size > 64) remoteCache.clear();
  remoteCache.set(ck, { value, until: Date.now() + (value.error ? REMOTE_FAIL_TTL_MS : REMOTE_TTL_MS) });
  return value;
}

function sshBinary() {
  return process.env.PI_TERMINAL_SSH || "ssh";
}

// argv of an ssh call. tty=true is the interactive terminal (needs a pty), false is a one-off command.
function sshArgv(t, tty, remoteCmd) {
  const a = [
    sshBinary(), tty ? "-tt" : "-T",
    "-o", "BatchMode=yes", // never ask for a password or passphrase: there is nobody to type it into
    "-o", "ConnectTimeout=" + SSH_CONNECT_TIMEOUT,
    "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "LogLevel=ERROR",
  ];
  if (t.identityFile) a.push("-i", expandHome(t.identityFile), "-o", "IdentitiesOnly=yes");
  a.push("-p", String(t.port), (t.user ? t.user + "@" : "") + t.host, remoteCmd);
  return a;
}

// Login shell in the project directory ($1). The directory is an argument, not part of the script.
function remoteShellCommand(rpath) {
  return "sh -c " + shq(R_PATH + 'cd "$1" && exec "${SHELL:-/bin/sh}" -l') + " sh " + shq(rpath);
}

// tmux on the remote host, private socket: $1 directory, $2 socket, $3 session, $4 project key, $5 1 = create.
// Same logic as relay.py's local tmux mode (create when missing, minimal config only when the user has none,
// tag the session with its key, attach and detach other clients).
const TMUX_REMOTE_SCRIPT = [
  R_PATH,
  'command -v tmux >/dev/null 2>&1 || { echo "pi-terminal: tmux is not installed on this host (install it or turn off tmuxMode)"; exit 127; };',
  't() { tmux -u -L "$S" "$@"; };',
  'S="$2"; N="$3";',
  'if ! t has-session -t "=$N" 2>/dev/null; then',
  '[ "$5" = 1 ] || { echo "pi-terminal: tmux session $N no longer exists"; exit 1; };',
  't new-session -d -s "$N" -c "$1" "${SHELL:-/bin/sh}" -l || exit 1;',
  'if [ ! -f "$HOME/.tmux.conf" ] && [ ! -f "${XDG_CONFIG_HOME:-$HOME/.config}/tmux/tmux.conf" ]; then',
  "t set -g status off; t set -g mouse on; t set -g history-limit 20000; t set -g escape-time 10;",
  't set -g focus-events on; t set -g set-clipboard on; t set -ga terminal-features "xterm-256color:RGB";',
  "fi; fi;",
  'if [ -n "$4" ]; then t set-option -t "=$N:" @pi_key "$4"; fi;',
  'exec tmux -u -L "$S" attach-session -d -t "=$N"',
].join(" ");

// For an attach (create = 0) the directory is not used, so a session whose recorded path the command line
// cannot carry (a quote in it) can still be reattached.
function remoteTmuxCommand(name, key, rpath, create) {
  return ["sh -c", shq(TMUX_REMOTE_SCRIPT), "sh", shq(create ? rpath : "/"), shq(tmuxSocket()), shq(name), shq(cleanKey(key)), create ? "1" : "0"].join(" ");
}

// What startRelay hands the relay for a remote session: the whole ssh command.
function remoteSpec(remote, tmuxName2, key, create) {
  const cmd = tmuxName2 ? remoteTmuxCommand(tmuxName2, key, remote.path, create) : remoteShellCommand(remote.path);
  return { exec: sshArgv(remote.target, true, cmd) };
}

// One tmux call on a remote host (no pty); resolves {ok, code, out, err} like tmuxRun. code is tmux's own
// exit status (1: no such session / no server, 127: no tmux on the host) or ssh's (255: could not connect).
function remoteTmuxRun(target, args, timeoutMs) {
  let cmd;
  try {
    cmd = "sh -c " + shq(R_PATH + 'exec tmux -u -L "$@"') + " sh " + [tmuxSocket(), ...args].map(shq).join(" ");
  } catch (e) {
    return Promise.resolve({ ok: false, out: "", err: String(e.message || e) });
  }
  const a = sshArgv(target, false, cmd);
  return spawnCapture(a[0], a.slice(1), { ...process.env }, timeoutMs || (SSH_CONNECT_TIMEOUT + 6) * 1000);
}

// What an ssh failure says, cut down to something one line of the panel can show.
function sshFailure(target, r) {
  const why = (r.err || "exit " + r.code).split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300);
  return new Error("cannot reach " + target.label + " over ssh: " + why);
}

// Checked before a tab is opened on a host, in one ssh call: the host answers, tmux is there (tmux tabs),
// and the project directory can be entered. Each failure has to be an error the panel shows, not a tab
// whose shell dies at once: the panel would open a fresh one, again and again.
const PREFLIGHT_SCRIPT = R_PATH + 'if [ "$2" = 1 ]; then command -v tmux >/dev/null 2>&1 || exit 127; fi; cd "$1"';
async function remotePreflight(remote, needTmux) {
  const cmd = "sh -c " + shq(PREFLIGHT_SCRIPT) + " sh " + shq(remote.path) + " " + (needTmux ? "1" : "0");
  const a = sshArgv(remote.target, false, cmd);
  const r = await spawnCapture(a[0], a.slice(1), { ...process.env }, REMOTE_CHECK_TIMEOUT_MS);
  if (r.ok) return;
  const label = remote.target.label;
  if (needTmux && r.code === 127) throw new Error("tmux is not installed on " + label + " (install it there, or turn off tmuxMode)");
  if (r.code === 255 || r.code === undefined) throw sshFailure(remote.target, r);
  const why = (r.err || "").split("\n").filter(Boolean).slice(-1)[0] || "";
  throw new Error("cannot enter " + remote.path + " on " + label + (why ? ": " + why.slice(0, 200) : ""));
}

// ---- sessions ------------------------------------------------------------------

function clampDim(v, fallback) {
  return Math.max(2, Math.min(1000, (v | 0) || fallback || 80));
}

// `remote` is {target, path} for a shell that runs on a remote host over ssh, else null.
function newSession(id, cwd, key, cols, rows, tmux, remote) {
  return {
    id, proc: null, cwd, key, cols, rows, tmux: !!tmux, remote: remote || null,
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
  // A remote shell has no local directory: ssh starts it in the project directory on the host.
  const args = ["-c", RELAY_SRC, s.remote ? "" : s.cwd, String(cols), String(rows)];
  if (spec) args.push(JSON.stringify(spec));
  const env = relayEnv("/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin");
  // ssh finds the key in the agent through this socket; the relay otherwise starts with a bare environment.
  if (s.remote && process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  const proc = spawn("python3", args, { stdio: ["pipe", "pipe", "pipe", "pipe"], env });
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
      const alive = await tmuxHas(s);
      if (s.proc !== proc) return;
      s.gone = !alive;
    }
    s.exited = true;
    s.exitCode = code;
    wakeAll(s);
  });
}

async function openSession({ cols, rows, key: wantKey }) {
  const cur = await currentWorkspace();
  const cwd = cur.cwd;
  const key = wantKey || cur.key;
  evictIdle(key);
  const c = clampDim(cols, 80);
  const r = clampDim(rows, 24);
  const n = ++seq;
  let id = "t" + n;
  let spec = null;
  let remote = null;
  if (cur.remote) {
    // A remote project: any failure to find or reach its host is an error here, never a local shell.
    const found = await resolveRemote(cur.remote);
    if (found.error) throw new Error(found.error);
    remote = { target: found.target, path: found.path };
  }
  const useTmux = await tmuxOn();
  if (useTmux) {
    // On means tmux: a missing binary is an error (thrown by tmuxSpec), not a fall back to a plain shell.
    // On a remote host that is checked there first, so the reason reaches the panel.
    if (remote) await remotePreflight(remote, true);
    id = tmuxName(key, n);
    spec = remote ? remoteSpec(remote, id, key, true) : tmuxSpec(id, key, true);
  } else if (remote) {
    await remotePreflight(remote, false);
    spec = remoteSpec(remote, null, key, false);
  }
  const s = newSession(id, cwd || (remote ? remote.path : ""), key, c, r, useTmux, remote);
  sessions.set(id, s);
  startRelay(s, c, r, spec);
  return { id, cwd: s.cwd, key, gen: 0, tmux: useTmux, remote: remote ? remote.target.label : "" };
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
  if (s.tmux && kill) {
    const args = ["kill-session", "-t", "=" + s.id];
    (s.remote ? remoteTmuxRun(s.remote.target, args) : tmuxRun(args)).catch(() => {});
  }
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
        startRelay(s, cols, rows, s.remote ? remoteSpec(s.remote, s.id, "", false) : tmuxSpec(s.id, "", false));
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
    case "term.list":
      return listPayload(await currentWorkspace());
    case "term.watch":
      return watchKey(p.key);
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
      // The host sends the session event to this process only (panels never get it): it just wakes
      // term.watch, which then re-reads the selection itself.
      pi.events.on(SESSION_EVENT, wakeWatchers);
      settingsLive = true;
    }
  } catch (_) {
    /* no event API: the TTL read still works, and term.watch notices a switch on its own tick */
  }
  await registerOpenCommand();
  await registerKillTmuxCommand();
}

async function onUnload() {
  try {
    if (settingsLive) {
      pi.events.off(SETTINGS_EVENT, onSettingsChanged);
      pi.events.off(SESSION_EVENT, wakeWatchers);
    }
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
