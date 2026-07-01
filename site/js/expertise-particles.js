/**
 * expertise-particles.js — DESKTOP Canvas-2D layer for the Expertise section.
 *
 * Per-domain glowing particles drift faintly in the section (chaos); when the
 * cursor enters a card, that card's domain particles ease out of chaos and
 * gather to DANCE along a halo just OUTSIDE the card's rounded border (so they
 * stay visible around the opaque cards), in the card's domain colour. Leaving
 * disperses them back to chaos. A "middle" feel: a gentle swirl-in on approach,
 * a slow-ish border river, a soft breathing pulse — between sober and hypnotic.
 *
 * The canvas sits BEHIND the cards (cards keep z-index:1), is pointer-transparent
 * and clipped to #expertise. Self-guards: no-op on mobile (the mobile build owns
 * its own particle physics) or with prefers-reduced-motion. Renders only while
 * the section is on screen.
 */
import { subscribe } from "./state.js";
import { watchVisibility } from "./dom-utils.js";
import { expSmooth } from "./math-utils.js";

const TUNE = {
  count: 240,        // particles per domain
  phaseSpeed: 14,    // border "river" speed along the perimeter
  spring: 18,        // pull onto the border target
  damp: 0.84,        // velocity damping while gathered (crisp settle)
  jitter: 2.8,       // breathing along the border (px)
  baseA: 0.12,       // idle visibility (#4): field fills the screen, dense near
                     //   cards and sparse/chaotic toward the edges. 0 = invisible.
  homePull: 0.0008,  // weak idle attraction to the card centre → denser near cards
  chaos: 0.16,       // idle noise strength → spreads the tail toward the edges
  spread: 170,       // seed falloff (px) from the card centre (bigger reaches edges)
  gatherA: 0.72,     // extra brightness on the border
  baseS: 1.0, gatherS: 1.8,  // particle size: chaos -> border
  swirl: 0.5,        // tangential spiral-in strength on approach
  pulse: 0.45,       // breathing brightness while on the border
  inflate: 7,        // halo offset OUTSIDE the card edge (px)
  radius: 22         // halo corner radius (px)
};

function hexRGB(h) {
  h = String(h).trim().replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Rounded-rect perimeter walker: returns { total, at(d)->[x,y] }. */
function perim(x, y, w, h, r) {
  r = Math.max(2, Math.min(r, w / 2, h / 2));
  const sx = w - 2 * r, sy = h - 2 * r, arc = Math.PI / 2 * r;
  const segs = [
    { l: sx, p: (t) => [x + r + sx * t, y] },
    { l: arc, p: (t) => { const a = -Math.PI / 2 + t * Math.PI / 2; return [x + w - r + r * Math.cos(a), y + r + r * Math.sin(a)]; } },
    { l: sy, p: (t) => [x + w, y + r + sy * t] },
    { l: arc, p: (t) => { const a = t * Math.PI / 2; return [x + w - r + r * Math.cos(a), y + h - r + r * Math.sin(a)]; } },
    { l: sx, p: (t) => [x + w - r - sx * t, y + h] },
    { l: arc, p: (t) => { const a = Math.PI / 2 + t * Math.PI / 2; return [x + r + r * Math.cos(a), y + h - r + r * Math.sin(a)]; } },
    { l: sy, p: (t) => [x, y + h - r - sy * t] },
    { l: arc, p: (t) => { const a = Math.PI + t * Math.PI / 2; return [x + r + r * Math.cos(a), y + r + r * Math.sin(a)]; } }
  ];
  const total = segs.reduce((s, g) => s + g.l, 0);
  return { total, at(d) { d = ((d % total) + total) % total; for (const g of segs) { if (d <= g.l) return g.p(g.l ? d / g.l : 0); d -= g.l; } return segs[0].p(0); } };
}

export function initExpertiseParticles(threeCtx, data) {
  if (matchMedia("(max-width: 767px)").matches) return null;          // mobile owns its own physics
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  const section = document.getElementById("expertise");
  if (!section) return null;

  // Data-driven knobs (cv_ui.json → particle_pages.expertise) override the TUNE
  // defaults above, so the editor's Animation tab can tune the field live. Absent
  // keys keep the defaults.
  const _fc = (data && data.particle_pages && data.particle_pages.expertise) || {};
  if (_fc.field_visibility != null) TUNE.baseA = +_fc.field_visibility;
  if (_fc.field_spread != null) TUNE.spread = +_fc.field_spread;
  if (_fc.field_homePull != null) TUNE.homePull = +_fc.field_homePull;
  if (_fc.field_chaos != null) TUNE.chaos = +_fc.field_chaos;

  if (getComputedStyle(section).position === "static") section.style.position = "relative";
  const cv = document.createElement("canvas");
  cv.className = "expertise-fx";
  cv.setAttribute("aria-hidden", "true");
  const ctx = cv.getContext("2d");
  const ensureCanvas = () => { if (!cv.isConnected) section.insertBefore(cv, section.firstChild); };
  ensureCanvas();
  // #expertise.innerHTML is wiped on language re-render — re-attach if removed.
  const mo = new MutationObserver(() => ensureCanvas());
  mo.observe(section, { childList: true });

  const root = document.documentElement;
  const colorOf = (id) => getComputedStyle(root).getPropertyValue(`--c-domain-${id}`).trim() || "#9a8aff";

  const DPR = Math.min(2, window.devicePixelRatio || 1);
  let W = 0, H = 0;
  function resize() {
    W = section.clientWidth; H = section.clientHeight;
    cv.width = Math.max(1, W * DPR); cv.height = Math.max(1, H * DPR);
    cv.style.width = W + "px"; cv.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  let parts = [];
  function buildParts() {
    const cards = [...section.querySelectorAll(".expertise-card")];
    const s = section.getBoundingClientRect();
    parts = [];
    for (const el of cards) {
      const id = el.dataset.domain; if (!id) continue;
      const rgb = hexRGB(colorOf(id));
      const r = el.getBoundingClientRect();
      const cx = r.left - s.left + r.width / 2, cy = r.top - s.top + r.height / 2;
      for (let i = 0; i < TUNE.count; i++) {
        // exponential falloff from the card centre → DENSE near the card, with a
        // long sparse tail toward the section edges (#4). Clamped on-screen.
        const ang = Math.random() * Math.PI * 2;
        const dist = -Math.log(1 - Math.random() * 0.999) * TUNE.spread;
        const x = Math.max(0, Math.min(W, cx + Math.cos(ang) * dist));
        const y = Math.max(0, Math.min(H, cy + Math.sin(ang) * dist));
        parts.push({ x, y, vx: 0, vy: 0, domain: id, rgb,
          pd: Math.random(), jitter: Math.random() * Math.PI * 2, gather: 0 });
      }
    }
  }

  let mx = -1e4, my = -1e4;
  const onMove = (e) => { const r = section.getBoundingClientRect(); mx = e.clientX - r.left; my = e.clientY - r.top; };
  section.addEventListener("pointermove", onMove, { passive: true });
  section.addEventListener("pointerleave", () => { mx = -1e4; my = -1e4; }, { passive: true });

  function cardRectsLocal() {
    const s = section.getBoundingClientRect();
    return [...section.querySelectorAll(".expertise-card")].map((el) => {
      const r = el.getBoundingClientRect();
      const rx = r.left - s.left, ry = r.top - s.top;
      const hovered = mx >= rx && mx <= rx + r.width && my >= ry && my <= ry + r.height;
      const x = rx - TUNE.inflate, y = ry - TUNE.inflate, w = r.width + 2 * TUNE.inflate, h = r.height + 2 * TUNE.inflate;
      return { domain: el.dataset.domain, x, y, w, h, perim: perim(x, y, w, h, TUNE.radius), hovered,
        ccx: r.left + r.width / 2, ccy: r.top + r.height / 2 };   // client centre (for worldFromScreen)
    });
  }

  // WebGL galaxy hook: gather a hovered card's domain particles UNDER the card
  // (they slide beneath the opaque card and "vanish"), synced with the 2D halo
  // so the visible field and the halo read as ONE connected thing.
  const DOMAIN_IDX = { ai: 0, "3dxr": 1, "2dmedia": 2, dev: 3, consulting: 4 }; // matches three-scene DOMAIN_IDS
  const GATHER_MAX = 0.92;
  const N_DOM = Object.keys(DOMAIN_IDX).length;       // keep every loop in sync with the WebGL field's domain count
  const gAmt = new Array(N_DOM).fill(0);              // per-domain eased gather
  const canGather = () => !!(threeCtx && threeCtx.setDomGather && threeCtx.worldFromScreen &&
    (!threeCtx.morphEnabled || threeCtx.morphEnabled()));
  function releaseGather() { if (canGather()) for (let d = 0; d < N_DOM; d++) { gAmt[d] = 0; threeCtx.setDomGather(d, 0); } }

  let visible = false, phase = 0, last = 0, raf = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!visible || !parts.length) { last = now; return; }
    const dt = last ? Math.min(33, now - last) / 1000 : 0.016; last = now;
    phase += dt * TUNE.phaseSpeed;
    const rects = cardRectsLocal();
    const byDom = {};
    for (const r of rects) byDom[r.domain] = r;

    // gather: the hovered card's domain ramps UP (sinuous, toward/under its card)
    // while EVERY other domain ramps DOWN — so card A releases as card B starts.
    if (canGather()) {
      const hov = rects.find((r) => r.hovered);
      const hd = hov ? (DOMAIN_IDX[hov.domain] ?? -1) : -1;   // hovered domain (-1 = none)
      if (hd >= 0) {                                          // keep its target on the (moving) card
        const nx = (hov.ccx / window.innerWidth) * 2 - 1;
        const ny = -(hov.ccy / window.innerHeight) * 2 + 1;
        const wp = threeCtx.worldFromScreen(nx, ny, 0);
        threeCtx.setDomGatherPos(hd, wp.x, wp.y, wp.z);
      }
      for (let d = 0; d < N_DOM; d++) {
        const target = (d === hd) ? GATHER_MAX : 0;
        const prev = gAmt[d];
        gAmt[d] = expSmooth(gAmt[d], target, dt, 4);
        if (gAmt[d] > 0.002 || prev > 0.002) threeCtx.setDomGather(d, gAmt[d] < 0.002 ? 0 : gAmt[d]);
      }
    }

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";
    for (const p of parts) {
      const r = byDom[p.domain];
      const want = (r && r.hovered) ? 1 : 0;
      p.gather = expSmooth(p.gather, want, dt, 6);
      if (p.gather > 0.01 && r) {
        const d = (p.pd * r.perim.total + phase) % r.perim.total;
        const [tx, ty] = r.perim.at(d);
        const jx = Math.cos(p.jitter + now * 0.002) * TUNE.jitter, jy = Math.sin(p.jitter + now * 0.002) * TUNE.jitter;
        const k = TUNE.spring * p.gather;
        p.vx += ((tx + jx) - p.x) * k * dt; p.vy += ((ty + jy) - p.y) * k * dt;
        if (TUNE.swirl && p.gather > 0.08 && p.gather < 0.96) {
          const cx = r.x + r.w / 2, cy = r.y + r.h / 2, dx = p.x - cx, dy = p.y - cy, len = Math.hypot(dx, dy) || 1;
          const sw = TUNE.swirl * 70 * (1 - p.gather);
          p.vx += (-dy / len) * sw * dt; p.vy += (dx / len) * sw * dt;
        }
        p.vx *= TUNE.damp; p.vy *= TUNE.damp;
      }
      if (p.gather < 0.99) {
        // IDLE (#4): the field is VISIBLE and fills the screen. A weak homing pull
        // toward this card's centre keeps the cloud DENSER near the card, while the
        // chaotic noise spreads the tail toward the edges (sparser) — a density
        // gradient. The edge nudge stops them escaping/pooling in a corner.
        const c = 1 - p.gather;
        if (r) {
          const hx = r.x + r.w / 2, hy = r.y + r.h / 2;
          p.vx += (hx - p.x) * TUNE.homePull * c;
          p.vy += (hy - p.y) * TUNE.homePull * c;
        }
        p.vx += Math.cos(now * 0.0006 + p.jitter) * TUNE.chaos * c;
        p.vy += Math.sin(now * 0.0005 + p.jitter * 1.3) * TUNE.chaos * c;
        if (p.x < 0) p.vx += 0.08 * c; else if (p.x > W) p.vx -= 0.08 * c;
        if (p.y < 0) p.vy += 0.08 * c; else if (p.y > H) p.vy -= 0.08 * c;
        p.vx *= 0.93; p.vy *= 0.93;
      }
      p.x += p.vx; p.y += p.vy;

      let a = TUNE.baseA + TUNE.gatherA * p.gather;
      if (TUNE.pulse) a *= 1 - TUNE.pulse * 0.2 * (0.5 - 0.5 * Math.sin(now * 0.0035 + p.jitter));
      const s = TUNE.baseS + TUNE.gatherS * p.gather;
      ctx.fillStyle = `rgba(${p.rgb[0]},${p.rgb[1]},${p.rgb[2]},${a})`;
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  const io = watchVisibility(section, { rootMargin: "0px" }, (vis) => {
    visible = vis;
    if (!visible) releaseGather();   // never leave a domain collapsed off-screen
  });
  const ro = new ResizeObserver(() => { resize(); });
  ro.observe(section);
  resize();
  buildParts();
  raf = requestAnimationFrame(frame);

  // language re-render rebuilds the cards (and may change which domains exist)
  const unsub = subscribe("lang", () => setTimeout(() => { ensureCanvas(); resize(); buildParts(); }, 0));

  // Live editor hook: hot-update the field knobs WITHOUT a preview reload (mirrors
  // experience-glass's evolvedcvApplyGlass). Re-seeds only when the spread changes.
  function applyFieldCfg(c) {
    if (!c) return;
    if (c.field_visibility != null) TUNE.baseA = +c.field_visibility;
    if (c.field_homePull != null) TUNE.homePull = +c.field_homePull;
    if (c.field_chaos != null) TUNE.chaos = +c.field_chaos;
    if (c.field_spread != null && +c.field_spread !== TUNE.spread) { TUNE.spread = +c.field_spread; buildParts(); }
  }
  window.evolvedcvApplyExpertiseField = applyFieldCfg;

  return {
    dispose() {
      releaseGather();
      cancelAnimationFrame(raf);
      io.disconnect(); ro.disconnect(); mo.disconnect();
      if (typeof unsub === "function") unsub();
      section.removeEventListener("pointermove", onMove);
      cv.remove();
      if (window.evolvedcvApplyExpertiseField === applyFieldCfg) delete window.evolvedcvApplyExpertiseField;
    }
  };
}
