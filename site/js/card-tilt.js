/**
 * card-tilt.js — Block B: subtle 3D tilt on .exp-card in response to pointer
 * position. When the cursor moves over a card, the card "points" toward the
 * nearest corner via a combined rotateX + rotateY transform.
 *
 * Design decisions:
 *  - Event delegation on document: one stable pointermove/pointerleave listener
 *    survives re-renders (language change rebuilds the DOM but this listener
 *    is on document, not on the cards themselves).
 *  - The tilt is cleared when the pointer leaves a card (pointerleave via
 *    delegation on the containing #experience element, which always exists).
 *  - Smooth motion: CSS transition on transform for smooth follow + reset.
 *  - Guards: disabled for pointer:coarse (touch), prefers-reduced-motion, and
 *    .is-expanded cards (used in the upcoming expand block).
 *  - will-change:transform is set on enter and cleared on leave so it does not
 *    keep a compositor layer alive on every card at all times.
 *
 * @returns {{ dispose: () => void }}
 */

const MAX_DEG    = 7;        // maximum tilt angle in degrees
const SCALE_HOVER = 1.025;   // very slight lift scale on hover

export function initCardTilt() {
  // ---- hard guards ----
  if (matchMedia("(pointer: coarse)").matches)          return { dispose() {} };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return { dispose() {} };

  // The #experience container — use it as the delegation root for leave events.
  // pointermove is on document so we get moves even when the pointer passes
  // quickly between gap rows.
  const section = document.getElementById("experience");
  if (!section) return { dispose() {} };

  // Currently tilted card reference (so we can reset it on leave).
  let activeCard = null;

  // ---- helpers ----

  /**
   * Apply tilt based on pointer position relative to the card's bounding rect.
   * px, py are in [-1, 1] (−1 = left/top edge, +1 = right/bottom edge).
   */
  function applyTilt(card, rect, clientX, clientY) {
    const px = ((clientX - rect.left) / rect.width)  * 2 - 1;  // [-1, +1]
    const py = ((clientY - rect.top)  / rect.height) * 2 - 1;  // [-1, +1]

    // Drive the glass reflection sweep (--mx, a %) so the oblique gleam on the
    // role plate + tags tracks the cursor. CSS consumes it as a percentage.
    const mxPct = ((clientX - rect.left) / rect.width) * 100;
    card.style.setProperty("--mx", `${Math.max(0, Math.min(100, mxPct)).toFixed(1)}%`);

    const rotateY =  px * MAX_DEG;
    const rotateX = -py * MAX_DEG;   // negative: top half tilts "toward" you

    card.style.transform =
      `perspective(900px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) scale(${SCALE_HOVER})`;
  }

  function clearTilt(card) {
    card.style.transform = "";
    card.style.willChange = "";
    card.style.setProperty("--mx", "50%"); // recentre the reflection at rest
  }

  // ---- event delegation: pointermove on document ----
  function onPointerMove(e) {
    if (e.pointerType === "touch") return;

    const card = e.target && e.target.closest
      ? e.target.closest(".exp-card")
      : null;

    // Leaving one card, entering another (or no card at all).
    if (activeCard && activeCard !== card) {
      clearTilt(activeCard);
      activeCard = null;
    }

    if (!card) return;

    // Skip expanded cards (future expand block).
    if (card.classList.contains("is-expanded")) return;

    // Skip hidden cards (pointer-events:none on .is-hidden, but belt-and-suspenders).
    if (card.classList.contains("is-hidden")) return;

    // First enter: prime will-change so the GPU layer is ready.
    if (activeCard !== card) {
      card.style.willChange = "transform";
      activeCard = card;
    }

    const rect = card.getBoundingClientRect();
    applyTilt(card, rect, e.clientX, e.clientY);
  }

  // ---- pointerleave: reset when the pointer exits the card (delegation) ----
  // Using the section as the delegation root; we also listen on document in case
  // the pointer exits the viewport while over a card.
  function onPointerLeave(e) {
    if (e.pointerType === "touch") return;

    const card = e.target && e.target.closest
      ? e.target.closest(".exp-card")
      : null;

    if (card && card === activeCard) {
      clearTilt(card);
      activeCard = null;
    }
  }

  // ---- handle cards that become hidden while the pointer is on them ----
  // MutationObserver watches for .is-hidden being added to the active card.
  const mo = new MutationObserver((records) => {
    if (!activeCard) return;
    for (const rec of records) {
      if (rec.target === activeCard &&
          rec.type === "attributes" &&
          rec.attributeName === "class" &&
          activeCard.classList.contains("is-hidden")) {
        clearTilt(activeCard);
        activeCard = null;
        break;
      }
    }
  });
  // Observe the grid — subtree:true so we catch all cards.
  mo.observe(section, { subtree: true, attributes: true, attributeFilter: ["class"] });

  // ---- register listeners ----
  document.addEventListener("pointermove", onPointerMove, { passive: true });
  // pointerleave does NOT bubble, so use the section as relay root.
  // We need capture:false + the event fires on the card — but since pointerleave
  // does not bubble we attach it to section with useCapture so we intercept
  // the event as it goes down, before the element itself processes it.
  // Alternatively: listen for pointerout (which DOES bubble) on document.
  document.addEventListener("pointerout", onPointerLeave, { passive: true });

  // ---- dispose ----
  function dispose() {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerout", onPointerLeave);
    mo.disconnect();
    if (activeCard) { clearTilt(activeCard); activeCard = null; }
  }

  return { dispose };
}
