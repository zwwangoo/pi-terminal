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

  // seq addressing: a resumed poll continues exactly where the replay ended — no repeated prefix
  await inv("term.write", { id: o.id, data: "echo SEQ\"\"_A\n" });
  await readUntil(o.id, /SEQ_A/, 5000);
  const at2 = await inv("term.attach", { id: o.id });
  GEN = at2.gen;
  check("attach names the resume seq", typeof at2.nextSeq === "number" && at2.nextSeq > 1, String(at2.nextSeq));
  check("attach replay carries the recent output", Buffer.from(at2.replay, "base64").toString("latin1").includes("SEQ_A"));

  check("attach replay cap is 1MiB, not the old 256KB", Buffer.from(at2.replay, "base64").length > 300 * 1024,
    `${Math.round(Buffer.from(at2.replay, "base64").length / 1024)}KB`);
  const resumed = await inv("term.poll", { id: o.id, gen: GEN, from: at2.nextSeq });
  check("poll from nextSeq does not repeat what was just replayed",
    !Buffer.from(resumed.data, "base64").toString("latin1").includes("SEQ_A"), `${Buffer.from(resumed.data, "base64").length} bytes`);

  // a reader can ask for a position the ring has already trimmed: it must be told, not quietly shortened
  const dropped = await inv("term.poll", { id: o.id, gen: GEN, from: 1 });
  check("a from position the ring dropped is reported as truncated", dropped.truncated === true,
    JSON.stringify({ truncated: dropped.truncated, nextSeq: dropped.nextSeq }));
  check("truncated poll still returns retained output and a usable nextSeq",
    Buffer.from(dropped.data, "base64").length > 0 && dropped.nextSeq > 1);
  const healed = await inv("term.poll", { id: o.id, gen: GEN });
  check("the cursor heals after a truncated poll", healed.truncated === false, JSON.stringify({ truncated: healed.truncated }));

  // Nobody polls this second session at all. The pty must keep running (the ring trims, the drop is
  // reported on the next poll). The output deliberately exceeds 4MB — the threshold the old byte queue
  // paused the pty at — because a pty paused with no reader never resumed: that is the bug this pins.
  const bg = await inv("term.open", { cols: 80, rows: 24 });
  await sleep(600);
  await inv("term.write", { id: bg.id, data: 'seq 1 800000; echo BG""_DONE\n' }); // ~5.5MB, past the old 4MB pause threshold
  await sleep(3000);
  const bgFirst = await inv("term.poll", { id: bg.id, gen: 0 });
  check("an unpolled session drops output instead of freezing its shell", bgFirst.truncated === true,
    JSON.stringify({ truncated: bgFirst.truncated }));
  let bgAcc = "", bgT0 = Date.now();
  while (Date.now() - bgT0 < 20000) {
    const r = await inv("term.poll", { id: bg.id, gen: 0 });
    bgAcc += Buffer.from(r.data, "base64").toString("latin1");
    if (/BG_DONE/.test(bgAcc)) break;
  }
  check("the unpolled shell ran to completion", /BG_DONE/.test(bgAcc), `${Date.now() - bgT0}ms`);
  await inv("term.close", { id: bg.id });

  // A retried poll (host timeout, panel retries) must still get its data. Two polls are in flight with
  // the same `from` and both have to read that block: a shared cursor would give it to whichever
  // finished first and hand the retry an empty response — output lost exactly when the host struggles.
  const at4 = await inv("term.attach", { id: o.id });
  GEN = at4.gen;
  const p1 = inv("term.poll", { id: o.id, gen: GEN, from: at4.nextSeq });
  const p2 = inv("term.poll", { id: o.id, gen: GEN, from: at4.nextSeq });
  await sleep(150);
  await inv("term.write", { id: o.id, data: "echo CONC\"\"_Z\n" });
  const [c1, c2] = await Promise.all([p1, p2]);
  const cb1 = Buffer.from(c1.data, "base64"), cb2 = Buffer.from(c2.data, "base64");
  check("a retried poll at the same seq still receives its data",
    cb1.length > 0 && cb2.length > 0 && cb2.slice(0, 16).equals(cb1.slice(0, 16)), `p1=${cb1.length}B p2=${cb2.length}B`);

  // The pause guard has to keep watching. A reader that looks active, stays behind, then disappears
  // must not leave the pty paused forever — that is the 0.1.6 freeze in a new shape.
  const pzMarker = path.join(require("os").tmpdir(), "pi-terminal-pause-guard.txt");
  try { require("fs").unlinkSync(pzMarker); } catch (_) {}
  const pz = await inv("term.open", { cols: 80, rows: 24 });
  await sleep(600);
  await inv("term.poll", { id: pz.id, gen: 0 });   // reader looks active...
  await inv("term.write", { id: pz.id, data: `seq 1 800000; echo alive > ${pzMarker}\n` }); // ...then floods
  await sleep(500);                                 // backlog > 512KiB with a recent poll -> the pty pauses
  await inv("term.poll", { id: pz.id, gen: 0 });    // drains part of it, stays behind -> the pause is kept
  await sleep(3000);                                // and now the reader never comes back
  let pzAlive = false;
  const pzT0 = Date.now();
  while (Date.now() - pzT0 < 25000) {
    if (require("fs").existsSync(pzMarker)) { pzAlive = true; break; }
    await sleep(200);
  }
  check("a pty paused by a reader that then vanished is released", pzAlive, `${Date.now() - pzT0}ms`);
  await inv("term.close", { id: pz.id });

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

  // Panel settings (term.settings): the backend cleans what the user typed, the panel only applies it.
  // The settings cache lives 3s without a host event, hence the sleeps between mock changes.
  const ps0 = await inv("term.settings", {});
  check("settings: defaults with nothing set", ps0.fontSize === 13 && ps0.fontFamily === "" && ps0.linkNeedsModifier === false && ps0.pasteSingleLine === false, JSON.stringify(ps0));
  global.pi.plugin.getSettings = async () => ({ fontSize: 16, fontFamily: "JetBrains Mono", linkNeedsModifier: true, pasteSingleLine: true });
  await sleep(3200);
  const ps1 = await inv("term.settings", {});
  check("settings: custom values pass through", ps1.fontSize === 16 && ps1.fontFamily === "JetBrains Mono" && ps1.linkNeedsModifier === true && ps1.pasteSingleLine === true, JSON.stringify(ps1));
  global.pi.plugin.getSettings = async () => ({ fontSize: 99, fontFamily: 'Fira"; } body { x: y\n', linkNeedsModifier: "yes", pasteSingleLine: 1 });
  await sleep(3200);
  const ps2 = await inv("term.settings", {});
  check("settings: font size is clamped to 8..32", ps2.fontSize === 32, JSON.stringify(ps2));
  check("settings: font family cannot carry CSS syntax", !/[;{}<>\n]/.test(ps2.fontFamily) && ps2.fontFamily.startsWith("Fira"), JSON.stringify(ps2.fontFamily));
  check("settings: non-boolean switches stay off", ps2.linkNeedsModifier === false && ps2.pasteSingleLine === false, JSON.stringify(ps2));
  global.pi.plugin.getSettings = async () => ({ fontSize: "abc", fontFamily: 42 });
  await sleep(3200);
  const ps3 = await inv("term.settings", {});
  check("settings: garbage falls back to defaults", ps3.fontSize === 13 && ps3.fontFamily === "", JSON.stringify(ps3));
  global.pi.plugin.getSettings = async () => ({ fontSize: 3 });
  await sleep(3200);
  check("settings: tiny font size is clamped up to 8", (await inv("term.settings", {})).fontSize === 8);
  global.pi.plugin.getSettings = async () => ({ fontSize: 0 }); // what the host writes when the box is cleared
  await sleep(3200);
  check("settings: a cleared font size box means default, not the minimum", (await inv("term.settings", {})).fontSize === 13);

  // Saving the zoomed font size (term.saveFont). The mock behaves like the host: setSettings merges into a
  // store, getSettings reads it back, and nothing is pushed as an event (the host only does that for its own dialog).
  const hostStore = { linkNeedsModifier: true }; // an unrelated stored value that must survive
  const hostWrites = [];
  global.pi.plugin.getSettings = async () => ({ ...hostStore });
  global.pi.plugin.setSettings = async (partial) => { hostWrites.push(partial); Object.assign(hostStore, partial); };
  await sleep(3200);
  const sv1 = await inv("term.saveFont", { fontSize: 17 });
  check("saveFont: writes the size through the host", sv1.ok === true && sv1.fontSize === 17 && hostWrites.length === 1 && hostWrites[0].fontSize === 17 && Object.keys(hostWrites[0]).length === 1, JSON.stringify({ sv1, hostWrites }));
  const sv1r = await inv("term.settings", {});
  check("saveFont: the next read already sees it (cache updated, no stale value)", sv1r.fontSize === 17, JSON.stringify(sv1r));
  check("saveFont: other stored settings are kept", sv1r.linkNeedsModifier === true, JSON.stringify(sv1r));
  await sleep(3200); // past the cache TTL: re-read from the "host", which now holds 17
  check("saveFont: survives a re-read from the host", (await inv("term.settings", {})).fontSize === 17);
  const sv2 = await inv("term.saveFont", { fontSize: 99 });
  check("saveFont: a size outside the range is clamped before it is stored", sv2.fontSize === 32 && hostStore.fontSize === 32, JSON.stringify({ sv2, stored: hostStore.fontSize }));
  const bad = [0, -4, "abc", null, undefined, NaN];
  let badRejected = 0;
  for (const b of bad) { if (await inv("term.saveFont", { fontSize: b }).then(() => false, () => true)) badRejected++; }
  check("saveFont: 0, negatives and non-numbers are rejected and nothing is stored", badRejected === bad.length && hostStore.fontSize === 32 && hostWrites.length === 2, JSON.stringify({ badRejected, writes: hostWrites.length }));
  global.pi.plugin.setSettings = async () => { throw new Error("disk full"); };
  const failed = await inv("term.saveFont", { fontSize: 20 }).then(() => "saved", (e) => String(e.message || e));
  check("saveFont: a failed write is reported", failed.includes("disk full"), failed);
  check("saveFont: ...and the cache keeps the stored value, not the one that failed", (await inv("term.settings", {})).fontSize === 32);
  delete global.pi.plugin.setSettings;
  check("saveFont: a host without setSettings is a clean error", await inv("term.saveFont", { fontSize: 15 }).then(() => false, (e) => /cannot save/.test(String(e.message))));
  global.pi.plugin.getSettings = async () => ({});

  // Input method: main.js drives im-select, so the test points it at a stub and reads the stub's own
  // state file. The real im-select (and the user's layout) is never touched.
  const fsMod = require("fs"), osMod = require("os");
  const imeDir = fsMod.mkdtempSync(path.join(osMod.tmpdir(), "pi-ime-"));
  const imeState = path.join(imeDir, "state");
  const imeFail = path.join(imeDir, "fail");
  const imeCalls = path.join(imeDir, "calls");
  const imeStub = path.join(imeDir, "im-select");
  fsMod.writeFileSync(imeState, "com.example.zh\n");
  // Writes take 200ms and fail while the "fail" marker exists, so an edge really is in flight when the
  // next one arrives and the error paths are reachable.
  fsMod.writeFileSync(imeStub, [
    "#!/bin/sh",
    `S="${imeState}"`,
    `F="${imeFail}"`,
    'echo "call:$1" >> "' + imeCalls + '"',
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
  await inv("ime.sync", { focused: false }); // the terminal lost focus again: next focus is a fresh edge

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
  await inv("ime.sync", { focused: false }); // close the failed edge so the next focus is a new one

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

  // ---- from here on the host pushes settings changes (pi.events), as the real host does
  const ABC = "com.apple.keylayout.ABC", ZH = "com.example.zh";
  const nCalls = () => { try { return fsMod.readFileSync(imeCalls, "utf8").split("\n").filter(Boolean).length; } catch (_) { return 0; } };
  const listeners = new Set();
  global.pi.events = {
    on: (e, h) => { if (e === "plugin:settingsChanged") listeners.add(h); },
    off: (e, h) => { listeners.delete(h); },
  };
  await m.onLoad(); // subscribes
  check("ime: onLoad subscribes to settings events", listeners.size === 1, "listeners=" + listeners.size);
  let settingsReads = 0;
  let currentSettings = { imeAutoSwitch: true };
  global.pi.plugin.getSettings = async () => { settingsReads++; return currentSettings; };
  // the host saves, then pushes the merged object; wait for the queued reconcile (stub writes take 200ms)
  const pushSettings = async (v) => { currentSettings = v; for (const h of [...listeners]) h(v); await sleep(700); };

  // already on English: the first focus reads once, repeats of the same edge spawn nothing
  setIme(ABC);
  fsMod.writeFileSync(imeCalls, "");
  await inv("ime.sync", { focused: true });
  const afterFirst = nCalls();
  await inv("ime.sync", { focused: true });
  await inv("ime.sync", { focused: true });
  check("ime: repeated focus spawns nothing", afterFirst === 1 && nCalls() === afterFirst, `first=${afterFirst} total=${nCalls()}`);
  await inv("ime.sync", { focused: false });
  check("ime: blur after an English focus leaves the layout alone", imeNow() === ABC, imeNow());

  // a second / reloaded panel: only the document that reported focus last may blur
  setIme(ZH);
  await inv("ime.sync", { focused: true, client: "A" });
  await inv("ime.sync", { focused: true, client: "B" });
  const lateBlur = await inv("ime.sync", { focused: false, client: "A" });
  check("ime: a late blur from the previous panel is ignored", lateBlur.reason === "not-owner" && imeNow() === ABC, `${JSON.stringify(lateBlur)} now=${imeNow()}`);
  await inv("ime.sync", { focused: false, client: "B" });
  check("ime: the owning panel's blur restores", imeNow() === ZH, imeNow());
  const orphan = await inv("ime.sync", { focused: true, client: "gone" });
  await inv("ime.sync", { focused: true, client: "next" });
  await inv("ime.sync", { focused: false, client: "next" });
  check("ime: a panel that vanished without a blur cannot pin the state", imeNow() === ZH && orphan.switched === true, `${JSON.stringify(orphan)} now=${imeNow()}`);

  // switch turned off while the terminal has focus: the host pushes the change and the source goes
  // back at once, without waiting for a blur
  setIme(ZH);
  await inv("ime.sync", { focused: true });
  check("ime: (setup) focused terminal is on English", imeNow() === ABC, imeNow());
  await pushSettings({ imeAutoSwitch: false });
  const offSt = await inv("ime.state", {});
  check("ime: disabling while focused restores at once",
    imeNow() === ZH && offSt.saved === "" && offSt.applied === false && offSt.focused === true,
    `now=${imeNow()} ${JSON.stringify(offSt)}`);
  const offBlur = await inv("ime.sync", { focused: false });
  check("ime: ...and the blur afterwards has nothing left to do", offBlur.switched === false && imeNow() === ZH, JSON.stringify(offBlur));

  // switch turned on while the terminal already has focus: picked up from the pushed event
  setIme(ZH);
  const offFocus = await inv("ime.sync", { focused: true });
  await pushSettings({ imeAutoSwitch: true });
  check("ime: enabling while focused takes effect on its own", offFocus.reason === "disabled" && imeNow() === ABC, `${offFocus.reason} now=${imeNow()}`);
  await inv("ime.sync", { focused: false });
  check("ime: ...and the blur afterwards restores", imeNow() === ZH, imeNow());

  // a pushed target applies to the next focus
  await pushSettings({ imeAutoSwitch: true, imeTarget: "com.apple.keylayout.US" });
  const pushedTarget = await inv("ime.sync", { focused: true });
  check("ime: pushed target is used", pushedTarget.to === "com.apple.keylayout.US" && imeNow() === "com.apple.keylayout.US", JSON.stringify(pushedTarget));
  await inv("ime.sync", { focused: false });
  await pushSettings({ imeAutoSwitch: true });

  // im-select removed and later put back: found again (after the short miss cache) without a reload
  const away = imeStub + ".away";
  fsMod.renameSync(imeStub, away);
  setIme(ZH);
  const gone = await inv("ime.sync", { focused: true });
  await inv("ime.sync", { focused: false });
  check("ime: a vanished binary is an error, not a crash", gone.ok === false && imeNow() === ZH, JSON.stringify(gone));
  fsMod.renameSync(away, imeStub);
  const missing = await inv("ime.sync", { focused: true });
  check("ime: a fresh miss is remembered briefly", missing.reason === "im-select-missing" && imeNow() === ZH, JSON.stringify(missing));
  await inv("ime.sync", { focused: false });
  await sleep(5300);
  const found = await inv("ime.sync", { focused: true });
  check("ime: binary is looked up again after the miss expires", found.switched === true && imeNow() === ABC, `${JSON.stringify(found)} now=${imeNow()}`);
  await inv("ime.sync", { focused: false });
  check("ime: ...and restores afterwards", imeNow() === ZH, imeNow());

  // the whole point of subscribing: no settings read on any edge since the event feed took over
  check("ime: no settings polling once subscribed", settingsReads === 0, "reads=" + settingsReads);
  await m.onUnload();
  check("ime: unload unsubscribes from settings events", listeners.size === 0, "listeners=" + listeners.size);
  }

  await m.onUnload();
  await sleep(300);
  const { execSync } = require("child_process");
  const left = execSync("pgrep -P " + process.pid + " || true").toString().trim();
  check("no orphan relay processes", left === "", left);
  console.log(ok ? "\nALL PASS" : "\nSOME FAILED");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
