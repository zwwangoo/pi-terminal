// Drives local.terminal/main.js exactly the way the host would: via onPanelInvoke, with a mocked `pi`.
const path = require("path");
global.pi = {
  workspace: { get: async () => ({ path: process.argv[2] || process.env.HOME }) },
  plugin: { getSettings: async () => ({}) },
};
const m = require(path.resolve(__dirname, "..", "dist", "local.terminal", "main.js"));
const inv = (c, p) => m.onPanelInvoke(c, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (name, cond, extra = "") => { if (!cond) ok = false; console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); };

let GEN = 0;
async function readUntil(id, re, ms = 8000) {
  let acc = "", t0 = Date.now(), polls = 0;
  while (Date.now() - t0 < ms) {
    const r = await inv("term.poll", { id, gen: GEN });
    polls++;
    acc += Buffer.from(r.data, "base64").toString("utf8");
    if (re.test(acc)) return { acc, polls, ms: Date.now() - t0 };
    if (r.exited) return { acc, polls, exited: r, ms: Date.now() - t0 };
  }
  return { acc, polls, timeout: true, ms: Date.now() - t0 };
}

(async () => {
  await m.onLoad();
  const o = await inv("term.open", { cols: 100, rows: 30 });
  check("open returns id+cwd", o.id && o.cwd === (process.argv[2] || process.env.HOME), JSON.stringify(o));

  await sleep(1500);
  await inv("term.write", { id: o.id, data: 'echo MAR""K_42; pwd\n' });
  const a = await readUntil(o.id, /MARK_42/);
  check("write -> poll echo", /MARK_42/.test(a.acc), `${a.ms}ms/${a.polls} polls`);
  check("shell started in workspace cwd", a.acc.includes(o.cwd));

  await inv("term.write", { id: o.id, data: "stty size\n" });
  const s1 = await readUntil(o.id, /30 100/);
  check("initial size 100x30", /30 100/.test(s1.acc));
  await inv("term.resize", { id: o.id, cols: 140, rows: 50 });
  await sleep(150);
  await inv("term.write", { id: o.id, data: "stty size\n" });
  const s2 = await readUntil(o.id, /50 140/);
  check("resize -> 140x50", /50 140/.test(s2.acc));

  // latency: per-keystroke echo round trip (long poll should wake immediately)
  const lat = [];
  for (let i = 0; i < 20; i++) {
    const t = Date.now();
    await inv("term.write", { id: o.id, data: "x" });
    await readUntil(o.id, /x/);
    lat.push(Date.now() - t);
  }
  lat.sort((x, y) => x - y);
  check("keystroke echo p50<30ms p95<80ms", lat[10] < 30 && lat[18] < 80, `p50=${lat[10]}ms p95=${lat[18]}ms max=${lat[19]}ms`);
  await inv("term.write", { id: o.id, data: "\x15" }); // ctrl-u clear line

  // reattach: ring buffer replay
  await sleep(300); await inv("term.poll", { id: o.id, gen: GEN }); // drain pending echo so the next poll really blocks
  const stale = inv("term.poll", { id: o.id, gen: GEN }); // long poll held by the "old panel"
  await sleep(100);
  const at = await inv("term.attach", { id: o.id });
  const st = await stale;
  check("old poller superseded on re-attach (fast)", st.superseded === true);
  GEN = at.gen;
  const stale2 = await inv("term.poll", { id: o.id, gen: 0 });
  check("stale gen rejected immediately", stale2.superseded === true);
  check("attach replays scrollback", Buffer.from(at.replay, "base64").toString().includes("MARK_42"));
  const lst = await inv("term.list");
  check("list shows session", lst.sessions.length === 1 && !lst.sessions[0].exited);

  // throughput + backpressure: 50MB through poll() in 256KB chunks, with a deliberately slow consumer
  await inv("term.write", { id: o.id, data: 'head -c 52428800 /dev/zero | base64 | wc -c; echo EN""D_2\n' });
  await readUntil(o.id, /END_2/, 60000);
  const t0 = Date.now();
  await inv("term.write", { id: o.id, data: 'head -c 52428800 /dev/zero | base64; echo FI""N_5\n' });
  let bytes = 0, tail = "", polls = 0;
  while (Date.now() - t0 < 60000) {
    const r = await inv("term.poll", { id: o.id, gen: GEN });
    polls++;
    bytes += Buffer.from(r.data, "base64").length;
    tail = (tail + Buffer.from(r.data, "base64").toString("latin1")).slice(-200);
    if (/FIN_5/.test(tail)) break;
    if (polls % 5 === 0) await sleep(5); // slow consumer -> exercises pause/resume
  }
  const dt = (Date.now() - t0) / 1000;
  check("throughput 66MB through poll()", /FIN_5/.test(tail), `${(bytes / 1048576).toFixed(1)}MB in ${dt.toFixed(2)}s = ${(bytes / 1048576 / dt).toFixed(0)}MB/s, ${polls} polls`);

  // interactive full-screen app with alt-screen + resize
  await inv("term.write", { id: o.id, data: "vi -u NONE -N /tmp/_pi_term_test.txt\n" });
  const v = await readUntil(o.id, /\x1b\[\?1049h/, 5000);
  check("vi enters alt screen", /\x1b\[\?1049h/.test(v.acc));
  await inv("term.write", { id: o.id, data: "ihello\x1b:q!\r" });
  const v2 = await readUntil(o.id, /\x1b\[\?1049l/, 5000);
  check("vi exits alt screen", /\x1b\[\?1049l/.test(v2.acc));

  // unicode
  await inv("term.write", { id: o.id, data: "echo 你好-终端\n" });
  const u = await readUntil(o.id, /你好-终端\r?\n/);
  check("utf-8 round trip", /你好-终端/.test(u.acc));

  // exit
  await inv("term.write", { id: o.id, data: "exit\n" });
  const e = await readUntil(o.id, /$never^/, 5000);
  check("exit reported", e.exited && e.exited.exited === true, JSON.stringify(e.exited && { code: e.exited.exitCode }));

  // per-project isolation: a session is tagged with the project it was opened in, and term.list reports
  // the project the host currently has open (the panel and this process read that same value).
  const wsA = { path: "/tmp", projectId: "projA" };
  const wsB = { path: "/usr", projectId: "projB" };
  global.pi.workspace.get = async () => wsA;
  const pa = await inv("term.open", { cols: 80, rows: 24 });
  global.pi.workspace.get = async () => wsB;
  const pb = await inv("term.open", { cols: 80, rows: 24 });
  check("open tags session with project key", pa.key === "p:projA" && pb.key === "p:projB", `${pa.key} ${pb.key}`);
  check("session cwd follows its project", pa.cwd === "/tmp" && pb.cwd === "/usr");
  const idsFor = (l) => l.sessions.filter((s) => s.key === l.key).map((s) => s.id);
  const lb = await inv("term.list");
  check("list sees only the open project's session", lb.key === "p:projB" && idsFor(lb).length === 1 && idsFor(lb)[0] === pb.id, JSON.stringify(idsFor(lb)));
  global.pi.workspace.get = async () => wsA;
  const la = await inv("term.list");
  check("switching the host project switches the list", la.key === "p:projA" && idsFor(la).length === 1 && idsFor(la)[0] === pa.id, JSON.stringify(idsFor(la)));
  global.pi.workspace.get = async () => ({ path: process.argv[2] || process.env.HOME });
  const lh = await inv("term.list");
  check("key follows the host workspace", lh.key === "r:" + (process.argv[2] || process.env.HOME), lh.key);
  await inv("term.close", { id: pa.id });
  await inv("term.close", { id: pb.id });

  // second session + close kills process
  const o2 = await inv("term.open", { cols: 80, rows: 24 });
  await sleep(800);
  await inv("term.close", { id: o2.id });
  let threw = false;
  try { await inv("term.poll", { id: o2.id }); } catch (_) { threw = true; }
  check("closed session rejected", threw);
  check("unknown channel rejected", await inv("bogus", {}).then(() => false, () => true));

  // Input method: main.js drives im-select, so the test points it at a stub and reads the stub's own
  // state file. The real im-select (and the user's layout) is never touched.
  const fsMod = require("fs"), osMod = require("os");
  const imeDir = fsMod.mkdtempSync(path.join(osMod.tmpdir(), "pi-ime-"));
  const imeState = path.join(imeDir, "state");
  const imeFail = path.join(imeDir, "fail");
  const imeStub = path.join(imeDir, "im-select");
  fsMod.writeFileSync(imeState, "com.example.zh\n");
  // Writes take 200ms and fail while the "fail" marker exists, so an edge really is in flight when the
  // next one arrives and the error paths are reachable.
  fsMod.writeFileSync(imeStub, [
    "#!/bin/sh",
    `S="${imeState}"`,
    `F="${imeFail}"`,
    'if [ -z "$1" ]; then cat "$S"; exit 0; fi',
    "sleep 0.2",
    'if [ -f "$F" ]; then echo "stub refuses to switch" >&2; exit 3; fi',
    'printf "%s" "$1" > "$S"',
    "",
  ].join("\n"), { mode: 0o755 });
  process.env.PI_TERMINAL_IM_SELECT = imeStub;
  const imeNow = () => fsMod.readFileSync(imeState, "utf8").trim();
  const setIme = (v) => fsMod.writeFileSync(imeState, v + "\n");
  const TTL = 3200; // main.js caches settings for 3s

  if (process.platform !== "darwin") {
    const r = await inv("ime.sync", { focused: true });
    check("ime: non-macOS is a no-op", r.switched === false && r.reason === "unsupported-platform", JSON.stringify(r));
  } else {
  // shipped off: with no settings at all, or with the switch off, nothing is spawned and the layout stays put
  const offDefault = await inv("ime.sync", { focused: true });
  check("ime: off by default", offDefault.switched === false && offDefault.reason === "disabled" && imeNow() === "com.example.zh", JSON.stringify(offDefault));
  global.pi.plugin.getSettings = async () => ({ imeAutoSwitch: false });
  await sleep(TTL);
  const off = await inv("ime.sync", { focused: true });
  check("ime: explicit off is a no-op", off.switched === false && off.reason === "disabled" && imeNow() === "com.example.zh", JSON.stringify(off));

  // a custom target id is honoured once the switch is on
  global.pi.plugin.getSettings = async () => ({ imeAutoSwitch: true, imeTarget: "com.apple.keylayout.US" });
  await sleep(TTL);
  const custom = await inv("ime.sync", { focused: true });
  check("ime: custom target honoured", custom.switched === true && custom.to === "com.apple.keylayout.US" && imeNow() === "com.apple.keylayout.US", JSON.stringify(custom));
  await inv("ime.sync", { focused: false });
  check("ime: custom target restored", imeNow() === "com.example.zh", imeNow());
  global.pi.plugin.getSettings = async () => ({ imeAutoSwitch: true });
  await sleep(TTL);

  const f1 = await inv("ime.sync", { focused: true });
  check("ime: focus switches to English and remembers the old source",
    f1.switched === true && f1.from === "com.example.zh" && f1.to === "com.apple.keylayout.ABC" && imeNow() === "com.apple.keylayout.ABC",
    JSON.stringify(f1));
  const f2 = await inv("ime.sync", { focused: true });
  check("ime: duplicate focus is ignored (saved value not overwritten)", f2.switched === false && f2.reason === "unchanged", JSON.stringify(f2));
  const b1 = await inv("ime.sync", { focused: false });
  check("ime: blur restores the previous source", b1.switched === true && b1.to === "com.example.zh" && imeNow() === "com.example.zh", JSON.stringify(b1));
  const b2 = await inv("ime.sync", { focused: false });
  check("ime: duplicate blur is ignored", b2.switched === false, JSON.stringify(b2));

  // the user switching by hand while the terminal has focus must survive the blur
  await inv("ime.sync", { focused: true });
  setIme("com.apple.keylayout.US");
  const b3 = await inv("ime.sync", { focused: false });
  check("ime: manual change during focus is not clobbered", b3.switched === false && b3.reason === "user-changed" && imeNow() === "com.apple.keylayout.US", JSON.stringify(b3));

  // interleaved edges: the blur lands while the focus edge is still mid-write (stub sleeps 200ms)
  setIme("com.example.zh");
  await Promise.all([inv("ime.sync", { focused: true }), inv("ime.sync", { focused: false })]);
  check("ime: blur arriving mid-focus still restores", imeNow() === "com.example.zh", imeNow());

  // a refused switch keeps the remembered source, and the next edge can still restore it
  fsMod.writeFileSync(imeFail, "");
  const failFocus = await inv("ime.sync", { focused: true });
  const savedAfterFail = (await inv("ime.state", {})).saved;
  check("ime: failed switch is reported and nothing is claimed", failFocus.ok === false && imeNow() === "com.example.zh" && savedAfterFail === "", `${JSON.stringify(failFocus)} saved=${savedAfterFail}`);
  fsMod.rmSync(imeFail, { force: true });

  // a refused restore keeps the memory so a later edge (or unload) can retry
  await inv("ime.sync", { focused: true });
  fsMod.writeFileSync(imeFail, "");
  const failBlur = await inv("ime.sync", { focused: false });
  const savedKept = (await inv("ime.state", {})).saved;
  check("ime: failed restore keeps the remembered source", failBlur.ok === false && savedKept === "com.example.zh", `${JSON.stringify(failBlur)} saved=${savedKept}`);
  fsMod.rmSync(imeFail, { force: true });

  // unload is the last safety net: it must not leave the user on English
  await inv("ime.sync", { focused: true });
  check("ime: focused terminal puts us on English", imeNow() === "com.apple.keylayout.ABC", imeNow());
  await m.onUnload();
  check("ime: unload restores the remembered source", imeNow() === "com.example.zh", imeNow());

  const imeSt = await inv("ime.state", {});
  check("ime: state reports the resolved stub", imeSt.supported === true && imeSt.binary === imeStub && imeSt.enabled === true && imeSt.focused === false, JSON.stringify(imeSt));
  }

  await m.onUnload();
  await sleep(300);
  const { execSync } = require("child_process");
  const left = execSync("pgrep -P " + process.pid + " || true").toString().trim();
  check("no orphan relay processes", left === "", left);
  console.log(ok ? "\nALL PASS" : "\nSOME FAILED");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
