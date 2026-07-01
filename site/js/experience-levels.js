/**
 * experience-levels.js — L0 level: "selection" mode for experience cards.
 *
 * When the cursor enters the footbar (Experience scene), ALL cards compact
 * into a 4×2 grid (L0). On mouse-out with a 150ms anti-jitter delay they
 * return to the normal view (L1). During L0 the page scroll is locked.
 *
 * Communication with footbar.js via custom events on document:
 *   "evolvedcv:footbar-enter"  → enterL0()
 *   "evolvedcv:footbar-leave"  → exitL0() with 150ms debounce
 *
 * Safety: a MutationObserver on body[data-scene] forces exitL0() if the
 * Experience scene is left without a pointerleave firing.
 *
 * Constraints:
 *  - Does NOT modify card-expand.js, scene-nav.js, experience-glass.js, card-tilt.js
 *  - Does NOT use overflow:hidden on the body (avoids layout jumps)
 *  - Reduced-motion: instant toggle without GSAP Flip
 *
 * @returns {{ enterL0: () => void, exitL0: () => void, dispose: () => void }}
 */

import { glassReflow } from "./glass-motion.js";
import { stickyBarHeight } from "./dom-utils.js";

export function initExperienceLevels() {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Document scroll BEFORE entering L0 — restored on exit
  // (decision A: leaving L0 returns you to exactly where you were).
  let _scrollBeforeL0 = 0;

  // Register the Flip plugin (no-op if already registered or GSAP is missing)
  if (window.gsap && window.Flip) {
    gsap.registerPlugin(Flip);
  }

  /* ------------------------------------------------------------------ scroll-lock */

  // Keys that cause page scroll — blocked while L0 is active
  const SCROLL_KEYS = new Set([
    "PageUp", "PageDown", " ", "ArrowUp", "ArrowDown", "Home", "End",
  ]);

  function preventScroll(e) {
    // SAFETY: only acts while L0 is active (so even if for any reason the
    // listener is not removed, scroll is free outside L0).
    if (!document.body.classList.contains("exp-l0")) return;
    // Block wheel and touchmove unconditionally; keydown only for scroll keys
    if (e.type === "keydown" && !SCROLL_KEYS.has(e.key)) return;
    e.preventDefault();
  }

  function lockScroll() {
    window.addEventListener("wheel",      preventScroll, { passive: false, capture: true });
    window.addEventListener("touchmove",  preventScroll, { passive: false, capture: true });
    window.addEventListener("keydown",    preventScroll, { capture: true });
  }

  function unlockScroll() {
    window.removeEventListener("wheel",      preventScroll, { capture: true });
    window.removeEventListener("touchmove",  preventScroll, { capture: true });
    window.removeEventListener("keydown",    preventScroll, { capture: true });
  }

  /* ------------------------------------------------------------------ reflow via glass-motion */

  /**
   * Toggle body.exp-l0 through the shared choreographer (glass-motion.js):
   * Flip + grid-height + (on enter) the scroll-anchor glide all live on the
   * SAME timeline → a single movement. On enter, any expanded card is collapsed
   * INSIDE the same Flip, so that transition is also seamless.
   *
   * @param {boolean} entering — true = adds exp-l0, false = removes it
   * @param {number|null} scrollTo — document Y to glide toward (or null)
   */
  function flipToggle(entering, restoreScroll = true) {
    const grid = document.querySelector("#experience .experience-grid");
    if (!grid) { document.body.classList.toggle("exp-l0", entering); return; }

    // Anchor on the section TITLE (sits ABOVE the grid, stable document position
    // entering/exiting L0). Entering: scrolls it just below the header (frames
    // the compact grid). Exiting: restores it to where it was at the pre-L0
    // scroll position (decision A). Read live every frame → no clamp-yank
    // while the grid shrinks/grows: one single movement.
    const title = expTitle();
    let scrollEaseTop = null;
    if (title) {
      if (entering) {
        scrollEaseTop = { el: title, toTop: () => headerOffset() };
      } else if (restoreScroll) {
        scrollEaseTop = {
          el: title,
          // titleDocTop - _scrollBeforeL0 = where the title must sit in the
          // viewport when scroll has returned to _scrollBeforeL0.
          toTop: () => Math.round(title.getBoundingClientRect().top + window.scrollY - _scrollBeforeL0),
        };
      }
    }

    glassReflow(grid, () => {
      // Collapse any expanded card as part of the same reflow.
      if (entering) {
        const expanded = document.querySelector(".exp-card.is-expanded");
        if (expanded) {
          expanded.classList.remove("is-expanded");
          expanded.setAttribute("aria-expanded", "false");
          expanded.style.transform = "";
        }
      }
      document.body.classList.toggle("exp-l0", entering);
    }, {
      scale: true,   // L0 scales cards into the compact 4×2 grid
      scrollEaseTop,
      reducedMotion,
    });
  }

  /* ------------------------------------------------------------------ enter / exit */

  // The Experience section title: a stable anchor (sits ABOVE the grid; its
  // document position does not change between L0 and L1).
  function expTitle() {
    const exp = document.getElementById("experience");
    if (!exp) return null;
    return exp.querySelector(".section-title, h2") || exp;
  }

  // Viewport top "just below the header" (header + subbar when visible + gap),
  // i.e. where to anchor the title when entering L0 to frame the grid.
  // On entry the grid compacts into 4×2 and SHRINKS: without this anchor it
  // would collapse upward and #education would scroll into view (old "scrolls to
  // Education" bug). Same components as the scene-nav anchor.
  // HEADER_GAP = 24 (same value as scene-nav). Same formula as scene-nav,
  // now shared via stickyBarHeight().
  const headerOffset = () => stickyBarHeight(24);

  function enterL0() {
    if (document.body.classList.contains("exp-l0")) return;
    _scrollBeforeL0 = window.scrollY;   // decision A: restore it on exit
    // Lock scroll before the event fires (the programmatic glide still goes through).
    lockScroll();
    // Frame + compact in one movement (the glide is part of the same
    // timeline as the Flip inside glassReflow).
    flipToggle(true);
  }

  function exitL0(restoreScroll = true) {
    if (!document.body.classList.contains("exp-l0")) return;

    flipToggle(false, restoreScroll);
    unlockScroll();
  }

  /* ------------------------------------------------------------------ debounce leave */

  let _leaveTimer = null;

  function onFootbarEnter() {
    // Cancel any pending exit timer
    if (_leaveTimer) {
      clearTimeout(_leaveTimer);
      _leaveTimer = null;
    }
    enterL0();
  }

  function onFootbarLeave() {
    // Anti-jitter: wait 150ms before exiting L0
    if (_leaveTimer) clearTimeout(_leaveTimer);
    _leaveTimer = setTimeout(() => {
      _leaveTimer = null;
      exitL0();
    }, 150);
  }

  /* ------------------------------------------------------------------ aggancio eventi */

  // "Apply" from the footbar: exits L0 (the dimmed preview becomes the result
  // because outside L0 the .is-hidden cards revert to display:none = removal).
  function onFootbarApply() {
    if (_leaveTimer) { clearTimeout(_leaveTimer); _leaveTimer = null; }
    exitL0();
  }

  document.addEventListener("evolvedcv:footbar-enter", onFootbarEnter);
  document.addEventListener("evolvedcv:footbar-leave", onFootbarLeave);
  document.addEventListener("evolvedcv:footbar-apply", onFootbarApply);

  /* ------------------------------------------------------------------ safety: cambio scena */

  // If the Experience scene is left without a pointerleave firing
  // (e.g. click on a navigation link), force exitL0.
  const sceneMO = new MutationObserver(() => {
    if (document.body.dataset.scene !== "experience") {
      if (_leaveTimer) { clearTimeout(_leaveTimer); _leaveTimer = null; }
      // Scene change: do NOT restore the pre-L0 scroll (scene-nav owns it here).
      exitL0(false);
    }
  });
  sceneMO.observe(document.body, {
    attributes:      true,
    attributeFilter: ["data-scene"],
  });

  /* ------------------------------------------------------------------ dispose */

  function dispose() {
    document.removeEventListener("evolvedcv:footbar-enter", onFootbarEnter);
    document.removeEventListener("evolvedcv:footbar-leave", onFootbarLeave);
    document.removeEventListener("evolvedcv:footbar-apply", onFootbarApply);
    if (_leaveTimer) { clearTimeout(_leaveTimer); _leaveTimer = null; }
    sceneMO.disconnect();
    // Ensure scroll-lock and class are removed
    if (document.body.classList.contains("exp-l0")) {
      document.body.classList.remove("exp-l0");
      unlockScroll();
    }
  }

  return { enterL0, exitL0, dispose };
}
