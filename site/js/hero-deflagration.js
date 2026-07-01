/**
 * hero-deflagration.js — Phase 1 Block 2 "intro_timing data-driven + split esplosione/composizione".
 *
 * Owns the first-second choreography of the single persistent particle system
 * (the bg "matter") and the scroll-driven melt handoff to the inline
 * constellation. It writes ONLY the morph buffers/uniforms exposed by
 * three-scene.js (aTargetA/aTargetB + uMorph/uBurst/uNameMode) — it never
 * creates a renderer, scene, or RAF of its own.
 *
 * Choreography (slow & majestic — req 9):
 *   FALL            [intro_timing.fall, default 0.7s]
 *                   point-of-light "fall": a slow, soft pre-burst swell.
 *   EXPLOSION       [intro_timing.explosion, default 1.0s]
 *                   burst fires up to peak (~0.95) and holds there while
 *                   morph stays near 0 — the matter truly EXPLODES outward
 *                   before any gathering begins.
 *   COMPOSITION     [intro_timing.composition_name, default 1.6s]
 *                   morph eases 0→1 on power3.out while burst recedes to 0;
 *                   the cloud gathers gently into "CHRISTINA DEBUG".
 *   BREATH          [intro_timing.breath, default 0.6s]
 *                   hold uMorph=1 (name breathes via uTime) before DOM reveal.
 *   SHOW_TEXT       [intro_timing.show_text, default 0.7s per glyph set]
 *                   hero headline/sub/meta assemble glyph-by-glyph.
 *   COUNTER_FADE    [intro_timing.counter_fade, default 0.8s]
 *                   hero counters fade in.
 *
 *   All durations are read from site_config.intro_timing in cv_data.json (passed
 *   in via `data`). Missing keys fall back to the defaults above — a stripped
 *   JSON still works.
 *
 *   scroll    a smoothed (scrub:1.2) ScrollTrigger over #hero->#about drives
 *             uMorph 1->0 and eases setNameMode toward 0: the name melts back
 *             into the galaxy elastically (req 10). LEGACY fallback only —
 *             desktop scene-nav owns the melt and kills this ST.
 *
 * Guards: no-op without WebGL ctx, with prefers-reduced-motion, or on a tier
 * where morph is disabled (low). In those cases the site behaves exactly as
 * before and the DOM hero name stays visible (CSS keys off the body class we
 * intentionally do NOT add).
 *
 * Accessibility: on activate we add body.deflagration-active; CSS sr-only's
 * the DOM hero name (kept in the DOM for SR/SEO, not display:none).
 *
 * Block 1 (Velo + gate): the timeline is built PAUSED. The internal waitFor
 * gate has been replaced by an external gate: initHeroDeflagration now returns
 *   { play, dispose, whenReady }
 * where whenReady is a Promise that resolves once fillNameTargets() has run and
 * the GPU buffers are loaded. main.js waits for this (raced against a safety
 * timeout), fades the loader, then calls play().
 */
import { sampleTextToTargets } from "./text-sampler.js";
import { applyScreenTransform } from "./particle-shapes.js";
import { splitIntoGlyphs, glyphScatter, glyphAssemble } from "./glyph.js";
import { flagIcon } from "./icons.js";
import { set, get } from "./state.js";

let activeTl = null;
let scrollTriggers = [];
let resizeHandler = null;
let langBanner = null;       // step 7 LANGUAGE banner (one-shot intro element)
let langBannerDone = false;  // dismissed (clicked) or collapsed (scrolled away)

/** Default intro timing values. Used when site_config.intro_timing is absent or a key is missing.
 *  Each of the 4 particle steps maps to ONE tunable key (seconds):
 *    apparition       — edges→dot + still + vibration + freeze (the whole step 1)
 *    explosion        — the burst (step 2); the flavour is site_config.intro_explosion
 *    composition_name — matter gathers into the name (step 3)
 *    breath           — the per-letter breath wave total (step 4)
 *  show_text / counter_fade time the DOM hero reveal that follows. */
const TIMING_DEFAULTS = {
  apparition: 2.2,
  explosion: 0.85,
  composition_name: 1.6,
  breath: 2.4,
  show_text: 0.7,
  counter_fade: 0.8,
  language: 0.6
};
// Shape of one letter's breath inside the shader (breathEnv): rise + settle (s).
// The per-letter stagger fills whatever time is left in T.breath after this.
const BREATH_SHAPE = 1.72;
const BREATH_AMP = 0.18;        // peak per-letter expansion
const SCATTER_BURST = 1.8;      // pre-apparition field radius (screen ~empty)
const VIB_AMP = 2.6;            // peak vibration excursion (world units)
const DEFAULT_EXPLOSION = "fireworks";

/**
 * Read intro_timing from cv_data.json (passed as `data`), merging against
 * TIMING_DEFAULTS so every key is always a valid positive float.
 */
function readTiming(data) {
  const raw = (data && data.site_config && data.site_config.intro_timing) || {};
  const t = {};
  for (const key of Object.keys(TIMING_DEFAULTS)) {
    const v = parseFloat(raw[key]);
    t[key] = (Number.isFinite(v) && v > 0) ? v : TIMING_DEFAULTS[key];
  }
  return t;
}

export function initHeroDeflagration(data, sceneCtx) {
  // ---- guards: leave the site exactly as today ----
  // ?preview=1 (used by the local editor's live preview) does NOT play the
  // intro animation, but — unlike reduced-motion — it still composes the name
  // into its FINAL state (particles forming the name) so the editor shows the
  // site as it looks after the intro, not the white DOM-name fallback. The
  // preview branch is taken further down, once the buffers/sampler are ready.
  const previewMode = new URLSearchParams(location.search).get("preview") === "1";
  if (!sceneCtx || sceneCtx.reducedMotion || !sceneCtx.morphEnabled || !sceneCtx.morphEnabled()) {
    return { dispose() {}, play() {}, whenReady: Promise.resolve() };
  }
  const g = window.gsap;
  if (!g) return { dispose() {}, play() {}, whenReady: Promise.resolve() };

  dispose(); // clean re-init

  const meltEnd = document.getElementById("about");   // legacy scroll-melt end anchor (next scene)
  const isMobile = window.matchMedia("(max-width: 767px)").matches;

  document.body.classList.add("deflagration-active");

  // ---- timing (data-driven, falls back to defaults) ----
  const T = readTiming(data);

  // ---------------------------------------------------------------- buffers
  const buf = sceneCtx.getMorphBuffers();
  const count = buf.count;

  /** Apply the Home (hero) position/scale config from cv_ui to a target buffer,
   *  so the intro composes the name where the editor's Animation tab says.
   *  Mirrors applyTransform() in particle-shapes.js (scale around screen centre
   *  + screen-space offset in normalized [-1,1] coords). */
  function applyHomeTransform(arr, n) {
    let cfg = data && data.particle_pages && data.particle_pages.hero;
    if (!cfg) return;
    // Tolerate the legacy nested-by-device shape ({desktop:{…}}) and a single
    // `scale`, so an un-migrated config still positions the name correctly.
    if (cfg.desktop && typeof cfg.desktop === "object") cfg = cfg.desktop;
    const sc = cfg.scale;
    const sx = cfg.scaleX != null ? cfg.scaleX : (sc != null ? sc : 1);
    const sy = cfg.scaleY != null ? cfg.scaleY : (sc != null ? sc : 1);
    const ox = cfg.x || 0, oy = cfg.y || 0;
    applyScreenTransform(arr, n, sx, sy, ox, oy, (nx, ny) => sceneCtx.worldFromScreen(nx, ny, 0));
  }

  /** Fill aTargetA from the rasterized name — resolves whenReady. */
  function fillNameTargets() {
    const cam = sceneCtx.camera;
    const mapPixelToWorld = (px, py, W, H) => {
      const nx = (px / W) * 2 - 1;
      const ny = -((py / H) * 2 - 1);
      const w = sceneCtx.worldFromScreen(nx, ny, 0);
      return { x: w.x, y: w.y, z: w.z };
    };
    const { targets, letterCenters, letterIndex } = sampleTextToTargets(data.profile.name.toUpperCase(), {
      count,
      lines: isMobile ? 2 : 1,
      yFrac: isMobile ? 0.32 : 0.36, // upper-center band; DOM hero sits below it
      mapPixelToWorld,
      withLetterCenters: true        // also tag each particle with its glyph centroid + order (for the breath)
    });
    applyHomeTransform(targets, count); // honour the Home position/scale config (cv_ui)
    buf.aTargetA.set(targets);
    if (buf.aLetterCenter && letterCenters) buf.aLetterCenter.set(letterCenters);
    if (buf.aLetterIndex && letterIndex) buf.aLetterIndex.set(letterIndex);
    buf.markTargetsDirty();
    void cam; // (cam captured for clarity; mapping uses worldFromScreen)
  }

  // ---------------------------------------------------------------- whenReady
  // Resolves when fillNameTargets() has completed. The idle-callback strategy
  // is kept so the rasterization doesn't block the compositing frame. We hand
  // the resolver out via the promise so main.js can sequence the reveal.
  let _targetsReady = false; // used by the resize handler
  let _resolveReady;
  const whenReady = new Promise((resolve) => { _resolveReady = resolve; });

  const startSampling = () => {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1));
    const fontsReady = document.fonts
      ? document.fonts.ready
          .then(() => document.fonts.load("700 100px 'Space Grotesk'"))
          .catch(() => {})
      : Promise.resolve();
    fontsReady.then(() =>
      idle(() => {
        fillNameTargets();
        _targetsReady = true;
        _resolveReady();
      })
    );
  };
  startSampling();

  // ---------------------------------------------------------------- preview branch
  // Editor live preview: jump straight to the END state (name fully composed),
  // with no timeline, no DOM-glyph scatter and no scroll-melt ScrollTriggers, so
  // the name simply sits there as on the finished site. deflagration-active was
  // already added above, so the white DOM hero name is sr-only'd and the hero is
  // offset for the particle name. Re-samples when the editor changes the size.
  if (previewMode) {
    // Same uniforms the timeline lands on at the end of COMPOSITION/BREATH:
    // gather 0 (NOT 1 — gather 1 would collapse every particle onto the centre
    // dot, hiding the name), burst/swirl 0, morph 1, nameMode 1.
    const applyFinal = () => {
      sceneCtx.setGather(0); sceneCtx.setBurst(0); sceneCtx.setSwirl(0);
      sceneCtx.setMorph(1); sceneCtx.setNameMode(1);
      sceneCtx.setBreath(0); sceneCtx.setBreathClock(0); sceneCtx.setGatherPos(0, 0, 0);
    };
    applyFinal();              // immediate (targets fill in a tick → name appears)
    whenReady.then(applyFinal); // recompose once the name targets are sampled
    // The header is hidden off-screen by CSS (body.deflagration-active
    // .site-header { translateY(-100%) }) and is normally slid in by the
    // timeline we skip here — reveal it directly so the preview shows it.
    const hdrEl = document.querySelector(".site-header");
    if (hdrEl) { hdrEl.style.transform = "translateY(0)"; hdrEl.style.willChange = "auto"; }
    // NOTE: the "evolvedcv:intro-done" signal (which unlocks scene-nav) is NOT
    // emitted here. There is no timeline, and scene-nav attaches its listener
    // later in boot (behind dynamic imports), so main.js emits it for us on the
    // reveal path — exactly as it does for the no-intro/reduced-motion case.
    let rzTimer;
    resizeHandler = () => {
      clearTimeout(rzTimer);
      rzTimer = setTimeout(() => { if (_targetsReady) fillNameTargets(); applyFinal(); }, 160);
    };
    addEventListener("resize", resizeHandler, { passive: true });
    return { dispose, play() {}, whenReady };
  }

  // ---------------------------------------------------------------- timeline (PAUSED)
  // Starts paused; main.js calls play() after the loader fades, so the first
  // frame the user sees is already the intro. Data-driven choreography:
  //   1 APPARITION   2 EXPLOSION (swappable)   3 COMPOSITION   4 BREATH   + text.
  const breathStagger = Math.max(0, T.breath - BREATH_SHAPE); // time left for the first→last wave
  const explosionKind = (data && data.site_config && data.site_config.intro_explosion) || DEFAULT_EXPLOSION;

  // hero DOM — assembled glyph-by-glyph once the name lands (hidden until then;
  // it sits under the loader overlay during the particle phases).
  const glyphSets = [
    document.querySelector(".hero__headline"),
    document.querySelector(".hero__sub"),
    document.querySelector(".hero__meta")
  ].filter(Boolean).map((node) => splitIntoGlyphs(node)).filter((set) => set.length);
  const counterEl = document.querySelector(".hero__counters");
  const headerEl = document.querySelector(".site-header");
  glyphSets.forEach((set) => glyphScatter(g, set));
  if (counterEl) g.set(counterEl, { opacity: 0, y: 18 });

  // step 7 LANGUAGE banner (built hidden; revealed at the end of the timeline).
  // Mobile: skip — the header already has the EN/IT toggle; no intro banner needed.
  langBannerDone = false;
  langBanner = isMobile ? null : buildLangBanner();

  // proxies the tweens drive into the shader uniforms
  const P = { gather: { v: 0 }, burst: { v: SCATTER_BURST }, swirl: { v: 0 },
              morph: { m: 0 }, name: { v: 0 }, breath: { t: 0 }, pos: { x: 0, y: 0 } };
  const setGather = () => sceneCtx.setGather(P.gather.v);
  const setBurst  = () => sceneCtx.setBurst(P.burst.v);
  const setSwirl  = () => sceneCtx.setSwirl(P.swirl.v);
  const setMorph  = () => sceneCtx.setMorph(P.morph.m);
  const setName   = () => sceneCtx.setNameMode(P.name.v);
  const setPos    = () => sceneCtx.setGatherPos(P.pos.x, P.pos.y, 0);
  const setClock  = () => sceneCtx.setBreathClock(P.breath.t);

  // initial state: scattered far + not yet gathered ⇒ screen ~empty (under loader)
  sceneCtx.setMorph(0); sceneCtx.setNameMode(0); sceneCtx.setSwirl(0);
  sceneCtx.setBreath(0); sceneCtx.setBreathClock(0);
  sceneCtx.setBreathParams(BREATH_AMP, breathStagger);
  sceneCtx.setBurst(SCATTER_BURST); sceneCtx.setGather(0); sceneCtx.setGatherPos(0, 0, 0);

  const tl = g.timeline({ paused: true });
  activeTl = tl;

  // ---- 1. APPARITION [T.apparition]: edges → bright dot, rest, vibrate, snap, HOLD ----
  const A = T.apparition;
  tl.to(P.gather, { v: 1, duration: A * 0.30, ease: "power2.in", onUpdate: setGather });
  tl.to({}, { duration: A * 0.06 });                       // the dot rests after arriving
  tl.to({ p: 0 }, {                                        // vibration: random, growing
    p: 1, duration: A * 0.46, ease: "none",
    onUpdate() {
      const pr = this.progress(); const tm = this.time();
      const amp = VIB_AMP * pr * pr; const f = 6 + pr * 26; const a = tm * f;
      P.pos.x = (Math.sin(a) + 0.5 * Math.sin(a * 2.7 + 1.3)) * amp * 0.66;
      P.pos.y = (Math.cos(a * 1.3) + 0.5 * Math.sin(a * 0.6 + 0.5)) * amp * 0.66;
      setPos();
    }
  });
  tl.to(P.pos, { x: 0, y: 0, duration: A * 0.06, ease: "power3.out", onUpdate: setPos }); // SNAP to dead centre
  tl.to({}, { duration: A * 0.12 });                       // HOLD: dot stays still before the blast

  // ---- 2. EXPLOSION [T.explosion] (flavour = site_config.intro_explosion) ----
  // All variants live here; swapping is a single config value. The dot releases
  // (gather 1→0) flinging particles out to the burst field, with per-flavour feel.
  const E = T.explosion;
  tl.addLabel("boom");
  if (explosionKind === "supernova") {
    tl.to(P.gather, { v: 0, duration: E * 0.70, ease: "expo.out", onUpdate: setGather }, "boom");
    tl.to(P.burst, { v: 2.5, duration: E * 0.28, ease: "power2.out", onUpdate: setBurst }, "boom");
    tl.to(P.burst, { v: 1.5, duration: E * 0.70, ease: "sine.out", onUpdate: setBurst }, "boom+=" + (E * 0.28));
  } else if (explosionKind === "vortex") {
    tl.to(P.gather, { v: 0, duration: E * 0.65, ease: "power2.out", onUpdate: setGather }, "boom");
    tl.to(P.burst, { v: 2.2, duration: E * 0.90, ease: "sine.out", onUpdate: setBurst }, "boom");
    tl.to(P.swirl, { v: 4.2, duration: E * 0.55, ease: "power2.out", onUpdate: setSwirl }, "boom");
    tl.to(P.swirl, { v: 0, duration: E * 0.45, ease: "sine.inOut", onUpdate: setSwirl }, "boom+=" + (E * 0.55));
  } else if (explosionKind === "implosion") {
    tl.to(P.gather, { v: 0.85, duration: E * 0.18, ease: "power2.out", onUpdate: setGather }, "boom");
    tl.to(P.gather, { v: 1.0, duration: E * 0.18, ease: "power2.in", onUpdate: setGather }, "boom+=" + (E * 0.18));
    tl.to(P.gather, { v: 0, duration: E * 0.55, ease: "expo.out", onUpdate: setGather }, "boom+=" + (E * 0.36));
    tl.to(P.burst, { v: 3.0, duration: E * 0.33, ease: "power2.out", onUpdate: setBurst }, "boom+=" + (E * 0.36));
    tl.to(P.burst, { v: 1.5, duration: E * 0.55, ease: "sine.out", onUpdate: setBurst }, "boom+=" + (E * 0.66));
  } else { // fireworks (default): quick launch + long decelerating push (weight)
    tl.to(P.gather, { v: 0, duration: E * 0.47, ease: "power2.out", onUpdate: setGather }, "boom");
    tl.to(P.burst, { v: 2.7, duration: E * 0.95, ease: "power3.out", onUpdate: setBurst }, "boom");
  }

  // ---- 3. COMPOSITION [T.composition_name]: matter gathers into the name ----
  tl.addLabel("compose", "boom+=" + E);
  if (isMobile) {
    // OPTION B: hand the name composition to the 2D physics layer (mobile-particles).
    // The WebGL stays exploded (no morph) and is hidden once the 2D has faded in.
    tl.call(() => window.dispatchEvent(new CustomEvent("evolvedcv:compose-handoff")), null, "compose");
  } else {
    tl.call(() => { P.swirl.v = 0; sceneCtx.setSwirl(0); P.gather.v = 0; sceneCtx.setGather(0); }, null, "compose");
    tl.to(P.morph, { m: 1, duration: T.composition_name, ease: "power3.out", onUpdate: setMorph,
      onComplete() { sceneCtx.setMorph(1); P.burst.v = 0; sceneCtx.setBurst(0); } }, "compose");
    tl.to(P.burst, { v: 0, duration: T.composition_name, ease: "power2.in", overwrite: "auto", onUpdate: setBurst }, "compose");
    tl.to(P.name, { v: 1, duration: T.composition_name * 0.75, ease: "sine.out", onUpdate: setName }, "compose+=0.3");
  }

  // ---- 4. BREATH [T.breath]: per-letter wave (first→last) with elastic settle ----
  // The clock runs 0→T.breath; each letter's local time is (clock - index*stagger)
  // so the breath travels across the name. Shape (rise+settle) lives in the shader.
  tl.addLabel("breath", "compose+=" + T.composition_name);
  tl.call(() => { sceneCtx.setMorph(1); P.burst.v = 0; sceneCtx.setBurst(0); sceneCtx.setBreathParams(BREATH_AMP, breathStagger); }, null, "breath");
  tl.to(P.breath, { t: T.breath, duration: T.breath, ease: "none", onUpdate: setClock,
    onComplete() { sceneCtx.setBreathClock(0); } }, "breath");

  // ---- hero text + counters: assemble glyph-by-glyph as the name lands ----
  const textAt = "compose+=" + (T.composition_name * 0.85);
  if (headerEl) {
    tl.call(() => {
      g.fromTo(headerEl, { y: "-100%", autoAlpha: 0.3 },
        { y: "0%", autoAlpha: 1, duration: 0.6, ease: "power2.out", clearProps: "will-change" });
    }, null, textAt);
  }
  if (glyphSets.length) {
    glyphSets.forEach((set, i) => {
      tl.add(glyphAssemble(g, set, { duration: T.show_text }), i === 0 ? textAt : "<+=0.12");
    });
    if (counterEl) tl.to(counterEl, { opacity: 1, y: 0, duration: T.counter_fade, ease: "power2.out" }, "<+=0.1");
  } else if (counterEl) {
    tl.to(counterEl, { opacity: 1, y: 0, duration: T.counter_fade, ease: "power2.out" }, textAt);
  }

  // ---- 7. LANGUAGE: the banner fades in beside the text (last beat of the intro) ----
  if (langBanner) {
    tl.to(langBanner, { autoAlpha: 1, y: 0, duration: T.language, ease: "power2.out" }, ">-0.05");
  }

  // ------------------------------------------------------------- scroll melt
  // The name DISSOLVES back into the ambient galaxy as you scroll the hero out
  // (uMorph 1->0). This keeps the galaxy alive for the rest of the page. Scroll
  // is never hijacked (scrub only). This is the LEGACY fallback: on desktop
  // scene-nav owns the melt and kills this ST via disableScrollDriving().
  //
  // NOTE: initHeroDeflagration runs BEFORE initSceneNav in the boot sequence,
  // so the "scene-nav" class is not yet on body at this point. The ST below
  // IS created; but initSceneNav subsequently calls disableScrollDriving() to
  // kill it (belt-and-suspenders). The class check here is kept as an
  // optimization for any future where boot order changes.
  // Skip the scroll-melt on MOBILE: phones hand the name off to the Canvas-2D
  // physics layer (mobile-particles.js) on the first scroll, so this WebGL melt
  // would only fight that handoff. Desktop keeps the scrubbed melt.
  if (window.ScrollTrigger && meltEnd && !matchMedia("(max-width: 767px)").matches
      && !document.body.classList.contains("scene-nav")) {
    const st = window.ScrollTrigger.create({
      trigger: "#hero",
      start: "top top",
      endTrigger: "#about",
      end: "top center",
      // numeric scrub = smoothing lag (s): the morph glides toward the scroll
      // position instead of snapping to it, so a single wheel notch eases in
      // and out elastically rather than jumping and freezing (req 10).
      scrub: 1.2,
      onUpdate(self) {
        sceneCtx.setMorph(1 - self.progress);   // name -> galaxy home
        sceneCtx.setNameMode(1 - self.progress); // ease mouse text-repulsion toward the 30% floor
      }
    });
    scrollTriggers.push(st);
  }

  // ---------------------------------------------------------------- resize
  let rzTimer = 0;
  resizeHandler = () => {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(() => {
      // re-sample if targets have been computed at least once (safe to re-run)
      if (_targetsReady) fillNameTargets();
      if (window.ScrollTrigger) window.ScrollTrigger.refresh();
    }, 180);
  };
  addEventListener("resize", resizeHandler, { passive: true });

  // ------------------------------------------------------------- intro-done signal
  // Dispatched when the full intro choreography (particles + text + counters)
  // completes so that scene-nav can unlock scrolling. Using eventCallback on
  // the GSAP timeline ensures it fires in order, after all tweens complete.
  // The signal is dispatched exactly once per boot (the timeline is one-shot).
  tl.eventCallback("onComplete", () => {
    window.dispatchEvent(new CustomEvent("evolvedcv:intro-done"));
  });

  /** Start the intro timeline (called by main.js after the loader fades). */
  function play() {
    if (activeTl) activeTl.play();
  }

  /**
   * Imperative melt control for scene-nav (hero→pills transition).
   * p = 0: name fully formed; p = 1: galaxy (melt complete).
   * Called by initSceneNav instead of the scroll-driven ST when scene-nav active.
   */
  function setMelt(p) {
    sceneCtx.setMorph(1 - p);
    sceneCtx.setNameMode(1 - p);
  }

  /**
   * Kill the scroll-driven melt ScrollTrigger (called by initSceneNav after
   * boot, as a clean-up in case the "scene-nav" flag was set too late for the
   * conditional above — belt-and-suspenders).
   */
  function disableScrollDriving() {
    for (const st of scrollTriggers) {
      try { st.kill(); } catch { /* no-op */ }
    }
    scrollTriggers.length = 0;
  }

  return { play, dispose, whenReady, setMelt, disableScrollDriving, collapseLangBanner, langBannerPending };
}

/* ---- Step 7: LANGUAGE banner -------------------------------------------- */

/**
 * Build the language banner into #hero .hero__aside (right of the text on
 * desktop, below it on mobile). Two flag buttons; clicking one switches the
 * language and dissolves the banner. Returns the element (hidden until the
 * intro reveals it) or null if the slot is missing.
 */
function buildLangBanner() {
  const aside = document.querySelector("#hero .hero__aside");
  if (!aside) return null;
  const banner = document.createElement("div");
  banner.className = "hero-lang";
  banner.setAttribute("role", "group");
  banner.setAttribute("aria-label", "Choose language / Scegli la lingua");
  banner.innerHTML =
    '<button type="button" class="hero-lang__btn" data-lang="en" aria-label="English">' +
      flagIcon("en") + '<span class="hero-lang__code">EN</span></button>' +
    '<button type="button" class="hero-lang__btn" data-lang="it" aria-label="Italiano">' +
      flagIcon("it") + '<span class="hero-lang__code">IT</span></button>';
  aside.appendChild(banner);
  banner.querySelectorAll(".hero-lang__btn").forEach((b) => {
    b.addEventListener("click", () => dismissLangBanner(b.dataset.lang));
  });
  const g = window.gsap;
  if (g) g.set(banner, { autoAlpha: 0, y: 18 });
  return banner;
}

/** Fire a mouseout so the magnetic cursor releases this element BEFORE it is
 *  removed — the browser doesn't emit mouseout for a node removed under the
 *  pointer, which would otherwise leave the ring "stuck"/magnet-pulled on it. */
function releaseCursor(scope) {
  scope.querySelectorAll("button").forEach((b) =>
    b.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
}

/** A flag was clicked: dissolve the banner, THEN switch the language (with the
 *  glyph "assemble" effect on the hero text when the language actually changes). */
function dismissLangBanner(lang) {
  if (langBannerDone || !langBanner) return;
  langBannerDone = true;
  const banner = langBanner;
  langBanner = null;
  releaseCursor(banner);
  const changed = lang !== get("lang");
  const finish = () => {
    banner.remove();
    if (changed) { set({ lang }); animateHeroTextIn(); } // set() re-renders the hero in the new language
  };
  const g = window.gsap;
  if (!g) { finish(); return; }
  g.to(banner, { autoAlpha: 0, scale: 0.92, duration: 0.4, ease: "power2.out", onComplete: finish });
}

/** Re-assemble the (freshly re-rendered) hero headline/sub/meta glyph-by-glyph,
 *  so a language switch from the banner changes the text WITH the intro effect. */
function animateHeroTextIn() {
  const g = window.gsap;
  if (!g) return;
  const sets = [".hero__headline", ".hero__sub", ".hero__meta"]
    .map((s) => document.querySelector(s)).filter(Boolean)
    .map((n) => splitIntoGlyphs(n)).filter((set) => set.length);
  if (!sets.length) return;
  const tl = g.timeline();
  sets.forEach((set, i) => {
    glyphScatter(g, set);
    tl.add(glyphAssemble(g, set, { duration: 0.6 }), i === 0 ? 0 : "<+=0.1");
  });
}

/** True while the banner is still on screen awaiting a choice. */
function langBannerPending() {
  return !langBannerDone && !!langBanner;
}

/**
 * Scrolled away without choosing: the whole banner flies into the header
 * language toggle (#lang-toggle) and vanishes — same spirit as the pills
 * collapsing into the Filter FAB. Language is left unchanged. One-shot.
 * `onDone` fires when the fly-away finishes (scene-nav delays the scroll until
 * then, so the animation plays BEFORE the page scrolls down).
 */
function collapseLangBanner(onDone) {
  if (langBannerDone || !langBanner) { if (onDone) onDone(); return; }
  langBannerDone = true;
  const banner = langBanner;
  langBanner = null;
  // Freeze the aside's width BEFORE the banner leaves the flow, so removing it
  // can't reflow (widen) the hero text mid-scroll — that abrupt widening was the
  // "strange" jump on the first scroll away from the hero.
  const aside = banner.parentElement;
  if (aside) aside.style.width = aside.offsetWidth + "px";
  releaseCursor(banner);
  const done = () => { banner.remove(); if (onDone) onDone(); };
  const g = window.gsap;
  const toggle = document.getElementById("lang-toggle");
  if (!g || !toggle) { done(); return; }
  const t = toggle.getBoundingClientRect();
  const r = banner.getBoundingClientRect();
  // fly the banner up to the language toggle and only fade out as it ARRIVES,
  // so the motion clearly ends at the toggle (not mid-air).
  const tl = g.timeline({ onComplete: done });
  tl.to(banner, {
    x: (t.left + t.width / 2) - (r.left + r.width / 2),
    y: (t.top + t.height / 2) - (r.top + r.height / 2),
    scale: 0.22, duration: 0.7, ease: "power3.inOut", transformOrigin: "center center"
  }, 0);
  tl.to(banner, { autoAlpha: 0, duration: 0.28, ease: "power1.in" }, 0.46);
}

function dispose() {
  if (activeTl) {
    activeTl.kill();
    activeTl = null;
  }
  for (const st of scrollTriggers) {
    try { st.kill(); } catch { /* no-op */ }
  }
  scrollTriggers = [];
  if (resizeHandler) {
    removeEventListener("resize", resizeHandler);
    resizeHandler = null;
  }
  if (langBanner) { langBanner.remove(); langBanner = null; }
  langBannerDone = false;
  document.body.classList.remove("deflagration-active");
}
