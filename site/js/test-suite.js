/**
 * test-suite.js — shared assertions for the pure filter engine.
 * Used by both test.html (browser) and tools/run-tests.mjs (Node).
 * Pure module: takes the raw cv data, returns [{ name, pass, detail }].
 */
import {
  buildUnits,
  filterUnits,
  countProjects,
  totalDuration,
  computeHeadline
} from "./filter-engine.js";

export function runSuite(data) {
  const results = [];
  const taxonomy = data.tag_taxonomy;
  const units = buildUnits(data, taxonomy);

  function check(name, condition, detail = "") {
    results.push({ name, pass: !!condition, detail: String(detail) });
  }

  /* ---- expskills (explicit references) ---- */
  const noExpskills = data.experience.filter((e) => !(e.expskills || []).length);
  check("every experience references at least one expskill",
    noExpskills.length === 0, noExpskills.map((e) => e.id).join(","));

  /* ---- units ---- */
  check("units expand projects (8 experiences -> 26 units)",
    units.length === 26, `got ${units.length}`);

  const jrcUnits = units.filter((u) => u.expId === "jrc_2015");
  check("JRC experience yields 9 project units", jrcUnits.length === 9, jrcUnits.length);

  check("project units inherit the parent experience's expskills",
    jrcUnits.every((u) => u.tags.includes("mr") && u.tags.includes("vr")) &&
    jrcUnits.every((u) => u.tags.length === jrcUnits[0].tags.length));

  /* ---- filtering ---- */
  check("empty selection matches everything",
    filterUnits(units, new Set(), taxonomy).length === units.length);

  const ai = filterUnits(units, new Set(["ai-automation"]), taxonomy);
  check("single-tag filter returns only matching units",
    ai.length > 0 && ai.every((u) => u.tags.includes("ai-automation")), `${ai.length} units`);

  const vr = filterUnits(units, new Set(["vr"]), taxonomy);
  const ar = filterUnits(units, new Set(["ar"]), taxonomy);
  const vrOrAr = filterUnits(units, new Set(["vr", "ar"]), taxonomy);
  check("OR within a domain (vr+ar = union ⊇ each)",
    vrOrAr.length >= Math.max(vr.length, ar.length) &&
    vrOrAr.length <= vr.length + ar.length &&
    vrOrAr.every((u) => u.tags.includes("vr") || u.tags.includes("ar")),
    `vr=${vr.length} ar=${ar.length} or=${vrOrAr.length}`);

  const cross = filterUnits(units, new Set(["3d-modeling", "ui-ux"]), taxonomy);
  check("OR across domains (every result has at least one)",
    cross.every((u) => u.tags.includes("3d-modeling") || u.tags.includes("ui-ux")),
    `${cross.length} units`);

  check("countProjects counts matching units", countProjects(ai) === ai.length);

  /* ---- duration merging ---- */
  const now = new Date(2026, 5, 12); // fixed clock: Jun 2026

  const winter = units.filter((u) => u.company === "Winteraction Lab");
  const wd = totalDuration(winter, now);
  check("7 contiguous Winteraction roles merge to exactly 3 years (not summed)",
    wd.totalMonths === 36 && wd.years === 3 && wd.months === 0,
    `${wd.years}y ${wd.months}m`);

  const synthetic = [
    { expId: "a", period: { start: "2020-01", end: "2020-12" } },
    { expId: "b", period: { start: "2020-06", end: "2021-05" } }
  ];
  const sd = totalDuration(synthetic, now);
  check("overlapping intervals merge (Jan 2020–May 2021 = 17 mo)",
    sd.totalMonths === 17, `${sd.totalMonths} mo`);

  const present = totalDuration(
    [{ expId: "p", period: { start: "2026-01", end: "present" } }], now);
  check("end:'present' extends to today (Jan–Jun 2026 = 6 mo)",
    present.totalMonths === 6, `${present.totalMonths} mo`);

  const all = totalDuration(units, now);
  check("full career duration merges concurrent roles (239 mo = 19y 11m)",
    all.totalMonths === 239 && all.years === 19 && all.months === 11,
    `${all.years}y ${all.months}m (${all.totalMonths} mo)`);

  /* ---- headline ---- */
  const h1 = computeHeadline(new Set(["3d-modeling", "mobile"]), data.headline_rules, taxonomy, "en");
  check("curated headline match", h1 === "3D Mobile Developer", h1);

  const h2 = computeHeadline(new Set(["mobile", "3d-modeling"]), data.headline_rules, taxonomy, "en");
  check("curated match is order-insensitive", h2 === h1, h2);

  const h3 = computeHeadline(new Set(["vfx", "scripting"]), data.headline_rules, taxonomy, "en");
  check("compositive fallback uses fragments + domain role",
    h3.includes("VFX") && h3.includes("Scripting"), h3);

  const h4 = computeHeadline(new Set(), data.headline_rules, taxonomy, "en", "Profile Headline");
  check("empty selection falls back to profile headline", h4 === "Profile Headline", h4);

  const h5 = computeHeadline(new Set(["ai-automation"]), data.headline_rules, taxonomy, "it");
  check("curated headline respects language", h5 === "Architetto di Automazione AI", h5);

  return results;
}
