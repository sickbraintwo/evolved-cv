/**
 * dev-server.mjs — LOCAL editor backend (NOT for production).
 *
 * Serves the site (site/) at /  and the editor UI (editor/) at /editor/, and
 * exposes a tiny read/write API for the two data files so the editor can
 * "edit here, see on the site":
 *
 *   GET  /api/data   -> site/cv_data.json   (raw JSON text)
 *   GET  /api/ui     -> site/cv_ui.json
 *   PUT  /api/data   -> body = full JSON; validate, write, run sync, 200/400
 *   PUT  /api/ui     -> same for cv_ui.json
 *
 * After a successful PUT it runs `node tools/sync-data.mjs` so site/data/*.js
 * is regenerated and the preview iframe reflects the change on reload.
 *
 * SECURITY: binds to 127.0.0.1 only. It can write EXACTLY two whitelisted
 * files and nothing else. Never deploy this — production serves the static
 * site/ folder (+ the optional contact endpoint), never this server.
 *
 *   node server/dev-server.mjs            -> http://127.0.0.1:8765
 *   PORT=3000 node server/dev-server.mjs
 */
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const SITE = join(ROOT, "site");
const EDITOR = join(ROOT, "editor");
function dirname(p) { return p.replace(/[\\/][^\\/]*$/, ""); }

const HOST = "127.0.0.1";
// Windows reserves/excludes some port ranges (Hyper-V/WinNAT) -> binding can
// fail with EACCES even though nothing is using the port. We try a list of
// candidates and, as a last resort, port 0 (the OS picks any free port).
const PREFERRED = Number(process.env.PORT) || 8765;
const PORT_CANDIDATES = [PREFERRED, 8123, 5179, 4321, 8090, 0];

// The ONLY files the API may read/write, by API key.
const DATA_FILES = {
  data: join(SITE, "cv_data.json"),
  ui: join(SITE, "cv_ui.json")
};

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

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function json(res, code, obj) {
  send(res, code, JSON.stringify(obj), "application/json; charset=utf-8");
}

/** Read the request body fully (capped) into a string. */
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Run tools/sync-data.mjs; resolves with combined stdout/stderr. */
function runSync() {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [join(ROOT, "tools", "sync-data.mjs")], { cwd: ROOT },
      (err, stdout, stderr) => {
        if (err) { err.detail = (stdout || "") + (stderr || ""); reject(err); return; }
        resolve((stdout || "") + (stderr || ""));
      });
  });
}

/** Serve a static file from a base dir; 404 if missing or path escapes base. */
async function serveStatic(res, baseDir, relPath) {
  let p = relPath;
  if (p === "" || p.endsWith("/")) p += "index.html";
  const filePath = join(baseDir, normalize(p));
  if (filePath !== baseDir && !filePath.startsWith(baseDir + sep)) {
    return send(res, 403, "403 Forbidden");
  }
  try {
    const buf = await readFile(filePath);
    send(res, 200, buf, TYPES[extname(filePath).toLowerCase()] || "application/octet-stream");
  } catch {
    send(res, 404, "404 Not Found");
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  const path = decodeURIComponent(url.pathname);

  // ---- API ----
  if (path.startsWith("/api/")) {
    const key = path.slice("/api/".length); // "data" | "ui"
    const file = DATA_FILES[key];
    if (!file) return json(res, 404, { error: "unknown resource" });

    if (req.method === "GET") {
      try {
        const text = await readFile(file, "utf8");
        return send(res, 200, text, "application/json; charset=utf-8");
      } catch (e) {
        return json(res, 500, { error: "read failed", detail: String(e) });
      }
    }

    if (req.method === "PUT") {
      let text;
      try { text = await readBody(req); }
      catch (e) { return json(res, 413, { error: String(e.message || e) }); }
      // validate: must be parseable JSON (we never write garbage to disk)
      try { JSON.parse(text); }
      catch (e) { return json(res, 400, { error: "invalid JSON", detail: String(e.message || e) }); }
      try {
        await writeFile(file, text.endsWith("\n") ? text : text + "\n", "utf8");
      } catch (e) {
        return json(res, 500, { error: "write failed", detail: String(e) });
      }
      // regenerate data/*.js so the preview reflects the change
      try {
        const out = await runSync();
        return json(res, 200, { ok: true, sync: out.trim() });
      } catch (e) {
        // file is saved but sync failed (e.g. taxonomy coverage) — report it
        return json(res, 422, { ok: false, error: "sync failed", detail: String(e.detail || e.message || e) });
      }
    }

    res.writeHead(405, { Allow: "GET, PUT" });
    return res.end("405 Method Not Allowed");
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, "405 Method Not Allowed");
  }

  // ---- editor UI at /editor ----
  if (path === "/editor" || path.startsWith("/editor/")) {
    return serveStatic(res, EDITOR, path.slice("/editor".length).replace(/^\//, ""));
  }

  // ---- everything else: the site ----
  return serveStatic(res, SITE, path.replace(/^\//, ""));
}

// Bind to the first working candidate. Each attempt uses a FRESH server: a
// listen failure (EACCES on Windows-reserved ports, EADDRINUSE if taken) is
// retried on the next candidate. Reusing one server across attempts misbehaves
// on Windows, and a pre-bind probe leaves a phantom socket — so we just try.
// Final candidate 0 = the OS assigns any free port.
function startOn(i) {
  const port = PORT_CANDIDATES[i];
  const srv = createServer(handleRequest);
  srv.once("error", (err) => {
    if ((err.code === "EACCES" || err.code === "EADDRINUSE") && i + 1 < PORT_CANDIDATES.length) {
      console.warn(`Port ${port} not available (${err.code}) — trying the next one…`);
      startOn(i + 1);
    } else {
      throw err;
    }
  });
  srv.listen(port, HOST, () => {
    const actual = srv.address().port;
    console.log(`EvolvedCV editor backend (LOCAL ONLY)`);
    console.log(`  site   : http://${HOST}:${actual}/`);
    console.log(`  editor : http://${HOST}:${actual}/editor/`);
    console.log("Press Ctrl+C to stop.");
  });
}
startOn(0);
