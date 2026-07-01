/**
 * counters.js — animated live counters "N projects · X yrs Y mo".
 * Count-up via requestAnimationFrame, re-animated on every filter change.
 * Writes to EVERY ".js-counters" node (hero + sticky subbar), so the same
 * animation feeds all placements and survives hero re-renders (lang switch).
 */
import { get, subscribe } from "./state.js";
import { filterUnits, countProjects, totalDuration } from "./filter-engine.js";
import { glyphSwap } from "./glyph.js";

let data = null;
let raf = 0;
const shown = { projects: 0, months: 0 };
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

function targetValues() {
  const units = filterUnits(data._units, get("activeTags"), data.tag_taxonomy);
  return {
    projects: countProjects(units),
    months: totalDuration(units).totalMonths
  };
}

function label(projects, months) {
  const yrs = Math.floor(months / 12);
  const mo = months % 12;
  const it = get("lang") === "it";
  const proj = it
    ? `${projects} ${projects === 1 ? "progetto" : "progetti"}`
    : `${projects} ${projects === 1 ? "project" : "projects"}`;
  const parts = [];
  if (yrs > 0) parts.push(it ? `${yrs} ann${yrs === 1 ? "o" : "i"}` : `${yrs} yr${yrs === 1 ? "" : "s"}`);
  if (mo > 0 || yrs === 0) parts.push(it ? `${mo} mes${mo === 1 ? "e" : "i"}` : `${mo} mo`);
  return `${proj} · ${parts.join(" ")}`;
}

// Collapsed form for the mobile subbar: "26p · 19y 11m" / "26p · 19a 11m"
function labelShort(projects, months) {
  const yrs = Math.floor(months / 12), mo = months % 12;
  const it = get("lang") === "it";
  const parts = [];
  if (yrs > 0) parts.push(yrs + (it ? "a" : "y"));
  if (mo > 0 || yrs === 0) parts.push(mo + "m");
  return projects + "p · " + parts.join(" ");
}

// The hero counter count-ups numerically; the subbar counter (req 6) instead
// glyph-swaps so it changes in the same per-character style as the job title
// beside it. So the count-up only writes to the NON-subbar .js-counters nodes.
function heroCounterNodes() {
  return Array.from(document.querySelectorAll(".js-counters"))
    .filter((n) => !n.classList.contains("site-subbar__counters"));
}

function setHero(text) {
  for (const node of heroCounterNodes()) node.textContent = text;
}

function animateTo(target) {
  cancelAnimationFrame(raf);
  const nodes = heroCounterNodes();
  if (!nodes.length) return;
  const from = { ...shown };
  const start = performance.now();
  const dur = 500;
  // .is-recalc marks "the counter is mid-recalculation" → its own colour token.
  for (const n of nodes) n.classList.add("is-recalc");

  function frame(now) {
    const k = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - k, 3); // ease-out cubic
    shown.projects = Math.round(from.projects + (target.projects - from.projects) * e);
    shown.months = Math.round(from.months + (target.months - from.months) * e);
    setHero(label(shown.projects, shown.months));
    if (k < 1) raf = requestAnimationFrame(frame);
    else for (const n of heroCounterNodes()) n.classList.remove("is-recalc");
  }
  raf = requestAnimationFrame(frame);
}

// req 6: the subbar counter retires its old value glyph-by-glyph and assembles
// the new one, mirroring the job-title swap right next to it.
function swapSubbarCounter(animate) {
  const node = document.querySelector(".site-subbar__counters");
  if (!node) return;
  const tv = targetValues();
  // On mobile: collapsed "26p · 19y 11m"; on desktop: full form.
  const text = matchMedia("(max-width: 767px)").matches
    ? labelShort(tv.projects, tv.months)
    : label(tv.projects, tv.months);
  if (animate && window.gsap && !reduced) {
    node.classList.add("is-recalc");
    glyphSwap(window.gsap, node, text, { duration: 0.5 });
    // glyphSwap drives its own internal onComplete (re-split), so the recalc
    // flag is cleared on a timer matching the retire+assemble span.
    setTimeout(() => node.classList.remove("is-recalc"), 900);
  } else {
    node.textContent = text;
  }
}

export function initCounters(cvData) {
  data = cvData;
  animateTo(targetValues());
  swapSubbarCounter(false);
  subscribe("activeTags", () => { animateTo(targetValues()); swapSubbarCounter(true); });
  subscribe("lang", () => { animateTo(targetValues()); swapSubbarCounter(true); });
}
