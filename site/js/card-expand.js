/**
 * card-expand.js — Blocco C: accordion expand/collapse for .exp-card.
 *
 * Clicking a card expands it to full-row width (flex-basis:100% via .is-expanded)
 * and reveals .exp-card__detail. A second click (or clicking another card)
 * collapses it. GSAP Flip is used to animate the reflow of all cards.
 *
 * Fallback: if window.gsap or window.Flip is missing, toggle happens
 * instantaneously (no crash).
 *
 * Guards:
 *  - prefers-reduced-motion: expansion works but skips GSAP Flip animation.
 *  - Links inside .exp-card__detail: click does NOT trigger expand/collapse.
 *  - Cards hidden by filters (.is-hidden): if a hidden card was expanded,
 *    .is-expanded is removed automatically.
 *
 * Animation fixes (smooth accordion):
 *  A) `.experience-grid.is-flipping .exp-card { transition: none !important }`
 *     in CSS prevents the 200ms ease-out tilt transition from fighting Flip's
 *     matrix tweens (rubber-band fix).
 *  B) `absolute:true` + `position:relative` on grid (set in CSS) + animated
 *     grid height keeps the sections below from jumping during the transition.
 *  C) GSAP drives the detail panel fade-in instead of the CSS keyframe that
 *     was fighting the reflow animation.
 *  D) `.project__name` glyph assembly is deferred to expand-time (not built
 *     in scroll-story while hidden) so glyphs are always visible when opened.
 *
 * @returns {{ dispose: () => void }}
 */

import { splitIntoGlyphs, glyphScatter, glyphRevealIO } from "./glyph.js";
import { glassReflow, GLASS_DURATION, GLASS_EASE } from "./glass-motion.js";

const FLIP_DURATION = GLASS_DURATION; // one shared clock for every glass reflow
const FLIP_EASE     = GLASS_EASE;
const SCROLL_GAP    = 16; // px breathing room below the sticky header

/** Height of the sticky header right now (includes the subbar when revealed). */
function stickyHeaderHeight() {
  const header = document.querySelector(".site-header");
  return header ? header.getBoundingClientRect().height : 0;
}

export function initCardExpand() {
  const section = document.getElementById("experience");
  if (!section) return { dispose() {} };

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // IntersectionObservers driving the per-glyph reveal of project titles.
  // Attached lazily the first time a card is expanded (project titles live in
  // the collapsed-hidden detail panel, so they can't be observed up-front like
  // the always-rendered section titles). Tracked here so dispose() can clean up.
  const projNameObservers = [];

  // Register GSAP Flip plugin if both are available
  if (window.gsap && window.Flip) {
    gsap.registerPlugin(Flip);
  }

  // ---- helpers ----------------------------------------------------------------

  /**
   * Collapses the given card (removes .is-expanded, updates aria).
   * Does NOT run a Flip transition — caller is responsible for Flip.
   */
  function collapse(card) {
    card.classList.remove("is-expanded");
    card.setAttribute("aria-expanded", "false");
    // Clear any stale tilt transform so Flip measures cleanly
    card.style.transform = "";
  }

  /**
   * Expands the given card (adds .is-expanded, updates aria).
   * Does NOT run a Flip transition — caller is responsible for Flip.
   */
  function expand(card) {
    card.classList.add("is-expanded");
    card.setAttribute("aria-expanded", "true");
  }

  /**
   * Finds the currently expanded card in the grid, or null.
   */
  function currentlyExpanded() {
    return section.querySelector(".exp-card.is-expanded") || null;
  }

  /**
   * Runs the expand/collapse reflow through the shared glass choreographer
   * (glass-motion.js): the Flip, the grid-height glide and the auto-scroll all
   * live on ONE timeline with ONE ease, so the card opens in a SINGLE motion
   * (no "snap then settle"). This module only contributes its bespoke children
   * (detail fade) and post-steps (project-title glyph reveal) onto that same
   * timeline.
   *
   * Glyph note: splitIntoGlyphs runs inside `mutate` (BEFORE glass-motion
   * measures the after-height) because it changes inline-block wrapping/height;
   * scatter is a pure transform so it rides along. The reveal observers attach
   * onSettle (page is still by then, so the first assembly isn't masked).
   */
  function flipTransition(grid, afterFn, expandingCard, holdCard = null) {
    let detail = null;
    const freshNames = []; // project-title nodes that still need an observer

    // Closing a card shrinks the grid by ~its whole height → the document gets
    // shorter and the browser CLAMPS scrollY upward, yanking the page (the
    // "heights/positions readjust" second/third beats). Capture the closing
    // card's CURRENT viewport top now (still expanded) so the live anchor below
    // can HOLD it there every frame — the closed card stays put (decision B) and
    // the clamp can't stratton the page. Null when opening (that uses the
    // under-header target instead).
    const holdTop = holdCard ? holdCard.getBoundingClientRect().top : null;

    const mutate = () => {
      afterFn(); // toggle classes + aria

      if (expandingCard && window.gsap && !reducedMotion) {
        detail = expandingCard.querySelector(".exp-card__detail");
        if (detail) {
          gsap.set(detail, { opacity: 0 }); // hide so scatter start doesn't flash
          detail.querySelectorAll(".project__name").forEach((el) => {
            const glyphs = splitIntoGlyphs(el); // idempotent; layout-affecting
            if (glyphs.length && el.dataset.pnReveal !== "1") {
              glyphScatter(gsap, glyphs);       // keep hidden until revealed
              freshNames.push(el);
            }
          });
        }
      }
    };

    glassReflow(grid, mutate, {
      duration: FLIP_DURATION,
      ease:     FLIP_EASE,
      scale:    false, // animate width/height so the card text stays crisp
      // Opening: glide the card's TOP to just below the sticky header via the
      // live eased anchor (reads the card's real rect each frame) so it never
      // lags a growing grid and lands aligned with no "arrive-from-below" tail.
      // Closing: HOLD the card's top at where it sits now (fromTop==toTop), so
      // the shrinking grid can't clamp-yank the page (decision B: stay put).
      scrollEaseTop: expandingCard
        ? { el: expandingCard, toTop: () => stickyHeaderHeight() + SCROLL_GAP }
        : (holdCard ? { el: holdCard, toTop: holdTop } : null),
      build: (tl, ctx) => {
        // Detail fade — a child on the SAME timeline (null tl = fallback path).
        if (tl && detail) {
          tl.to(detail, {
            opacity: 1,
            duration: ctx.duration * 0.45,
            ease: "power2.out",
          }, ctx.duration * 0.08);
        }
      },
      onSettle: () => {
        // Attach the IntersectionObserver reveal to not-yet-observed project
        // titles, now that the motion has settled (so the first assembly plays
        // on a still page). The observer then drives each title for good
        // (re-scatter out of view, re-assemble back in).
        freshNames.forEach((el) => {
          if (el.dataset.pnReveal === "1") return;
          el.dataset.pnReveal = "1";
          const io = glyphRevealIO(el);
          if (io) projNameObservers.push(io);
        });
      },
    });
  }

  // ---- main toggle logic ------------------------------------------------------

  function toggle(card) {
    const alreadyExpanded = card.classList.contains("is-expanded");
    const grid = section.querySelector(".experience-grid");
    const expandedCard = currentlyExpanded();

    // glassReflow owns the Flip state capture + the tilt-transform reset (it
    // clears transforms before measuring), so we just hand it the grid, the DOM
    // mutation and which card (if any) is opening.
    if (!grid) {
      // No grid (shouldn't happen) → bare DOM toggle.
      if (alreadyExpanded) { collapse(card); }
      else { if (expandedCard) collapse(expandedCard); expand(card); }
      return;
    }

    if (alreadyExpanded) {
      // Close the clicked card: hold its top steady so the shrinking grid can't
      // clamp-yank the page (decision B: stay where you are).
      flipTransition(grid, () => collapse(card), null, card);
    } else {
      // Accordion: close currently open, open clicked — single reflow.
      flipTransition(grid, () => {
        if (expandedCard) collapse(expandedCard);
        expand(card);
      }, card);
    }
  }

  // ---- event delegation: click ------------------------------------------------

  function onClick(e) {
    // Ignore clicks on links inside the detail (let the browser navigate)
    if (e.target && e.target.closest("a")) return;

    const card = e.target && e.target.closest
      ? e.target.closest(".exp-card")
      : null;
    if (!card) return;

    toggle(card);
  }

  // ---- event delegation: keyboard (Enter / Space) on focused card -------------

  function onKeyDown(e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target && e.target.closest
      ? e.target.closest(".exp-card")
      : null;
    if (!card) return;

    // Space would scroll — prevent default
    if (e.key === " ") e.preventDefault();

    // Same link-click guard: if the focused element is a link, let it activate
    if (e.target && e.target.closest("a")) return;

    toggle(card);
  }

  // ---- MutationObserver: close expanded card when it becomes hidden -----------

  const mo = new MutationObserver((records) => {
    for (const rec of records) {
      const card = rec.target;
      if (
        rec.type === "attributes" &&
        rec.attributeName === "class" &&
        card.classList.contains("exp-card") &&
        card.classList.contains("is-hidden") &&
        card.classList.contains("is-expanded")
      ) {
        // No animation — just remove the class so it's clean when re-shown
        collapse(card);
      }
    }
  });

  mo.observe(section, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });

  // ---- register listeners on a stable ancestor --------------------------------

  section.addEventListener("click",   onClick);
  section.addEventListener("keydown", onKeyDown);

  // ---- dispose ----------------------------------------------------------------

  function dispose() {
    section.removeEventListener("click",   onClick);
    section.removeEventListener("keydown", onKeyDown);
    mo.disconnect();
    projNameObservers.forEach((io) => io.disconnect());
    projNameObservers.length = 0;
    // Reset any lingering expanded state
    const expanded = currentlyExpanded();
    if (expanded) collapse(expanded);
  }

  return { dispose };
}
