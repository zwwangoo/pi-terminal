// Assemble the installable plugin directory into dist/local.terminal/ (then PluginCheck / PluginPack it).
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const out = path.join(root, "dist", "local.terminal");
const src = path.join(root, "src");
const nm = path.join(root, "node_modules", "@xterm");

for (const f of ["xterm/lib/xterm.js", "addon-fit/lib/addon-fit.js", "addon-web-links/lib/addon-web-links.js"]) {
  if (!fs.existsSync(path.join(nm, f))) {
    console.error("missing " + f + " - run `npm ci` first");
    process.exit(1);
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "views"), { recursive: true });
const cp = (from, to) => fs.copyFileSync(from, path.join(out, to));

// main.js = main.src.js with the python PTY relay embedded as a string literal.
const relay = fs.readFileSync(path.join(src, "relay.py"), "utf8");
const mainSrc = fs.readFileSync(path.join(src, "main.src.js"), "utf8");
if (!mainSrc.includes("__RELAY_SRC__")) throw new Error("main.src.js has no __RELAY_SRC__ placeholder");
fs.writeFileSync(path.join(out, "main.js"), mainSrc.replace("__RELAY_SRC__", () => JSON.stringify(relay)));

cp(path.join(root, "manifest.json"), "manifest.json");
cp(path.join(root, "README.md"), "README.md");
for (const f of ["index.html", "panel.js", "panel.css"]) cp(path.join(src, "views", f), "views/" + f);
cp(path.join(nm, "xterm/lib/xterm.js"), "views/xterm.js");
cp(path.join(nm, "xterm/css/xterm.css"), "views/xterm.css");
cp(path.join(nm, "addon-fit/lib/addon-fit.js"), "views/addon-fit.js");
cp(path.join(nm, "addon-web-links/lib/addon-web-links.js"), "views/addon-web-links.js");

console.log("assembled", out);
