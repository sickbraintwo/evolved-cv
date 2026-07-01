/**
 * serve.mjs — tiny static dev server (no dependencies).
 * Serves the site/ folder over HTTP so fetch("cv_data.json") works exactly
 * like it will on the VPS (site/ contents are deployed at web root). Usage:
 *
 *   node tools/serve.mjs            -> http://localhost:8741
 *   PORT=3000 node tools/serve.mjs  -> http://localhost:3000
 *
 * The screenshot harness (tools/shoot*.mjs) expects this on port 8741.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
function dirname(p) { return p.replace(/[\\/][^\\/]*$/, ""); }

const PORT = Number(process.env.PORT) || 5189; // 8xxx ranges are often reserved by Hyper-V/WSL/Docker on Windows
const HOST = process.env.HOST || "0.0.0.0";    // bind LAN so a phone on the same Wi-Fi can open it
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
  ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2"
};

createServer(async (req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/" || p.endsWith("/")) p += "index.html";
  const filePath = join(root, normalize(p));
  if (!filePath.startsWith(root)) { res.writeHead(403); res.end("403"); return; }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
  }
}).listen(PORT, HOST, () => {
  console.log(`EvolvedCV served at  http://localhost:${PORT}   (host=${HOST})`);
  console.log(`On your phone (same Wi-Fi):  http://<this-pc-ip>:${PORT}`);
  console.log("Press Ctrl+C to stop.");
});
