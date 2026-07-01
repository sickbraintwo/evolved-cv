/**
 * three-scene.js — F4: particle background + shared render infrastructure.
 *
 * Owns the ONE WebGL renderer on #bg3d and the ONE render loop.
 * The filter scene (F5) does not create its own renderer: it asks this
 * module for a "layer" ({scene, camera}) that is rendered on top of the
 * background each frame (renderer.autoClear=false + clearDepth). This keeps
 * a single GL context, a single RAF, and lets the background stay alive
 * (dimmed via uniform) behind the filter views.
 *
 * Tier system (particle COUNT is data-driven — site_config.particle_count):
 *   HIGH = configured count (clamped 3000..16000), dpr cap 2
 *   MID  = ~45% of it, dpr cap 1.5
 *   LOW  = fixed 1200, static (single frame; loop only while a layer
 *         such as the filter scene is visible)
 * Selection: deviceMemory, GPU blacklist, viewport, prefers-reduced-motion.
 * Override with ?tier=high|mid|low. Watchdog degrades (never upgrades)
 * one tier when fps < 30 for 3 consecutive seconds.
 *
 * Colors come ONLY from theme.js (css/tokens.css).
 */
import * as THREE from "three";
import { getToken, getDomainColor } from "./theme.js";
import { watchVisibility } from "./dom-utils.js";

const DOMAIN_IDS = ["ai", "3dxr", "2dmedia", "dev", "consulting"];

/** The 5 domain colours sorted by HUE → a smooth left-to-right sweep for the
 *  name/initials coherent colouring (no random salt-and-pepper). */
function huePalette() {
  const hsl = { h: 0, s: 0, l: 0 };
  return DOMAIN_IDS
    .map((d) => new THREE.Color(getDomainColor(d)))
    .map((c) => { c.getHSL(hsl); return { c, h: hsl.h }; })
    .sort((a, b) => a.h - b.h)
    .map((o) => o.c);
}

/* ---------------------------------------------------------- particle count */
// Range guardrails: below MIN the galaxy/constellation looks sparse; above MAX
// integrated GPUs start dropping frames. The JSON value is the desktop "high"
// target; weaker tiers scale it down (LOW is fixed for very weak devices).
const PARTICLE_MIN = 3000;
const PARTICLE_MAX = 16000;
const PARTICLE_DEFAULT = 10000;
let baseCount = PARTICLE_DEFAULT; // set from site_config.particle_count in initScene

/* ------------------------------------------------------------------ tiers */

const TIERS = {
  high: { dprCap: 2, morph: true, mult: 1 },
  mid: { dprCap: 1.5, morph: true, mult: 0.45 },
  low: { dprCap: 1, morph: false, count: 1200 }
};
const TIER_ORDER = ["high", "mid", "low"];

/** Particle count for a tier: fixed if the tier pins a count, else scaled. */
function tierCount(t) {
  const cfg = TIERS[t];
  return cfg.count != null ? cfg.count : Math.round(baseCount * cfg.mult);
}

function gpuBlacklisted(gl) {
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (!ext) return false;
    const r = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "").toLowerCase();
    return (
      /mali-4/.test(r) ||
      /adreno\s*\(tm\)\s*[34]\d\d\b/.test(r) ||
      /adreno\s*[34]\d\d\b/.test(r) ||
      /powervr/.test(r)
    );
  } catch {
    return false;
  }
}

function pickTier(gl) {
  const override = new URLSearchParams(location.search).get("tier");
  if (override && TIERS[override]) return override;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return "low";
  const mem = navigator.deviceMemory || 4;
  const minSide = Math.min(innerWidth, innerHeight);
  const coarse = matchMedia("(pointer: coarse)").matches;        // touch device (phone/tablet)
  const tooSmall = minSide < (coarse ? 300 : 360);                // a narrow phone is not a weak device
  if (gpuBlacklisted(gl) || mem <= 2 || tooSmall) return "low";
  if (mem <= 4 || minSide < 700) return "mid";
  return "high";
}

/* ------------------------------------------------------------------ shaders */

// Ashima-style simplex noise (3D), then a cheap curl approximation.
const NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
vec3 curlNoise(vec3 p){
  const float e = 0.12;
  float nx1 = snoise(p + vec3(0.0, e, 0.0));
  float nx2 = snoise(p - vec3(0.0, e, 0.0));
  float ny1 = snoise(p + vec3(0.0, 0.0, e));
  float ny2 = snoise(p - vec3(0.0, 0.0, e));
  float nz1 = snoise(p + vec3(e, 0.0, 0.0));
  float nz2 = snoise(p - vec3(e, 0.0, 0.0));
  return normalize(vec3(nx1 - nx2, ny1 - ny2, nz1 - nz2) + 0.0001);
}
`;

const BG_VERT = /* glsl */ `
uniform float uTime;
uniform vec2 uMouse;      // world coords on z=0 plane (already smoothed)
uniform float uScroll;    // 0..1 page scroll
uniform float uPixelRatio;
uniform float uStatic;    // 1 = freeze motion (LOW tier / reduced motion)
uniform float uMorph;     // 0..2 : 0=home/galaxy, 1=aTargetA (name), 2=aTargetB (nodes)
uniform float uBurst;     // 0..1 : outward explosion scatter applied to home
uniform float uNameMode;  // 0..1 : gates mouse repulsion to the text phase
uniform float uGather;          // intro: 0..1 global collapse toward uGatherPos
uniform vec3  uGatherPos;       // intro: global collapse point
uniform float uDomGather[5];    // Expertise: per-domain gather amount (0..1 each)
uniform vec3  uDomGatherPos[5]; // Expertise: per-domain target (card centre, world)
uniform float uGatherWave;      // Expertise: sinuous wave amplitude (world units)
uniform float uDomFilament[5];  // Experience: 0 = point gather, 1 = FILAMENT stream
uniform vec3  uDomOrigin[5];    // Experience: filament source (the lit chip, world)
uniform vec3  uDomSpread[5];    // Experience: half-extent of the lit cards' box (cone opening)
uniform float uBreath;    // global per-letter expansion (all letters together); additive with the wave
uniform float uBreathT;   // breath clock (s) driving the staggered wave; <=0 = inert
uniform float uBreathAmp; // peak expansion of the breath wave
uniform float uBreathStagger; // per-letter delay (s) across the name (first→last)
uniform float uSwirl;     // radians of swirl around uGatherPos (vortex explosion); 0 = none
attribute float aSeed;
attribute float aDomain;  // -1 = base color, 0..3 = domain
attribute vec3 aTargetA;  // name-text target position
attribute vec3 aTargetB;  // constellation-node target position
attribute float aMorphSeed; // 0..1 per-particle stagger window
attribute vec3 aLetterCenter; // centroid of this particle's glyph (name space) for the breath
attribute float aLetterIndex; // 0..1 glyph order (first→last) for the staggered breath wave
varying float vDomain;
varying float vGlow;
varying float vTextGrad;   // 0..1 horizontal screen position → gradient coordinate
${NOISE_GLSL}
// breath envelope for one letter: t = seconds since THIS letter's breath began.
// expands to amp (ease-out), then returns to 0 with a damped-elastic settle.
float breathEnv(float t, float amp){
  if (t <= 0.0 || amp <= 0.0) return 0.0;
  float rise = 0.42;
  float settle = 1.30;
  if (t < rise){
    float x = t / rise;
    return amp * (1.0 - (1.0 - x) * (1.0 - x)); // ease-out toward amp
  }
  float td = t - rise;
  if (td > settle) return 0.0;
  float x = td / settle;                          // 0..1
  return amp * exp(-6.0 * x) * cos(x * 9.95);     // amp -> 0 with elastic overshoot
}
void main(){
  // Every particle now carries one of the 5 domain colours: the ~70% that were
  // aDomain=-1 (rendered in the dim base #2A2347 → near-invisible on black) pick a
  // domain from their own seed. Gather/filament logic below still keys off aDomain,
  // so the BEHAVIOUR is unchanged — only the colour is.
  vDomain = aDomain > -0.5 ? aDomain : floor(fract(aSeed * 43.0) * 5.0);
  float t = uTime * (1.0 - uStatic);

  // ---- home (galaxy) position with its living motion ----
  vec3 home = position;

  // slow galaxy swirl
  float ang = t * 0.03 + aSeed * 6.2831;
  float swirl = 0.15 * sin(ang);
  home.xz = mat2(cos(swirl), -sin(swirl), sin(swirl), cos(swirl)) * home.xz;

  // galaxy motion fades out as the name forms (uMorph 0->1)
  float galaxyAmt = 1.0 - clamp(uMorph, 0.0, 1.0);

  // curl-noise drift
  home += curlNoise(home * 0.07 + vec3(0.0, t * 0.02, t * 0.013)) * (1.4 + aSeed) * (1.0 - uStatic) * galaxyAmt;

  // scroll drift: gentle vertical parallax + expansion
  home.y += uScroll * -6.0 * (0.4 + aSeed * 0.6) * galaxyAmt;
  home.xz *= 1.0 + uScroll * 0.15 * galaxyAmt;

  // explosion scatter (reads before the morph snaps into the name)
  home += normalize(vec3(aSeed - 0.5, aMorphSeed - 0.5, fract(aSeed * 7.3) - 0.5) + 0.0001) * uBurst * 14.0;

  // ---- per-particle staggered morph factor ----
  // remap the global uMorph through a per-particle window so letters/clusters
  // arrive at slightly different times (window width 0.35).
  float win = 0.35;
  float lo = aMorphSeed * win;
  float seg = floor(clamp(uMorph, 0.0, 1.999));        // 0 -> A blend, 1 -> B blend
  float local = clamp(uMorph - seg, 0.0, 1.0);
  float k = clamp((local - lo) / (1.0 - win), 0.0, 1.0);
  k = k * k * (3.0 - 2.0 * k);                          // smoothstep ease

  vec3 morphed;
  if (uMorph < 1.0) {
    morphed = mix(home, aTargetA, k);
  } else {
    morphed = mix(aTargetA, aTargetB, k);
  }
  vec3 p = morphed;

  // soft pointer attraction/repulsion on the z~0 slab. Strongest during the
  // name phase (uNameMode), but never fully disconnects: once the name melts
  // back into the galaxy (uNameMode -> 0 on scroll) a 30% floor remains so the
  // matter stays cursor-reactive all the way down (req 11). The floor is gated
  // by (1-uStatic) so prefers-reduced-motion / LOW tier keep zero mouse motion.
  float nm = max(uNameMode, 0.30 * (1.0 - uStatic));
  vec2 d = p.xy - uMouse;
  float dist = length(d);
  float influence = smoothstep(7.0, 0.0, dist) * nm;
  p.xy += normalize(d + 0.0001) * influence * 1.8;       // push away
  p.xy -= normalize(d + 0.0001) * smoothstep(14.0, 7.0, dist) * 0.5 * nm; // far ring pulled in
  vGlow = influence;

  // ---- BREATH: each glyph expands from its own centroid, only once the name
  // is formed (uMorph ~1). The staggered wave gives every letter its own breath
  // offset (uBreathT - index*stagger), so the breath travels first→last; uBreath
  // adds an optional global (all-together) breath. aLetterCenter defaults to home
  // so this is inert for the galaxy phase / untagged builds. ----
  float nameFormed = clamp(uMorph, 0.0, 1.0);
  float bWave = breathEnv(uBreathT - aLetterIndex * uBreathStagger, uBreathAmp);
  p += (p - aLetterCenter) * ((uBreath + bWave) * nameFormed);

  // ---- SWIRL: optional rotation around the gather point, used by the vortex
  // explosion to make the burst turbulent (uSwirl = 0 → no-op). ----
  if (uSwirl != 0.0) {
    vec3 rel = p - uGatherPos;
    float cs = cos(uSwirl), sn = sin(uSwirl);
    rel.xy = mat2(cs, -sn, sn, cs) * rel.xy;
    p = uGatherPos + rel;
  }

  // ---- GATHER ----
  // INTRO: global linear collapse toward the apparition point (unchanged).
  p = mix(p, uGatherPos, clamp(uGather, 0.0, 1.0));
  // EXPERTISE: each domain gathers toward ITS card centre, independently (so one
  // card can RELEASE while another STARTS). Base particles (aDomain<0) excluded.
  // The path is SINUOUS: progress toward the card + a serpentine perpendicular
  // wave that swells mid-flight and vanishes at both ends — organic, not a rigid
  // spin. Per-particle phase varies the curves. Symmetric → unwinds on release.
  if (aDomain > -0.5) {
    int gd = int(aDomain + 0.5);
    float g = clamp(uDomGather[gd], 0.0, 1.0);
    if (g > 0.0005) {
      vec3 tgt = uDomGatherPos[gd];
      if (uDomFilament[gd] > 0.5) {
        // EXPERIENCE FILAMENTS: borrow this domain's particles from the field and
        // string them along a STREAM from the lit chip (uDomOrigin) to the card
        // zone (tgt). aSeed positions each particle along the line; a travelling
        // ripple perpendicular to the stream gives it a thread-like body. g ramps
        // them out and back, so it's a loan (they reflow to the galaxy on release).
        vec3 orig = uDomOrigin[gd];
        // OPEN the cone: each particle aims at a point spread across the box of
        // ALL the lit cards (uDomSpread = half-extent), not just the centroid —
        // so the filament fans out to reach every selected experience.
        vec2 jit = vec2(fract(aSeed * 41.3) - 0.5, fract(aSeed * 97.7) - 0.5) * 2.0; // [-1,1]
        vec3 endPoint = tgt + vec3(jit * uDomSpread[gd].xy, 0.0);
        vec3 streamTarget = mix(orig, endPoint, aSeed);            // a point along the filament
        vec2 fdir  = normalize(tgt.xy - orig.xy + vec2(1e-4));
        vec2 fperp = vec2(-fdir.y, fdir.x);
        vec2 base  = mix(p.xy, streamTarget.xy, g);                // glide onto the stream
        float ph   = aSeed * 18.8496 + t * 1.6;                    // ripple travelling along it
        float wave = sin(ph) * (0.35 + 0.65 * sin(aSeed * 6.2831)) * sin(g * 3.14159) * uGatherWave * 0.6;
        p.xy = base + fperp * wave;
        p.z  = mix(p.z, streamTarget.z, g);
      } else {
        vec2 dir = tgt.xy - p.xy;
        vec2 base = p.xy + dir * g;                                // travel toward the card
        vec2 perp = normalize(vec2(-dir.y, dir.x) + vec2(1e-4));   // sideways axis
        float ph = aDomain * 2.39 + dot(p.xy, vec2(0.021, 0.017)); // per-particle-ish phase
        float wave = sin(g * 9.4248 + ph) * sin(g * 3.14159) * uGatherWave;
        p.xy = base + perp * wave;
        p.z  = mix(p.z, tgt.z, g);
      }
    }
  }

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vTextGrad = gl_Position.x / gl_Position.w * 0.5 + 0.5;   // screen-x in [0,1]
  float size = (1.2 + aSeed * 2.2 + influence * 2.5) * uPixelRatio;
  gl_PointSize = size * (140.0 / -mv.z);
}
`;

const BG_FRAG = /* glsl */ `
uniform vec3 uColorBase;
uniform vec3 uColorHot;
uniform vec3 uDomainColors[5];
uniform float uDim;       // 0 = normal, 1 = fully dimmed (filter mode)
uniform float uTextColor; // 0..1 : blend toward the coherent name/initials colour
uniform int uTextMode;    // 1 palette-gradient, 2 duotone, 3 single, 4 Exp-loop
uniform float uColorLoops; // mode 4: how many times the 5-colour cycle repeats along the text
uniform vec3 uTextPalette[5];
uniform vec3 uTextDuoA;
uniform vec3 uTextDuoB;
varying float vDomain;
varying float vGlow;
varying float vTextGrad;
void main(){
  vec2 uv = gl_PointCoord - 0.5;
  float r = length(uv);
  if (r > 0.5) discard;
  float falloff = smoothstep(0.5, 0.0, r);
  // vDomain is always 0..4 now → every particle takes its domain colour (a touch
  // of base mixed in for cohesion). This is what makes the formerly-invisible 70%
  // show up, all sharing the 5 Expertise colours.
  int d = int(vDomain + 0.5);
  vec3 col = mix(uColorBase, uDomainColors[d], 0.78);
  // Coherent colouring on the name (Home) / initials (Contact): instead of the
  // random per-particle domain colour, derive the colour from screen-x so
  // neighbours share hues (a smooth sweep) — no "vomit" with high-contrast palettes.
  if (uTextColor > 0.001 && uTextMode > 0) {
    float g = clamp(vTextGrad, 0.0, 1.0);
    vec3 tcol;
    if (uTextMode == 1) {                       // gradient across the hue-sorted palette
      float f = g * 4.0;
      float i0f = floor(f);
      int i0 = int(i0f);
      int i1 = int(min(i0f + 1.0, 4.0));        // float min (GLSL ES 1.00 has no int min)
      tcol = mix(uTextPalette[i0], uTextPalette[i1], f - i0f);
    } else if (uTextMode == 2) {                // duotone primary → accent
      tcol = mix(uTextDuoA, uTextDuoB, g);
    } else if (uTextMode == 4) {                // cyclic sweep through the 5 Exp colours (last→first wraps)
      float u = fract(g * max(1.0, uColorLoops));
      float f = u * 5.0;
      float i0f = floor(f);
      int i0 = int(mod(i0f, 5.0));
      int i1 = int(mod(i0f + 1.0, 5.0));
      tcol = mix(uDomainColors[i0], uDomainColors[i1], f - i0f);
    } else {                                    // single accent tint
      tcol = uTextDuoB;
    }
    col = mix(col, tcol, uTextColor);
  }
  col = mix(col, uColorHot, vGlow * 0.8);
  float alpha = falloff * (0.55 + vGlow * 0.45) * (1.0 - uDim * 0.88);
  gl_FragColor = vec4(col, alpha);
}
`;

/* ------------------------------------------------------------------ scene */

let ctx = null; // singleton context shared with filter-scene

function buildParticles(count) {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const dom = new Float32Array(count);
  const morphSeed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // galaxy/nebula field: flattened disc + halo
    const arm = Math.random() * Math.PI * 2;
    const rad = Math.pow(Math.random(), 0.6) * 26;
    const halo = Math.random() < 0.25;
    const y = halo ? (Math.random() - 0.5) * 22 : (Math.random() - 0.5) * 5 * (1 - rad / 30);
    pos[i * 3] = Math.cos(arm + rad * 0.12) * rad;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = Math.sin(arm + rad * 0.12) * rad - 4;
    seed[i] = Math.random();
    dom[i] = Math.random() < 0.3 ? Math.floor(Math.random() * DOMAIN_IDS.length) : -1;
    morphSeed[i] = Math.random();
  }
  // morph targets preallocated and seeded to home so uMorph=0 == today.
  const tgtA = pos.slice();
  const tgtB = pos.slice();
  // per-particle centroid of the glyph it belongs to (name space). Defaults to
  // the home position so the breath term (p - aLetterCenter) is ZERO until the
  // text sampler fills it — keeps the breath a no-op for the legacy intro.
  const letterC = pos.slice();
  // per-particle glyph order, normalized 0..1 (first→last letter). Drives the
  // staggered breath wave. Defaults to 0 (no stagger) until the sampler fills it.
  const letterIdx = new Float32Array(count);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  geo.setAttribute("aDomain", new THREE.BufferAttribute(dom, 1));
  geo.setAttribute("aTargetA", new THREE.BufferAttribute(tgtA, 3));
  geo.setAttribute("aTargetB", new THREE.BufferAttribute(tgtB, 3));
  geo.setAttribute("aMorphSeed", new THREE.BufferAttribute(morphSeed, 1));
  geo.setAttribute("aLetterCenter", new THREE.BufferAttribute(letterC, 3));
  geo.setAttribute("aLetterIndex", new THREE.BufferAttribute(letterIdx, 1));
  return geo;
}

/**
 * Initialize the background scene. Returns the shared context, or throws
 * (caller adds the `no-3d` class on <html>).
 */
export function initScene(cvData) {
  const configured = Number(cvData?.site_config?.particle_count);
  if (Number.isFinite(configured)) {
    baseCount = Math.max(PARTICLE_MIN, Math.min(PARTICLE_MAX, Math.round(configured)));
  }
  const canvas = document.getElementById("bg3d");
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: true,
    powerPreference: "high-performance"
  });
  const gl = renderer.getContext();
  let tier = pickTier(gl);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 200);
  camera.position.set(0, 0, 30);

  const uniforms = {
    uTime: { value: 0 },
    uMouse: { value: new THREE.Vector2(999, 999) },
    uScroll: { value: 0 },
    uPixelRatio: { value: 1 },
    uStatic: { value: 0 },
    uMorph: { value: 0 },
    uBurst: { value: 0 },
    uNameMode: { value: 0 },
    uGather: { value: 0 },
    uGatherPos: { value: new THREE.Vector3(0, 0, 0) },
    uDomGather: { value: [0, 0, 0, 0, 0] },
    uDomGatherPos: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
    uGatherWave: { value: 3.0 },
    uDomFilament: { value: [0, 0, 0, 0, 0] },
    uDomOrigin: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
    uDomSpread: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
    uBreath: { value: 0 },
    uBreathT: { value: 0 },
    uBreathAmp: { value: 0.18 },
    uBreathStagger: { value: 0 },
    uSwirl: { value: 0 },
    uDim: { value: 0 },
    uColorBase: { value: new THREE.Color(getToken("--c-particle-base")) },
    uColorHot: { value: new THREE.Color(getToken("--c-particle-hot")) },
    uDomainColors: { value: DOMAIN_IDS.map((d) => new THREE.Color(getDomainColor(d))) },
    // Coherent colouring for the name (Home) / initials (Contact). uTextColor
    // fades in only on those scenes (driven by the morph director); uTextMode
    // picks the scheme (0 random/off, 1 palette gradient, 2 duotone, 3 single).
    uTextColor: { value: 0 },
    uTextMode: { value: 1 },
    uColorLoops: { value: 1 },                                   // mode 4: repetitions of the 5-colour cycle
    uTextPalette: { value: huePalette() },                       // domain colours sorted by hue → smooth sweep
    uTextDuoA: { value: new THREE.Color(getToken("--c-accent-1")) },
    uTextDuoB: { value: new THREE.Color(getToken("--c-accent-2")) }
  };

  const material = new THREE.ShaderMaterial({
    vertexShader: BG_VERT,
    fragmentShader: BG_FRAG,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });

  let points = null;
  let morphOn = false; // recomputed per tier in applyTier()
  function applyTier(t) {
    tier = t;
    const cfg = TIERS[t];
    const dpr = Math.min(devicePixelRatio || 1, cfg.dprCap);
    renderer.setPixelRatio(dpr);
    uniforms.uPixelRatio.value = dpr;
    uniforms.uStatic.value = t === "low" || reduced ? 1 : 0;
    morphOn = !!cfg.morph && !reduced;
    // a tier rebuild discards the old buffers (incl. any filled targets);
    // reset the morph state so the fresh galaxy buffer reads as "today".
    uniforms.uMorph.value = 0;
    uniforms.uBurst.value = 0;
    uniforms.uNameMode.value = 0;
    uniforms.uGather.value = 0;
    uniforms.uBreath.value = 0;
    uniforms.uBreathT.value = 0;
    uniforms.uSwirl.value = 0;
    uniforms.uGatherPos.value.set(0, 0, 0);
    if (points) {
      scene.remove(points);
      points.geometry.dispose();
    }
    points = new THREE.Points(buildParticles(tierCount(t)), material);
    points.frustumCulled = false;
    scene.add(points);
  }
  applyTier(tier);

  // declared before resize(): renderOnce() runs during the initial resize()
  // call on static tiers and must not hit the const in its TDZ
  const layers = []; // { scene, camera, visible, update(dt) }

  function resize() {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    if (bgStatic()) renderOnce();
  }
  addEventListener("resize", resize);
  resize();

  /* ---- pointer (smoothed in update) ---- */
  const mouseTarget = new THREE.Vector2(999, 999);
  addEventListener("pointermove", (e) => {
    // project to z=0 plane of the bg camera
    const ndc = new THREE.Vector3((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1, 0.5);
    ndc.unproject(camera);
    const dir = ndc.sub(camera.position).normalize();
    const t = -camera.position.z / dir.z;
    mouseTarget.set(camera.position.x + dir.x * t, camera.position.y + dir.y * t);
  }, { passive: true });

  /* ---- scroll ---- */
  let scrollTarget = 0;
  addEventListener("scroll", () => {
    const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    scrollTarget = scrollY / max;
  }, { passive: true });

  /* ---- loop + layers ---- */
  const clock = new THREE.Clock();
  let rafId = 0;
  let running = false;
  let canvasVisible = true;

  // fps watchdog
  let slowMs = 0;

  function bgStatic() {
    return tier === "low" || reduced;
  }

  function anyLayerVisible() {
    return layers.some((l) => l.visible);
  }

  function renderOnce() {
    renderer.autoClear = true;
    renderer.render(scene, camera);
    renderer.autoClear = false;
    for (const l of layers) {
      if (!l.visible) continue;
      renderer.clearDepth();
      renderer.render(l.scene, l.camera);
    }
    renderer.autoClear = true;
  }

  function frame() {
    rafId = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.1);

    // watchdog (only while animating, never on first frames)
    if (dt > 1 / 30 && clock.elapsedTime > 2) {
      slowMs += dt * 1000;
      if (slowMs > 3000 && tier !== "low") {
        const next = TIER_ORDER[TIER_ORDER.indexOf(tier) + 1];
        console.info(`[three-scene] fps watchdog: degrading tier -> ${next}`);
        applyTier(next);
        slowMs = 0;
      }
    } else if (dt <= 1 / 30) {
      slowMs = 0;
    }

    if (!bgStatic()) {
      uniforms.uTime.value += dt;
      uniforms.uMouse.value.lerp(mouseTarget, 0.06);
      uniforms.uScroll.value += (scrollTarget - uniforms.uScroll.value) * 0.05;
    }
    for (const l of layers) if (l.visible && l.update) l.update(dt);
    renderOnce();

    // static background with no layers: stop after this frame
    if (bgStatic() && !anyLayerVisible()) stop();
  }

  function start() {
    if (running || document.hidden || !canvasVisible) return;
    running = true;
    clock.getDelta();
    rafId = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });
  watchVisibility(canvas, undefined, (visible) => {
    canvasVisible = visible;   // start() reads this flag, so set it first
    if (visible) start();
    else stop();
  });

  if (bgStatic()) {
    // single static frame, no loop
    uniforms.uTime.value = 7;
    renderOnce();
  } else {
    start();
  }

  // reusable scratch for worldFromScreen (zero-alloc at steady state)
  const _wfsV = new THREE.Vector3();
  const _wfsDir = new THREE.Vector3();

  ctx = {
    renderer,
    camera,
    tier: () => tier,
    reducedMotion: reduced,
    /** True when the current tier (and not reduced) supports the morph engine. */
    morphEnabled: () => morphOn && !bgStatic(),
    /** Write uMorph (0..2). Re-render immediately if the bg is static. */
    setMorph(v) {
      if (!morphOn) return;
      uniforms.uMorph.value = v;
      if (bgStatic()) renderOnce();
    },
    /** Read the current uMorph value (0..2). */
    getMorph() {
      return uniforms.uMorph.value;
    },
    /** Write uBurst (0..1 outward scatter). */
    setBurst(v) {
      if (!morphOn) return;
      uniforms.uBurst.value = v;
      if (bgStatic()) renderOnce();
    },
    /** Write uNameMode (0..1, gates mouse repulsion to the text phase). */
    setNameMode(v) {
      if (!morphOn) return;
      uniforms.uNameMode.value = v;
      if (bgStatic()) renderOnce();
    },
    /** Blend amount toward the coherent name/initials colour (0..1). */
    setTextColor(v) {
      uniforms.uTextColor.value = v;
      if (bgStatic()) renderOnce();
    },
    /** Coherent colour scheme: 0 random/off, 1 palette-gradient, 2 duotone, 3 single, 4 Exp-loop. */
    setTextMode(m) {
      uniforms.uTextMode.value = m | 0;
      if (bgStatic()) renderOnce();
    },
    /** Mode-4 cycle repetitions along the text (1 = one pass, N = N loops). */
    setColorLoops(n) {
      uniforms.uColorLoops.value = Math.max(1, +n || 1);
      if (bgStatic()) renderOnce();
    },
    /** Write uGather (0..1 collapse toward the apparition point). */
    setGather(v) {
      if (!morphOn) return;
      uniforms.uGather.value = v;
      if (bgStatic()) renderOnce();
    },
    /** Move the gather/apparition point (world coords) — used for the vibration. */
    setGatherPos(x, y, z = 0) {
      if (!morphOn) return;
      uniforms.uGatherPos.value.set(x, y, z);
      if (bgStatic()) renderOnce();
    },
    /** Per-domain gather amount (Expertise). idx 0..3, v 0..1. Independent per
     *  domain so a hovered card can ramp up while the previous releases. */
    setDomGather(idx, v) {
      if (!morphOn) return;
      uniforms.uDomGather.value[idx] = v;
      if (bgStatic()) renderOnce();
    },
    /** Per-domain gather target (Expertise), world coords. */
    setDomGatherPos(idx, x, y, z = 0) {
      if (!morphOn) return;
      uniforms.uDomGatherPos.value[idx].set(x, y, z);
      if (bgStatic()) renderOnce();
    },
    /** Per-domain FILAMENT mode (Experience). 1 = stream the domain along
     *  origin→target instead of gathering to the point. */
    setDomFilament(idx, v) {
      if (!morphOn) return;
      uniforms.uDomFilament.value[idx] = v;
      if (bgStatic()) renderOnce();
    },
    /** Per-domain filament SOURCE (the lit chip), world coords. */
    setDomOrigin(idx, x, y, z = 0) {
      if (!morphOn) return;
      uniforms.uDomOrigin.value[idx].set(x, y, z);
      if (bgStatic()) renderOnce();
    },
    /** Per-domain filament SPREAD: half-extent (world) of the lit cards' box, so
     *  the cone fans out to cover every selected experience. */
    setDomSpread(idx, hx, hy, hz = 0) {
      if (!morphOn) return;
      uniforms.uDomSpread.value[idx].set(hx, hy, hz);
      if (bgStatic()) renderOnce();
    },
    /** Write uBreath (global per-letter expansion; all letters together). */
    setBreath(v) {
      if (!morphOn) return;
      uniforms.uBreath.value = v;
      if (bgStatic()) renderOnce();
    },
    /** Advance the staggered-breath clock (seconds). <=0 = inert. */
    setBreathClock(t) {
      if (!morphOn) return;
      uniforms.uBreathT.value = t;
      if (bgStatic()) renderOnce();
    },
    /** Configure the breath wave: peak expansion + per-letter delay (s). */
    setBreathParams(amp, staggerSeconds) {
      if (amp != null) uniforms.uBreathAmp.value = amp;
      if (staggerSeconds != null) uniforms.uBreathStagger.value = staggerSeconds;
    },
    /** Write uSwirl (radians of swirl around the gather point; vortex explosion). */
    setSwirl(v) {
      if (!morphOn) return;
      uniforms.uSwirl.value = v;
      if (bgStatic()) renderOnce();
    },
    /**
     * Direct access to the morph target buffers for in-place filling.
     * markTargetsDirty() flags both target attributes for GPU upload.
     */
    getMorphBuffers() {
      const g = points.geometry;
      return {
        geometry: g,
        count: g.attributes.position.count,
        position: g.attributes.position.array,
        aTargetA: g.attributes.aTargetA.array,
        aTargetB: g.attributes.aTargetB.array,
        aLetterCenter: g.attributes.aLetterCenter.array,
        aLetterIndex: g.attributes.aLetterIndex.array,
        markTargetsDirty() {
          g.attributes.aTargetA.needsUpdate = true;
          g.attributes.aTargetB.needsUpdate = true;
          g.attributes.aLetterCenter.needsUpdate = true;
          g.attributes.aLetterIndex.needsUpdate = true;
        }
      };
    },
    /**
     * Map normalized screen coords (x,y in [-1,1], y up) to a world point on
     * the z=`z` plane of the bg camera. Matches the unproject math used for
     * the pointer slab and hero-orbit's band fit.
     */
    worldFromScreen(nx, ny, z = 0) {
      _wfsV.set(nx, ny, 0.5).unproject(camera);
      _wfsDir.copy(_wfsV).sub(camera.position).normalize();
      const tt = (z - camera.position.z) / _wfsDir.z;
      return _wfsV.copy(camera.position).add(_wfsDir.multiplyScalar(tt)).clone();
    },
    /** Show/hide JUST the particle cloud (other layers, e.g. glass, stay).
     *  Used on mobile to hand off to the CPU physics layer. */
    setParticlesVisible(v) {
      if (points) points.visible = !!v;
      if (bgStatic()) renderOnce();
    },
    /** Animate background dimming (0 normal .. 1 dimmed for filter mode). */
    setDim(v, dur = 1) {
      if (window.gsap) window.gsap.to(uniforms.uDim, { value: v, duration: dur, ease: "expo.inOut" });
      else uniforms.uDim.value = v;
    },
    /**
     * Register an overlay layer rendered after (on top of) the background.
     * Returns handles to toggle visibility; setting visible restarts the
     * loop if the static background had parked it.
     */
    addLayer(layer) {
      layers.push(layer);
      return {
        setVisible(v) {
          layer.visible = v;
          if (v) start();
          else if (bgStatic()) renderOnce();
        }
      };
    },
    requestRender: renderOnce,
    /**
     * Render JUST the particle background (no overlay layers) into an offscreen
     * render target, from the live bg camera. Used by experience-glass so its
     * transmission slabs can refract the REAL galaxy (a layer's transmission
     * pass can only sample objects in its own scene, so it samples this RT via
     * a backdrop quad). Restores the previous target + autoClear state.
     */
    renderToTarget(target) {
      const prevTarget = renderer.getRenderTarget();
      const prevAuto = renderer.autoClear;
      renderer.setRenderTarget(target);
      renderer.autoClear = true;
      renderer.clear();
      renderer.render(scene, camera);
      renderer.autoClear = prevAuto;
      renderer.setRenderTarget(prevTarget);
    }
  };

  // Live colour refresh: re-read the domain/theme colours into the uniforms so the
  // particle field follows palette edits WITHOUT a reload — keeping it in lock-step
  // with the CSS-coloured Experience/expskill/Expertise chrome. The editor calls
  // this right AFTER evolvedcvApplyTheme (which injects the fresh CSS tokens).
  function refreshColors() {
    uniforms.uColorBase.value.set(getToken("--c-particle-base"));
    uniforms.uColorHot.value.set(getToken("--c-particle-hot"));
    DOMAIN_IDS.forEach((d, i) => uniforms.uDomainColors.value[i].set(getDomainColor(d)));
    huePalette().forEach((c, i) => uniforms.uTextPalette.value[i].copy(c));
    uniforms.uTextDuoA.value.set(getToken("--c-accent-1"));
    uniforms.uTextDuoB.value.set(getToken("--c-accent-2"));
    if (bgStatic()) renderOnce();
  }
  ctx.refreshColors = refreshColors;
  window.evolvedcvApplySceneColors = refreshColors;

  return ctx;
}

export function getSceneContext() {
  return ctx;
}
