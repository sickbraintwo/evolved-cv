/**
 * text-sampler.js — rasterize a string to an offscreen canvas and sample its
 * lit pixels into exactly `count` world-space target positions for the morph
 * engine. Pure & synchronous (~30ms typical); the caller (hero-deflagration)
 * wraps it in requestIdleCallback after fonts are ready so it never touches
 * the first-paint critical path. No DOM mutation beyond the offscreen canvas.
 *
 * The mapping from canvas pixels to world space is supplied by the caller via
 * `mapPixelToWorld(px, py, W, H)` (built from ctx.worldFromScreen), so the
 * targets live in the SAME world space the bg camera uses.
 */

/**
 * @param {string} text
 * @param {object} opts
 * @param {number} opts.count           number of target positions to produce
 * @param {string} [opts.fontFamily]    default "Space Grotesk"
 * @param {number} [opts.weight]        default 700
 * @param {number} [opts.lines]         1 or 2 (default 1)
 * @param {(px:number,py:number,W:number,H:number)=>{x:number,y:number,z:number}} opts.mapPixelToWorld
 * @returns {Float32Array} count*3 target positions
 */
export function sampleTextToTargets(text, {
  count,
  fontFamily = "Space Grotesk",
  weight = 700,
  lines = 1,
  yFrac = 0.5,
  xFrac = 0.5,
  fontFrac = null,
  mapPixelToWorld,
  withLetterCenters = false
} = {}) {
  const out = new Float32Array(count * 3);
  // When letter centroids are requested we return { targets, letterCenters };
  // otherwise the legacy bare Float32Array. wrap() keeps the fallbacks honest
  // (letterCenters == positions ⇒ the breath term is a no-op).
  const wrap = (arr) => (withLetterCenters
    ? { targets: arr, letterCenters: arr.slice(), letterIndex: new Float32Array(count) }
    : arr);
  if (!count) return wrap(out);

  // canvas sized to a viewport-ish raster (kept modest for sampling speed)
  const W = Math.min(Math.max(window.innerWidth, 640), 1920);
  const H = Math.min(Math.max(window.innerHeight, 480), 1080);
  const cnv = document.createElement("canvas");
  cnv.width = W;
  cnv.height = H;
  const g = cnv.getContext("2d", { willReadFrequently: true });
  if (!g) {
    // no 2d context: fall back to a tight central cluster so the morph still reads
    return wrap(fillFallback(out, count, mapPixelToWorld, W, H));
  }

  // font size: explicit fraction of the canvas width (fontFrac) when given,
  // else ~11vw per the design intent (smaller when 2 lines).
  let fontPx = fontFrac != null
    ? Math.round(W * fontFrac)
    : Math.round(W * (lines === 2 ? 0.13 : 0.11));
  g.clearRect(0, 0, W, H);
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  const setFont = () => { g.font = `${weight} ${fontPx}px '${fontFamily}', system-ui, sans-serif`; };
  setFont();

  const rows = lines === 2 ? splitTwoLines(text) : [text];
  // auto-fit: shrink so the widest row fits ~92% of the available width on the
  // side the text is anchored to (handles long / uppercased names, and keeps an
  // off-centre anchor — xFrac != 0.5 — from clipping at the nearest edge).
  const cx = W * xFrac;
  const maxW = Math.min(cx, W - cx) * 2 * 0.92;
  const widest = Math.max(...rows.map((r) => g.measureText(r).width)) || 1;
  if (widest > maxW) { fontPx = Math.floor(fontPx * (maxW / widest)); setFont(); }

  const lineGap = fontPx * 1.04;
  const y0 = H * yFrac - ((rows.length - 1) * lineGap) / 2;
  rows.forEach((row, i) => g.fillText(row, cx, y0 + i * lineGap));

  const data = g.getImageData(0, 0, W, H).data;

  // collect lit pixel coords (stride the scan to keep it fast on large rasters)
  const lit = [];
  const step = 2; // sub-sample the raster grid
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      if (data[(y * W + x) * 4 + 3] > 128) lit.push(x, y);
    }
  }

  const litCount = lit.length / 2;
  if (litCount === 0) return wrap(fillFallback(out, count, mapPixelToWorld, W, H));

  const map = typeof mapPixelToWorld === "function"
    ? mapPixelToWorld
    : (px, py, w, h) => ({ x: (px / w) * 2 - 1, y: -((py / h) * 2 - 1), z: 0 });

  // ---- per-letter centroids (optional) ----------------------------------
  // Measure each glyph's box in canvas space (textAlign is "center", so a row
  // of width Wrow starts at cx - Wrow/2). Each sampled pixel is later tagged
  // with the WORLD centroid of the glyph whose box it falls in, so the BREATH
  // phase can expand every letter from its own middle.
  const letterCenters = withLetterCenters ? new Float32Array(count * 3) : null;
  const letterIndex = withLetterCenters ? new Float32Array(count) : null;
  let boxes = null;
  if (withLetterCenters) {
    boxes = [];
    rows.forEach((row, ri) => {
      const rowY = y0 + ri * lineGap;
      const total = g.measureText(row).width;
      const left = cx - total / 2;
      for (let j = 0; j < row.length; j++) {
        if (row[j] === " ") continue;
        const x0 = left + g.measureText(row.slice(0, j)).width;
        const cw = g.measureText(row[j]).width || 1;
        boxes.push({ cx: x0 + cw / 2, cy: rowY, x0, x1: x0 + cw, _w: null, ord: boxes.length });
      }
    });
  }
  // normalize glyph order to 0..1 (first→last) for the staggered breath wave
  const denom = boxes && boxes.length > 1 ? boxes.length - 1 : 1;
  const boxWorld = (b) => (b._w || (b._w = map(b.cx, b.cy, W, H)));
  const nearestBox = (px, py) => {
    let best = null, bestD = Infinity;
    for (const b of boxes) {
      const inX = px >= b.x0 && px <= b.x1;
      // prefer same row (dy dominates), then the containing glyph, then nearest cx
      const d = Math.abs(py - b.cy) * 4 + (inX ? 0 : Math.abs(px - b.cx));
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  };

  for (let i = 0; i < count; i++) {
    // even stride over the lit set (reservoir-ish); repeat with jitter to fill
    // when there are fewer lit pixels than requested particles.
    const idx = Math.floor((i / count) * litCount) % litCount;
    const sx = lit[idx * 2];
    const sy = lit[idx * 2 + 1];
    let px = sx;
    let py = sy;
    if (litCount < count) {
      px += (Math.random() - 0.5) * step * 2.2;
      py += (Math.random() - 0.5) * step * 2.2;
    }
    const w = map(px, py, W, H);
    out[i * 3] = w.x;
    out[i * 3 + 1] = w.y;
    out[i * 3 + 2] = (Math.random() - 0.5) * 0.6; // small z jitter near 0
    if (letterCenters) {
      const b = boxes.length ? nearestBox(sx, sy) : null;
      const lw = b ? boxWorld(b) : w;
      letterCenters[i * 3] = lw.x;
      letterCenters[i * 3 + 1] = lw.y;
      letterCenters[i * 3 + 2] = 0;
      letterIndex[i] = b ? b.ord / denom : 0;
    }
  }
  return withLetterCenters ? { targets: out, letterCenters, letterIndex } : out;
}

function splitTwoLines(text) {
  const words = String(text).trim().split(/\s+/);
  if (words.length <= 1) return [text];
  // balance the two lines by word count
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
}

function fillFallback(out, count, mapPixelToWorld, W, H) {
  const map = typeof mapPixelToWorld === "function"
    ? mapPixelToWorld
    : (px, py, w, h) => ({ x: (px / w) * 2 - 1, y: -((py / h) * 2 - 1), z: 0 });
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random());
    const px = W / 2 + Math.cos(a) * r * W * 0.18;
    const py = H / 2 + Math.sin(a) * r * H * 0.12;
    const w = map(px, py, W, H);
    out[i * 3] = w.x;
    out[i * 3 + 1] = w.y;
    out[i * 3 + 2] = (Math.random() - 0.5) * 0.6;
  }
  return out;
}
