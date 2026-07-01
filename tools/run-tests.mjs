/**
 * run-tests.mjs — Node runner for the same suite used by test.html.
 * Run: node tools/run-tests.mjs   (exit 1 on any failure)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runSuite } from "../site/js/test-suite.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(root, "site", "cv_data.json"), "utf8"));

const results = runSuite(data);
let failed = 0;
for (const r of results) {
  const mark = r.pass ? "PASS" : "FAIL";
  if (!r.pass) failed++;
  console.log(`${mark}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} tests passed`);
process.exit(failed > 0 ? 1 : 0);
