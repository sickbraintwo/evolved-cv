/**
 * mobile-particles.js — CPU physics particle layer for MOBILE ONLY.
 *
 * Option A of the mobile revamp: on phones we don't drive the WebGL morph cloud;
 * instead a separate Canvas-2D layer runs a real physics sim (damped springs +
 * scroll impulse + edge containment + content-box repulsion/collision). Desktop
 * is untouched — it keeps the WebGL morph.
 *
 * Recipe (locked, no UI here — it was tuned in proto/mobile-physics.html):
 *   Nome@hero → Galassia (the long middle) → Iniziali@contact, all driven by
 *   the page scroll; all four FX on (galaxy-alive, breath, trails, touch); and
 *   the dynamics switch RANDOMLY per section (never repeating the previous one,
 *   count fixed so no buffer rebuild).
 *
 * Colours come from theme.js exactly like the WebGL cloud: each particle is
 * either the base colour or tinted 0.75 toward one of the 4 domain colours
 * (ai / 3dxr / 2dmedia / dev) — so the cloud keeps the "expertise" colours.
 *
 * Handoff: the WebGL intro composes the name as usual; on the FIRST scroll this
 * layer fades in (seeded on the name) and the WebGL particles are hidden, so the
 * name stays put through the swap. Guards: mobile width + canvas2d + not
 * reduced-motion, else it does nothing (static fallback intact).
 */
import { getToken, getDomainColor } from "./theme.js";

const DOMAIN_IDS  = ["ai", "3dxr", "2dmedia", "dev"];
const SECTION_IDS = ["hero", "about", "expertise", "experience", "education", "contact"];
const COUNT = 700;          // fixed mobile count (kept constant across presets)

// Dynamics presets (no count — count stays fixed). Mirrors the prototype.
const PRESETS = {
  christina: { stiff:65, damp:0.95, impulse:16, rest:0.80, noise:75, repel:100 },
  tempesta: { stiff:65, damp:0.95, impulse:22, rest:0.85, noise:90, repel:100 },
  elegante: { stiff:35, damp:0.93, impulse:12, rest:0.55, noise:45, repel:60 },
  liquido:  { stiff:16, damp:0.97, impulse:14, rest:0.40, noise:60, repel:75 }
};
const PKEYS = ["christina", "tempesta", "elegante", "liquido"];

const REPEL_MARGIN = 52, TR = 95, TOUCH_F = 900, DT = 1 / 60;
const INTRO_DUR = 2.6;   // seconds of slow scatter→compose on mobile intro
const BOX_PAD = 10;   // small halo so particles don't graze the text
function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

export function initMobileParticles(data, sceneCtx) {
  if (!matchMedia("(max-width: 767px)").matches) return null;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return null;

  const headerEl = document.querySelector(".site-header");   // live top wall: header bottom edge
  let counterEl = document.querySelector(".hero__counters"); // hero counter → drives name↔galaxy

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return null;
  canvas.id = "mobile-particles";
  Object.assign(canvas.style, {
    // top/left (not inset:0) + an explicit px size set in sizeCanvas(): inset:0 +
    // 100vh would stretch the buffer to the LARGE viewport while the buffer is the
    // VISIBLE one, so particles drew scaled vs the DOM when the address bar showed.
    position: "fixed", top: "0", left: "0",
    zIndex: "-1",            // same plane as #bg3d but later in DOM → above it, below content
    pointerEvents: "none", opacity: "0", transition: "opacity .5s ease"
  });
  document.body.appendChild(canvas);

  // Flag the body: this 2D layer now OWNS the name on mobile, so the redundant
  // DOM hero name (.hero__kicker) is sr-only'd via CSS. Gated on this class (not
  // a bare media query) so that when this module bails — reduced-motion, no
  // canvas2d — the DOM name still shows as the proper fallback.
  document.body.classList.add("mobile-particles-on");

  /* ---- colours (base / domains) from the theme, parsed to [r,g,b] ---- */
  const parseColor = (() => {
    const oc = document.createElement("canvas").getContext("2d");
    return (str) => {
      oc.fillStyle = "#000"; oc.fillStyle = str;       // normalize
      const s = oc.fillStyle;                          // #rrggbb or rgb(...)
      if (s[0] === "#") return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
      const m = s.match(/\d+/g) || [120, 216, 255];
      return [+m[0], +m[1], +m[2]];
    };
  })();
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  let base = parseColor(getToken("--c-particle-base") || "#78d8ff");
  // The flat Canvas-2D layer has no additive glow to lift dark particles off the
  // dark page, so a dark base (e.g. #2A2347) renders the name — which is MOSTLY
  // base-coloured particles — nearly invisible. If the base reads too dark, lift
  // it toward the light text colour so the name is legible; the domain-tinted
  // accent particles (already light) stay vivid for the "expertise" colours.
  const lumOf = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  if (lumOf(base) < 140) base = mix(base, parseColor(getToken("--c-text") || "#F2F0FB"), 0.7);
  const domCols = DOMAIN_IDS.map((d) => parseColor(getDomainColor(d) || "#78d8ff"));

  /* ---- name / initials text ---- */
  const fullName = (data?.profile?.name || "Christina Debug").toString().trim();
  const words = fullName.split(/\s+/);
  const nameLines = words.length >= 2 ? [words[0].toUpperCase(), words.slice(1).join(" ").toUpperCase()] : [fullName.toUpperCase()];
  const initials = (words.map((w) => w[0]).join("") || "CD").toUpperCase().slice(0, 3);

  /* ---- state ---- */
  let W = 0, H = 0, DPR = 1, N = COUNT;
  let px, py, vx, vy, nameX, nameY, initX, initY, galX, galY, colR, colG, colB;
  let nameCx = 0, nameCy = 0, initCx = 0, initCy = 0;
  let T = 0, lastScrollY = 0, arc = 0, curSection = -1, lastPresetKey = "christina";
  let introT = -1;   // intro elapsed time (seconds); -1 = not running
  let nameBandRect = null;   // cached name-band rect; recomputed only when NOT scrolled (stable size)
  let ptrOn = false, ptrX = 0, ptrY = 0;
  const cfg = { stiff:65, damp:0.95, impulse:16, rest:0.80, noise:75, repel:100 };
  let obstacles = [], obsTick = 0, lastVpH = 0, obsForce = false;
  // Card border-radius, read LIVE (cheap: a handful of cards per recompute). NOT
  // cached: the value can differ by card state (collapsed/expanded) and isn't
  // reliably settled at first measure, so a cache locks the wrong radius.
  function cardRadius(el, w, h) {
    const r = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    return Math.min(r, w / 2, h / 2);
  }

  /* ---- text rasterization → normalized points (y down) ---- */
  function rasterText(lines, fontPx) {
    const oc = document.createElement("canvas"), o = oc.getContext("2d");
    const weight = 800, family = "Inter, Arial, sans-serif";
    o.font = `${weight} ${fontPx}px ${family}`;
    let maxW = 0; for (const t of lines) maxW = Math.max(maxW, o.measureText(t).width);
    const lineH = fontPx * 1.12, w = Math.ceil(maxW) + 8, h = Math.ceil(lineH * lines.length) + 8;
    oc.width = w; oc.height = h;
    o.font = `${weight} ${fontPx}px ${family}`; o.textBaseline = "top"; o.textAlign = "center"; o.fillStyle = "#fff";
    lines.forEach((t, i) => o.fillText(t, w / 2, 4 + i * lineH));
    const d = o.getImageData(0, 0, w, h).data, pts = [];
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if (d[(y * w + x) * 4 + 3] > 128) pts.push([x / w, y / h]);
    return { pts, aspect: w / h };
  }
  function resample(raster, n) {
    const m = raster.pts.length || 1, out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = raster.pts[Math.floor((i * m) / n) % m];
    return out;
  }
  function placeInto(norm, aspect, rect, outX, outY) {
    let rw = rect.w, rh = rw / aspect;
    if (rh > rect.h) { rh = rect.h; rw = rh * aspect; }
    const rx = rect.x + (rect.w - rw) / 2, ry = rect.y + (rect.h - rh) / 2;
    for (let i = 0; i < norm.length; i++) { outX[i] = rx + norm[i][0] * rw; outY[i] = ry + norm[i][1] * rh; }
  }

  function buildFormations() {
    N = COUNT;
    px = new Float32Array(N); py = new Float32Array(N); vx = new Float32Array(N); vy = new Float32Array(N);
    nameX = new Float32Array(N); nameY = new Float32Array(N);
    initX = new Float32Array(N); initY = new Float32Array(N);
    galX = new Float32Array(N); galY = new Float32Array(N);
    colR = new Float32Array(N); colG = new Float32Array(N); colB = new Float32Array(N);

    const nameFont = Math.max(54, Math.min(120, W * 0.20));
    const nr = rasterText(nameLines, nameFont);
    // Centre the name band in the gap between the header bottom and the hero text.
    // It must keep a STABLE size: a URL-bar show/hide fires resize→buildFormations,
    // and the sticky header is in flow (3-line pushes content down), so measuring
    // while scrolled mis-sizes the name (the "smaller on scroll back" bug). So we
    // (a) use innerBar.offsetHeight — the 1-line header height, immune to the
    // intro's translateY and to scroll — and the hero text's DOCUMENT Y, and
    // (b) only (re)compute the rect when NOT scrolled, caching it otherwise.
    if (!nameBandRect || !document.body.classList.contains("is-scrolled")) {
      const innerBar = document.querySelector(".site-header__inner");
      const hb = innerBar ? innerBar.offsetHeight : 49;                  // 1-line header height (transform-proof)
      const htEl = document.querySelector("#hero .hero__text");
      const textTop = htEl ? (htEl.getBoundingClientRect().top + (window.scrollY || 0)) : H * 0.34;
      const gapTop = hb + 8, gapBot = Math.max(gapTop + 40, textTop - 8);
      const bandH = Math.min(H * 0.22, Math.max(60, (gapBot - gapTop) * 0.78));
      const bandY = Math.max(gapTop, (gapTop + gapBot) / 2 - bandH / 2);
      nameBandRect = { x: W * 0.06, y: bandY, w: W * 0.88, h: bandH };
    }
    placeInto(resample(nr, N), nr.aspect, nameBandRect, nameX, nameY);
    const ir = rasterText([initials], 200);
    // "WP" composes in the gap between the mid-screen social row (~50% vh) and
    // the bottom footer (~83% vh at max scroll) — measured at 390x844.
    placeInto(resample(ir, N), ir.aspect, { x: W * 0.25, y: H * 0.55 + 60, w: W * 0.50, h: H * 0.26 }, initX, initY);

    for (let i = 0; i < N; i++) {
      const ang = Math.random() * 6.283, rad = Math.sqrt(Math.random());
      galX[i] = W * 0.5 + Math.cos(ang) * rad * W * 0.46;
      galY[i] = H * 0.5 + Math.sin(ang) * rad * H * 0.46;
      // colour: base, or 0.75 toward a domain colour (~30% of particles)
      const dom = Math.random() < 0.3 ? (Math.random() * 4) | 0 : -1;
      const c = dom < 0 ? base : mix(base, domCols[dom], 0.75);
      colR[i] = c[0] | 0; colG[i] = c[1] | 0; colB[i] = c[2] | 0;
    }
    let nsx = 0, nsy = 0, isx = 0, isy = 0;
    for (let i = 0; i < N; i++) { nsx += nameX[i]; nsy += nameY[i]; isx += initX[i]; isy += initY[i]; }
    nameCx = nsx / N; nameCy = nsy / N; initCx = isx / N; initCy = isy / N;
    // seed on the name (matches the WebGL intro position at handoff)
    for (let i = 0; i < N; i++) { px[i] = nameX[i]; py[i] = nameY[i]; vx[i] = vy[i] = 0; }
  }

  // Size the canvas to the VISIBLE (visual) viewport, in explicit px. Using the
  // visualViewport dimensions (not 100vw/100vh, which track the LARGE viewport)
  // keeps the drawing buffer 1:1 with the displayed box, so particles never draw
  // scaled vs the DOM while the mobile address bar is showing. Cheap: no formation
  // rebuild — safe to call on every visualViewport resize during the bar animation.
  function sizeCanvas() {
    const vv = window.visualViewport;
    W = Math.round(vv ? vv.width : window.innerWidth);
    H = Math.round(vv ? vv.height : window.innerHeight);
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function resize() {
    sizeCanvas();
    buildFormations();   // re-place the name/galaxy/initials targets for the new size
  }

  /* ---- content-box obstacles: union rect of each on-screen section's content ---- */
  function computeObstacles() {
    const out = [];
    for (const id of SECTION_IDS) {
      const el = document.getElementById(id);
      if (!el) continue;

      // CHANGE C: contact box wraps the FORM ONLY (not the social row).
      // We measure the form element top-to-(button-bottom + gap) so particles
      // clear the input area but flow freely around the social icon row.
      if (id === "contact") {
        const form   = el.querySelector(".contact-form");
        const button = el.querySelector(".contact-form__submit");
        const ta     = el.querySelector("#cf-message");
        if (form && button && ta) {
          const fr = form.getBoundingClientRect();
          const br = button.getBoundingClientRect();
          const tr = ta.getBoundingClientRect();
          if (fr.bottom > 0 && fr.top < H) {             // form on-screen
            const G    = br.top - tr.bottom;              // gap: textarea-bottom → button-top
            const top  = fr.top    - BOX_PAD;
            const bot  = br.bottom + Math.max(0, G);      // extend by same gap below button
            const xl   = fr.left   - BOX_PAD;
            const xr   = fr.right  + BOX_PAD;
            out.push({ x: Math.max(0, xl), y: top, _dy: top + (window.scrollY || 0), w: xr - xl, h: bot - top, r: 0 });
          }
        }
        continue;
      }

      // Hero: measure the TEXT block only (.hero__text). Its .hero__inner wrapper
      // carries a 48vh top padding, so the wrapper's rect starts at the top of the
      // screen and would swallow the particle-name band above — pushing the name
      // particles out to the edges. The text block sits in the lower half (role /
      // sub / meta / counters) which is the real box to react to.
      const host = id === "hero" ? (el.querySelector(".hero__text") || el) : el;
      const hr = host.getBoundingClientRect();
      if (hr.bottom < 0 || hr.top > H) continue;       // off-screen
      let top = Infinity, bot = -Infinity, l = Infinity, r = -Infinity, hasPlain = false;
      for (const c of host.children) {
        // (display:none children have a 0×0 rect → dropped by the size check below;
        //  no getComputedStyle, so this stays cheap enough to run EVERY frame.)
        // Exclude the section heading: the obstacle aligns to the CONTENT block
        // ("banner" + body) only, never the title (req 2026-06-21). The sr-only
        // hero name (.hero__kicker, ~1px) is dropped by the size check below.
        if (c.tagName === "H2" || (c.classList && c.classList.contains("section-title"))) continue;
        const cr = c.getBoundingClientRect();
        if (cr.height < 4 || cr.width < 4) continue;
        // A grid/list of cards → ONE obstacle PER CARD (particles weave through the
        // gaps BETWEEN cards, not just around the whole block), boxed exactly on
        // each card's edges (pad 0). _dy = box top's DOCUMENT Y (corner-anchored).
        const useCards = /\b(grid|list)\b/.test((c.className || "") + "") && c.children.length >= 2;
        if (useCards) {
          for (const it of c.children) {
            const ir = it.getBoundingClientRect();
            if (ir.height < 4 || ir.width < 4) continue;
            // Tie the obstacle's corner rounding to the card's own border-radius so
            // the particle field hugs the card shape (no sharp-cornered exclusion
            // around a rounded card). Clamped to half the smaller side.
            const rad = cardRadius(it, ir.width, ir.height);
            // Keep a reference to the card element: its box is re-read LIVE every
            // frame (below) so it can never drift from the card — the _dy/scrollY
            // reconstruction desynced during the mobile address-bar reveal.
            out.push({ el: it, x: Math.max(0, ir.left), y: ir.top, _dy: ir.top + (window.scrollY || 0), w: ir.width, h: ir.height, r: rad });
          }
        } else {
          // Plain content (hero text lines, about summary) stays ONE union box so
          // the name band / paragraph isn't shattered into many tiny obstacles.
          hasPlain = true;
          top = Math.min(top, cr.top); bot = Math.max(bot, cr.bottom);
          l = Math.min(l, cr.left); r = Math.max(r, cr.right);
        }
      }
      // Plain content keeps a small halo so particles don't graze the letters.
      if (hasPlain && isFinite(top)) out.push({
        x: Math.max(0, l - BOX_PAD),
        y: top - BOX_PAD,
        _dy: (top - BOX_PAD) + (window.scrollY || 0),
        w: (r - l) + 2 * BOX_PAD,
        h: (bot - top) + 2 * BOX_PAD,
        r: 0
      });
    }

    // The mobile Filters control is a solid obstacle the galaxy particles bounce
    // off. It has TWO shapes depending on state, and we add whichever is on-screen:
    //   • panel CLOSED → the small fixed FAB pill near the bottom edge;
    //   • panel OPEN   → the whole bottom filter sheet (#filter-overlay), so the
    //     particles pile on/above its TOP edge in the transparent L0 area above it.
    // Each is an el:box (rect re-read LIVE every frame → glued through the
    // address-bar reveal). Both are gated on REAL state (not just the rect): the
    // hidden FAB still occupies its fixed box (visibility:hidden, not
    // display:none), so boxing it blindly would wall off hero/contact.
    const panelOpen = document.body.classList.contains("mode-filter");
    const overlay = document.getElementById("filter-overlay");
    if (panelOpen && overlay && !overlay.hidden) {
      const orr = overlay.getBoundingClientRect();
      if (orr.width > 4 && orr.height > 4 && orr.bottom > 0 && orr.top < H) {
        const rad = cardRadius(overlay, orr.width, orr.height);
        out.push({ el: overlay, x: Math.max(0, orr.left), y: orr.top, _dy: orr.top + (window.scrollY || 0), w: orr.width, h: orr.height, r: rad });
      }
    } else {
      const fab = document.getElementById("filter-fab");
      if (fab && document.body.classList.contains("in-experience") && !fab.classList.contains("is-open")) {
        const fr = fab.getBoundingClientRect();
        if (fr.width > 4 && fr.height > 4 && fr.bottom > 0 && fr.top < H) {
          const rad = cardRadius(fab, fr.width, fr.height);
          out.push({ el: fab, x: Math.max(0, fr.left), y: fr.top, _dy: fr.top + (window.scrollY || 0), w: fr.width, h: fr.height, r: rad });
        }
      }
    }
    return out;
  }

  /* ---- random preset per section (dynamics only) ---- */
  function pickRandomPreset() {
    let k; do { k = PKEYS[(Math.random() * PKEYS.length) | 0]; } while (k === lastPresetKey);
    lastPresetKey = k; Object.assign(cfg, PRESETS[k]);
  }
  function currentSectionIndex() {
    const mid = H * 0.5;
    for (let s = 0; s < SECTION_IDS.length; s++) {
      const el = document.getElementById(SECTION_IDS[s]);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) return s;
    }
    return curSection < 0 ? 0 : curSection;
  }

  function collideBox(i, b, rest) {
    const x = px[i], y = py[i];
    if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) return; // outside the AABB
    const r = b.r || 0;
    if (r > 0.5) {
      // Rounded corners: in a corner quadrant the wall is the ARC (radius r) around
      // the corner centre, so particles may occupy the gap OUTSIDE the rounded card
      // corner (the box corner triangle), matching the card's smoothed edge.
      const cxC = (x < b.x + r) ? b.x + r : (x > b.x + b.w - r) ? b.x + b.w - r : null;
      const cyC = (y < b.y + r) ? b.y + r : (y > b.y + b.h - r) ? b.y + b.h - r : null;
      if (cxC !== null && cyC !== null) {
        const dx = x - cxC, dy = y - cyC, d = Math.sqrt(dx * dx + dy * dy);
        if (d >= r) return;                       // in the corner gap → not inside the card
        const nx = d > 1e-3 ? dx / d : 1, ny = d > 1e-3 ? dy / d : 0;
        px[i] = cxC + nx * r; py[i] = cyC + ny * r;
        const vn = vx[i] * nx + vy[i] * ny;       // reflect velocity along the arc normal
        vx[i] -= (1 + rest) * vn * nx; vy[i] -= (1 + rest) * vn * ny;
        return;
      }
    }
    // Straight edge bands (or no radius): push out to the nearest flat edge.
    const dl = x - b.x, dr = b.x + b.w - x, dt = y - b.y, db = b.y + b.h - y, m = Math.min(dl, dr, dt, db);
    if (m === dl)      { px[i] = b.x;        vx[i] = -Math.abs(vx[i]) * rest; }
    else if (m === dr) { px[i] = b.x + b.w;  vx[i] =  Math.abs(vx[i]) * rest; }
    else if (m === dt) { py[i] = b.y;        vy[i] = -Math.abs(vy[i]) * rest; }
    else               { py[i] = b.y + b.h;  vy[i] =  Math.abs(vy[i]) * rest; }
  }

  function step() {
    // Header bottom is the live TOP wall: header is position:sticky so rect.bottom = its rendered height.
    const topWall = headerEl ? Math.max(0, headerEl.getBoundingClientRect().bottom) : 0;
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - H);
    const scrollY = window.scrollY || window.pageYOffset || 0;
    arc = Math.min(1, Math.max(0, scrollY / maxScroll));
    const rawVel = scrollY - lastScrollY; lastScrollY = scrollY;

    const sec = currentSectionIndex();
    if (sec !== curSection) { curSection = sec; pickRandomPreset(); }

    // Obstacle boxes are ANCHORED to the content's corners (req): re-measure the
    // corners only every few frames (cheap), but EVERY frame re-derive each box's
    // viewport Y from its stored DOCUMENT Y minus the live scroll — so the box stays
    // glued to its element with zero lag, without reading the DOM rects every frame.
    // Recompute the corner anchors every few frames (cheap) OR immediately when the
    // viewport HEIGHT changes: the mobile address bar showing/hiding on up/down
    // scroll shifts every card's on-screen position, and a cached _dy box would lag
    // behind by the bar's height — a visible drift, worst going UP where the bar
    // re-appears gradually through the whole gesture. Recomputing on the change
    // keeps the boxes glued to their cards in both directions.
    const vpChanged = Math.abs(H - lastVpH) > 0.5; lastVpH = H;
    if (vpChanged || obsForce || (obsTick % 6) === 0) { obstacles = computeObstacles(); obsForce = false; }
    obsTick++;
    // Re-place each box for the live scroll. Card boxes carry their element and are
    // re-read from the LIVE rect every frame — immune to the mobile address-bar
    // reveal (which shifts the cards but not a cached document-Y). Union boxes
    // (hero/about/contact) have no single element, so they use the _dy anchor.
    // The canvas is sized to the visible viewport and pinned at top:0, which lines
    // up 1:1 with getBoundingClientRect here — so NO visual-viewport offset is
    // subtracted (doing so added a small transient drift while the bar animated).
    for (let b = 0; b < obstacles.length; b++) {
      const o = obstacles[b];
      if (o.el) { const cr = o.el.getBoundingClientRect(); o.x = Math.max(0, cr.left); o.y = cr.top; o.w = cr.width; o.h = cr.height; }
      else o.y = o._dy - scrollY;
    }

    // name↔galaxy is tied to the hero COUNTER vs the header (not a raw scroll fraction):
    // the name holds while the counter is below the header; it melts to galaxy as the
    // counter goes UNDER the header, and re-forms the name when it scrolls back down.
    if (!counterEl) counterEl = document.querySelector(".hero__counters");
    const cTop = counterEl ? counterEl.getBoundingClientRect().top : Infinity;
    const nameW = smoothstep(topWall, topWall + 150, cTop);
    const initW = smoothstep(0.86, 1.00, arc);
    const galW  = Math.max(0, 1 - nameW - initW);

    // Advance / expire the intro slow-compose timer.
    if (introT >= 0) { introT += DT; if (introT > INTRO_DUR) introT = -1; }
    const inIntro = introT >= 0;

    // The name and the initials are the two READABLE set-pieces: when the target
    // is one of them (shapeW→1) firm the spring up and add friction so the shape
    // assembles crisply and SETTLES, instead of staying a loose cloud. The galaxy
    // middle (shapeW→0) keeps the soft, playful per-section preset dynamics.
    // During the intro window we override k/damp with a gentle glide so users
    // see particles drift in across ~2.6s, then normal firm-up resumes.
    const shapeW = Math.max(nameW, initW);
    // Obstacles stay ON through the whole scroll and release ONLY at the very ENDS —
    // the top (where the name completes) and the bottom (where the initials do) — i.e.
    // once the user has nowhere left to scroll. Otherwise particles returning to a
    // shape stay trapped UNDER a content box (e.g. the Home block). Also off in intro.
    const atTop = scrollY < 4, atBottom = scrollY > maxScroll - 4;
    const obstaclesOn = !inIntro && !atTop && !atBottom;
    let k, damp;
    if (inIntro) { k = 22; damp = 0.92; }
    else { k = cfg.stiff + (110 - cfg.stiff) * shapeW; damp = cfg.damp + (0.88 - cfg.damp) * shapeW; }
    const rest = cfg.rest, noiseAmt = cfg.noise / 100;
    const imp = -rawVel * cfg.impulse;
    // suppress scroll impulse during intro so the compose isn't disturbed
    const hasImpulse = !inIntro && Math.abs(rawVel) > 0.5;
    const repelF = cfg.repel * 7;

    T += DT;
    const cx = W / 2, cy = H / 2;
    const breath = 1 + 0.05 * Math.sin(T * 1.3);             // FX: breath (always on)
    const ga = T * 0.06, gc = Math.cos(ga), gs = Math.sin(ga); // FX: galaxy alive
    const touchOn = ptrOn;                                    // FX: touch

    for (let i = 0; i < N; i++) {
      let nx = nameCx + (nameX[i] - nameCx) * breath, ny = nameCy + (nameY[i] - nameCy) * breath;
      let ixp = initCx + (initX[i] - initCx) * breath, iyp = initCy + (initY[i] - initCy) * breath;
      let gx = galX[i], gy = galY[i];
      const rx = gx - cx, ry = gy - cy;
      gx = cx + rx * gc - ry * gs + Math.sin(T * 0.5 + i) * 7;
      gy = cy + rx * gs + ry * gc + Math.cos(T * 0.4 + i * 1.3) * 7;

      const tx = nx * nameW + gx * galW + ixp * initW;
      const ty = ny * nameW + gy * galW + iyp * initW;

      vx[i] = (vx[i] + k * (tx - px[i]) * DT) * damp;
      vy[i] = (vy[i] + k * (ty - py[i]) * DT) * damp;

      if (hasImpulse) {
        vy[i] += imp * (0.6 + Math.random() * 0.8);
        vx[i] += (Math.random() - 0.5) * Math.abs(imp) * noiseAmt * 2;
        vy[i] += (Math.random() - 0.5) * Math.abs(imp) * noiseAmt;
      }
      if (touchOn) {
        const dx = px[i] - ptrX, dy = py[i] - ptrY, d2 = dx * dx + dy * dy;
        if (d2 < TR * TR) { const d = Math.sqrt(d2) || 1, f = TOUCH_F * (1 - d / TR); vx[i] += (dx / d) * f * DT; vy[i] += (dy / d) * f * DT; }
      }
      // box repulsion halo — only while obstacles are ON (galaxy middle); off during
      // the intro and while a shape forms, so the gather/return flows cleanly.
      if (obstaclesOn) for (let b = 0; b < obstacles.length; b++) {
        const bx = obstacles[b];
        let nX = Math.max(bx.x, Math.min(px[i], bx.x + bx.w)), nY = Math.max(bx.y, Math.min(py[i], bx.y + bx.h));
        // Round the nearest-point at the corners too, so the soft repulsion halo
        // follows the same arc as the hard wall (consistent rounded silhouette).
        const br = bx.r || 0;
        if (br > 0.5) {
          const ccx = (px[i] < bx.x + br) ? bx.x + br : (px[i] > bx.x + bx.w - br) ? bx.x + bx.w - br : null;
          const ccy = (py[i] < bx.y + br) ? bx.y + br : (py[i] > bx.y + bx.h - br) ? bx.y + bx.h - br : null;
          if (ccx !== null && ccy !== null) {
            const ex = px[i] - ccx, ey = py[i] - ccy, ed = Math.sqrt(ex * ex + ey * ey) || 1;
            nX = ccx + (ex / ed) * br; nY = ccy + (ey / ed) * br;
          }
        }
        const dx = px[i] - nX, dy = py[i] - nY, d2 = dx * dx + dy * dy;
        if (repelF > 0 && d2 > 0.01 && d2 < REPEL_MARGIN * REPEL_MARGIN) {
          const d = Math.sqrt(d2), f = repelF * (1 - d / REPEL_MARGIN);
          vx[i] += (dx / d) * f * DT; vy[i] += (dy / d) * f * DT;
        }
      }

      px[i] += vx[i] * DT; py[i] += vy[i] * DT;

      if (obstaclesOn) for (let b = 0; b < obstacles.length; b++) collideBox(i, obstacles[b], rest);   // hard, before edges (off while a shape forms)
      const r = 1.5;
      if (px[i] < r) { px[i] = r; vx[i] = -vx[i] * rest; } else if (px[i] > W - r) { px[i] = W - r; vx[i] = -vx[i] * rest; }
      // TOP wall = header bottom edge (live; position:sticky so rect.bottom = header height in viewport coords).
      // Clamp ≥ 0 so a hidden/translated header yields 0 (no wall above viewport).
      if (py[i] < topWall + r) { py[i] = topWall + r; vy[i] = -vy[i] * rest; } else if (py[i] > H - r) { py[i] = H - r; vy[i] = -vy[i] * rest; }
    }
  }

  function draw() {
    // trails (always on): fade previous frame; source-over keeps the colours
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(10,11,16,0.22)"; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < N; i++) {
      ctx.fillStyle = `rgba(${colR[i]},${colG[i]},${colB[i]},.9)`;
      ctx.beginPath(); ctx.arc(px[i], py[i], 1.7, 0, 6.283); ctx.fill();
    }
  }

  /* ---- run loop (only while active) ---- */
  let raf = 0, running = false;
  function loop() { step(); draw(); raf = requestAnimationFrame(loop); }

  /* ---- activation / handoff ---- */
  let activated = false;
  // intro=true: low-tier path — WebGL never ran, so the 2D layer owns the
  //   intro: after resize() seeds particles AT the name, re-scatter them so
  //   the spring composes the name into view (scatter → compose animation).
  // intro=false: mid/high-tier path — WebGL already ran the deflagration,
  //   the 2D layer seeds at the name for a seamless WebGL→2D handoff.
  function activate(intro) {
    if (activated) return; activated = true;
    resize();                                  // (re)seed on the name at current size
    if (intro) {
      // scatter every particle to a random screen position so the spring
      // assembles the name visibly (low tier owns the intro)
      for (let i = 0; i < N; i++) { px[i] = Math.random() * W; py[i] = Math.random() * H; vx[i] = vy[i] = 0; }
      introT = 0;   // start slow-compose timer
    }
    canvas.style.opacity = "1";                // fade the 2D layer in
    running = true; raf = requestAnimationFrame(loop);
    // hide the WebGL particles AFTER the fade so the name never gaps
    if (sceneCtx && sceneCtx.setParticlesVisible) setTimeout(() => sceneCtx.setParticlesVisible(false), 500);
  }

  // OPTION B handoff: the deflagration fires "evolvedcv:compose-handoff" exactly
  // at the "compose" label (mid/high tier) so the 2D layer takes over the name
  // gathering while the WebGL cloud stays exploded. On low tier / no-3d (no
  // deflagration) the fallback "evolvedcv:intro-done" fires instead. Both call
  // activate(true) — the activated guard makes the second event a no-op.
  const onHandoff = () => activate(true);
  window.addEventListener("evolvedcv:compose-handoff", onHandoff, { once: true });
  window.addEventListener("evolvedcv:intro-done",      onHandoff, { once: true });

  /* ---- listeners ---- */
  const onResize = () => { if (activated) resize(); };
  window.addEventListener("resize", onResize, { passive: true });
  window.addEventListener("orientationchange", () => setTimeout(onResize, 200));
  // Address-bar reveal can change ONLY the visual viewport (innerHeight stays put)
  // on some mobile browsers. On a visual-viewport RESIZE, re-fit the canvas buffer
  // to the new visible size (cheap, no formation rebuild → no jank). On a SCROLL of
  // the visual viewport (offset change), just force an obstacle list refresh — the
  // per-frame placement already reads the live offset. `H` detector covers browsers
  // that resize innerHeight instead.
  const onVVResize = () => { if (activated) sizeCanvas(); obsForce = true; };
  const onVVScroll = () => { obsForce = true; };
  const vv = window.visualViewport;
  if (vv) { vv.addEventListener("resize", onVVResize, { passive: true }); vv.addEventListener("scroll", onVVScroll, { passive: true }); }
  const onMove = (e) => { ptrOn = true; ptrX = e.clientX; ptrY = e.clientY; };
  const offPtr = () => { ptrOn = false; };
  window.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("pointerdown", onMove, { passive: true });
  window.addEventListener("pointerup", offPtr, { passive: true });
  window.addEventListener("touchend", offPtr, { passive: true });

  // size now (so the canvas is correct even before activation)
  resize();

  return {
    activate,
    dispose() {
      if (raf) cancelAnimationFrame(raf); running = false;
      window.removeEventListener("resize", onResize);
      if (vv) { vv.removeEventListener("resize", onVVResize); vv.removeEventListener("scroll", onVVScroll); }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onMove);
      window.removeEventListener("pointerup", offPtr);
      window.removeEventListener("touchend", offPtr);
      window.removeEventListener("evolvedcv:compose-handoff", onHandoff);
      window.removeEventListener("evolvedcv:intro-done",      onHandoff);
      canvas.remove();
      document.body.classList.remove("mobile-particles-on");
      if (sceneCtx && sceneCtx.setParticlesVisible) sceneCtx.setParticlesVisible(true);
    }
  };
}
