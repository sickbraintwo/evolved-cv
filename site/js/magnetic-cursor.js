/**
 * magnetic-cursor.js — Phase 1 Block 2: custom magnetic cursor for fine pointers.
 *
 * A small filled dot tracks the mouse with light lag; a larger ring lags more
 * and "snaps"/scales up when hovering interactive elements. The ring also
 * applies a subtle magnetic pull toward hovered element centers.
 *
 * Guards (all return {dispose(){}} immediately, leaving native cursor intact):
 *   - window.gsap missing
 *   - prefers-reduced-motion: reduce
 *   - pointer:fine not available (touch / coarse devices)
 *
 * The body class "has-magnetic-cursor" is added only on success; CSS scopes
 * cursor:none under that class so a JS failure never leaves the user cursorless.
 *
 * Dispose pattern: kills all tweens, removes DOM nodes and listeners, restores
 * the body class. Safe to call multiple times.
 */

const INTERACTIVE_SELECTOR =
  'a[href], button, .contact-link, [role="button"], .header-btn, .magnetic';

/** @returns {{ dispose: () => void }} */
export function initMagneticCursor() {
  // ---- hard guards ----
  if (!window.gsap) return { dispose() {} };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return { dispose() {} };
  if (!matchMedia("(pointer: fine)").matches) return { dispose() {} };

  const gsap = window.gsap;

  // ---- activate: signal CSS to hide native cursor ----
  document.body.classList.add("has-magnetic-cursor");

  // ---- build cursor DOM nodes ----
  const dot = document.createElement("div");
  dot.className = "mcursor mcursor--dot";
  dot.setAttribute("aria-hidden", "true");

  const ring = document.createElement("div");
  ring.className = "mcursor mcursor--ring";
  ring.setAttribute("aria-hidden", "true");

  document.body.append(dot, ring);

  // Center each node on the pointer via GSAP transform components (NOT a CSS
  // translate, which quickTo would overwrite). xPercent stays correct as the
  // ring grows. Start hidden so there's no stray dot in the corner before the
  // first mousemove (native cursor is already hidden by the body class).
  gsap.set([dot, ring], { xPercent: -50, yPercent: -50, opacity: 0 });
  let revealed = false;

  // ---- GSAP quick setters for performant positional updates ----
  // quickTo returns a function that immediately animates the target to a value.
  const dotX  = gsap.quickTo(dot,  "x", { duration: 0.12, ease: "power3.out" });
  const dotY  = gsap.quickTo(dot,  "y", { duration: 0.12, ease: "power3.out" });
  const ringX = gsap.quickTo(ring, "x", { duration: 0.28, ease: "power3.out" });
  const ringY = gsap.quickTo(ring, "y", { duration: 0.28, ease: "power3.out" });

  // Current raw mouse position (used to compute magnetic pull).
  let mouseX = 0;
  let mouseY = 0;
  // Magnetic pull target (overridden when over an interactive element).
  let magnetX = null;
  let magnetY = null;

  // ---- mousemove: drive dot directly, ring toward mouse (or magnet) ----
  function onMouseMove(e) {
    mouseX = e.clientX;
    mouseY = e.clientY;

    // Self-heal: if we were magnetised to an element that is no longer under the
    // pointer (e.g. a button removed by a re-render — no mouseout is emitted for
    // a node deleted under the cursor), drop the active + magnet state so the
    // ring doesn't stay stuck/pulled toward a vanished element.
    if (magnetX !== null) {
      const under = document.elementFromPoint(mouseX, mouseY);
      if (!under || !under.closest(INTERACTIVE_SELECTOR)) {
        ring.classList.remove("mcursor--active", "mcursor--over-link");
        magnetX = null;
        magnetY = null;
      }
    }

    // Reveal on first real movement (avoids a corner flash at 0,0 pre-move).
    if (!revealed) {
      revealed = true;
      gsap.set(dot,  { x: mouseX, y: mouseY });
      gsap.set(ring, { x: mouseX, y: mouseY });
      gsap.to([dot, ring], { opacity: 1, duration: 0.2, overwrite: "auto" });
    }

    dotX(mouseX);
    dotY(mouseY);

    if (magnetX !== null && magnetY !== null) {
      // Lerp ring target 35% toward element center, 65% toward cursor.
      const tx = mouseX + (magnetX - mouseX) * 0.35;
      const ty = mouseY + (magnetY - mouseY) * 0.35;
      ringX(tx);
      ringY(ty);
    } else {
      ringX(mouseX);
      ringY(mouseY);
    }
  }

  // ---- hover detection via event delegation ----
  function onMouseOver(e) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const el = target.closest(INTERACTIVE_SELECTOR);
    if (!el) return;

    ring.classList.add("mcursor--active");
    // Links get their own ring colour vs. buttons (req: cursor-ring-over-link).
    ring.classList.toggle("mcursor--over-link", el.matches("a[href]"));

    // Compute element center in viewport coords for magnetic pull.
    const rect = el.getBoundingClientRect();
    magnetX = rect.left + rect.width  / 2;
    magnetY = rect.top  + rect.height / 2;
  }

  function onMouseOut(e) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const el = target.closest(INTERACTIVE_SELECTOR);
    if (!el) return;

    ring.classList.remove("mcursor--active", "mcursor--over-link");
    magnetX = null;
    magnetY = null;
  }

  // ---- hide / show when mouse leaves / enters the window ----
  function onDocLeave() {
    gsap.to([dot, ring], { opacity: 0, duration: 0.15, overwrite: "auto" });
  }
  function onDocEnter() {
    gsap.to([dot, ring], { opacity: 1, duration: 0.15, overwrite: "auto" });
  }

  // ---- mousedown/mouseup: punch scale on the dot ----
  // Driven by GSAP (scale composes into the same transform matrix as x/y);
  // a CSS class can't override GSAP's inline transform.
  function onMouseDown() {
    gsap.to(dot, { scale: 0.6, duration: 0.12, ease: "power3.out", overwrite: "auto" });
  }
  function onMouseUp() {
    gsap.to(dot, { scale: 1, duration: 0.18, ease: "back.out(2)", overwrite: "auto" });
  }

  // ---- register listeners (all passive where possible) ----
  document.addEventListener("mousemove",  onMouseMove,  { passive: true });
  document.addEventListener("mouseover",  onMouseOver,  { passive: true });
  document.addEventListener("mouseout",   onMouseOut,   { passive: true });
  document.addEventListener("mousedown",  onMouseDown,  { passive: true });
  document.addEventListener("mouseup",    onMouseUp,    { passive: true });
  document.documentElement.addEventListener("mouseleave", onDocLeave, { passive: true });
  document.documentElement.addEventListener("mouseenter", onDocEnter, { passive: true });

  // ---- dispose ----
  function dispose() {
    document.removeEventListener("mousemove",  onMouseMove);
    document.removeEventListener("mouseover",  onMouseOver);
    document.removeEventListener("mouseout",   onMouseOut);
    document.removeEventListener("mousedown",  onMouseDown);
    document.removeEventListener("mouseup",    onMouseUp);
    document.documentElement.removeEventListener("mouseleave", onDocLeave);
    document.documentElement.removeEventListener("mouseenter", onDocEnter);

    gsap.killTweensOf([dot, ring]);
    dot.remove();
    ring.remove();
    document.body.classList.remove("has-magnetic-cursor");
  }

  return { dispose };
}
