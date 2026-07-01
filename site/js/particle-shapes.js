/**
 * particle-shapes.js — per-scene morph director for the shared particle system.
 *
 * Each scene asks the ONE particle cloud (owned by three-scene.js) to gather
 * into a distinct silhouette. The cloud is never duplicated: this module only
 * fills the morph target buffers (aTargetA / aTargetB) and animates uMorph,
 * exactly like hero-deflagration does for the intro name.
 *
 * Morph engine recap (three-scene BG_VERT):
 *   uMorph 0      → galaxy "home"          (the ambient field)
 *   uMorph 0..1   → mix(home, aTargetA)
 *   uMorph 1..2   → mix(aTargetA, aTargetB)
 * So at any moment exactly ONE of the two target slots is "revealed":
 *   level 1 → slot A, level 2 → slot B, level 0 → galaxy.
 *
 * Ping-pong: to show a new silhouette we fill the slot we are about to reveal
 * (the one NOT currently shown) and tween uMorph toward its level. This lets us
 * chain any number of shapes (name → frame → edges → … ) with a continuous
 * GPU-side interpolation and only two buffers. Galaxy (pills / experience) is
 * the rest state and resets the chain (next shape always re-enters via slot A).
 *
 * Scene → shape map (ids match scene-nav):
 *   hero        → the name silhouette (matches the intro)
 *   about       → a rounded "frame" outline around the content
 *   expertise   → a frame hugging the cards block (centre cleared for cards)
 *   experience  → galaxy
 *   education   → a ringed planet (the "surprise")
 *   contact     → the initials (W P) tucked bottom-right
 *
 * Guards: returns null when the morph engine is unavailable (low tier /
 * reduced-motion / no WebGL) so scene-nav falls back to its legacy melt.
 */
import { sampleTextToTargets } from "./text-sampler.js";

/**
 * Scale a particle buffer's points around the screen centre by (sx, sy) and
 * offset them by the screen-space vector (ox, oy), expressed in normalized
 * [-1,1] screen coords. `worldAt(nx, ny)` maps a normalized screen point to a
 * world position ({x, y}). No-op for the identity transform. Shared by this
 * module's per-page morph and hero-deflagration's intro-name composition (which
 * used a byte-identical loop).
 */
export function applyScreenTransform(arr, count, sx, sy, ox, oy, worldAt) {
  if (sx === 1 && sy === 1 && !ox && !oy) return;
  const c = worldAt(0, 0);     // world point at screen centre
  const o = worldAt(ox, oy);   // world point at the requested screen offset
  const dx = o.x - c.x, dy = o.y - c.y;
  for (let i = 0; i < count; i++) {
    const ix = i * 3;
    arr[ix]     = c.x + (arr[ix]     - c.x) * sx + dx;
    arr[ix + 1] = c.y + (arr[ix + 1] - c.y) * sy + dy;
  }
}

export function initParticleShapes(data, sceneCtx) {
  if (!sceneCtx || !sceneCtx.morphEnabled || !sceneCtx.morphEnabled()) return null;

  const isMobile = window.matchMedia("(max-width: 767px)").matches;
  const name = (data?.profile?.name || "Christina Debug").toString();
  const initials = name.trim().split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(0, 3) || "CD";

  // WebGL Expertise field knobs (data-driven; tunable live in the editor). Mutable
  // so the live hook can retune them without a reload. See cardsFrame() for use.
  const _num = (v, d) => (v == null || v === "" || Number.isNaN(+v)) ? d : +v;
  const _ef = (data && data.particle_pages && data.particle_pages.expertise) || {};
  const _expField = {
    reach:   _num(_ef.field_reach, 0.9),     // outward spread (low = tight frame, high = fills to edges)
    conc:    _num(_ef.field_conc, 1.0),      // density gradient: high = denser on the cards
    outBias: _num(_ef.field_outbias, 0.85),  // fraction flung OUTWARD into the margins (vs hugging)
    depth:   _num(_ef.field_depth, 0.7),     // z-scatter (flat plane ↔ deep cloud)
    jitter:  _num(_ef.field_jitter, 0.01)    // positional noise (crisp ↔ fuzzy)
  };
  // About "frame" knobs (data-driven; tunable live). thickness = stroke band width
  // in NDC; offset = gap between the text box and the inner edge of the frame
  // (viewport fraction, used as padding when measuring the box). See rectFrame().
  const _ab = (data && data.particle_pages && data.particle_pages.about) || {};
  const _aboutFrame = {
    thickness: _num(_ab.frame_thickness, 0.016),
    offsetX:   _num(_ab.frame_offset_x, _num(_ab.frame_offset, 0.05)),  // gap X (back-compat: old single frame_offset)
    offsetY:   _num(_ab.frame_offset_y, _num(_ab.frame_offset, 0.05)),  // gap Y
    corner:    _num(_ab.frame_corner, 0.7)     // corner radius as a fraction of the shorter box half-side
  };

  /* ---- pixel→world mapping (same basis hero-deflagration uses) ---- */
  function mapPixelToWorld(px, py, W, H) {
    const nx = (px / W) * 2 - 1;
    const ny = -((py / H) * 2 - 1);
    const w = sceneCtx.worldFromScreen(nx, ny, 0);
    return { x: w.x, y: w.y, z: w.z };
  }
  // world point on the z=0 slab for a normalized screen coord (x,y in [-1,1], y up)
  function pt(nx, ny) { return sceneCtx.worldFromScreen(nx, ny, 0); }

  /* ============================ shape generators ====================== */
  // Every generator writes count*3 floats into `arr` (world coords on/near z=0).

  /** Text silhouette (name / initials) via the shared rasterizer. */
  function textShape(text, opts) {
    return (arr, count) => {
      arr.set(sampleTextToTargets(text, { count, mapPixelToWorld, ...opts }));
    };
  }

  // Normalized-screen Y offset that equals `cm` real centimetres (1cm ≈ 37.8 CSS
  // px; the [-1,1] Y span covers innerHeight, so 1 unit = innerHeight/2 px).
  function cmToNdcY(cm) { return (cm * 37.795 * 2) / Math.max(1, window.innerHeight); }

  /**
   * Resting-position normalized rect of the actual About text box (the section
   * title + the summary paragraph, unioned). The box scrolls into place WHILE
   * the morph animates, so the live rect is shifted by (scrollNow − restScroll)
   * to the spot it will occupy at rest. Returns {cx,cy,hw,hh} in [-1,1] space,
   * or null when the elements aren't measurable yet.
   */
  // Screen-Y shift that maps a LIVE client rect to its resting position: the
  // incoming scene scrolls into place WHILE the morph animates, so a DOM-anchored
  // shape must target where the box will SETTLE (sub-bar expanded), exactly like
  // scene-nav's sceneScrollTop — not its mid-transition spot.
  function restShiftPx() {
    const subEl = document.querySelector(".site-subbar");
    const liveSub = subEl ? subEl.getBoundingClientRect().height : 0;
    const si = document.querySelector(".site-subbar__inner");
    const steadySub = (document.body.classList.contains("is-scrolled") && si)
      ? si.getBoundingClientRect().height : 0;
    return window.scrollY - _restScroll + (steadySub - liveSub);
  }

  /** Union client rect of `els` → resting normalized rect {cx,cy,hw,hh} in
   *  [-1,1] (y up), padded by (padXFrac,padYFrac) of the viewport. null when
   *  nothing is measurable yet. */
  function boxNdc(els, padXFrac, padYFrac) {
    let top = Infinity, bottom = -Infinity, leftX = Infinity, rightX = -Infinity;
    for (const e of els) {
      if (!e) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom);
      leftX = Math.min(leftX, r.left); rightX = Math.max(rightX, r.right);
    }
    if (!isFinite(top)) return null;
    const shift = restShiftPx();
    top += shift; bottom += shift;
    const padX = innerWidth * padXFrac, padY = innerHeight * padYFrac;
    leftX -= padX; rightX += padX; top -= padY; bottom += padY;
    const nl = (leftX / innerWidth) * 2 - 1, nr = (rightX / innerWidth) * 2 - 1;
    const nt = -((top / innerHeight) * 2 - 1), nb = -((bottom / innerHeight) * 2 - 1);
    return { cx: (nl + nr) / 2, cy: (nt + nb) / 2, hw: (nr - nl) / 2, hh: (nt - nb) / 2 };
  }

  function aboutBoxNdc() {
    const about = document.getElementById("about");
    if (!about) return null;
    // gap text-box → inner frame edge, independent per axis
    return boxNdc([about.querySelector(".section-title"), about.querySelector(".about__summary")], _aboutFrame.offsetX, _aboutFrame.offsetY);
  }

  /** Resting normalized rect of the WHOLE Expertise cards block (union of every
   *  .expertise-card). The full-viewport galaxy can frame this on all four sides
   *  because the block leaves dark margins L/R — unlike the section-clipped 2D
   *  canvas, which is exactly block-width and has no outer room. */
  function expertiseBlockNdc() {
    const sec = document.getElementById("expertise");
    if (!sec) return null;
    return boxNdc([...sec.querySelectorAll(".expertise-card")], 0.012, 0.022);
  }

  /** Distribute `count` particles along a rounded-rectangle OUTLINE at (cx,cy). */
  function sampleRoundedRect(arr, count, cx, cy, hw, hh, rx, ry, thick = 0.016) {
    const straightX = 2 * Math.max(0, hw - rx);
    const straightY = 2 * Math.max(0, hh - ry);
    const arc = (Math.PI / 2) * (rx + ry) / 2;
    const segLen = [straightX, arc, straightY, arc, straightX, arc, straightY, arc];
    const total = segLen.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < count; i++) {
      let d = ((i + 0.5) / count) * total;
      let s = 0; while (s < 7 && d > segLen[s]) { d -= segLen[s]; s++; }
      const f = d / (segLen[s] || 1);
      let nx, ny;
      switch (s) {
        case 0: nx = -(hw - rx) + f * straightX; ny = hh; break;                   // top edge →
        case 1: { const a = f * Math.PI / 2; nx = (hw - rx) + Math.sin(a) * rx; ny = (hh - ry) + Math.cos(a) * ry; break; } // TR
        case 2: nx = hw; ny = (hh - ry) - f * straightY; break;                    // right edge ↓
        case 3: { const a = f * Math.PI / 2; nx = (hw - rx) + Math.cos(a) * rx; ny = -(hh - ry) - Math.sin(a) * ry; break; } // BR
        case 4: nx = (hw - rx) - f * straightX; ny = -hh; break;                   // bottom edge ←
        case 5: { const a = f * Math.PI / 2; nx = -(hw - rx) - Math.sin(a) * rx; ny = -(hh - ry) - Math.cos(a) * ry; break; } // BL
        case 6: nx = -hw; ny = -(hh - ry) + f * straightY; break;                  // left edge ↑
        default: { const a = f * Math.PI / 2; nx = -(hw - rx) - Math.cos(a) * rx; ny = (hh - ry) + Math.sin(a) * ry; break; } // TL
      }
      nx += cx + (Math.random() - 0.5) * thick;   // stroke band width (data-driven)
      ny += cy + (Math.random() - 0.5) * thick;
      const w = pt(nx, ny);
      arr[i * 3] = w.x; arr[i * 3 + 1] = w.y; arr[i * 3 + 2] = (Math.random() - 0.5) * 0.6;
    }
  }

  /** Rounded-rectangle OUTLINE wrapping the ACTUAL About text box (about). */
  function rectFrame(arr, count) {
    const box = aboutBoxNdc();
    const cx = box ? box.cx : 0;
    const cy = box ? box.cy : -cmToNdcY(1);
    const hw = box ? Math.max(0.2, box.hw) : 0.64;
    const hh = box ? Math.max(0.15, box.hh) : 0.46;
    // CIRCULAR corners: NDC is anisotropic (1 X-unit = ½ viewport width, 1 Y-unit
    // = ½ viewport height), so equal rx/ry in NDC would look squashed ("stretched
    // square") on a wide box. Pick ONE radius in screen PIXELS from the shorter box
    // side, then convert back per-axis → the two arcs share the same pixel radius.
    const hwPx = hw * innerWidth / 2, hhPx = hh * innerHeight / 2;
    const rPx = Math.min(hwPx, hhPx) * _aboutFrame.corner;
    const rx = rPx / (innerWidth / 2);
    const ry = rPx / (innerHeight / 2);
    sampleRoundedRect(arr, count, cx, cy, hw, hh, rx, ry, _aboutFrame.thickness);
  }

  /** Point + outward unit normal on a CENTERED rounded rect, at an even (jittered)
   *  spread index. Used to grow a fading band away from the border. */
  function rrPointNormal(i, count, hw, hh, rx, ry) {
    const straightX = 2 * Math.max(0, hw - rx);
    const straightY = 2 * Math.max(0, hh - ry);
    const arc = (Math.PI / 2) * (rx + ry) / 2;
    const segLen = [straightX, arc, straightY, arc, straightX, arc, straightY, arc];
    const total = segLen.reduce((a, b) => a + b, 0) || 1;
    let d = ((i + Math.random()) / count) * total;
    let s = 0; while (s < 7 && d > segLen[s]) { d -= segLen[s]; s++; }
    const f = d / (segLen[s] || 1);
    let nx, ny, mx, my;
    switch (s) {
      case 0: nx = -(hw - rx) + f * straightX; ny = hh; mx = 0; my = 1; break;                                              // top
      case 1: { const a = f * Math.PI / 2; nx = (hw - rx) + Math.sin(a) * rx; ny = (hh - ry) + Math.cos(a) * ry; mx = Math.sin(a); my = Math.cos(a); break; } // TR
      case 2: nx = hw; ny = (hh - ry) - f * straightY; mx = 1; my = 0; break;                                                // right
      case 3: { const a = f * Math.PI / 2; nx = (hw - rx) + Math.cos(a) * rx; ny = -(hh - ry) - Math.sin(a) * ry; mx = Math.cos(a); my = -Math.sin(a); break; } // BR
      case 4: nx = (hw - rx) - f * straightX; ny = -hh; mx = 0; my = -1; break;                                              // bottom
      case 5: { const a = f * Math.PI / 2; nx = -(hw - rx) - Math.sin(a) * rx; ny = -(hh - ry) - Math.cos(a) * ry; mx = -Math.sin(a); my = -Math.cos(a); break; } // BL
      case 6: nx = -hw; ny = -(hh - ry) + f * straightY; mx = -1; my = 0; break;                                            // left
      default: { const a = f * Math.PI / 2; nx = -(hw - rx) - Math.cos(a) * rx; ny = (hh - ry) + Math.sin(a) * ry; mx = -Math.cos(a); my = Math.sin(a); break; } // TL
    }
    return { nx, ny, mx, my };
  }

  /** Frame the Expertise cards block: particles ride the rounded-rect OUTLINE,
   *  DENSE on the border and thinning OUTWARD into the dark page margins (an
   *  exponential band, biased ~80% outward since inward sits behind the opaque
   *  cards). This is the idle silhouette for the Expertise scene. */
  function cardsFrame(arr, count) {
    const box = expertiseBlockNdc();
    const cx = box ? box.cx : 0, cy = box ? box.cy : 0;
    const hw = box ? Math.max(0.2, box.hw) : 0.72;
    const hh = box ? Math.max(0.15, box.hh) : 0.5;
    const rx = Math.min(0.1, hw * 0.16), ry = Math.min(0.13, hh * 0.16);
    const reach = _expField.reach, conc = Math.max(0.2, _expField.conc);
    const outBias = _expField.outBias, depth = _expField.depth, jit = _expField.jitter;
    for (let i = 0; i < count; i++) {
      const p = rrPointNormal(i, count, hw, hh, rx, ry);
      const out = Math.random() < outBias ? 1 : -1;                   // outward into margins vs hugging (behind cards)
      // exponential outward offset: DENSE near the cards, sparse tail toward the
      // edges. `reach` scales the distance (no cap → fills the viewport); `conc`
      // steepens (high) or flattens (low) the density gradient.
      const off = Math.pow(-Math.log(Math.random() + 1e-4), 1 / conc) * reach * 0.5 * out;
      const nx = cx + p.nx + p.mx * off + (Math.random() - 0.5) * jit;
      const ny = cy + p.ny + p.my * off + (Math.random() - 0.5) * jit;
      const w = pt(nx, ny);
      arr[i * 3] = w.x; arr[i * 3 + 1] = w.y; arr[i * 3 + 2] = (Math.random() - 0.5) * depth;
    }
  }

  /** Scatter to the four page-edge bands, leaving the centre clear (expertise). */
  function edgesScatter(arr, count) {
    const inner = 0.62;   // centre kept empty out to this radius
    const outer = 0.99;
    for (let i = 0; i < count; i++) {
      const side = i & 3;                       // even spread across the 4 sides
      const along = (Math.random() * 2 - 1) * outer;
      const depth = inner + Math.random() * (outer - inner);
      let nx, ny;
      if (side === 0)      { ny = depth;  nx = along; }      // top
      else if (side === 1) { ny = -depth; nx = along; }      // bottom
      else if (side === 2) { nx = -depth; ny = along; }      // left
      else                 { nx = depth;  ny = along; }      // right
      const w = pt(nx, ny);
      arr[i * 3] = w.x; arr[i * 3 + 1] = w.y; arr[i * 3 + 2] = (Math.random() - 0.5) * 1.2;
    }
  }

  /**
   * A floor seen in perspective (education) — a grid that recedes toward a
   * horizon: "lane" lines fan out from a wide near edge to a narrow far edge
   * (they converge), and "rung" cross-lines bunch up toward the top. In 2D the
   * silhouette is a trapezoid with the larger base at the bottom.
   */
  function perspectiveFloor(arr, count) {
    const halfBottom = 0.80;   // near edge half-width (wide base)
    const c = 0.16;            // far/near width ratio (top width = c * bottom)
    const nyBottom = -0.84;    // near edge (screen-bottom) — lowered
    const nyTop = -0.26;       // far edge (horizon) — lowered + shorter (smaller span)
    const ROWS = 8;            // rung cross-lines (equal world-depth steps)
    const LANES = 9;           // converging lane lines
    // perspective scale at depth fraction f∈[0,1] (0 near .. 1 far)
    const scale = (f) => 1 / (1 + (1 / c - 1) * f);
    // screen Y tied to the same scale → rungs compress toward the top
    const yAt = (f) => nyBottom + (nyTop - nyBottom) * (1 - scale(f)) / (1 - c);
    const halfAt = (f) => halfBottom * scale(f);
    for (let i = 0; i < count; i++) {
      let nx, ny;
      if (Math.random() < 0.5) {
        // a point on a rung (horizontal cross-line) at an equal-depth step
        const f = Math.floor(Math.random() * (ROWS + 1)) / ROWS;
        const u = Math.random() * 2 - 1;
        nx = u * halfAt(f); ny = yAt(f);
      } else {
        // a point on a lane (converging depth line) at a continuous depth
        const lane = (Math.floor(Math.random() * (LANES + 1)) / LANES) * 2 - 1;
        const f = Math.random();
        nx = lane * halfAt(f); ny = yAt(f);
      }
      nx += (Math.random() - 0.5) * 0.008;
      ny += (Math.random() - 0.5) * 0.008;
      const w = pt(nx, ny);
      arr[i * 3] = w.x; arr[i * 3 + 1] = w.y; arr[i * 3 + 2] = (Math.random() - 0.5) * 0.6;
    }
  }

  /* ---- registry ---- */
  // Shape generators keyed by NAME (these are the dropdown values in the editor's
  // Animation tab). "galaxy" (null) = the ambient field / rest state.
  // Contact initials: size/position are data-driven (cv_ui.json →
  // particle_pages.contact) so the editor's Animation tab can tune them.
  const _ccfg = (data && data.particle_pages && data.particle_pages.contact) || {};
  // mutable so the live editor hook can retune the initials without a reload
  const _initOpts = { fontFrac: _num(_ccfg.fontFrac, 0.14), xFrac: _num(_ccfg.xFrac, 0.5), yFrac: _num(_ccfg.yFrac, 0.80) };
  // Contact scatter: only a fraction of the cloud spells the initials; the rest
  // settle on the z=0 plane the letters stand on — dense near, thinning outward
  // (exponential), like the Expertise field. All mutable for the live hook.
  const _initScatter = {
    frac:       _num(_ccfg.initials_frac, 0.25),  // share of particles spelling the initials (must stay legible)
    lineFrac:   _num(_ccfg.line_frac, 0.4),       // of the REST: share riding the baseline (the others fill the arc)
    spread:     _num(_ccfg.scatter_spread, 0.5),  // line length beyond the letter gap = arc half-width (NDC)
    conc:       _num(_ccfg.scatter_conc, 1.0),    // density gradient (high = denser near the letters / the centre)
    lineOffset: _num(_ccfg.line_offset, 0)        // fine nudge of the baseline in Y (NDC)
  };
  const _LINE_PAD_PX = 20;   // horizontal gap each side of the letters with NO line
  const _ARC_FOOT_PX = 10;   // the arc bottom stops this far above the footer

  // Resting NDC-Y of the footer top (shifted to where it settles, like aboutBoxNdc).
  function footerTopNdc() {
    const f = document.querySelector(".site-footer");
    if (!f) return null;
    const r = f.getBoundingClientRect();
    if (r.height < 1) return null;
    const top = r.top + restShiftPx();
    return -((top / innerHeight) * 2 - 1);
  }

  // Contact cloud in three reads: (1) the initials stay crisp; (2) a baseline at
  // the bottom of the letters carries a horizontal scatter that SKIPS the letters
  // (a 20px gap each side), dense near them, thinning outward; (3) the remainder
  // fills a half-arc spanning the line's ends down to ~10px above the footer,
  // denser near the initials.
  function fillInitials(arr, count) {
    const sFrac = Math.min(1, Math.max(0, _initScatter.frac));
    const nInit = Math.max(1, Math.min(count, Math.round(count * sFrac)));
    arr.set(sampleTextToTargets(initials, { count: nInit, mapPixelToWorld, ..._initOpts }), 0);

    const rest = count - nInit;
    if (rest <= 0) return;
    const cxN = _initOpts.xFrac * 2 - 1;
    const cyN = -(_initOpts.yFrac * 2 - 1);
    const fontPx = innerWidth * _initOpts.fontFrac;
    // baseline = same height as the bottom of the glyphs (cap-height ≈ 0.72·fontPx)
    const capDrop = 0.72 * fontPx / innerHeight;
    const baseY = cyN - capDrop + _initScatter.lineOffset;
    // exact half-width of the initials via measureText (same font as the sampler),
    // so the line gap hugs the real letters; + 20px padding each side.
    let letterHalf = 1.1 * _initOpts.fontFrac;
    try {
      const g2 = document.createElement("canvas").getContext("2d");
      g2.font = `700 ${Math.round(fontPx)}px 'Space Grotesk', system-ui, sans-serif`;
      letterHalf = g2.measureText(initials).width / innerWidth;
    } catch { /* keep the estimate */ }
    const gapHalf = letterHalf + (2 * _LINE_PAD_PX / innerWidth);
    const conc = Math.max(0.2, _initScatter.conc);
    const spread = _initScatter.spread;
    const a = gapHalf + spread;                    // line outer end = arc horizontal semi-axis
    const ftN = footerTopNdc();
    const arcBottomY = ftN != null ? ftN + (2 * _ARC_FOOT_PX / innerHeight) : baseY - 0.5;
    const b = Math.max(0.05, baseY - arcBottomY);  // arc vertical semi-axis (down to ~footer)
    const lineN = Math.round(rest * Math.min(1, Math.max(0, _initScatter.lineFrac)));

    let i = nInit;
    // (2) baseline: OUTSIDE the letter gap, fanning out, dense near the letters.
    for (let k = 0; k < lineN; k++, i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const t = Math.pow(Math.random(), conc);     // 0..1, dense near 0 (the letters) when conc>1
      const nx = cxN + side * (gapHalf + t * spread);
      const ny = baseY + (Math.random() - 0.5) * 0.012;
      const w = pt(nx, ny);
      arr[i * 3] = w.x; arr[i * 3 + 1] = w.y; arr[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
    }
    // (3) the half-arc: lower half-ellipse from end to end of the line, filled,
    // denser toward the initials (top centre).
    for (; i < count; i++) {
      const ang = Math.random() * Math.PI;         // lower half (downward)
      const rr = Math.pow(Math.random(), conc);    // radial: dense near the centre when conc>1
      const nx = cxN + Math.cos(ang) * a * rr;
      const ny = baseY - Math.sin(ang) * b * rr;
      const w = pt(nx, ny);
      arr[i * 3] = w.x; arr[i * 3 + 1] = w.y; arr[i * 3 + 2] = (Math.random() - 0.5) * 0.6;
    }
  }
  const SHAPE_GENERATORS = {
    name: textShape(name.toUpperCase(), { lines: isMobile ? 2 : 1, yFrac: isMobile ? 0.32 : 0.36 }),
    initials: fillInitials,
    frame: rectFrame,
    cardsframe: cardsFrame,
    edges: edgesScatter,
    floor: perspectiveFloor,
    galaxy: null
  };
  // Legacy scene→shape map: the fallback used when cv_ui has no per-page config.
  const DEFAULT_SHAPES = {
    hero: SHAPE_GENERATORS.name,
    about: SHAPE_GENERATORS.frame,
    expertise: SHAPE_GENERATORS.cardsframe,
    experience: null,
    education: SHAPE_GENERATORS.floor,
    contact: SHAPE_GENERATORS.initials
  };

  /** Per-axis scale (around the screen centre) + screen-space offset on a buffer. */
  function applyTransform(arr, count, cfg) {
    const sx = cfg.scaleX == null ? 1 : cfg.scaleX;
    const sy = cfg.scaleY == null ? 1 : cfg.scaleY;
    const ox = cfg.x || 0, oy = cfg.y || 0;
    applyScreenTransform(arr, count, sx, sy, ox, oy, pt);
  }
  const withTransform = (gen, cfg) => (arr, count) => { gen(arr, count); applyTransform(arr, count, cfg); };

  /** Normalize a raw cv_ui per-page entry to the flat schema this module reads.
   *  Tolerates the legacy nested-by-device shape ({desktop:{shape,x,y,scale}})
   *  and the single `scale` → so an un-migrated config can never silently kill
   *  the morph by leaving `shape` undefined. Returns null when there's nothing
   *  usable (→ caller falls back to the legacy DEFAULT_SHAPES). */
  function normalizeCfg(raw) {
    if (!raw || typeof raw !== "object") return null;
    const c = raw.desktop && typeof raw.desktop === "object" ? raw.desktop : raw;
    if (!c.shape) return null;
    const sc = c.scale;
    return {
      shape:  c.shape,
      x:      c.x || 0,
      y:      c.y || 0,
      scaleX: c.scaleX != null ? c.scaleX : (sc != null ? sc : 1),
      scaleY: c.scaleY != null ? c.scaleY : (sc != null ? sc : 1)
    };
  }

  /** Resolve a scene id → its (transformed) shape generator: from the cv_ui
   *  per-page config (desktop) if present, else the legacy default. The config
   *  is intentionally desktop-only — mobile particles use the WIP physics. */
  function resolveShape(id) {
    const cfg = normalizeCfg(data && data.particle_pages && data.particle_pages[id]);
    if (cfg) {
      const gen = SHAPE_GENERATORS[cfg.shape];
      return gen ? withTransform(gen, cfg) : null;   // "galaxy"/unknown → null
    }
    return Object.prototype.hasOwnProperty.call(DEFAULT_SHAPES, id) ? DEFAULT_SHAPES[id] : null;
  }

  // Coherent particle colouring for the TEXT scenes (name / initials). The shape
  // name decides whether a scene is "text"; its color_mode picks the scheme.
  const DEFAULT_SHAPE_NAME = { hero: "name", about: "frame", expertise: "cardsframe", experience: "galaxy", education: "floor", contact: "initials" };
  const _TEXT_MODES = { random: 0, palette: 1, duotone: 2, single: 3, "palette-loop": 4 };
  function shapeNameOf(id) {
    const cfg = normalizeCfg(data && data.particle_pages && data.particle_pages[id]);
    return cfg ? cfg.shape : (DEFAULT_SHAPE_NAME[id] || "galaxy");
  }
  function isTextShape(id) { const s = shapeNameOf(id); return s === "name" || s === "initials"; }
  function textModeOf(id) {
    const cm = ((data && data.particle_pages && data.particle_pages[id]) || {}).color_mode;
    return _TEXT_MODES[cm] != null ? _TEXT_MODES[cm] : 1;   // default = palette gradient
  }
  function colorLoopsOf(id) {
    const n = ((data && data.particle_pages && data.particle_pages[id]) || {}).color_loops;
    return Math.max(1, +n || 1);
  }
  // Apply the colour scheme + loop count for a text scene in one place.
  function applyTextScheme(id) { sceneCtx.setTextMode(textModeOf(id)); sceneCtx.setColorLoops(colorLoopsOf(id)); }

  /* ============================ morph director ======================= */
  // level: which slot is currently revealed (0 galaxy, 1 = A, 2 = B).
  // Right after the intro the name sits in slot A at uMorph 1.
  let level = sceneCtx.getMorph() >= 0.5 ? 1 : 0;
  let currentMorph = sceneCtx.getMorph();
  let currentName = 1;            // intro leaves nameMode high
  let currentText = 0;            // coherent text-colour blend currently applied (0..1)
  let activeShapeId = "hero";
  let _restScroll = 0;            // scroll target the incoming scene will rest at

  // Home shows the name straight out of the intro: switch its coherent colouring
  // on from the start so the name never flashes the random per-particle palette.
  if (isTextShape(activeShapeId)) {
    applyTextScheme(activeShapeId);
    sceneCtx.setTextColor(1);
    currentText = 1;
  }

  // STALE-STATE SYNC. On the real site this director is CONSTRUCTED (main.js)
  // before deflagration.play() composes the name: initHeroDeflagration has
  // already reset uMorph to 0, so getMorph() reads 0 here and level/currentMorph
  // cache the galaxy state. The intro then drives uMorph 0→1, leaving the name in
  // slot A at uMorph 1 — but the cache stays stale. Left unsynced, the FIRST
  // scene morph runs with morphFrom=0 AND fills slot A, so it melts the name back
  // to the galaxy and overwrites the name buffer before reforming into the About
  // frame: the visible "dirty" first morph. Re-read the LIVE state when the intro
  // completes so the first morph blends slot A (name) → slot B (shape) cleanly.
  // In ?preview=1 the intro is skipped and getMorph() is already 1 at
  // construction, so this listener simply re-affirms the same values.
  const syncAfterIntro = () => {
    currentMorph = sceneCtx.getMorph();
    level = currentMorph >= 0.5 ? 1 : 0;
    currentName = 1;
  };
  window.addEventListener("evolvedcv:intro-done", syncAfterIntro, { once: true });

  function fillSlot(slot, shapeFn) {
    const buf = sceneCtx.getMorphBuffers();
    const target = slot === "A" ? buf.aTargetA : buf.aTargetB;
    shapeFn(target, buf.count);
    buf.markTargetsDirty();
  }

  /**
   * Prepare the transition to scene `id`. Fills the relevant target slot NOW
   * (synchronous, once) and returns a controller the caller drives 0→1 in sync
   * with its own scroll tween:  apply(p) interpolates, settle() pins the end.
   */
  function beginScene(id, restScroll) {
    // where the incoming scene's DOM will rest (so DOM-anchored shapes like the
    // About frame can target the box's final on-screen position, not its
    // mid-transition one). Falls back to the current scroll.
    _restScroll = typeof restScroll === "number" ? restScroll : window.scrollY;
    const shapeFn = resolveShape(id);
    const morphFrom = currentMorph;
    const nameFrom = currentName;
    const textFrom = currentText;
    let morphTo, nameTo;

    if (!shapeFn) {
      // galaxy rest state (pills / experience): dissolve back to the field
      morphTo = 0; nameTo = 0; level = 0;
    } else {
      // reveal the slot we are NOT currently showing, then tween onto it
      const targetLevel = level === 1 ? 2 : 1;   // from 0 or 2 → A(1); from 1 → B(2)
      fillSlot(targetLevel === 1 ? "A" : "B", shapeFn);
      morphTo = targetLevel; nameTo = 1; level = targetLevel;
    }
    // Coherent text colouring fades in only on the name/initials scenes (in sync
    // with the morph). Set the scheme up-front for the incoming text scene.
    const textTo = shapeFn && isTextShape(id) ? 1 : 0;
    if (textTo) applyTextScheme(id);
    activeShapeId = id;
    currentMorph = morphTo;
    currentName = nameTo;
    currentText = textTo;

    return {
      apply(p) {
        sceneCtx.setMorph(morphFrom + (morphTo - morphFrom) * p);
        sceneCtx.setNameMode(nameFrom + (nameTo - nameFrom) * p);
        sceneCtx.setTextColor(textFrom + (textTo - textFrom) * p);
      },
      settle() {
        sceneCtx.setMorph(morphTo);
        sceneCtx.setNameMode(nameTo);
        sceneCtx.setTextColor(textTo);
      }
    };
  }

  /** Re-fill the active silhouette after a viewport resize (no animation). */
  function refresh() {
    const shapeFn = activeShapeId ? resolveShape(activeShapeId) : null;
    if (!shapeFn || level === 0) return;
    _restScroll = window.scrollY;   // at rest the DOM is already in place
    fillSlot(level === 2 ? "B" : "A", shapeFn);
  }

  let rzTimer = 0;
  const onResize = () => { clearTimeout(rzTimer); rzTimer = setTimeout(refresh, 200); };
  window.addEventListener("resize", onResize, { passive: true });

  // Live editor hook: retune the Contact initials (size/position) and re-fill the
  // active silhouette immediately — no preview reload.
  function applyInitials(c) {
    if (!c) return;
    if (c.fontFrac != null) _initOpts.fontFrac = +c.fontFrac;
    if (c.xFrac != null) _initOpts.xFrac = +c.xFrac;
    if (c.yFrac != null) _initOpts.yFrac = +c.yFrac;
    if (c.initials_frac != null) _initScatter.frac = +c.initials_frac;
    if (c.line_frac != null) _initScatter.lineFrac = +c.line_frac;
    if (c.scatter_spread != null) _initScatter.spread = +c.scatter_spread;
    if (c.scatter_conc != null) _initScatter.conc = +c.scatter_conc;
    if (c.line_offset != null) _initScatter.lineOffset = +c.line_offset;
    refresh();
  }
  window.evolvedcvApplyInitials = applyInitials;

  // Live editor hook: retune the WebGL Expertise field reach + re-fill immediately.
  function applyExpertiseShape(c) {
    if (!c) return;
    if (c.field_reach != null) _expField.reach = +c.field_reach;
    if (c.field_conc != null) _expField.conc = +c.field_conc;
    if (c.field_outbias != null) _expField.outBias = +c.field_outbias;
    if (c.field_depth != null) _expField.depth = +c.field_depth;
    if (c.field_jitter != null) _expField.jitter = +c.field_jitter;
    refresh();
  }
  window.evolvedcvApplyExpertiseShape = applyExpertiseShape;

  // Live editor hook: retune the per-page transform (x / y / scale / shape) and
  // the About frame knobs, then re-fill the active silhouette — no preview reload.
  // `all` is the whole particle_pages map; we merge each page into our own `data`
  // so resolveShape() picks up the new transform on the next refresh().
  function applyParticlePages(all) {
    if (!all || typeof all !== "object") return;
    const pp = (data.particle_pages = data.particle_pages || {});
    // Snapshot the DISPLAYED scene's config so we can tell whether THIS edit
    // actually touched it (editing another page must not disturb it).
    const before = JSON.stringify(pp[activeShapeId] || null);
    for (const id of Object.keys(all)) {
      if (all[id] && typeof all[id] === "object") pp[id] = Object.assign(pp[id] || {}, all[id]);
    }
    // closure knobs that aren't re-read from `data` on each fill: sync them here.
    if (pp.about) {
      if (pp.about.frame_thickness != null) _aboutFrame.thickness = +pp.about.frame_thickness;
      if (pp.about.frame_offset_x != null) _aboutFrame.offsetX = +pp.about.frame_offset_x;
      if (pp.about.frame_offset_y != null) _aboutFrame.offsetY = +pp.about.frame_offset_y;
      if (pp.about.frame_corner != null) _aboutFrame.corner = +pp.about.frame_corner;
    }
    // Only re-touch the LIVE scene when ITS OWN config changed. Editing a different
    // page (e.g. Contact's loop while Home is on screen) must leave Home untouched —
    // otherwise its colour scheme + a geometry refresh would visibly re-shuffle it.
    if (JSON.stringify(pp[activeShapeId] || null) === before) return;
    if (isTextShape(activeShapeId)) applyTextScheme(activeShapeId);
    refresh();
  }
  window.evolvedcvApplyParticlePages = applyParticlePages;

  return {
    beginScene,
    refresh,
    dispose() {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("evolvedcv:intro-done", syncAfterIntro);
      clearTimeout(rzTimer);
      if (window.evolvedcvApplyInitials === applyInitials) delete window.evolvedcvApplyInitials;
      if (window.evolvedcvApplyExpertiseShape === applyExpertiseShape) delete window.evolvedcvApplyExpertiseShape;
      if (window.evolvedcvApplyParticlePages === applyParticlePages) delete window.evolvedcvApplyParticlePages;
    }
  };
}
