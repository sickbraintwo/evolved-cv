/**
 * scroll-story.js — F6a: GSAP ScrollTrigger scrollytelling.
 *
 * Effects (all subtle, all optional):
 *   1. Progressive reveal of section cards (fade + rise, stagger).
 *   2. Per-glyph text assembly (req 7): section titles, the About paragraph,
 *      expertise/experience/education headings and the contact button text are
 *      split into per-character spans that fly in from scattered positions.
 *      The effect REPLAYS every time the element enters the viewport, in both
 *      scroll directions (req 8), re-scattering once it leaves.
 *   3. Hero parallax: inner block drifts up and fades as you scroll past.
 *   4. Experience timeline: a vertical accent line "draws" itself while the
 *      section scrolls through the viewport (CSS var --timeline-draw).
 *
 * Accessibility: each split element keeps its full text as aria-label; the
 * glyph spans are aria-hidden.
 *
 * Hard guards:
 *   - window.gsap / window.ScrollTrigger missing  -> console.warn + no-op.
 *   - prefers-reduced-motion: reduce              -> no-op (content stays
 *     fully visible; we never pre-hide anything in CSS).
 *
 * Language toggle re-renders every section (new DOM nodes), so all triggers
 * are rebuilt on `lang` changes via gsap.context().revert().
 */
import { subscribe } from "./state.js";
import { glyphRevealIO } from "./glyph.js";

// Batch fade+rise for structural blocks. Text elements that get the per-glyph
// assembly (below) are intentionally excluded so they don't double-animate.
const REVEAL_SELECTOR = [
  ".expertise-card",
  ".exp-card",
  ".education-card",
  ".education-langs",
  ".contact-link"
].join(", ");

// Elements whose TEXT assembles glyph-by-glyph when scrolled into view (req 7).
// Re-triggers on every entry, both directions (req 8). The hero headline/sub/
// meta get the same effect but driven by the deflagration intro, not here.
//
// ALL of these are driven by an IntersectionObserver (see glyph.js
// glyphRevealIO), NOT a ScrollTrigger. ScrollTrigger caches each trigger's
// pixel position and only updates on refresh(); but the experience grid
// expands/collapses, changing the height of the page below it — which left
// ScrollTrigger-based reveals (Education, Contact, …) stuck scattered/invisible,
// and calling ScrollTrigger.refresh() to fix them corrupted the glyph tweens
// site-wide. An IntersectionObserver always reflects each element's REAL
// geometry and self-corrects on any layout shift, so one robust mechanism now
// covers every glyph reveal. (.project__name is handled separately, at
// expand-time, by card-expand.js.)
const GLYPH_SELECTOR = [
  ".section:not(.section--hero) > h2.section-title",
  ".about__summary",
  ".expertise-card__title",
  ".company-card__name",
  ".role__title",
  ".education-card__title",
  ".contact-link__text"
].join(", ");

let gsapCtx = null;
let glyphObservers = [];
let revealObserver = null;

/**
 * Fade+rise reveal (cards, contact links, …) driven by an IntersectionObserver.
 * Was a ScrollTrigger.batch, but ScrollTrigger caches each trigger's pixel
 * position and only updates on refresh(); when a filter collapses the
 * experience grid the cached positions go stale and the still-unrevealed items
 * below (e.g. the Contact links) never fired their onEnter → stayed at
 * opacity:0 (the section looked EMPTY below its title). An IntersectionObserver
 * reflects each element's real geometry and self-corrects on any layout shift.
 * Reveals once, then unobserves; clears inline props so the filter engine
 * (.is-hidden) keeps control afterwards.
 */
function revealOnScroll() {
  const gsap = window.gsap;
  const items = gsap.utils.toArray(REVEAL_SELECTOR);
  if (!items.length) return null;
  gsap.set(items, { opacity: 0, y: 26 });
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      gsap.to(e.target, {
        opacity: 1, y: 0, duration: 0.6, ease: "power2.out",
        clearProps: "opacity,transform"
      });
      io.unobserve(e.target);
    }
  }, { threshold: 0, rootMargin: "0px 0px -10% 0px" });
  items.forEach((el) => io.observe(el));
  return io;
}

/** Apply the IntersectionObserver-driven glyph reveal to every match. */
function splitAndAnimateGlyphs() {
  glyphObservers = window.gsap.utils
    .toArray(GLYPH_SELECTOR)
    .map((el) => glyphRevealIO(el))
    .filter(Boolean);
}

/**
 * Snap every glyph-reveal element currently in view to its ASSEMBLED state
 * instantly. The IntersectionObserver assembles with a ~1.25s scatter tween,
 * which looks like the page "breaking" below the experience grid when a filter
 * reflow slides those sections into view (a layout shift, not a scroll). Calling
 * this during/after the filter animation keeps them clean. Out-of-view elements
 * are left to the observer (they stay scattered, ready to replay on scroll).
 */
export function resyncGlyphReveals() {
  const gsap = window.gsap;
  if (!gsap) return;
  for (const io of glyphObservers) {
    const el = io && io._el;
    const glyphs = io && io._glyphs;
    if (!el || !glyphs || !glyphs.length) continue;
    // Assemble anything anywhere in the viewport (not the IO's 88% line) so a
    // title that lands at the very bottom edge after a filter isn't left
    // scattered in the dead-zone.
    const r = el.getBoundingClientRect();
    if (r.top < innerHeight && r.bottom > 0) {
      gsap.set(glyphs, { opacity: 1, x: 0, y: 0, rotation: 0, overwrite: true });
    }
  }
}

function build() {
  const gsap = window.gsap;

  /* ---- 1. reveal: fade + rise (cards, links) — IntersectionObserver so it
     survives the filter's layout shifts (see revealOnScroll) ---- */
  if (revealObserver) revealObserver.disconnect();
  revealObserver = revealOnScroll();

  gsapCtx = gsap.context(() => {
    /* ---- 2. per-glyph text assembly (titles + body, replays each entry) ---- */
    splitAndAnimateGlyphs();

    /* ---- 3. hero parallax (scrubbed, very light) ----
       When scene-nav is active the hero is a locked full-screen scene so there
       is no free scrolling within it to parallax against. initScrollStory runs
       BEFORE initSceneNav (same boot sequence), so the "scene-nav" class is not
       set here yet — the ST IS created, but initSceneNav subsequently calls
       disableScrollDriving() to kill it. The class check is kept for clarity and
       future boot-order robustness. */
    const heroInner = document.querySelector(".hero__inner");
    // Skip on MOBILE: phones run native scroll + the Canvas-2D physics layer
    // (no scene-nav), and this parallax would fade the hero text out on scroll —
    // unwanted there (the user never asked for it). Desktop is unaffected.
    const mobileNative = matchMedia("(max-width: 767px)").matches;
    if (heroInner && !mobileNative && !document.body.classList.contains("scene-nav")) {
      gsap.to(heroInner, {
        yPercent: -12,
        opacity: 0.25,
        ease: "none",
        scrollTrigger: {
          trigger: "#hero",
          start: "top top",
          end: "bottom 25%",
          scrub: 0.4
        }
      });
    }

  });

  window.ScrollTrigger.refresh();
}

export function initScrollStory() {
  if (!window.gsap || !window.ScrollTrigger) {
    console.warn("[scroll-story] GSAP/ScrollTrigger not available — skipping scroll effects");
    return;
  }
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    // Content is visible by default; simply do nothing.
    return;
  }

  window.gsap.registerPlugin(window.ScrollTrigger);
  build();

  // Language switch re-renders all sections: revert old triggers/tweens
  // (restores inline styles) and rebuild on the fresh DOM. ui-renderer's
  // own `lang` subscriber registered first, so the DOM is new by now.
  subscribe("lang", () => {
    if (gsapCtx) gsapCtx.revert();
    // Disconnect IO observers bound to the old (about-to-be-replaced) DOM nodes
    glyphObservers.forEach((io) => io.disconnect());
    glyphObservers = [];
    if (revealObserver) { revealObserver.disconnect(); revealObserver = null; }
    build();
  });
}

/**
 * Kill the hero-parallax ScrollTrigger if it was created despite scene-nav being
 * active (belt-and-suspenders — called by initSceneNav after boot). The IO reveals
 * and card reveals are left intact; only the scroll-scrub parallax is killed.
 */
export function disableScrollDriving() {
  if (!window.ScrollTrigger) return;
  // Find the hero-parallax trigger by its trigger element and kill it.
  const heroParallaxTriggers = window.ScrollTrigger.getAll().filter(
    (st) => st.trigger && st.trigger.id === "hero"
  );
  heroParallaxTriggers.forEach((st) => { try { st.kill(); } catch { /* no-op */ } });
}
