/**
 * scene-nav.js — Full-page "step scroll" navigation controller.
 *
 * Replaces free document scrolling with a discrete scene stepper:
 *   0. #hero         — LOCKED until intro completes (never overflows)
 *   1. #about        — hybrid (locked if it fits, free if it overflows)
 *   2. #expertise    — hybrid
 *   3. #experience   — always FREE NATIVE SCROLL (card accordion keeps working)
 *   4. #education    — hybrid
 *   5. #contact      — hybrid
 *
 * Architecture: CONTROLLED NATIVE SCROLL — sections stay in normal document
 * flow; the stepper animates window.scrollTo between section tops via a GSAP
 * proxy tween.
 *
 * HYBRID step/scroll (the general model, not just #experience): a scene is
 * "free" when its CONTENT block is taller than the available area under the
 * header. Free scenes scroll natively and only hand off to the next/prev scene
 * once at their bottom/top boundary plus another intent; scenes that fit are
 * locked (each intent steps). This is decided LIVE (measured each scene change
 * and on resize) so a phone rotated to landscape, or an accordion that grows,
 * falls into the right branch automatically — no fragile mobile/desktop rail.
 *
 * Hard guards (both must pass or the module does NOTHING):
 *   - prefers-reduced-motion → leave the legacy free-scroll site intact.
 *   - window.gsap unavailable → same.
 * This keeps the accessibility fallback fully working.
 *
 * Integration with other modules:
 *   - Sets body.scene-nav early (before build) so hero-orbit/deflagration/
 *     scroll-story see the flag when they create their ScrollTriggers.
 *   - Calls disableScrollDriving() on each module after their inits (belt-and-
 *     suspenders: in case they ran before the class was set, or a late init).
 *   - Listens for "evolvedcv:intro-done" to unlock the hero lock.
 *
 * Dot navigation: a fixed vertical strip on the right, one button per scene.
 * CSS lives in the main.css scene-nav block appended there.
 */
import { stickyBarHeight } from "./dom-utils.js";

const TRANSITION_DURATION = 0.9;   // seconds — generous, the transition is meant to be enjoyed
const TRANSITION_EASE     = "power2.inOut";
// Leaving Experience: let the (experience-only) footbar slide fully out BEFORE
// the scroll starts, so it never trails along into the next scene. Matches the
// footbar's own --dur-base slide.
const FOOTBAR_EXIT_LEAD   = 0.24;  // s — delay the scroll while the footbar exits
const WHEEL_COOLDOWN      = 120;    // ms after a transition before the next wheel intent is honoured
const TOUCH_MIN_DELTA     = 40;     // px swipe threshold
const FREE_BOUNDARY_SLACK = 4;      // px tolerance at #experience top/bottom

// Scene descriptors populated from the live DOM in buildSceneList().
// Each entry: { el, id, label }. Free/locked is decided live (sceneIsFree).
let scenes = [];

// Controller state
let currentIndex    = 0;
let animating       = false;
let introLocked     = true;   // true until "evolvedcv:intro-done"
let lastWheelTime   = 0;      // epoch ms of last processed wheel intent
let touchStartY     = 0;
let lastVW          = 0;      // last seen innerWidth  (viewport-change watchdog)
let lastVH          = 0;      // last seen innerHeight

// Imperative APIs (stored so dot-nav clicks drive the same choreography as wheel/key).
let deflagApiRef    = null;
let orbitApiRef     = null;
let shapesApiRef    = null;   // per-scene particle morph director | null

// Refs kept for cleanup
let wheelHandler    = null;
let touchStartHandler = null;
let touchMoveHandler  = null;
let touchEndHandler   = null;
let keyHandler      = null;
let resizeTimer     = null;

/**
 * Build the ordered scene list from the live DOM, skipping display:none elements.
 * The scene order matches the spec: hero, about, expertise, experience,
 * education, contact. Only sections that exist AND are visible are included.
 *
 * Note: whether a scene is "free" (native scroll) is NOT stored here — it is
 * decided live by sceneIsFree() because it depends on the current viewport and
 * content height, both of which change at runtime.
 */
function buildSceneList() {
  const ids = ["hero", "about", "expertise", "experience", "education", "contact"];
  scenes = [];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (getComputedStyle(el).display === "none") continue;
    // Derive a human-readable label from the section's heading or id
    const heading = el.querySelector("h2");
    const label   = heading ? (heading.getAttribute("aria-label") || heading.textContent.trim()) : id;
    scenes.push({ el, id, label });
  }
}

/* ---- Hybrid step/scroll decision ----------------------------- */

// A scene is "free" (native scroll) when its content overflows the area under
// the header. Measured live so viewport changes (e.g. phone rotation) and
// content changes (filtering, accordion) are honoured automatically.
//  - #hero never overflows (it's the full-screen particle name) → always locked.
//  - #experience is always free (it's a scroll list with an accordion by design,
//    and it owns the pills-consume choreography on entry).
const FREE_MARGIN = 16; // px slack: only treat as overflow when clearly taller

function sceneOverflows(el) {
  const c = sectionContent(el);
  const available = innerHeight - headerHeight();
  return c.height > available - FREE_MARGIN;
}

function sceneIsFree(s) {
  if (!s) return false;
  if (s.id === "hero") return false;
  if (s.id === "experience") return true;
  return sceneOverflows(s.el);
}

// Cached free-state of the CURRENT scene, so the wheel/touch handlers don't
// force a layout reflow (getBoundingClientRect) on every event. Refreshed on
// scene change and on viewport change only.
let currentFree = false;
function recomputeFree() { currentFree = sceneIsFree(scenes[currentIndex]); }

/* ---- Scroll anchoring (clear the sticky header) -------------- */

// The header is sticky and, from step 2 on, grows a second bar (the subbar,
// max-height 64px). Scrolling a section's raw offsetTop to y=0 would tuck its
// title UNDER that taller header. So we land each section's title a fixed gap
// BELOW the expanded header instead. Hero stays pinned at the very top.
const HEADER_GAP = 24; // px breathing room under the header

// Per-scene extra downward nudge (px) for the top-anchored scenes.
const SCENE_NUDGE = { contact: 38 }; // ~1cm lower (req)

// Scenes whose content is vertically CENTERED in the viewport (when it fits);
// others (e.g. contact) keep the title top-anchored below the header.
const CENTERED_SCENES = new Set(["about", "expertise", "education"]);

/**
 * Live screen-space metrics of a section's CONTENT block (union of its visible
 * direct children): {top, bottom, mid, height}. Used both to centre a scene and
 * to decide free/locked (sceneOverflows).
 *
 * Out-of-flow decorative layers are EXCLUDED: #expertise has an absolutely
 * positioned particle canvas (.expertise-fx, inset:0) that is as tall as the
 * 100svh section. Counting it made the content look viewport-tall, so the scene
 * was permanently mis-classified as "free" (overflowing) even when the actual
 * cards fit — which forced a phantom native scroll (revealing the next title)
 * before the first step would register. Only in-flow children define the real
 * content height the user scrolls through.
 */
function sectionContent(el) {
  let top = Infinity, bottom = -Infinity;
  for (const c of el.children) {
    const cs = getComputedStyle(c);
    if (cs.display === "none") continue;
    if (cs.position === "absolute" || cs.position === "fixed") continue;
    const r = c.getBoundingClientRect();
    if (r.height < 1) continue;
    top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom);
  }
  if (!isFinite(top)) { const r = el.getBoundingClientRect(); top = r.top; bottom = r.bottom; }
  return { top, bottom, mid: (top + bottom) / 2, height: bottom - top };
}

/**
 * Live header height = the real rendered bar + (when scrolled) the real sub-bar
 * content. Measured every call rather than hardcoded, so it stays correct when
 * the OS text size / resolution / zoom changes the header's actual height.
 */
function headerHeight() {
  return stickyBarHeight();
}

/**
 * Absolute document scrollTop that lands scene `s` correctly:
 *  - hero  → 0 (its particle name occupies the full first screen)
 *  - others→ the section title sits HEADER_GAP below the expanded header.
 * Uses the live rect (+ current scrollY) so it is correct regardless of where
 * the page is currently scrolled.
 *
 * Direction-independence: the sub-bar lives INSIDE the sticky header and grows
 * the document by its own height when body.is-scrolled flips on (going down out
 * of the hero). So arriving at #about from the hero measures the doc with the
 * sub-bar still collapsed, while arriving from below measures it already
 * expanded — a ~64px discrepancy that made #about stop at two different spots.
 * Subtracting the sub-bar's LIVE rendered height normalizes both approaches to
 * the same target (the collapsed reference the outbound trip was tuned at).
 */
function sceneScrollTop(s) {
  if (!s) return 0;
  if (s.id === "hero") return 0;

  const subbar = document.querySelector(".site-subbar");
  const liveSub = subbar ? Math.round(subbar.getBoundingClientRect().height) : 0;
  // steadySub = the sub-bar height when fully expanded (the layout we settle
  // into). Used to normalize the target to the expanded reference so the spot
  // is IDENTICAL whether arriving from above (sub-bar still collapsing) or
  // below (already expanded). headerHeight() already includes steadySub.
  let steadySub = 0;
  if (document.body.classList.contains("is-scrolled")) {
    const si = document.querySelector(".site-subbar__inner");
    steadySub = si ? Math.round(si.getBoundingClientRect().height) : 0;
  }
  const hh = headerHeight();

  // Centred scenes: place the content block's centre in the area below the
  // header — but only when it fits; tall content falls back to top-anchoring so
  // it isn't clipped at both ends.
  if (CENTERED_SCENES.has(s.id)) {
    const c = sectionContent(s.el);
    const available = innerHeight - hh;
    if (c.height <= available - 16) {
      // Anchor on the SECTION's geometric centre, not the content union: the
      // section is a stable 100svh box and the content is flex-centred within
      // it, so the section centre == content centre but doesn't jitter with the
      // title's glyph-split / reveal state → identical target every visit.
      const r = s.el.getBoundingClientRect();
      const midDocExpanded = (r.top + r.bottom) / 2 + window.scrollY + (steadySub - liveSub);
      const desired = hh + available / 2; // optical centre of the below-header area
      return Math.max(0, Math.round(midDocExpanded - desired));
    }
    // else: fall through to top-anchor
  }

  // Default: top-anchor the title just below the (possibly expanding) header,
  // minus an optional per-scene downward nudge (smaller scrollTop = lower).
  const anchor = s.el.querySelector(".section-title, h2") || s.el;
  const docTop = anchor.getBoundingClientRect().top + window.scrollY;
  const nudge = SCENE_NUDGE[s.id] || 0;
  return Math.max(0, Math.round(docTop - liveSub - hh - HEADER_GAP - nudge));
}

/* ---- Dot navigation ------------------------------------------ */

let dotNav = null;  // the <nav> element
let dotBtns = [];   // array of <button> elements, one per scene
let inkWrap  = null; // goo-filtered ink layer (behind the rings)
let inkGooOut  = null; // outer white goo layer (full shape)
let inkGooIn   = null; // inner bg goo layer (erodes outer → ~2px OUTLINE)
let inkPurp    = null; // purple-dot layer (the liquid marker)
let inkNeckOut = null; // outer white neck
let inkNeckIn  = null; // inner bg neck (keeps the bridge an OUTLINE, hollow)
let inkDot     = null; // the purple dot that flows from ring to ring
let ringOut = [];    // outer white discs, one per ring
let ringIn  = [];    // inner bg discs, one per ring
let inkTl    = null; // active ink GSAP timeline (killed on re-trigger/rebuild)
let currentInkY = 0; // current purple-dot centre (nav coords)
const R_OUT = 9;     // outer disc radius (18px) — must match CSS
const R_IN  = 7;     // inner disc radius (14px) — leaves a ~2px outline
const NECK_OUT_W = 11; // outer neck width — must match CSS
const NECK_IN_W  = 7;  // inner neck width — must match CSS
const LEAN  = 2.5;   // px the two cells "lean" toward each other while merging
const INK_DURATION = 1.0; // s — total length of the mitosis choreography

function buildDotNav() {
  // Remove any stale nav from a previous build
  if (dotNav) dotNav.remove();
  dotBtns = [];
  ringOut = [];
  ringIn = [];

  dotNav = document.createElement("nav");
  dotNav.className = "scene-dot-nav";
  dotNav.setAttribute("aria-label", "Section navigation");

  for (let i = 0; i < scenes.length; i++) {
    const { label } = scenes[i];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "scene-dot";
    btn.setAttribute("aria-label", label);
    btn.dataset.sceneIndex = String(i);
    if (i === currentIndex) {
      btn.setAttribute("aria-current", "true");
      btn.classList.add("is-active");
    }
    btn.addEventListener("click", () => {
      if (introLocked && i !== 0) return; // respect intro lock
      syncViewport();                     // re-measure before a jump too
      go(i, deflagApiRef, orbitApiRef);
    });
    dotNav.appendChild(btn);
    dotBtns.push(btn);

    // Per-ring discs: white (outer) + bg (inner) → the inner erodes the outer
    // to a ~2px OUTLINE ring.
    const dOut = document.createElement("span");
    dOut.className = "scene-dot-goo__ring";
    const dIn = document.createElement("span");
    dIn.className = "scene-dot-goo-in__ring";
    ringOut.push(dOut);
    ringIn.push(dIn);
  }

  // Stacked layers (z via CSS): outer white goo · inner bg goo (erodes to a
  // rim) · purple dot. Buttons stay transparent click targets on top.
  inkGooOut = document.createElement("div");
  inkGooOut.className = "scene-dot-goo";
  inkGooOut.setAttribute("aria-hidden", "true");
  inkNeckOut = document.createElement("span");
  inkNeckOut.className = "scene-dot-goo__neck";
  inkGooOut.append(inkNeckOut, ...ringOut);

  inkGooIn = document.createElement("div");
  inkGooIn.className = "scene-dot-goo-in";
  inkGooIn.setAttribute("aria-hidden", "true");
  inkNeckIn = document.createElement("span");
  inkNeckIn.className = "scene-dot-goo-in__neck";
  inkGooIn.append(inkNeckIn, ...ringIn);

  inkPurp = document.createElement("div");
  inkPurp.className = "scene-dot-purple";
  inkPurp.setAttribute("aria-hidden", "true");
  inkDot = document.createElement("span");
  inkDot.className = "scene-dot-purple__dot";
  inkPurp.appendChild(inkDot);

  dotNav.append(inkGooOut, inkGooIn, inkPurp);
  document.body.appendChild(dotNav);

  // Now that the nav is laid out, place the static rings + the dot.
  positionStatics();
  placeInk(currentIndex);
}

/** Y centre of dot i, in nav coordinates. */
function dotCenterY(i) {
  const b = dotBtns[i];
  return b ? b.offsetTop + b.offsetHeight / 2 : 0;
}

/** Pin every ring disc (outer + inner) onto its dot centre (static). */
function positionStatics() {
  for (let i = 0; i < dotBtns.length; i++) {
    const cy = dotCenterY(i);
    if (ringOut[i]) ringOut[i].style.top = (cy - R_OUT) + "px";
    if (ringIn[i])  ringIn[i].style.top  = (cy - R_IN)  + "px";
  }
}

/** Span both necks (outer + inner) between two ring centres (rounded ends). */
function setNeckSpan(y1, y2) {
  const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
  if (inkNeckOut) {
    inkNeckOut.style.top = (lo - NECK_OUT_W / 2) + "px";
    inkNeckOut.style.height = (hi - lo + NECK_OUT_W) + "px";
  }
  if (inkNeckIn) {
    inkNeckIn.style.top = (lo - NECK_IN_W / 2) + "px";
    inkNeckIn.style.height = (hi - lo + NECK_IN_W) + "px";
  }
}

/** Collapse both necks to nothing (rest state). */
function collapseNecks() {
  if (inkNeckOut) inkNeckOut.style.height = "0px";
  if (inkNeckIn)  inkNeckIn.style.height = "0px";
}

/** Move the purple dot to nav-Y `y` (GSAP if present, else a CSS transform). */
function setDotY(y) {
  const g = window.gsap;
  if (g) g.set(inkDot, { y });
  else inkDot.style.transform = `translateY(${y}px)`;
}

/** Snap to the resting marker on dot i: purple dot in the ring, no bridge. */
function placeInk(i) {
  if (!inkDot) return;
  if (inkTl) { inkTl.kill(); inkTl = null; }
  const y = dotCenterY(i);
  currentInkY = y;
  setDotY(y);
  collapseNecks();
  const g = window.gsap;
  if (g) {
    g.set([inkNeckOut, inkNeckIn], { scaleX: 1 }); // full-width = a 2px outline
    if (ringOut.length) g.set([...ringOut, ...ringIn], { y: 0 }); // clear any lean
  }
}

/**
 * Organic transition from the current ring to dot `toIdx` — two cells doing
 * mitosis in reverse:
 *   1. CONNECT — the two cells lean toward each other and a hollow (OUTLINE)
 *                bridge oozes out joining their white membranes (metaball).
 *   2. FLOW    — the purple dot streams across the bridge like a liquid.
 *   3. SNAP    — the bridge retracts into the target and the cells spring back
 *                (elastic recoil), the purple dot resting in the destination.
 * Soft, overlapping eases keep it fluid (not mechanical). No-GSAP → instant.
 */
function moveInk(fromIdx, toIdx) {
  if (!inkDot || !inkNeckOut) return;
  const g = window.gsap;
  const cA = dotCenterY(fromIdx);
  const cB = dotCenterY(toIdx);
  if (!g) { placeInk(toIdx); return; }
  if (inkTl) inkTl.kill();

  g.set([inkNeckOut, inkNeckIn], { scaleX: 1 });
  const dir = Math.sign(cB - cA) || 1;
  const srcDiscs = [ringOut[fromIdx], ringIn[fromIdx]].filter(Boolean);
  const dstDiscs = [ringOut[toIdx],   ringIn[toIdx]].filter(Boolean);

  const span = { a: cA, b: cA };               // bridge ends; both start at source
  const refresh = () => setNeckSpan(span.a, span.b);
  const tl = g.timeline({ onComplete() { placeInk(toIdx); inkTl = null; } });
  // 1. CONNECT — cells lean in; the outline bridge oozes from source to target
  tl.to(srcDiscs, { y: dir * LEAN,  duration: 0.5, ease: "sine.inOut" }, 0);
  tl.to(dstDiscs, { y: -dir * LEAN, duration: 0.5, ease: "sine.inOut" }, 0);
  tl.to(span, { b: cB, duration: 0.5, ease: "power3.out", onUpdate: refresh }, 0.05);
  // 2. FLOW — the purple dot streams across like a liquid
  tl.to(inkDot, { y: cB, duration: 0.7, ease: "sine.inOut" }, 0.2);
  // 3. SNAP — bridge retracts into the target, the cells spring back
  tl.to(span, { a: cB, duration: 0.45, ease: "power2.in", onUpdate: refresh }, 0.78);
  tl.to([...srcDiscs, ...dstDiscs], { y: 0, duration: 0.7, ease: "elastic.out(1, 0.55)" }, 0.85);
  // Compress the whole choreography to exactly INK_DURATION seconds, keeping the
  // phases proportionate (tweak the constant to retune the speed in one place).
  tl.timeScale(tl.duration() / INK_DURATION);
  inkTl = tl;
}

function updateDotNav(idx) {
  for (let i = 0; i < dotBtns.length; i++) {
    const active = i === idx;
    dotBtns[i].classList.toggle("is-active", active);
    if (active) {
      dotBtns[i].setAttribute("aria-current", "true");
    } else {
      dotBtns[i].removeAttribute("aria-current");
    }
  }
}

/* ---- Navigation ------------------------------------------------ */

/**
 * Transition to scene at index `target`.
 * - Clamps to valid range.
 * - No-ops if already there or transition in progress.
 * - Animates window.scrollTo via a GSAP proxy.
 * - Drives the particle morph (or legacy hero melt) in sync with the scroll.
 */
function go(target, deflagApi, orbitApi) {
  target = Math.max(0, Math.min(scenes.length - 1, target));
  if (target === currentIndex) return;
  if (animating) return;

  // Leaving the hero downward with the step-7 LANGUAGE banner still up: play its
  // fly-into-the-toggle animation FIRST, then run the transition (req). The
  // collapse marks the banner consumed, so the re-entered go() won't loop.
  {
    const hIdx = scenes.findIndex((s) => s.id === "hero");
    if (deflagApi && deflagApi.langBannerPending && deflagApi.langBannerPending()
        && currentIndex === hIdx && target > hIdx) {
      animating = true;
      deflagApi.collapseLangBanner(() => {
        animating = false;
        go(target, deflagApi, orbitApi);
      });
      return;
    }
  }

  animating = true;

  const from    = scenes[currentIndex];
  const to      = scenes[target];
  const goingDown = target > currentIndex;

  // Leaving Experience → flip the scene marker NOW so the experience-only footbar
  // starts sliding out immediately; the scroll is then led by FOOTBAR_EXIT_LEAD
  // (below) so the bar is gone before the page moves. (req 2026-06-23)
  const leavingExperience = from && from.id === "experience" && to.id !== "experience";
  if (leavingExperience) document.body.dataset.scene = to.id;
  const scrollLead = leavingExperience ? FOOTBAR_EXIT_LEAD : 0;

  // Leaving the HERO downward: the name dissolves into the galaxy almost instantly
  // (the melt visual saturates at low progress), but power2.inOut's slow start
  // means the page barely moves for the first beat — so the full-screen galaxy
  // sits STILL "over" the hero before the scroll kicks in (read as "another page
  // under the home", req 2026-06-23). Give this one transition a fast-start ease
  // so the scroll moves WITH the melt from the first frame — no dead time. Other
  // transitions keep the gentle inOut. (Only the scroll is retimed; the morph
  // stays on inOut so the dissolve still reads as a melt, not a snap.)
  const leavingHeroDown = from && from.id === "hero" && goingDown;
  const scrollEase = leavingHeroDown ? "power3.out" : TRANSITION_EASE;

  // Gooey outline metaball + liquid dot run toward the destination in sync with
  // the scroll; mark the target ring (aria) now so it leads the eye.
  moveInk(currentIndex, target);
  updateDotNav(target);

  // Scene index (ids stay stable across the session).
  const heroIdx = scenes.findIndex((s) => s.id === "hero");

  // Step-driven chrome: the dot-nav, the brand name and the sub-bar only exist
  // from step 2 onward (hidden on the hero). Drive body.is-scrolled by the step
  // boundary so it is authoritative (the CSS already keys the name/subbar/dots
  // off it). Set at transition START so they fade in/out in sync with the move.
  document.body.classList.toggle("is-scrolled", target > heroIdx);

  // Target scroll position: lands the section title just below the (possibly
  // expanded) sticky header, so the second header bar never covers it.
  //
  // HYBRID directional landing: when stepping INTO a free (overflowing) scene
  // going UP from below, land at its BOTTOM so native scroll-up reveals it from
  // the end (symmetric with going down, which lands at the top). Otherwise land
  // at the top anchor.
  let targetScrollY = sceneScrollTop(to);
  if (!goingDown && sceneIsFree(to)) {
    const bottomY = to.el.offsetTop + to.el.offsetHeight - innerHeight;
    targetScrollY = Math.max(targetScrollY, Math.round(bottomY));
  }

  const g = window.gsap;
  const tl = g.timeline({
    onComplete() {
      currentIndex = target;
      animating    = false;
      // Pin scroll exactly on the landing position (rounding/sub-px safety).
      // For a free scene we still pin (to its top OR bottom, computed above)
      // so the native scroll starts from a known boundary; mid-scroll the user
      // takes over from there.
      window.scrollTo({ top: targetScrollY, behavior: "instant" });
      document.body.dataset.scene = to.id;
      recomputeFree();                         // cache new scene's free-state
      updateDotNav(currentIndex);
    }
  });

  // ---- scroll tween (the backbone of every transition) ----
  // scrollLead > 0 only when leaving Experience: hold the scroll a beat so the
  // footbar finishes exiting first.
  //
  // Animate a NORMALIZED progress 0→1 and derive the scroll position from a
  // start captured in onStart (i.e. AFTER scrollLead). Leaving Experience the
  // scroll is delayed by FOOTBAR_EXIT_LEAD, and Experience is a FREE scene — the
  // wheel that triggered the hand-off was not preventDefaulted, so the browser's
  // native momentum keeps moving the page during that delay. Seeding the tween
  // from the scrollY captured at go() time would then yank the page back to that
  // now-stale spot on the very first frame: a visible "up a bit, then down"
  // rebound. Reading the live scrollY in onStart adopts wherever momentum left
  // us, so the move to the target stays monotonic.
  let scrollFrom = window.scrollY;
  const prog = { p: 0 };
  tl.to(prog, {
    p:        1,
    duration: TRANSITION_DURATION,
    ease:     scrollEase,
    onStart() { scrollFrom = window.scrollY; },
    onUpdate() {
      window.scrollTo({ top: scrollFrom + (targetScrollY - scrollFrom) * prog.p, behavior: "instant" });
    }
  }, scrollLead);

  // ---- scene-specific side-effects woven into the scroll tween ----

  // PARTICLE MORPH: every transition re-sculpts the shared cloud into the
  // destination scene's silhouette (hero name → about frame → expertise cards
  // frame → galaxy for experience → education planet → contact initials). The
  // director fills the right target slot synchronously here and we drive its
  // controller 0→1 in lock-step with the scroll tween.
  if (shapesApiRef) {
    const ctrl = shapesApiRef.beginScene(to.id, targetScrollY);
    const m = { p: 0 };
    tl.to(m, { p: 1, duration: TRANSITION_DURATION, ease: TRANSITION_EASE,
      onUpdate() { ctrl.apply(m.p); }, onComplete() { ctrl.settle(); } }, scrollLead);
  } else if (deflagApi) {
    // Fallback (morph-disabled tier): the legacy hero name melt only.
    if (currentIndex === heroIdx && target > heroIdx) {
      const m = { p: 0 };
      tl.to(m, { p: 1, duration: TRANSITION_DURATION, ease: TRANSITION_EASE,
        onUpdate() { deflagApi.setMelt(m.p); } }, 0);
    } else if (target === heroIdx && currentIndex > heroIdx) {
      const m = { p: 1 };
      tl.to(m, { p: 0, duration: TRANSITION_DURATION, ease: TRANSITION_EASE,
        onUpdate() { deflagApi.setMelt(m.p); } }, 0);
    }
  }

  // ---- incoming section reveal (simple, consistent cross-site signature) ----
  // A subtle fade+rise of the destination section's direct children. Simple
  // and consistent across all scenes; bespoke per-boundary transitions are a
  // future phase. Skip for #experience (free-scroll; content was already
  // revealed by IntersectionObserver) and for going back to hero.
  const targetEl = to.el;
  const revealChildren = targetEl.children.length > 0 && !sceneIsFree(to) && to.id !== "hero";
  if (revealChildren) {
    // Only animate children that don't already have an IO-reveal observer on them
    // (section title gets glyph-reveal via IO; skip it to avoid double-animation).
    // We pick the non-h2 children for the structural reveal overlay.
    const kids = Array.from(targetEl.children).filter(
      (c) => !c.classList.contains("section-title") && c.tagName !== "H2"
    );
    if (kids.length) {
      g.fromTo(
        kids,
        { opacity: 0, y: 18 },
        {
          opacity: 1, y: 0,
          duration: 0.55,
          ease: "power2.out",
          stagger: 0.05,
          clearProps: "opacity,transform",
          delay: TRANSITION_DURATION * 0.55  // start reveal as scroll lands
        }
      );
    }
  }

  void from; void goingDown; // referenced for future bespoke transitions
}

/* ---- Intent dispatch ------------------------------------------ */

function isFreeScene() {
  return currentFree;
}

/** Check if the current (free) scene's native scroll is at its TOP boundary. */
function curAtTop() {
  const s = scenes[currentIndex];
  if (!s) return false;
  return window.scrollY <= sceneScrollTop(s) + FREE_BOUNDARY_SLACK;
}

/** Check if the current (free) scene's native scroll is at its BOTTOM boundary. */
function curAtBottom() {
  const s = scenes[currentIndex];
  if (!s) return false;
  return window.scrollY + window.innerHeight >= s.el.offsetTop + s.el.offsetHeight - FREE_BOUNDARY_SLACK;
}

/**
 * Quick viewport re-check, run on EVERY directional input. If the window was
 * resized / zoomed / had its OS text-size changed since the last input, the
 * cached layout is stale: re-pin the current scene to its freshly-measured
 * anchor and re-fit the particle shape to the new size, so each step always
 * lands on a correctly-sized scene (no next-scene bleed). Cheap no-op when the
 * dimensions are unchanged.
 */
function syncViewport() {
  if (innerWidth === lastVW && innerHeight === lastVH) return;
  lastVW = innerWidth;
  lastVH = innerHeight;
  if (shapesApiRef && shapesApiRef.refresh) shapesApiRef.refresh();
  // Viewport changed → the current scene may have crossed the fit/overflow
  // threshold (e.g. phone rotated): recompute its free-state before deciding.
  recomputeFree();
  const s = scenes[currentIndex];
  if (s && !currentFree && !animating) {
    window.scrollTo({ top: sceneScrollTop(s), behavior: "instant" });
  }
}

/**
 * Emit a navigation intent: +1 = down, -1 = up.
 * Respects intro lock, free-scene boundary checks, cooldown and animating flag.
 */
function intent(dir, deflagApi, orbitApi) {
  // In L0 (Experience compact grid) the footbar owns the input and the page
  // scroll is locked by experience-levels.js. That lock only preventDefaults the
  // native scroll — it does NOT stopPropagation — so this wheel/touch/key handler
  // still runs. Without this guard a scroll while the cursor is over the footbar
  // fires a scene hand-off and ejects the user to the next section. Stay inert.
  if (document.body.classList.contains("exp-l0")) return;
  syncViewport();                 // re-measure on every input (catch resizes)
  if (introLocked) return;
  if (animating) return;

  const now = Date.now();
  if (now - lastWheelTime < WHEEL_COOLDOWN) return;

  if (isFreeScene()) {
    // Inside a free (overflowing) scene: only hand off when at the boundary;
    // otherwise let the native scroll move within the scene.
    if (dir > 0 && !curAtBottom()) return;
    if (dir < 0 && !curAtTop())    return;
  }

  const next = currentIndex + dir;
  if (next < 0 || next >= scenes.length) return;

  lastWheelTime = now;
  go(next, deflagApi, orbitApi);
}

/* ---- Input handlers ------------------------------------------ */

function makeHandlers(deflagApi, orbitApi) {
  // wheel: one directional intent per gesture; preventDefault on locked scenes
  // to stop the browser from also moving the scroll position.
  wheelHandler = (e) => {
    if (!isFreeScene()) {
      e.preventDefault();
    }
    const dir = e.deltaY > 0 ? 1 : -1;
    intent(dir, deflagApi, orbitApi);
  };

  // touch: record start, prevent native scroll on locked scenes (touchmove),
  // emit intent on end if Δ >= TOUCH_MIN_DELTA.
  touchStartHandler = (e) => {
    touchStartY = e.touches[0].clientY;
  };

  touchMoveHandler = (e) => {
    if (!isFreeScene()) e.preventDefault();
  };

  touchEndHandler = (e) => {
    const delta = touchStartY - e.changedTouches[0].clientY;
    if (Math.abs(delta) < TOUCH_MIN_DELTA) return;
    const dir = delta > 0 ? 1 : -1;
    intent(dir, deflagApi, orbitApi);
  };

  // keyboard: arrows / page / home / end.
  // Ignore when focus is inside an input/textarea or when a modifier is held.
  keyHandler = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    // Also ignore when a contenteditable element is focused
    if (document.activeElement && document.activeElement.isContentEditable) return;

    let dir = 0;
    let prevent = !isFreeScene(); // only preventDefault on locked scenes

    if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === " ") {
      dir = 1;
    } else if (e.key === "ArrowUp" || e.key === "PageUp") {
      dir = -1;
    } else if (e.key === "Home") {
      if (prevent) e.preventDefault();
      if (!introLocked && !animating) go(0, deflagApi, orbitApi);
      return;
    } else if (e.key === "End") {
      if (prevent) e.preventDefault();
      if (!introLocked && !animating) go(scenes.length - 1, deflagApi, orbitApi);
      return;
    }

    if (!dir) return;
    if (prevent) e.preventDefault();
    intent(dir, deflagApi, orbitApi);
  };
}

function attachHandlers() {
  // wheel: non-passive so we can preventDefault on locked scenes
  window.addEventListener("wheel", wheelHandler, { passive: false });
  window.addEventListener("touchstart", touchStartHandler, { passive: true });
  // touchmove: non-passive so we can preventDefault on locked scenes
  window.addEventListener("touchmove", touchMoveHandler, { passive: false });
  window.addEventListener("touchend", touchEndHandler, { passive: true });
  window.addEventListener("keydown", keyHandler);
}

function detachHandlers() {
  if (wheelHandler)      { window.removeEventListener("wheel",      wheelHandler);      wheelHandler      = null; }
  if (touchStartHandler) { window.removeEventListener("touchstart", touchStartHandler); touchStartHandler = null; }
  if (touchMoveHandler)  { window.removeEventListener("touchmove",  touchMoveHandler);  touchMoveHandler  = null; }
  if (touchEndHandler)   { window.removeEventListener("touchend",   touchEndHandler);   touchEndHandler   = null; }
  if (keyHandler)        { window.removeEventListener("keydown",    keyHandler);        keyHandler        = null; }
}

/* ---- Resize handler ------------------------------------------ */

function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (animating) return;
    if (!scenes[currentIndex]) return;
    const s = scenes[currentIndex];
    recomputeFree(); // resize may have flipped fit ↔ overflow
    if (!currentFree) {
      // Re-pin to the current scene's top (section may have shifted after resize)
      window.scrollTo({ top: sceneScrollTop(s), behavior: "instant" });
    }
  }, 180);
}

/* ---- Main export ---------------------------------------------- */

/**
 * Initialize the scene stepper.
 *
 * @param {object}  data        - cv_data (unused currently, reserved for future config)
 * @param {object}  sceneCtx    - three-scene context (unused directly; passed for extension)
 * @param {object|null} orbitApi    - API returned by initHeroOrbit: { setReveal, setSeq, disableScrollDriving }
 * @param {object|null} deflagApi  - API returned by initHeroDeflagration: { setMelt, disableScrollDriving, ... }
 * @param {object|null} scrollStoryApi - API from initScrollStory: { disableScrollDriving }
 * @param {object|null} shapesApi  - per-scene morph director: { beginScene, refresh } | null
 *
 * Returns { dispose } or null if guards bail.
 */
export function initSceneNav(data, sceneCtx, orbitApi, deflagApi, scrollStoryApi, shapesApi) {
  // ---- Hard guards ---------------------------------------------------
  // If reduced-motion OR no GSAP: do absolutely nothing. The legacy free-scroll
  // site remains intact. This is the accessibility fallback.
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  if (!window.gsap) return null;
  // MOBILE (≤767px): the discrete scene stepper is disabled. Phones use native
  // continuous scroll so the Canvas-2D physics layer (mobile-particles.js) can
  // drive its name→galaxy→initials arc off scrollY + scroll velocity — the two
  // are incompatible (the stepper preventDefaults touchmove and teleports between
  // scenes, freezing the physics and stranding the user mid-section). Desktop
  // keeps the stepper. See mobile-redesign decision (2026-06-21).
  if (matchMedia("(max-width: 767px)").matches) return null;

  // ---- Activate ---------------------------------------------------------
  // Set the body class FIRST — hero-orbit/deflagration/scroll-story will read
  // this flag when they create their ScrollTriggers. Since we run AFTER those
  // inits (see main.js), we also call their disableScrollDriving() below to
  // kill any STs that may have been created before the class was set.
  document.body.classList.add("scene-nav");

  // Store APIs so dot-nav clicks drive the same melt choreography as
  // wheel/touch/key.
  deflagApiRef  = deflagApi || null;
  orbitApiRef   = orbitApi || null;
  shapesApiRef  = shapesApi || null;
  lastVW = innerWidth;
  lastVH = innerHeight;

  // Disable CSS smooth-scroll so the GSAP tween's behavior:"instant" updates
  // don't get smoothed again by the browser's own interpolation.
  document.documentElement.style.scrollBehavior = "auto";

  // Kill any conflicting ScrollTriggers from the modules that were already inited
  if (deflagApi   && deflagApi.disableScrollDriving)   deflagApi.disableScrollDriving();
  if (orbitApi    && orbitApi.disableScrollDriving)    orbitApi.disableScrollDriving();
  if (scrollStoryApi && scrollStoryApi.disableScrollDriving) scrollStoryApi.disableScrollDriving();

  // ---- Scene list -------------------------------------------------------
  buildSceneList();

  if (scenes.length < 2) {
    // Not enough scenes to step between — bail gracefully
    document.body.classList.remove("scene-nav");
    return null;
  }

  // ---- Intro lock -------------------------------------------------------
  // Locked until the intro timeline fires "evolvedcv:intro-done".
  // If the intro is not active (no-3d / reduced-motion — but we already bailed
  // on reduced-motion above; no-3d is still possible), main.js dispatches the
  // event immediately so we unlock right away.
  introLocked = true;

  const onIntroDone = () => {
    introLocked = false;
    // Pin scroll to scene 0's ANCHOR on unlock (safety — intro may have caused
    // drift). Use sceneScrollTop (hero → 0), NOT el.offsetTop: the sticky header
    // reserves its own height (~49px) of flow space above <main>, so hero's
    // offsetTop is the header height, not 0. Scrolling there would snap the page
    // up by exactly the header height right as the intro finishes — the hero DOM
    // text (role/sub/counter) would visibly "rise" while the viewport-fixed
    // particle name stays put. Anchoring at 0 keeps everything where it composed.
    if (!animating && scenes[0]) {
      window.scrollTo({ top: sceneScrollTop(scenes[0]), behavior: "instant" });
    }
    recomputeFree();
  };
  window.addEventListener("evolvedcv:intro-done", onIntroDone, { once: true });

  // ---- Initial pin -------------------------------------------------------
  // Snap to scene 0 immediately (hero top) so the stepper starts from a known
  // state regardless of browser scroll restoration.
  window.scrollTo({ top: 0, behavior: "instant" });
  currentIndex = 0;
  document.body.dataset.scene = scenes[0].id;
  recomputeFree();

  // ---- Dot nav -----------------------------------------------------------
  buildDotNav();
  updateDotNav(0);

  // ---- Input handlers ----------------------------------------------------
  makeHandlers(deflagApi, orbitApi);
  attachHandlers();

  // ---- Resize -----------------------------------------------------------
  window.addEventListener("resize", onResize, { passive: true });

  // ---- Dispose -----------------------------------------------------------
  function dispose() {
    detachHandlers();
    window.removeEventListener("resize", onResize);
    window.removeEventListener("evolvedcv:intro-done", onIntroDone);
    clearTimeout(resizeTimer);
    if (inkTl) { inkTl.kill(); inkTl = null; }
    if (dotNav) { dotNav.remove(); dotNav = null; }
    dotBtns = [];
    inkGooOut = inkGooIn = inkPurp = inkNeckOut = inkNeckIn = inkDot = null;
    ringOut = [];
    ringIn = [];
    scenes  = [];
    deflagApiRef = null;
    orbitApiRef  = null;
    shapesApiRef = null;
    document.body.classList.remove("scene-nav");
    delete document.body.dataset.scene;
    document.documentElement.style.scrollBehavior = "";
    introLocked = true;
  }

  return { dispose };
}
