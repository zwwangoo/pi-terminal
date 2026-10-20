// Test harness ONLY (not shipped): serves local.terminal/views and fakes window.pluginBridge over HTTP -> real main.js onPanelInvoke.
const http = require("http"), fs = require("fs"), path = require("path");
global.pi = { workspace: { get: async () => ({ path: process.argv[2] || process.env.HOME }) } };
const m = require("../dist/local.terminal/main.js");
const root = path.resolve(__dirname, "..", "dist", "local.terminal", "views");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const shim = `<script>window.pluginBridge={invoke:function(c,p){return fetch('/invoke',{method:'POST',body:JSON.stringify({c:c,p:p})}).then(function(r){return r.json()}).then(function(j){if(j.error)throw new Error(j.error);return j.result})},on:function(){}};</script>`;
http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/invoke") {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", async () => {
      const { c, p } = JSON.parse(b);
      try { res.end(JSON.stringify({ result: await m.onPanelInvoke(c, p) })); }
      catch (e) { res.end(JSON.stringify({ error: String(e.message || e) })); }
    });
    return;
  }
  let f = req.url.split("?")[0]; if (f === "/") f = "/index.html";
  const fp = path.join(root, f);
  if (!fp.startsWith(root) || !fs.existsSync(fp)) { res.statusCode = 404; return res.end("nf"); }
  let body = fs.readFileSync(fp);
  if (f === "/index.html") body = Buffer.from(body.toString().replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "").replace("<head>", "<head>" + shim));
  res.setHeader("content-type", types[path.extname(fp)] || "application/octet-stream");
  res.end(body);
}).listen(48765, "127.0.0.1", () => console.log("harness on 48765"));
