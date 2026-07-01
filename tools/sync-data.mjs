/**
 * sync-data.mjs — zero-dependency build helper.
 *
 * 1. Reads cv_data.json (textual content) + cv_ui.json (non-textual: theme,
 *    colors, particles, glass material).
 * 2. Validates that every expskill id referenced by an experience or an
 *    education entry (.expskills) exists in tag_taxonomy.
 * 3. Generates data/cv_data.js (window.CV_DATA) and data/cv_ui.js
 *    (window.CV_UI) so the site works from file:// and avoids a fetch.
 *
 * Run: node tools/sync-data.mjs
 * Exits 1 (and prints the uncovered list) if validation fails.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(root, "site", "cv_data.json"), "utf8"));
const ui = JSON.parse(readFileSync(join(root, "site", "cv_ui.json"), "utf8"));

/* ---------- validation ---------- */

const validIds = new Set();
for (const domain of data.tag_taxonomy.domains) {
  for (const tag of domain.tags) validIds.add(tag.id);
}

const referenced = new Set();
for (const exp of data.experience) {
  for (const id of exp.expskills || []) referenced.add(id);
}
for (const edu of data.education || []) {
  for (const id of edu.expskills || []) referenced.add(id);
}

const unknown = [...referenced].filter((id) => !validIds.has(id));
if (unknown.length > 0) {
  console.warn("WARNING: experiences/education reference unknown expskill ids:");
  for (const id of unknown) console.warn("  - " + id);
  process.exit(1);
}
console.log(`Expskill refs OK (${referenced.size} distinct expskills referenced).`);

/* ---------- generation ---------- */

mkdirSync(join(root, "site", "data"), { recursive: true });

const dataHeader =
  "/* AUTO-GENERATED — edit cv_data.json then run: node tools/sync-data.mjs */\n";
writeFileSync(join(root, "site", "data", "cv_data.js"),
  `${dataHeader}window.CV_DATA = ${JSON.stringify(data, null, 2)};\n`, "utf8");
console.log("data/cv_data.js generated.");

const uiHeader =
  "/* AUTO-GENERATED — edit cv_ui.json then run: node tools/sync-data.mjs */\n";
writeFileSync(join(root, "site", "data", "cv_ui.js"),
  `${uiHeader}window.CV_UI = ${JSON.stringify(ui, null, 2)};\n`, "utf8");
console.log("data/cv_ui.js generated.");
