// Remote projects: the shell runs on the project's host over ssh, never locally.
// A fake `ssh` (PI_TERMINAL_SSH) logs its arguments and runs the remote command string locally with sh -c,
// so the real relay, the real command construction and the real tmux logic are exercised without a network.
// Needs python3 and sqlite3; the tmux part needs tmux (printed SKIP without it).
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");

const MAIN = path.resolve(__dirname, "..", "dist", "local.terminal", "main.js");
const TMUX = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((p) => fs.existsSync(p));
const SQLITE = ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"].find((p) => fs.existsSync(p));
if (!SQLITE) {
  console.log("SKIP sqlite3 not installed");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-"));
const DATA = path.join(tmp, "data");
const REMOTE_HOME = path.join(tmp, "remote-home");
const LOG = path.join(tmp, "ssh.log");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(REMOTE_HOME, { recursive: true });

// The fake remote: one argument per log line, then the last argument (the remote command) run by sh.
const FAKE = path.join(tmp, "ssh");
fs.writeFileSync(
  FAKE,
  `#!/bin/sh
{ echo "--call"; for a in "$@"; do echo "$a"; done; } >> '${LOG}'
for last; do :; done
if [ -e '${tmp}/fail' ]; then echo "ssh: connect to host x port 22: Connection refused" >&2; exit 255; fi
if [ -e '${tmp}/notmux' ]; then case "$last" in *"command -v tmux"*) exit 127;; esac; fi
export SHELL=/bin/sh HOME='${REMOTE_HOME}'
exec /bin/sh -c "$last"
`,
  { mode: 0o755 },
);
process.env.PI_TERMINAL_SSH = FAKE;
process.env.PI_TERMINAL_DATA_DIR = DATA;
process.env.PI_TERMINAL_SQLITE = SQLITE;
// The fake remote is this machine, so the plugin's *local* tmux must not see these sessions: that would
// register them as local ones and hide whether discovery through the "remote" works.
process.env.PI_TERMINAL_TMUX = "/nonexistent/tmux";
const SOCK = "pi-terminal-remote-test-" + process.pid;
process.env.PI_TERMINAL_TMUX_SOCK = SOCK;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (name, cond, extra = "") => { if (!cond) ok = false; console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); };

const HOSTS = [
  { hostKey: "ssh-alpha", label: "Alpha", url: "ws://127.0.0.1:1/x", metadata: { transport: "ssh", ssh: { host: "alpha.example", port: 2222, user: "alice", identityFile: "/keys/alpha" } } },
  { hostKey: "ssh-beta", label: "Beta", url: "ws://127.0.0.1:2/x", metadata: { transport: "ssh", ssh: { host: "beta.example", port: 22, user: "bob" } } },
  { hostKey: "plain-gamma", label: "Gamma", url: "ws://127.0.0.1:3/x" }, // added by hand: no ssh info
];
function writeHosts(hosts) { fs.writeFileSync(path.join(DATA, "remote-hosts.json"), JSON.stringify({ version: 1, hosts })); }
function writeGroups(groups) {
  fs.rmSync(path.join(DATA, "pi.sqlite"), { force: true });
  const sql = ["create table kv(ns text not null, key text not null, value_json text not null, updated_at integer, primary key(ns,key));"];
  for (const g of groups) sql.push(`insert into kv values('projectGroups','${g.id}','${JSON.stringify(g.value).replace(/'/g, "''")}',0);`);
  const r = spawnSync(SQLITE, [path.join(DATA, "pi.sqlite"), sql.join("\n")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("sqlite3: " + r.stderr);
}
const group = (id, hostKey, rpath) => ({ id, value: { id, primaryPath: "remote-project:" + id, remote: { hostKey, path: rpath } } });
const calls = () => {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, "utf8").split("--call\n").filter(Boolean).map((c) => c.replace(/\n$/, "").split("\n"));
};

let WS, SETTINGS = {};
function load() {
  delete require.cache[MAIN];
  delete require.cache[path.join(path.dirname(MAIN), "ring-buffer.js")];
  global.pi = {
    workspace: { get: async () => WS },
    plugin: { getSettings: async () => SETTINGS },
    commands: { register: async () => ({ ok: true }) },
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
    if (r.exited || r.superseded) return { acc, ok: false, exited: r.exited };
  }
  return { acc, ok: false, timeout: true };
}
const type = (m, id, text) => m.onPanelInvoke("term.write", { id, data: text });
const rejects = async (p) => { try { await p; return null; } catch (e) { return String(e.message || e); } };

(async () => {
  const dirs = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-dirs-"));
  const plainDir = path.join(dirs, "proj");
  const oddDir = path.join(dirs, "我的 项目 $HOME *x");
  fs.mkdirSync(plainDir);
  fs.mkdirSync(oddDir);

  // ---- a project bound to Alpha: ssh to alice@alpha.example:2222, directory taken from workspace.remote.path ----
  writeHosts(HOSTS);
  writeGroups([group("g1", "ssh-alpha", plainDir), group("g2", "ssh-beta", oddDir), group("g3", "plain-gamma", plainDir)]);
  let m = load();
  await m.onLoad();
  WS = { path: "remote-project:g1", name: "p", remote: { path: plainDir, readOnly: true } };
  let o = await m.onPanelInvoke("term.open", { cols: 100, rows: 30 });
  check("remote: open returns the host label", o.remote === "Alpha" && o.tmux === false, JSON.stringify(o));
  await type(m, o.id, "echo AT:$(pwd):$((6*7))\r");
  let r = await readUntil(m, o.id, 0, /AT:[^\r\n]+:42/);
  check("remote: shell starts in the remote directory", r.ok && (r.acc.includes("AT:" + fs.realpathSync(plainDir) + ":42") || r.acc.includes("AT:" + plainDir + ":42")) && !/AT:\/Users\/[^/]+:42/.test(r.acc), JSON.stringify(r.acc.slice(-200)));
  let c = calls().pop() || [];
  check("remote: ssh target, port and key", c.includes("alice@alpha.example") && c[c.indexOf("-p") + 1] === "2222" && c[c.indexOf("-i") + 1] === "/keys/alpha", JSON.stringify(c.slice(0, 20)));
  check("remote: interactive, never asks for a password", c.includes("-tt") && c.includes("BatchMode=yes"));
  let l = await m.onPanelInvoke("term.list");
  check("remote: list carries the host label", l.sessions.some((s) => s.id === o.id && s.remote === "Alpha"), JSON.stringify(l.sessions));
  await m.onPanelInvoke("term.close", { id: o.id });

  // ---- the directory goes through the remote command line untouched: spaces, Chinese, $ and * ----
  WS = { path: "remote-project:g2", remote: { path: oddDir } };
  o = await m.onPanelInvoke("term.open", { cols: 100, rows: 30 });
  check("remote: host from the project binding (Beta, no key file)", o.remote === "Beta", JSON.stringify(o));
  await type(m, o.id, "echo IN:$(pwd):$((6*7))\r");
  r = await readUntil(m, o.id, 0, /IN:[^\r\n]+:42/);
  check("remote: directory with space / Chinese / $ / * is used as is", r.ok && r.acc.includes("我的 项目 $HOME *x"), JSON.stringify(r.acc.slice(-200)));
  c = calls().pop() || [];
  check("remote: no -i without a key file", !c.includes("-i") && c.includes("bob@beta.example") && c[c.indexOf("-p") + 1] === "22");
  await m.onPanelInvoke("term.close", { id: o.id });

  // ---- errors: never a local shell ----
  const before = calls().length;
  WS = { path: "remote-project:g3", remote: { path: plainDir } };
  let e = await rejects(m.onPanelInvoke("term.open", { cols: 80, rows: 24 }));
  check("error: host without ssh info", e && /no SSH connection info/.test(e) && /Gamma|plain-gamma/.test(e), String(e));

  WS = { path: "remote-project:unknown", remote: { path: plainDir } };
  e = await rejects(m.onPanelInvoke("term.open", { cols: 80, rows: 24 }));
  check("error: unknown project with several ssh hosts asks for remoteHost", e && /remoteHost/.test(e) && /Alpha/.test(e) && /Beta/.test(e), String(e));

  WS = { path: "remote-project:g1", remote: { path: "/tmp/it's" } };
  e = await rejects(m.onPanelInvoke("term.open", { cols: 80, rows: 24 }));
  check("error: directory with a quote is refused", e && /unsupported character/.test(e), String(e));

  WS = { path: "remote-project:g1" }; // remote project, but the host gave no directory and the record has one
  writeGroups([{ id: "g1", value: { id: "g1", remote: { hostKey: "ssh-alpha", path: "" } } }]);
  m = load();
  await m.onLoad();
  e = await rejects(m.onPanelInvoke("term.open", { cols: 80, rows: 24 }));
  check("error: no directory anywhere", e && /no directory/.test(e), String(e));
  l = await m.onPanelInvoke("term.list");
  check("error: nothing was started (no local fallback)", l.sessions.length === 0 && calls().length === before);

  // ---- the project's binding is authoritative; remoteHost only stands in when the binding cannot be read ----
  writeGroups([group("g1", "ssh-alpha", plainDir)]);
  SETTINGS = { remoteHost: "beta" };
  m = load();
  await m.onLoad();
  WS = { path: "remote-project:g1", remote: { path: plainDir } };
  o = await m.onPanelInvoke("term.open", { cols: 80, rows: 24 });
  check("setting: remoteHost does NOT override the project's binding", o.remote === "Alpha", JSON.stringify(o));
  await m.onPanelInvoke("term.close", { id: o.id });
  WS = { path: "remote-project:unbound", remote: { path: plainDir } };
  o = await m.onPanelInvoke("term.open", { cols: 80, rows: 24 });
  check("setting: remoteHost (label, any case) used when there is no binding", o.remote === "Beta", JSON.stringify(o));
  await m.onPanelInvoke("term.close", { id: o.id });
  SETTINGS = { remoteHost: "nope" };
  m = load();
  await m.onLoad();
  e = await rejects(m.onPanelInvoke("term.open", { cols: 80, rows: 24 }));
  check("setting: unknown remoteHost is an error", e && /matches no SSH host/.test(e), String(e));

  // ---- no binding and no setting: an error, even when only one host has ssh info (no guessing) ----
  SETTINGS = {};
  writeGroups([]);
  writeHosts([HOSTS[0], HOSTS[2]]);
  m = load();
  await m.onLoad();
  WS = { path: "remote-project:zzz", remote: { path: plainDir } };
  const nBefore = calls().length;
  e = await rejects(m.onPanelInvoke("term.open", { cols: 80, rows: 24 }));
  check("no guess: unreadable binding + only one ssh host is an error", e && /cannot tell which remote host/.test(e) && calls().length === nBefore, String(e));

  // ---- a host whose address cannot be put on a command line is named as such ----
  writeHosts([{ hostKey: "ssh-bad", label: "Bad", metadata: { transport: "ssh", ssh: { host: "-oProxyCommand=x", user: "u" } } }]);
  writeGroups([group("gb", "ssh-bad", plainDir)]);
  m = load();
  await m.onLoad();
  WS = { path: "remote-project:gb", remote: { path: plainDir } };
  e = await rejects(m.onPanelInvoke("term.open", { cols: 80, rows: 24 }));
  check("invalid host: refused, with the real reason", e && /refuses to put on a command line/.test(e) && calls().length === nBefore, String(e));
  writeHosts(HOSTS);

  // ---- preflight: unreachable host / missing directory are errors, nothing is opened ----
  writeGroups([group("g1", "ssh-alpha", plainDir)]);
  SETTINGS = {};
  m = load();
  await m.onLoad();
  WS = { path: "remote-project:g1", remote: { path: plainDir } };
  fs.writeFileSync(path.join(tmp, "fail"), "");
  e = await rejects(m.onPanelInvoke("term.open", { cols: 80, rows: 24 }));
  check("preflight: unreachable host is an error with ssh's message", e && /cannot reach Alpha over ssh/.test(e) && /Connection refused/.test(e), String(e));
  fs.rmSync(path.join(tmp, "fail"));
  WS = { path: "remote-project:g1", remote: { path: path.join(plainDir, "does-not-exist") } };
  e = await rejects(m.onPanelInvoke("term.open", { cols: 80, rows: 24 }));
  check("preflight: missing directory is an error", e && /cannot enter .*does-not-exist on Alpha/.test(e), String(e));
  l = await m.onPanelInvoke("term.list");
  check("preflight: no tab was left behind", l.sessions.length === 0, JSON.stringify(l.sessions));

  // ---- a local shell left under the key of a remote project is not offered ----
  writeHosts(HOSTS);
  writeGroups([group("zzz", "ssh-alpha", plainDir)]);
  SETTINGS = {};
  m = load();
  await m.onLoad();
  WS = { path: plainDir };
  const stale = await m.onPanelInvoke("term.open", { cols: 80, rows: 24, key: "r:remote-project:zzz" });
  check("stale: local shell under the remote project's key was opened", !stale.remote);
  WS = { path: "remote-project:zzz", remote: { path: plainDir } };
  l = await m.onPanelInvoke("term.list");
  check("stale: not offered while the project is remote", !l.sessions.some((s) => s.id === stale.id), JSON.stringify(l.sessions));
  const fresh = await m.onPanelInvoke("term.open", { cols: 80, rows: 24 });
  l = await m.onPanelInvoke("term.list");
  check("stale: the remote tab is the only one offered", l.sessions.length === 1 && l.sessions[0].id === fresh.id && l.sessions[0].remote === "Alpha", JSON.stringify(l.sessions));
  await m.onPanelInvoke("term.close", { id: fresh.id });
  await m.onPanelInvoke("term.close", { id: stale.id });
  await m.onUnload();

  // ---- a local project is untouched ----
  m = load();
  await m.onLoad();
  WS = { path: plainDir };
  const n0 = calls().length;
  o = await m.onPanelInvoke("term.open", { cols: 80, rows: 24 });
  check("local: no ssh, no remote label", calls().length === n0 && !o.remote && o.cwd === plainDir, JSON.stringify(o));
  await m.onPanelInvoke("term.close", { id: o.id });
  await m.onUnload();

  // ---- tmuxMode on a remote host ----
  if (!TMUX) {
    console.log("SKIP tmux part: tmux not installed");
  } else {
    writeHosts(HOSTS);
    writeGroups([group("g1", "ssh-alpha", plainDir)]);
    SETTINGS = { tmuxMode: true };
    const has = (name) => spawnSync(TMUX, ["-u", "-L", SOCK, "has-session", "-t", "=" + name]).status === 0;
    m = load();
    await m.onLoad();
    WS = { path: "remote-project:g1", remote: { path: plainDir } };
    o = await m.onPanelInvoke("term.open", { cols: 100, rows: 30 });
    check("tmux: remote tab is a tmux tab on that host", o.tmux === true && o.remote === "Alpha" && /^pit_/.test(o.id), JSON.stringify(o));
    await type(m, o.id, "echo TM:$(pwd):$((6*7))\r");
    r = await readUntil(m, o.id, 0, /TM:[^\r\n]+:42/);
    check("tmux: shell runs in the remote directory", r.ok, JSON.stringify(r.acc.slice(-200)));
    check("tmux: session exists on the private socket", has(o.id));
    const key = spawnSync(TMUX, ["-u", "-L", SOCK, "show-options", "-t", "=" + o.id + ":", "@pi_key"], { encoding: "utf8" }).stdout;
    check("tmux: session is tagged with the project key", /@pi_key r:remote-project:g1/.test(key), key.trim());
    const status = spawnSync(TMUX, ["-u", "-L", SOCK, "show-options", "-g", "mouse"], { encoding: "utf8" }).stdout;
    check("tmux: minimal config applied (no user tmux.conf on the host)", /mouse on/.test(status), status.trim());

    // plugin restarts: the session is still there and found again through the host
    await m.onUnload();
    check("tmux: survives the plugin unloading", has(o.id));
    m = load();
    await m.onLoad();
    const listCalls0 = calls().filter((cc) => cc.some((x) => x.includes("list-sessions"))).length;
    // two lists at once (term.list and term.watch both do this): one ssh call, and both see the session
    const [l1, l2] = await Promise.all([m.onPanelInvoke("term.list"), m.onPanelInvoke("term.list")]);
    const listCalls1 = calls().filter((cc) => cc.some((x) => x.includes("list-sessions"))).length;
    check("tmux: concurrent lists share one discovery", listCalls1 - listCalls0 === 1, "ssh list-sessions calls: " + (listCalls1 - listCalls0));
    check("tmux: both concurrent lists see the session", [l1, l2].every((x) => x.sessions.some((s) => s.id === o.id)), JSON.stringify([l1.sessions, l2.sessions]));
    l = await m.onPanelInvoke("term.list");
    const found = l.sessions.find((s) => s.id === o.id);
    check("tmux: rediscovered on the host after a reload", !!found && found.remote === "Alpha" && found.exited === false, JSON.stringify(l.sessions));
    const a = await m.onPanelInvoke("term.attach", { id: o.id, cols: 100, rows: 30 });
    await type(m, o.id, "echo BACK:$((7*7))\r");
    r = await readUntil(m, o.id, a.gen, /BACK:49/);
    check("tmux: reattach works", r.ok, JSON.stringify(r.acc.slice(-200)));

    // a dropped ssh must not make a live session look gone: detach the client, then every check fails (255)
    const alive = spawnSync(TMUX, ["-u", "-L", SOCK, "detach-client", "-s", o.id]);
    fs.writeFileSync(path.join(tmp, "fail"), "");
    await sleep(2500);
    l = await m.onPanelInvoke("term.list");
    const flaky = l.sessions.find((s) => s.id === o.id);
    check("tmux: ssh failing does not mark a live session gone", alive.status === 0 && has(o.id) && !!flaky && flaky.exited === false, JSON.stringify(l.sessions));
    fs.rmSync(path.join(tmp, "fail"));

    // tmux's own "no such session" is reported as gone
    const own = spawnSync(TMUX, ["-u", "-L", SOCK, "kill-session", "-t", "=" + o.id]);
    check("tmux: killed on the host", own.status === 0 && !has(o.id));
    // the tab was detached (see above); pressing Enter in the panel reattaches, which finds the session gone
    await m.onPanelInvoke("term.attach", { id: o.id, cols: 100, rows: 30 });
    await sleep(2500);
    l = await m.onPanelInvoke("term.list");
    check("tmux: session killed on the host is reported gone", l.sessions.every((s) => s.id !== o.id) || l.sessions.find((s) => s.id === o.id).exited === true, JSON.stringify(l.sessions));

    // closing a tab ends the host's session
    const o2 = await m.onPanelInvoke("term.open", { cols: 100, rows: 30 });
    await type(m, o2.id, "echo UP:$((6*7))\r");
    const r2 = await readUntil(m, o2.id, 0, /UP:42/);
    if (!r2.ok) console.log("DEBUG o2", JSON.stringify(r2.acc.slice(-400)), JSON.stringify(o2));
    check("tmux: second tab exists", has(o2.id));
    await m.onPanelInvoke("term.close", { id: o2.id });
    await sleep(1500);
    check("tmux: closing the tab kills the session on the host", !has(o2.id));

    // end-all command: kills the host's server
    const o3 = await m.onPanelInvoke("term.open", { cols: 100, rows: 30 });
    await type(m, o3.id, "echo UP3:$((6*7))\r");
    const r3 = await readUntil(m, o3.id, 0, /UP3:42/);
    if (!r3.ok) console.log("DEBUG o3", JSON.stringify(r3.acc.slice(-400)), JSON.stringify(o3));
    check("tmux: third tab exists", has(o3.id));
    // the registered command runs killAllTmux
    const cmds = new Map();
    global.pi.commands.register = async (cmd) => { cmds.set(cmd.id, cmd); return { ok: true }; };
    m = load();
    global.pi.commands.register = async (cmd) => { cmds.set(cmd.id, cmd); return { ok: true }; };
    await m.onLoad();
    await cmds.get("local.terminal.killTmux").run();
    check("tmux: 'end all' also ends the host's sessions", !has(o3.id));
    await m.onUnload();

    spawnSync(TMUX, ["-u", "-L", SOCK, "kill-server"]);

    // a session whose recorded directory has a quote in it (found on the host, not created here) still reattaches
    const quoteDir = path.join(dirs, "it's");
    fs.mkdirSync(quoteDir);
    const qn = "pit_quote01_test";
    spawnSync(TMUX, ["-u", "-L", SOCK, "new-session", "-d", "-s", qn, "-c", quoteDir, "/bin/sh"], { env: { ...process.env, HOME: REMOTE_HOME } });
    spawnSync(TMUX, ["-u", "-L", SOCK, "set-option", "-t", "=" + qn + ":", "@pi_key", "r:remote-project:g1"]);
    m = load();
    await m.onLoad();
    WS = { path: "remote-project:g1", remote: { path: plainDir } };
    l = await m.onPanelInvoke("term.list");
    check("tmux: session with a quote in its directory is found", l.sessions.some((x) => x.id === qn && x.remote === "Alpha"), JSON.stringify(l.sessions));
    const qa = await m.onPanelInvoke("term.attach", { id: qn, cols: 100, rows: 30 });
    await type(m, qn, "echo QUOTE:$((6*7))\r");
    r = await readUntil(m, qn, qa.gen, /QUOTE:42/);
    check("tmux: ...and reattaches", r.ok, JSON.stringify(r.acc.slice(-150)));
    await m.onUnload();
    spawnSync(TMUX, ["-u", "-L", SOCK, "kill-server"]);

    // tmux missing on the host: an error the panel can show, nothing opened (a dying tab would loop)
    fs.writeFileSync(path.join(tmp, "notmux"), "");
    SETTINGS = { tmuxMode: true };
    m = load();
    await m.onLoad();
    WS = { path: "remote-project:g1", remote: { path: plainDir } };
    e = await rejects(m.onPanelInvoke("term.open", { cols: 80, rows: 24 }));
    check("tmux: not installed on the host is an error", e && /tmux is not installed on Alpha/.test(e), String(e));
    l = await m.onPanelInvoke("term.list");
    check("tmux: ...and no tab is left", l.sessions.length === 0, JSON.stringify(l.sessions));
    await m.onUnload();
    fs.rmSync(path.join(tmp, "notmux"));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(dirs, { recursive: true, force: true });
  console.log(ok ? "\nALL PASS" : "\nFAILED");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("ERROR", e);
  spawnSync(TMUX || "true", ["-u", "-L", SOCK, "kill-server"]);
  process.exit(1);
});
