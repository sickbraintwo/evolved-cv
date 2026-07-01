/**
 * footbar.js — fixed bottom filter bar, visible only in the Experience scene.
 * Shows all expskills (tags) grouped by domain as pill chips. Clicking a chip
 * → toggleTag() → the Experience cards re-filter automatically (ui-renderer is
 * already subscribed to activeTags).
 *
 * Desktop only: on mobile (<= 767px) does nothing (mobile has its own FAB).
 * Depends on: state.js (get/subscribe/toggleTag), theme.js (getDomainColor).
 * Does not touch: filter-scene.js, state.js, ui-renderer.js, theme.js.
 */

import { get, subscribe, toggleTag, resetTags } from "./state.js";
import { getDomainColor } from "./theme.js";
import { expSmooth } from "./math-utils.js";

/* ------------------------------------------------------------------ helpers */

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

/* ------------------------------------------------------------------ module state */

let _data  = null;
let _nav   = null; // <nav class="footbar">
let _reset = null; // <button class="footbar__reset"> — shown only when a filter is active
let _apply = null; // <button class="footbar__apply"> — shown at L0 when a filter is active

/* ---- proximity growth (peek → full) ----------------------------------------
   The bar is small ("peek") when the cursor is near the top and grows toward
   full size as the cursor approaches the bottom (where the bar lives). Only
   the bar changes (it is position:fixed): the experiences do NOT move.
   Shortcut: hovering the bar directly → full (for users who scroll with the
   wheel without moving the mouse). Smoothed via lerp in a rAF loop that stops
   when there is nothing left to animate. */
const GROW_START = 0.60;  // pointer NY (0 top .. 1 bottom) at which growth starts
const GROW_FULL  = 0.95;  // pointer NY at which bar is full size
const HYST_LOW   = 0.45;  // below this threshold → back to peek (hysteresis dead-zone 0.45–0.60)
const GROW_LERP  = 9;     // smoothing speed (avoids a nervous 1:1 response)

let _grow       = 0;      // 0 peek .. 1 full (smoothed value, written to --grow)
let _pointerNY  = 0;      // normalised cursor Y (0 top .. 1 bottom)
let _hoverFull  = false;  // cursor on the bar → force full size
let _prevTarget = 0;      // last target (for the hysteresis dead-zone)
let _active     = false;  // siamo nella scena Experience?
let _raf        = 0;
let _lastT      = 0;

function targetGrow() {
  if (_hoverFull) return 1;
  const ny = _pointerNY;
  let t;
  if (ny >= GROW_START)      t = Math.min(1, (ny - GROW_START) / (GROW_FULL - GROW_START));
  else if (ny <= HYST_LOW)   t = 0;
  else                       t = _prevTarget;   // dead-zone: keep current state
  _prevTarget = t;
  return t;
}

function growTick(now) {
  const dt = _lastT ? Math.min(50, now - _lastT) / 1000 : 0.016;
  _lastT = now;
  // Leaving the scene (!_active) FREEZES the current scale: the bar slides
  // away (CSS slide) at its current size without shrinking as it exits
  // (that was the weird effect). On entry syncActive resets _grow to 0 (peek).
  const target = _active ? targetGrow() : _grow;
  _grow = expSmooth(_grow, target, dt, GROW_LERP);
  const settled = Math.abs(target - _grow) < 0.0008;
  if (settled) _grow = target;
  if (_nav) _nav.style.setProperty("--grow", _grow.toFixed(4));
  if (settled) { _raf = 0; _lastT = 0; return; }   // nothing to animate → stop the loop
  _raf = requestAnimationFrame(growTick);
}
function growLoop() { if (!_raf) { _lastT = 0; _raf = requestAnimationFrame(growTick); } }

/* ---- cross-lighting skill ↔ experience ------------------------------------
   BEHAVIOUR: hover = transient PREVIEW (the skill and its experiences light up,
   others dim) — on mouse-out everything reverts; CLICK is the persistent
   selection (toggleTag → filter). Bidirectional: hovering a chip lights up the
   experience-cards that include that skill; hovering a card lights up the
   "sibling" chips (its skills). Non-destructive: only adds temporary classes,
   does not touch the filter (.is-hidden). */
const _skillToExps = new Map();  // tagId  -> Set(expId)
const _expToSkills = new Map();  // expId  -> string[] (tagId)
let _litCard = null;             // card currently under the cursor (anti-bounce)

function buildMaps() {
  _skillToExps.clear(); _expToSkills.clear();
  for (const e of (_data && _data.experience) || []) {
    const skills = Array.isArray(e.expskills) ? e.expskills : [];
    _expToSkills.set(e.id, skills);
    for (const t of skills) {
      if (!_skillToExps.has(t)) _skillToExps.set(t, new Set());
      _skillToExps.get(t).add(e.id);
    }
  }
}

// hover on a CHIP → lights up the experiences with that skill, dims the others
function lightExpsForSkill(tagId, color) {
  const ids = _skillToExps.get(tagId) || new Set();
  for (const card of document.querySelectorAll("#experience .exp-card[data-exp-id]")) {
    const on = ids.has(card.dataset.expId);
    if (on && color) card.style.setProperty("--lit-c", color);
    card.classList.toggle("exp-skill-lit", on);
    card.classList.toggle("exp-skill-dim", !on);
  }
}
function clearExpLights() {
  for (const card of document.querySelectorAll("#experience .exp-card.exp-skill-lit, #experience .exp-card.exp-skill-dim")) {
    card.classList.remove("exp-skill-lit", "exp-skill-dim");
  }
}

// hover on a CARD → lights up the "sibling" chips (its skills)
function lightChipsForExp(expId) {
  const skills = new Set(_expToSkills.get(expId) || []);
  if (!_nav) return;
  for (const chip of _nav.querySelectorAll(".footbar__chip[data-tag]")) {
    chip.classList.toggle("is-sibling", skills.has(chip.dataset.tag));
  }
}
function clearChipLights() {
  if (!_nav) return;
  for (const chip of _nav.querySelectorAll(".footbar__chip.is-sibling")) chip.classList.remove("is-sibling");
}

/* ---- FILAMENTS (brick 5) --------------------------------------------------
   When a skill lights up (hover on a chip), the REAL particles from the WebGL
   field of THAT domain are borrowed and streamed as a trail from the chip
   toward the sibling experiences (centroid of the lit cards), in the domain
   colour. On mouse-out they flow back into the galaxy (borrowed, not spawned).
   Reuses the per-domain gather from three-scene in "filament" mode. */
const FIL_DOMAIN_IDX = { ai: 0, "3dxr": 1, "2dmedia": 2, dev: 3, consulting: 4 }; // = three-scene DOMAIN_IDS
const FIL_MAX  = 0.9;
const FIL_LERP = 5;
let _three   = null;   // threeCtx (WebGL) o null
let _filDom  = -1;     // domain currently streaming (-1 = none)
let _filActive = false;
let _filChip = null;   // the source chip of the filament
let _filAmt  = 0;      // 0..1 smussato
let _filRaf  = 0, _filLast = 0;

function canFilament() {
  return !!(_three && _three.setDomFilament && _three.worldFromScreen &&
    (!_three.morphEnabled || _three.morphEnabled()));
}
function rectCenterWorld(r) {
  const nx = ((r.left + r.width / 2) / Math.max(1, window.innerWidth)) * 2 - 1;
  const ny = -(((r.top + r.height / 2) / Math.max(1, window.innerHeight)) * 2 - 1);
  return _three.worldFromScreen(nx, ny, 0);
}
function litCardsRect() {
  const cards = document.querySelectorAll("#experience .exp-card.exp-skill-lit");
  if (!cards.length) return null;
  let l = 1e9, t = 1e9, r = -1e9, b = -1e9;
  for (const c of cards) { const cr = c.getBoundingClientRect(); l = Math.min(l, cr.left); t = Math.min(t, cr.top); r = Math.max(r, cr.right); b = Math.max(b, cr.bottom); }
  return { left: l, top: t, width: r - l, height: b - t };
}
// half-size (in WORLD) of the lit-cards bounding box → cone opening width
function rectHalfExtentWorld(rc) {
  const iw = Math.max(1, window.innerWidth), ih = Math.max(1, window.innerHeight);
  const cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
  const ndcCX = (cx / iw) * 2 - 1, ndcCY = -((cy / ih) * 2 - 1);
  const wL = _three.worldFromScreen((rc.left / iw) * 2 - 1, ndcCY, 0);
  const wR = _three.worldFromScreen(((rc.left + rc.width) / iw) * 2 - 1, ndcCY, 0);
  const wT = _three.worldFromScreen(ndcCX, -((rc.top / ih) * 2 - 1), 0);
  const wB = _three.worldFromScreen(ndcCX, -(((rc.top + rc.height) / ih) * 2 - 1), 0);
  return { hx: Math.abs(wR.x - wL.x) / 2, hy: Math.abs(wT.y - wB.y) / 2 };
}
function filTick(now) {
  const dt = _filLast ? Math.min(50, now - _filLast) / 1000 : 0.016; _filLast = now;
  const target = _filActive ? FIL_MAX : 0;
  _filAmt = expSmooth(_filAmt, target, dt, FIL_LERP);
  const settled = Math.abs(target - _filAmt) < 0.002;
  if (settled) _filAmt = target;
  if (_filDom >= 0 && canFilament()) {
    if (_filActive && _filChip) { const o = rectCenterWorld(_filChip.getBoundingClientRect()); if (o) _three.setDomOrigin(_filDom, o.x, o.y, o.z); }
    if (_filActive) {
      const lr = litCardsRect();
      if (lr) {
        const c = rectCenterWorld(lr); _three.setDomGatherPos(_filDom, c.x, c.y, c.z);
        const he = rectHalfExtentWorld(lr); _three.setDomSpread(_filDom, he.hx, he.hy, 0);  // open the cone across all lit cards
      }
    }
    _three.setDomFilament(_filDom, 1);
    _three.setDomGather(_filDom, _filAmt < 0.002 ? 0 : _filAmt);
  }
  if (settled) {
    if (!_filActive && _filDom >= 0) {                  // release complete → switch off
      if (canFilament()) { _three.setDomGather(_filDom, 0); _three.setDomFilament(_filDom, 0); }
      _filDom = -1; _filChip = null;
    }
    _filRaf = 0; _filLast = 0; return;
  }
  _filRaf = requestAnimationFrame(filTick);
}
function filLoop() { if (!_filRaf) { _filLast = 0; _filRaf = requestAnimationFrame(filTick); } }
function startFilament(domainId, chip) {
  const di = FIL_DOMAIN_IDX[domainId];
  if (di === undefined || !canFilament()) { stopFilament(); return; } // consulting/no domain
  if (_filDom >= 0 && _filDom !== di) {                 // domain change: kill the old one instantly
    _three.setDomGather(_filDom, 0); _three.setDomFilament(_filDom, 0);
    _filAmt = 0;
  }
  _filDom = di; _filChip = chip; _filActive = true;
  filLoop();
}
function stopFilament() { _filActive = false; filLoop(); }

/* ------------------------------------------------------------------ build */

/**
 * Build and append the <nav> to the body.
 * Called once by initFootbar().
 */
function buildDom() {
  _nav = el("nav", "footbar");
  _nav.setAttribute("aria-label", get("lang") === "it" ? "Filtro competenze" : "Filter skills");
  document.body.appendChild(_nav);
  renderChips();
}

/**
 * Rebuilds the chips whenever the language changes.
 * Keeps the visual state (aria-pressed) in sync with activeTags.
 */
function renderChips() {
  if (!_nav || !_data) return;
  const lang = get("lang");
  _nav.setAttribute("aria-label", lang === "it" ? "Filtro competenze" : "Filter skills");
  _nav.innerHTML = "";

  for (const domain of _data.tag_taxonomy.domains) {
    if (!domain.tags || domain.tags.length === 0) continue;
    const color = getDomainColor(domain.id);

    const group = el("div", `footbar__group footbar__group--${domain.id}`);
    group.style.setProperty("--chip-c", color);

    for (const tag of domain.tags) {
      const b = el("button", "footbar__chip");
      b.type = "button";
      b.dataset.tag = tag.id;
      b.style.setProperty("--chip-c", color);
      b.setAttribute("aria-pressed", "false");
      b.textContent = tag.label[lang] || tag.label.en;
      b.addEventListener("click", () => toggleTag(tag.id));
      // hover = preview: lights the experiences with this skill + filaments
      b.addEventListener("pointerenter", () => { lightExpsForSkill(tag.id, color); startFilament(domain.id, b); });
      b.addEventListener("pointerleave", () => { clearExpLights(); stopFilament(); });
      group.appendChild(b);
    }

    _nav.appendChild(group);
  }

  // Contextual Reset: shown ONLY when at least one expskill is active, and
  // clears all filters (resetTags → activeTags empty → all cards shown).
  _reset = el("button", "footbar__reset");
  _reset.type = "button";
  _reset.innerHTML =
    `<span class="footbar__reset-glyph" aria-hidden="true">↺</span>` +
    `<span>${lang === "it" ? "Azzera" : "Reset"}</span>`;
  _reset.addEventListener("click", () => resetTags());
  _nav.appendChild(_reset);

  // Apply: shown ONLY at L0 (body.exp-l0) with an active filter. Turns the
  // preview (dimmed cards) into the result (removal) by exiting L0 → L1.
  // Exits L0 via custom event listened to by experience-levels.js.
  _apply = el("button", "footbar__apply");
  _apply.type = "button";
  _apply.textContent = lang === "it" ? "Applica" : "Apply";
  _apply.addEventListener("click", () => document.dispatchEvent(new CustomEvent("evolvedcv:footbar-apply")));
  _nav.appendChild(_apply);

  // sync immediately with the current state
  syncPressed();
}

/**
 * Updates aria-pressed/.is-active on chips and the Reset visibility, based
 * on activeTags — without rebuilding the DOM.
 */
function syncPressed() {
  if (!_nav) return;
  const active = get("activeTags");
  for (const b of _nav.querySelectorAll(".footbar__chip[data-tag]")) {
    const on = active.has(b.dataset.tag);
    b.setAttribute("aria-pressed", String(on));
    b.classList.toggle("is-active", on);
  }
  if (_reset) _reset.classList.toggle("is-on", active.size > 0);
  if (_apply) _apply.classList.toggle("is-on", active.size > 0);  // CSS shows it only at L0
}

/* ------------------------------------------------------------------ init */

/**
 * Initialise the footbar.
 * Returns null on mobile (<=767px) — mobile uses the FAB.
 *
 * @param {object} data — data object loaded by data-loader (same
 *                        reference passed to the other inits in main.js)
 * @param {object|null} threeCtx — WebGL context (three-scene) for filaments
 * @returns {object|null} public API or null on mobile
 */
export function initFootbar(data, threeCtx) {
  // Desktop only
  if (window.matchMedia("(max-width: 767px)").matches) return null;
  _three = threeCtx || null;

  _data = data;
  buildMaps();
  buildDom();

  // Cross-lighting, CARD → chip direction: hovering an experience card lights
  // the "sibling" chips. Delegated on #experience (survives language re-renders).
  // mouseover/out bubble: uses closest + relatedTarget to detect real
  // entry/exit from the card.
  const expSection = document.getElementById("experience");
  const onExpOver = (e) => {
    const card = e.target.closest && e.target.closest(".exp-card[data-exp-id]");
    if (!card || card === _litCard) return;
    _litCard = card;
    lightChipsForExp(card.dataset.expId);   // does NOT grow the bar (only lights siblings)
  };
  const onExpOut = (e) => {
    const card = e.target.closest && e.target.closest(".exp-card[data-exp-id]");
    if (!card || card !== _litCard) return;
    if (e.relatedTarget && card.contains(e.relatedTarget)) return;  // still inside the card
    _litCard = null;
    clearChipLights();
  };
  if (expSection) {
    expSection.addEventListener("mouseover", onExpOver);
    expSection.addEventListener("mouseout", onExpOut);
  }

  // Update labels when the language changes (rebuilds chips)
  subscribe("lang", () => renderChips());

  // Update visual state (pressed/glow) when active tags change
  subscribe("activeTags", () => syncPressed());

  // ---- proximity growth ----
  // reduced-motion: no animated growth — the bar stays FULL and static.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    _grow = 1;
    _nav.style.setProperty("--grow", "1");
    return { refresh() { renderChips(); }, dispose() {} };
  }
  const onPointerMove = (e) => {
    _pointerNY = e.clientY / Math.max(1, window.innerHeight);
    if (_active) growLoop();           // resume lerp while the cursor moves
  };
  const onEnter = () => {
    _hoverFull = true;
    growLoop();
    // Notify experience-levels.js that the cursor entered the footbar (→ L0)
    document.dispatchEvent(new CustomEvent("evolvedcv:footbar-enter"));
  };
  const onLeave = (e) => {
    // Exiting from the BOTTOM EDGE of the bar (toward the screen bottom): do NOT
    // change anything — if at L0 stay at L0, if at L1 stay at L1 (user request).
    // Only exiting upward/sideways (back to experiences) de-compacts.
    const r = _nav.getBoundingClientRect();
    if (e && e.clientY >= r.bottom - 2) return;
    _hoverFull = false;
    growLoop();
    // Notify experience-levels.js that the cursor left the footbar (→ L1)
    document.dispatchEvent(new CustomEvent("evolvedcv:footbar-leave"));
  };
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  _nav.addEventListener("pointerenter", onEnter);
  _nav.addEventListener("pointerleave", onLeave);

  // enable/disable the loop when entering/leaving the Experience scene
  const syncActive = () => {
    const on = document.body.classList.contains("scene-nav") &&
               document.body.dataset.scene === "experience";
    // on entry: ALWAYS restart from peek (bar enters small, then grows with
    // proximity) — no flash of the previous size.
    if (on && !_active) { _grow = 0; _nav.style.setProperty("--grow", "0"); }
    _active = on;
    if (!on) stopFilament();   // leaving Experience: filaments flow back
    growLoop();
  };
  const mo = new MutationObserver(syncActive);
  mo.observe(document.body, { attributes: true, attributeFilter: ["data-scene", "class"] });
  syncActive();

  return {
    /** Force a full re-render (e.g. after a runtime data change) */
    refresh() { renderChips(); },
    dispose() {
      if (_raf) cancelAnimationFrame(_raf), (_raf = 0);
      if (_filRaf) cancelAnimationFrame(_filRaf), (_filRaf = 0);
      if (_filDom >= 0 && canFilament()) { _three.setDomGather(_filDom, 0); _three.setDomFilament(_filDom, 0); }
      window.removeEventListener("pointermove", onPointerMove);
      _nav.removeEventListener("pointerenter", onEnter);
      _nav.removeEventListener("pointerleave", onLeave);
      if (expSection) {
        expSection.removeEventListener("mouseover", onExpOver);
        expSection.removeEventListener("mouseout", onExpOut);
      }
      mo.disconnect();
    }
  };
}
