/**
 * dom-utils.js — tiny shared DOM helpers used across modules.
 *
 * Kept deliberately small: only patterns that were copy-pasted in 3+ places and
 * are semantically identical land here. Module-specific geometry/visibility
 * logic stays in its own module.
 */

/**
 * Observe a single element and call `onChange(visible)` whenever its
 * intersection with the viewport (or the configured root) flips. Fires once
 * right after observe() with the current state. Returns the IntersectionObserver
 * so callers can `unobserve`/`observe`/`disconnect` later (e.g. to force a
 * re-evaluation, or to tear down).
 *
 * Used as a pure visibility GATE (pause/resume a loop, toggle a WebGL layer) —
 * NOT for content reveals (those live in glyph.js / scroll-story.js, which need
 * per-element animation state, not a boolean).
 *
 * @param {Element} el
 * @param {IntersectionObserverInit|undefined} opts  rootMargin/threshold, or undefined for defaults
 * @param {(visible: boolean) => void} onChange
 * @returns {IntersectionObserver}
 */
export function watchVisibility(el, opts, onChange) {
  const io = new IntersectionObserver(
    (entries) => onChange(entries.some((e) => e.isIntersecting)),
    opts
  );
  io.observe(el);
  return io;
}

/**
 * Height (px, rounded) of the sticky header bar AS RENDERED RIGHT NOW: the
 * header's inner row, plus — when body.is-scrolled — the sub-bar's inner row,
 * plus an optional `gap` of breathing room. Used to anchor scroll so content
 * lands just below the sticky chrome.
 *
 * Measures the INNER rows (.site-header__inner / .site-subbar__inner), not the
 * outer .site-header: the outer box animates (the sub-bar slides in via a
 * transform), so the inner rows give a transform-stable height. Fallback 56 for
 * the header row when the node isn't found yet.
 *
 * NOTE: card-expand.js deliberately measures the OUTER .site-header instead (it
 * feeds the glass-expand anchor and was tuned against that box) — it is left as
 * its own helper on purpose, do not fold it in here.
 *
 * @param {number} [gap=0]
 * @returns {number}
 */
export function stickyBarHeight(gap = 0) {
  const inner = document.querySelector(".site-header__inner");
  const base = inner ? Math.round(inner.getBoundingClientRect().height) : 56;
  let sub = 0;
  if (document.body.classList.contains("is-scrolled")) {
    const si = document.querySelector(".site-subbar__inner");
    sub = si ? Math.round(si.getBoundingClientRect().height) : 0;
  }
  return base + sub + gap;
}
