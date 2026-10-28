// Window ⌘T shortcut, offline (mocked `pi`, no PTY): the manifest's shortcut setting and the runtime
// have to agree on one command id, and that command must reveal our view. A rename on either side
// fails here instead of leaving a dead keybinding. The accelerator itself is validated by the host.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
let ok = true;
const check = (name, cond, extra = "") => { if (!cond) ok = false; console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); };

const shortcut = (manifest.contributes?.settings ?? []).find((s) => s.type === "shortcut");
const viewId = manifest.contributes?.views?.[0]?.id;

const registered = new Map();
const revealed = [];
global.pi = {
  plugin: { getSettings: async () => ({}) },
  workspace: { get: async () => ({ path: "" }) },
  commands: { register: async (c) => registered.set(c.id, c) },
  ui: { revealView: async (input) => { revealed.push(input); } },
};
const m = require(path.resolve(root, "dist", "local.terminal", "main.js"));

(async () => {
  await m.onLoad();
  const command = registered.get(shortcut?.command);
  check("onLoad registers the command the shortcut names", Boolean(command?.run), `${shortcut?.command} vs ${[...registered.keys()]}`);
  await command.run();
  check("run reveals the terminal view", revealed.length === 1 && revealed[0].viewId === viewId, JSON.stringify(revealed));
  // No active session is the normal refusal; the keypress must stay quiet instead of rejecting.
  global.pi.ui.revealView = async () => { throw new Error("no session is active"); };
  check("a refused reveal does not throw", await command.run().then(() => true, () => false));
  await m.onUnload();
  console.log(ok ? "\nALL PASS" : "\nSOME FAILED");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
