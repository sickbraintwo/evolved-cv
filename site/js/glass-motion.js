/**
 * glass-motion.js — ONE choreographer for every Experience glass reflow.
 *
 * THE PROBLEM IT SOLVES
 * Expand/collapse, L0 (selection grid) and filtering each used to run their OWN
 * stack of independent GSAP tweens — a Flip, a separate grid-height tween, a
 * separate auto-scroll — plus CSS transitions, each with its own duration/ease.
 * Because they finished at different times (e.g. a card's width settled almost
 * instantly while a power3.inOut scroll only ramped up later), the eye read TWO
 * movements: a thing that snapped "into place", then a second eased settle.
 *
 * THE SYSTEM
 * Every glass reflow now routes through glassReflow(): ONE master GSAP timeline
 * owns the Flip, the height glide and the scroll as children that all start at
 * t=0 and share the SAME duration and ease — so they read as a SINGLE motion.
 * `absolute:true` is used everywhere so a card's size AND position animate on
 * one curve (no early-settling width, no un-masked row-reflow snap). The WebGL
 * glass slabs follow each card's getBoundingClientRect every frame, so unifying
 * the DOM motion unifies the glass for free.
 *
 * Callers pass a `mutate` function (the DOM layout change) and optionally a
 * `build` hook to add their OWN bespoke children (detail fade, glyph reveal) to
 * the SAME timeline — keeping everything on one clock.
 */

export const GLASS_DURATION = 0.55;
export const GLASS_EASE     = "power3.inOut";

// The master timeline currently in flight (per single shared grid). A new
// reflow kills it so rapid interactions (e.g. clicking card after card) hand
// off cleanly instead of two timelines fighting over the same cards.
let _active = null;

/**
 * Run a single, unified glass reflow.
 *
 * @param {HTMLElement} grid    the .experience-grid
 * @param {() => void}  mutate  applies the DOM layout change (toggle classes,
 *                              split glyphs for layout, …). Runs BETWEEN the
 *                              before/after height measurements.
 * @param {object} [opts]
 * @param {number}  [opts.duration]  seconds (default GLASS_DURATION)
 * @param {string}  [opts.ease]      GSAP ease (default GLASS_EASE)
 * @param {boolean} [opts.scale]     true → Flip animates via scaleX/Y (good for
 *                                   enter/leave); false → width/height (content
 *                                   stays crisp; default, best for expand/L0)
 * @param {number|null|(() => number|null)} [opts.scrollTo]  absolute document Y
 *                                   to glide to in lockstep, or null for no
 *                                   auto-scroll. May be a function, resolved
 *                                   AFTER `mutate` (so it can read the card's
 *                                   final flow position, e.g. cardTopTarget)
 * @param {{el: HTMLElement, toTop: number|(() => number)}} [opts.scrollEaseTop]
 *                                   LIVE eased scroll anchor: glides `el`'s
 *                                   viewport TOP from where it rests now to
 *                                   `toTop`, reading the live rect each frame so
 *                                   it never desyncs from a growing grid (no
 *                                   clamp tail / overshoot). Preferred over
 *                                   scrollTo whenever a specific card must land
 *                                   under the sticky header (expand/accordion).
 * @param {(curH:number, beforeH:number, afterH:number) => number|null} [opts.scrollAnchor]
 *                                   alternative to scrollTo: called each frame
 *                                   with the live grid height; return a scrollY
 *                                   to pin (used by filtering to keep the
 *                                   content BELOW the grid from lurching)
 * @param {(els:Element[]) => void} [opts.onEnter]  Flip onEnter
 * @param {(els:Element[]) => void} [opts.onLeave]  Flip onLeave
 * @param {(tl:object, ctx:object) => void} [opts.build]  add bespoke children to
 *                                   the master timeline at t=0 (same clock)
 * @param {() => void} [opts.onSettle]  runs once the whole motion completes
 * @returns {object|null} the master GSAP timeline (or null in the instant path)
 */
export function glassReflow(grid, mutate, opts = {}) {
  const {
    duration = GLASS_DURATION,
    ease     = GLASS_EASE,
    scale    = false,
    scrollTo = null,
    scrollEaseTop = null,
    scrollAnchor = null,
    onEnter  = null,
    onLeave  = null,
    build    = null,
    onSettle = null,
    reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches,
  } = opts;

  const g = window.gsap, Flip = window.Flip;
  const cards = grid ? [...grid.querySelectorAll(".exp-card")] : [];

  // Debug hook (no-op in production: only records when a probe sets the global).
  if (window.__glassLog) {
    window.__glassLog.push({ t: Math.round(performance.now()), n: cards.length, scale: !!opts.scale, killing: !!_active });
  }

  // Fallback: no engine / reduced motion / nothing to animate → do it instantly.
  if (!g || !Flip || reducedMotion || !grid || !cards.length) {
    mutate();
    if (scrollEaseTop && scrollEaseTop.el) {
      // Land the anchored card directly at its target viewport top.
      const toTop = (typeof scrollEaseTop.toTop === "function") ? scrollEaseTop.toTop() : scrollEaseTop.toTop;
      const cur = scrollEaseTop.el.getBoundingClientRect().top;
      window.scrollTo({ top: Math.max(0, Math.round(window.scrollY + (cur - toTop))), behavior: "auto" });
    } else {
      const sy = (typeof scrollTo === "function") ? scrollTo() : scrollTo;
      if (sy != null) window.scrollTo({ top: Math.max(0, Math.round(sy)), behavior: "auto" });
    }
    if (build) build(null, {});
    if (onSettle) onSettle();
    return null;
  }

  // A reflow is starting: hand off cleanly from any in-flight one.
  const interrupting = !!_active;
  if (_active) { _active.kill(); _active = null; }

  // At REST, clear card-tilt transforms so Flip measures clean rects. But when
  // INTERRUPTING a reflow still in flight, those inline transforms are GSAP
  // Flip's own mid-animation matrices — clearing them would SNAP the cards back
  // (a visible second jump). Leave them so Flip.getState captures the live
  // transformed positions and the new reflow continues smoothly from there.
  if (!interrupting) cards.forEach((c) => { c.style.transform = ""; });

  const state   = Flip.getState(cards);
  const beforeH = grid.getBoundingClientRect().height;

  // Capture the anchored card's RESTING viewport top BEFORE mutate, so the live
  // scroll anchor (below) eases the card's top from exactly where it sits now to
  // its target — no jump at p=0.
  const anchorEl   = scrollEaseTop && scrollEaseTop.el;
  const anchorFrom = anchorEl ? anchorEl.getBoundingClientRect().top : 0;

  grid.classList.add("is-flipping");   // suppress CSS transitions during the motion
  mutate();                            // the DOM layout change (+ any layout-affecting prep)
  const afterH = grid.getBoundingClientRect().height;
  const anchorTo = anchorEl
    ? ((typeof scrollEaseTop.toTop === "function") ? scrollEaseTop.toTop() : scrollEaseTop.toTop)
    : 0;

  // Resolve the scroll target NOW (after mutate, before Flip applies any
  // transform) so a function target can read the card's final flow position.
  const scrollY = (typeof scrollTo === "function") ? scrollTo() : scrollTo;

  const master = g.timeline({
    onComplete() {
      g.set(grid, { clearProps: "height" });
      grid.classList.remove("is-flipping");
      if (_active === master) _active = null;
      if (onSettle) onSettle();
    },
  });
  _active = master;

  // Pin the grid at its old height, then glide it to the new one so the sections
  // below don't jump — child at t=0.
  g.set(grid, { height: beforeH });
  if (Math.abs(beforeH - afterH) > 1) {
    master.to(grid, {
      height: afterH, duration, ease,
      onUpdate: scrollAnchor ? () => {
        const curH = parseFloat(grid.style.height) || afterH;
        const y = scrollAnchor(curH, beforeH, afterH);
        if (y != null) window.scrollTo({ top: Math.max(0, Math.round(y)), behavior: "instant" });
      } : undefined,
    }, 0);
  }

  // Auto-scroll on the SAME clock/ease — child at t=0 (no separate tween).
  if (scrollY != null && Math.abs(scrollY - window.scrollY) > 4) {
    const proxy = { y: window.scrollY };
    master.to(proxy, {
      y: scrollY, duration, ease,
      onUpdate() { window.scrollTo({ top: proxy.y, behavior: "instant" }); },
    }, 0);
  }

  // The Flip itself, re-parented onto the master at t=0 → same clock as the rest.
  // absolute:true keeps size+position on ONE curve and masks sibling row-reflow.
  const flipTl = Flip.from(state, {
    duration, ease, absolute: true, nested: true, scale,
    onEnter: onEnter || undefined,
    onLeave: onLeave || undefined,
  });
  master.add(flipTl, 0);

  // LIVE EASED SCROLL ANCHOR — the robust fix for the "card arrives from below
  // then realigns" second movement. Instead of scrolling to a fixed Y computed
  // up-front (which the browser CLAMPS while the grid — and thus the document —
  // is still growing, desyncing the scroll from the card and leaving a tail),
  // we read the card's LIVE top every frame and nudge the scroll so that top
  // follows an eased path from where it rested to its target. Added AFTER the
  // Flip so its onUpdate reads the card's post-transform rect. Because it tracks
  // the real element it is immune to grid-height growth and ends EXACTLY with
  // the timeline → one motion, no overshoot, no settle.
  if (anchorEl) {
    const prox = { p: 0 };
    master.to(prox, {
      p: 1, duration, ease,
      onUpdate() {
        const want = anchorFrom + (anchorTo - anchorFrom) * prox.p;
        const dy = anchorEl.getBoundingClientRect().top - want;
        if (Math.abs(dy) > 0.5) {
          window.scrollTo({ top: Math.max(0, Math.round(window.scrollY + dy)), behavior: "instant" });
        }
      },
    }, 0);
  }

  // Caller's bespoke children (detail fade, glyph reveal) on the SAME timeline.
  if (build) build(master, { duration, ease, beforeH, afterH });

  return master;
}
