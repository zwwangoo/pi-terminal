// Drives local.terminal/main.js exactly the way the host would: via onPanelInvoke, with a mocked `pi`.
const path = require("path");
global.pi = { workspace: { get: async () => ({ path: process.argv[2] || process.env.HOME }) } };
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

  // per-project isolation: sessions are tagged with their project, term.list reports the caller's project
  const wsA = { path: "/tmp", projectId: "projA" };
  const wsB = { path: "/usr", projectId: "projB" };
  const pa = await inv("term.open", { cols: 80, rows: 24, ws: wsA });
  const pb = await inv("term.open", { cols: 80, rows: 24, ws: wsB });
  check("open tags session with project key", pa.key === "p:projA" && pb.key === "p:projB", `${pa.key} ${pb.key}`);
  check("session cwd follows its project", pa.cwd === "/tmp" && pb.cwd === "/usr");
  const la = await inv("term.list", { ws: wsA });
  const lb = await inv("term.list", { ws: wsB });
  const idsFor = (l) => l.sessions.filter((s) => s.key === l.key).map((s) => s.id);
  check("list in project A sees only A's session", la.key === "p:projA" && idsFor(la).length === 1 && idsFor(la)[0] === pa.id, JSON.stringify(idsFor(la)));
  check("list in project B sees only B's session", lb.key === "p:projB" && idsFor(lb).length === 1 && idsFor(lb)[0] === pb.id, JSON.stringify(idsFor(lb)));
  const lh = await inv("term.list");
  check("without hint falls back to host workspace key", lh.key === "r:" + (process.argv[2] || process.env.HOME), lh.key);
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

  await m.onUnload();
  await sleep(300);
  const { execSync } = require("child_process");
  const left = execSync("pgrep -P " + process.pid + " || true").toString().trim();
  check("no orphan relay processes", left === "", left);
  console.log(ok ? "\nALL PASS" : "\nSOME FAILED");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
