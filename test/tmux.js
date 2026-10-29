// tmuxMode: a tab backed by a private tmux server survives the plugin being unloaded and loaded again.
// Runs against a throwaway tmux socket (PI_TERMINAL_TMUX_SOCK), never the user's own server.
// Needs tmux and python3; prints SKIP and exits 0 when tmux is not installed.
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFileSync, spawnSync } = require("child_process");

const TMUX = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((p) => fs.existsSync(p));
if (!TMUX) {
  console.log("SKIP tmux not installed");
  process.exit(0);
}
const SOCK = "pi-terminal-test-" + process.pid;
process.env.PI_TERMINAL_TMUX = TMUX;
process.env.PI_TERMINAL_TMUX_SOCK = SOCK;
// A scratch HOME, so the developer's real ~/.tmux.conf neither leaks into the run nor gets touched.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-home-"));
process.env.PI_TERMINAL_TMUX_HOME = HOME;
const MAIN = path.resolve(__dirname, "..", "dist", "local.terminal", "main.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (name, cond, extra = "") => { if (!cond) ok = false; console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); };

const tm = (...a) => spawnSync(TMUX, ["-u", "-L", SOCK, ...a], { encoding: "utf8" });
const tmSessions = () => {
  const r = tm("list-sessions", "-F", "#{session_name}");
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
};

const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-a-"));
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-b-"));
let WS = { path: dirA };
let SETTINGS = {};
const commands = new Map();

// A fresh copy of main.js, as if the plugin process had been restarted.
function load() {
  delete require.cache[MAIN];
  delete require.cache[path.join(path.dirname(MAIN), "ring-buffer.js")];
  global.pi = {
    workspace: { get: async () => WS },
    plugin: { getSettings: async () => SETTINGS },
    commands: { register: async (c) => { commands.set(c.id, c); return { ok: true }; } },
  };
  return require(MAIN);
}

async function readUntil(m, id, gen, re, ms = 8000) {
  let acc = "";
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await m.onPanelInvoke("term.poll", { id, gen });
    acc += Buffer.from(r.data || "", "base64").toString("utf8");
    if (re.test(acc)) return { acc, ok: true };
    if (r.exited || r.superseded) return { acc, ok: false, exited: r.exited, r };
  }
  return { acc, ok: false, timeout: true };
}

(async () => {
  // ---- off (default): plain pty, no tmux involved -------------------------------------------
  let m = load();
  await m.onLoad();
  const plain = await m.onPanelInvoke("term.open", { cols: 100, rows: 30 });
  check("off: plain session, not tmux", /^t\d+$/.test(plain.id) && plain.tmux === false, JSON.stringify(plain));
  await m.onPanelInvoke("term.close", { id: plain.id });
  await m.onUnload();
  check("off: no tmux server was started", tmSessions().length === 0);

  // ---- on: open, set state in the shell, unload ---------------------------------------------
  SETTINGS = { tmuxMode: true };
  m = load();
  await m.onLoad();
  const a = await m.onPanelInvoke("term.open", { cols: 100, rows: 30 });
  check("on: session is a tmux session", /^pit_[0-9a-f]{8}_/.test(a.id) && a.tmux === true, a.id);
  await sleep(1200);
  await m.onPanelInvoke("term.write", { id: a.id, data: 'export PIFOO=bar42; echo REA""DY_1; stty size\n' });
  const r1 = await readUntil(m, a.id, 0, /READY_1[\s\S]*30 100/);
  check("on: shell runs inside tmux at the requested size", r1.ok, r1.ok ? "" : JSON.stringify(r1.acc.slice(-200)));
  check("on: session exists on the tmux server", tmSessions().includes(a.id));
  check("on: project key is stored on the session", tm("display", "-p", "-t", "=" + a.id + ":", "#{@pi_key}").stdout.trim().startsWith("r:"));
  check("on: no user config -> minimal fallback applied (status off, mouse on)", tm("show", "-gv", "status").stdout.trim() === "off" && tm("show", "-gv", "mouse").stdout.trim() === "on");

  await m.onUnload();
  await sleep(300);
  check("unload detaches: the tmux session is still alive", tmSessions().includes(a.id), tmSessions().join(","));
  check("unload detaches: the shell is still running", tm("display", "-p", "-t", "=" + a.id + ":", "#{pane_dead}").stdout.trim() === "0");

  // ---- reload: found again, shell state intact ----------------------------------------------
  m = load();
  await m.onLoad();
  const l1 = await m.onPanelInvoke("term.list");
  const found = l1.sessions.find((s) => s.id === a.id);
  check("reload: session is rediscovered", !!found && !found.exited && found.tmux === true, JSON.stringify(l1.sessions));
  check("reload: it belongs to the same project", !!found && found.key === l1.key, `${found && found.key} vs ${l1.key}`);
  const at = await m.onPanelInvoke("term.attach", { id: a.id, cols: 90, rows: 28 });
  check("reload: attach starts from an empty ring (tmux repaints)", at.replay === "" && at.tmux === true);
  await m.onPanelInvoke("term.write", { id: a.id, data: 'echo V=$PIFOO; stty size\n' });
  const r2 = await readUntil(m, a.id, at.gen, /V=bar42[\s\S]*28 90/);
  check("reload: shell state survived and the size follows the new client", r2.ok, r2.ok ? "" : JSON.stringify(r2.acc.slice(-200)));
  const stale = await m.onPanelInvoke("term.poll", { id: a.id, gen: 0 });
  check("reload: a stale poller is superseded", stale.superseded === true);

  // ---- a second attach replaces the first client --------------------------------------------
  const at2 = await m.onPanelInvoke("term.attach", { id: a.id, cols: 90, rows: 28 });
  await m.onPanelInvoke("term.write", { id: a.id, data: "echo AGA\"\"IN_3\n" });
  const r3 = await readUntil(m, a.id, at2.gen, /AGAIN_3/);
  check("re-attach: the new client works", r3.ok);
  check("re-attach: only one client stays attached", tm("display", "-p", "-t", "=" + a.id + ":", "#{session_attached}").stdout.trim() === "1");

  // ---- project isolation --------------------------------------------------------------------
  WS = { path: dirB };
  const b = await m.onPanelInvoke("term.open", { cols: 80, rows: 24 });
  const l2 = await m.onPanelInvoke("term.list");
  const ka = l2.sessions.find((s) => s.id === a.id).key, kb = l2.sessions.find((s) => s.id === b.id).key;
  check("projects: each session carries its own key", ka !== kb && kb === l2.key, `${ka} / ${kb}`);
  await sleep(1200);
  await m.onPanelInvoke("term.write", { id: b.id, data: "pwd\n" });
  const cwdB = tm("display", "-p", "-t", "=" + b.id + ":", "#{pane_current_path}").stdout.trim();
  check("projects: the new session starts in its workspace", cwdB === fs.realpathSync(dirB), cwdB);

  // ---- prefix + d only detaches the client --------------------------------------------------
  await m.onPanelInvoke("term.write", { id: b.id, data: "\x02d" });
  const rd = await readUntil(m, b.id, 0, /never-matches/, 5000);
  check("detach key: the client exits but the session is not reported gone", rd.exited === true && rd.r.gone === false, JSON.stringify(rd.r));
  const l3 = await m.onPanelInvoke("term.list");
  check("detach key: the session is still listed as alive", l3.sessions.some((s) => s.id === b.id && !s.exited));
  const atb = await m.onPanelInvoke("term.attach", { id: b.id, cols: 80, rows: 24 });
  await m.onPanelInvoke("term.write", { id: b.id, data: "echo BAC\"\"K_4\n" });
  const rb2 = await readUntil(m, b.id, atb.gen, /BACK_4/);
  check("detach key: it can be attached again", rb2.ok);

  // ---- closing a tab ends the tmux session; unload does not ---------------------------------
  await m.onPanelInvoke("term.close", { id: b.id });
  await sleep(500);
  check("close: the tmux session is gone", !tmSessions().includes(b.id), tmSessions().join(","));
  check("close: the other project's session is untouched", tmSessions().includes(a.id));
  // the shell exits by itself: the session is reported gone, not re-attachable
  WS = { path: dirA };
  const atx = await m.onPanelInvoke("term.attach", { id: a.id, cols: 90, rows: 28 });
  await m.onPanelInvoke("term.write", { id: a.id, data: "exit\n" });
  const rx = await readUntil(m, a.id, atx.gen, /never-matches/, 8000);
  check("exit: the poll reports exited and the session gone, with no error (the panel closes the tab)",
    rx.exited === true && rx.r && rx.r.gone === true && !rx.r.error, JSON.stringify(rx.r));
  // attaching to a session that no longer exists is an error and must stay visible, not auto-close
  const atg = await m.onPanelInvoke("term.attach", { id: a.id, cols: 90, rows: 28 });
  const rg = await readUntil(m, a.id, atg.gen, /never-matches/, 8000);
  check("gone: re-attaching reports the error (the panel keeps that tab)", rg.exited === true && !!rg.r.error, JSON.stringify(rg.r));
  const l4 = await m.onPanelInvoke("term.list");
  check("exit: the session is listed as gone", !l4.sessions.some((s) => s.id === a.id && !s.exited), JSON.stringify(l4.sessions));
  await m.onUnload();

  // ---- killTmux command ---------------------------------------------------------------------
  m = load();
  await m.onLoad();
  const c1 = await m.onPanelInvoke("term.open", { cols: 80, rows: 24 });
  await sleep(1200); // open returns before the relay has created the tmux session
  await m.onUnload();
  m = load();
  await m.onLoad();
  const k = commands.get("local.terminal.killTmux");
  check("killTmux: command is registered", !!k && typeof k.run === "function");
  check("killTmux: leftover session is there first", tmSessions().includes(c1.id));
  await k.run();
  check("killTmux: server and sessions are gone", tmSessions().length === 0);
  const l5 = await m.onPanelInvoke("term.list");
  check("killTmux: nothing left to list", l5.sessions.length === 0, JSON.stringify(l5.sessions));
  await m.onUnload();

  // ---- a user's own ~/.tmux.conf is loaded and the fallback is not applied -------------------
  fs.writeFileSync(path.join(HOME, ".tmux.conf"), "set -g history-limit 4242\nset -g status on\n");
  SETTINGS = { tmuxMode: true };
  m = load();
  await m.onLoad();
  const u = await m.onPanelInvoke("term.open", { cols: 80, rows: 24 });
  await sleep(1500);
  check("user conf: its history-limit is in effect", tm("show", "-gv", "history-limit").stdout.trim() === "4242", tm("show", "-gv", "history-limit").stdout.trim());
  check("user conf: the fallback did not override it (status stays on, mouse stays off)",
    tm("show", "-gv", "status").stdout.trim() === "on" && tm("show", "-gv", "mouse").stdout.trim() === "off");
  await m.onPanelInvoke("term.close", { id: u.id });
  await m.onUnload();
  tm("kill-server");
  fs.rmSync(path.join(HOME, ".tmux.conf"));

  // ---- tmux missing ----------------------------------------------------------------------------
  process.env.PI_TERMINAL_TMUX = "/nonexistent/tmux";
  SETTINGS = { tmuxMode: true };
  m = load();
  await m.onLoad();
  let err = "";
  try { await m.onPanelInvoke("term.open", { cols: 80, rows: 24 }); } catch (e) { err = String(e.message || e); }
  check("missing: the switch on without tmux fails with a clear error (no silent plain shell)", /tmux was not found/.test(err), err);
  check("missing: term.list does not claim tmux is wanted", (await m.onPanelInvoke("term.list")).tmuxWanted === false);
  await m.onUnload();

  // ---- what counts as on ------------------------------------------------------------------------
  process.env.PI_TERMINAL_TMUX = TMUX;
  for (const [value, wantTmux] of [[true, true], ["on", true], ["auto", true], [false, false], ["off", false], [undefined, false]]) {
    SETTINGS = value === undefined ? {} : { tmuxMode: value };
    m = load();
    await m.onLoad();
    const t = await m.onPanelInvoke("term.open", { cols: 80, rows: 24 });
    check(`setting ${JSON.stringify(value)} -> ${wantTmux ? "tmux" : "plain shell"}`, t.tmux === wantTmux, JSON.stringify(t));
    await m.onPanelInvoke("term.close", { id: t.id });
    await m.onUnload();
  }
})().catch((e) => { ok = false; console.log("FAIL exception", e && e.stack || e); }).finally(() => {
  tm("kill-server");
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  const left = spawnSync("pgrep", ["-f", "pi-terminal-test-" + process.pid], { encoding: "utf8" }).stdout.trim();
  console.log((left ? "FAIL" : "PASS") + " no leftover tmux/relay processes" + (left ? "  " + left : ""));
  if (left) ok = false;
  console.log(ok ? "\nALL PASS" : "\nSOME FAILED");
  process.exit(ok ? 0 : 1);
});
