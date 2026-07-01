/**
 * header-bars.js — scroll-driven header restructure.
 *
 * At scroll 0 the first bar shows only "EvolvedCV" + IT/PDF. Past the hero
 * threshold body.is-scrolled is toggled, which (via CSS in main.css):
 *   - reveals "— Christina Debug" next to the brand,
 *   - slides in the second sticky bar (live headline + counters),
 *   - materializes the Filters button top-right (filter-overlay.css).
 * The same toggle is broadcast as a "evolvedcv:scrolled" CustomEvent so the
 * inline constellation (hero-orbit.js) can run its collapse morph in sync.
 *
 * Also measures the first bar's height into --bar1-h (used by the FAB to
 * align with the bars) and keeps the subbar headline live (filter-engine).
 *
 * Guards: works with or without GSAP. With GSAP+ScrollTrigger (and no
 * reduced motion preference) the threshold is a ScrollTrigger toggle;
 * otherwise a passive scroll listener (bars still appear, CSS transitions
 * are neutralized by the global reduced-motion rule).
 */
import { get, subscribe } from "./state.js";
import { computeHeadline } from "./filter-engine.js";
import { glyphSwap } from "./glyph.js";
import { t } from "./i18n.js";

let data = null;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

function headlineText() {
  return computeHeadline(
    get("activeTags"),
    data.headline_rules,
    data.tag_taxonomy,
    get("lang"),
    t(data.profile.headline)
  );
}

// Shrinks #subbar-headline font-size so the full text fits on one line on
// mobile (no ellipsis). Resets to CSS default on desktop.
function fitHeadline() {
  const node = document.getElementById("subbar-headline");
  if (!node) return;
  node.style.fontSize = "";                                 // reset to CSS base
  if (!matchMedia("(max-width: 767px)").matches) return;   // desktop: leave default
  const avail = node.clientWidth;
  const needed = node.scrollWidth;                         // full text at base size
  if (avail > 0 && needed > avail) {
    const base = parseFloat(getComputedStyle(node).fontSize) || 16;
    // 0.95 safety factor so the fitted width lands UNDER `avail` (no ellipsis);
    // floor to whole px; min 9px so the whole title fits even on a 312px phone.
    node.style.fontSize = Math.max(9, Math.floor(base * (avail / needed) * 0.95)) + "px";
  }
}

// req 6: every tag selection swaps the subbar job title — the old title
// retires glyph-by-glyph and the new one assembles in its place.
function updateHeadline(animate) {
  const node = document.getElementById("subbar-headline");
  if (!node) return;
  const text = headlineText();
  if (animate && window.gsap && !reduced) {
    glyphSwap(window.gsap, node, text, { duration: 0.5 });
    setTimeout(fitHeadline, 700);  // re-fit after swap settles
  } else {
    node.textContent = text;
    fitHeadline();
  }
}

function setScrolled(on) {
  if (document.body.classList.contains("is-scrolled") === on) return;
  document.body.classList.toggle("is-scrolled", on);
  dispatchEvent(new CustomEvent("evolvedcv:scrolled", { detail: { scrolled: on } }));
}

export function initHeaderBars(cvData) {
  data = cvData;

  updateHeadline(false);   // also calls fitHeadline() inside (non-animated branch)
  subscribe("activeTags", () => updateHeadline(true));
  subscribe("lang", () => updateHeadline(true));
  addEventListener("resize", fitHeadline, { passive: true });
  addEventListener("orientationchange", fitHeadline, { passive: true });

  // --bar1-h: first bar height, used to align the Filters button (FAB)
  const bar1 = document.querySelector(".site-header__inner");
  const setBarH = () => {
    if (bar1) document.documentElement.style.setProperty("--bar1-h", `${bar1.offsetHeight}px`);
  };
  setBarH();
  if (window.ResizeObserver && bar1) new ResizeObserver(setBarH).observe(bar1);

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isMobile = matchMedia("(max-width: 767px)").matches;

  if (isMobile) {
    // MOBILE: flip is-scrolled when the hero counter line crosses under the sticky header.
    // Natural hysteresis: once scrolled the header grows (e.g. 48→~110px), so headerBottom
    // jumps up and the condition stays true — no flicker on the way back up.
    const counter = document.querySelector(".hero__counters") || document.getElementById("counters");
    const header  = document.querySelector(".site-header");
    const check = () => {
      if (!counter || !header) return;
      const headerBottom = header.getBoundingClientRect().bottom;  // live; taller when scrolled → natural hysteresis
      const counterTop   = counter.getBoundingClientRect().top;
      setScrolled(counterTop < headerBottom);
    };
    addEventListener("scroll", check, { passive: true });
    addEventListener("resize", check, { passive: true });
    check();
  } else {
    // DESKTOP: original GSAP ScrollTrigger / passive-scroll fallback, unchanged.
    if (window.gsap && window.ScrollTrigger && !reduced) {
      window.gsap.registerPlugin(window.ScrollTrigger);
      window.ScrollTrigger.create({
        trigger: "#hero",
        start: "bottom 35%",
        onEnter: () => setScrolled(true),
        onLeaveBack: () => setScrolled(false)
      });
    } else {
      // fallback: same threshold (~end of hero) via passive scroll listener
      const check = () => {
        const hero = document.getElementById("hero");
        const threshold = hero ? hero.offsetTop + hero.offsetHeight - innerHeight * 0.35 : innerHeight;
        setScrolled(scrollY >= threshold);
      };
      addEventListener("scroll", check, { passive: true });
      addEventListener("resize", check, { passive: true });
      check();
    }
  }
}
