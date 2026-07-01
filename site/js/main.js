/**
 * main.js — bootstrap. Load data -> i18n/theme -> render -> counters ->
 * 3D background (three-scene) -> filter mode (filter-scene).
 * The 3D modules are imported dynamically and every init is guarded:
 * the CV stays fully usable if WebGL/CDN/GSAP are unavailable.
 *
 * Block 1 (Velo + gate): a full-viewport loader overlay (#page-loader, inline
 * in index.html) covers everything from first paint. After all inits, we await
 * deflagration.whenReady (+ document.fonts.ready) raced against a 3500 ms
 * safety timeout, then fade the loader, add body.is-ready, and call
 * deflagration.play() so the very first visible frame is already the intro.
 * Fallback paths (no-3d / reduced-motion / timeout) always hide the loader.
 */
import { loadData } from "./data-loader.js";
import { set, get, subscribe } from "./state.js";
import { initI18n } from "./i18n.js";
import { initTheme } from "./theme.js";
import { initRenderer } from "./ui-renderer.js";
import { initCounters } from "./counters.js";
import { initHeaderBars } from "./header-bars.js";
import { initPageChrome } from "./page-chrome.js";
import { initPdfExport } from "./pdf-export.js";

const DEBUG = new URLSearchParams(location.search).get("debug") === "1";

function pickDefaultView(data) {
  const mobile = window.matchMedia("(max-width: 767px)").matches;
  return mobile
    ? data.site_config.default_view_mobile
    : data.site_config.default_view_desktop;
}

function initHeaderControls() {
  const langToggle = document.getElementById("lang-toggle");
  // keep the toggle label/aria in sync with the CURRENT language, however it was
  // changed (header click OR the intro language banner calling set({lang})).
  const syncLangToggle = () => {
    const cur = get("lang");
    langToggle.dataset.lang = cur; // CSS slides the knob under EN / IT
    langToggle.setAttribute("aria-label", cur === "en" ? "Language — current: English" : "Lingua — attuale: Italiano");
  };
  langToggle.addEventListener("click", () => {
    set({ lang: get("lang") === "en" ? "it" : "en" });
  });
  subscribe("lang", syncLangToggle);
  syncLangToggle();

  // PDF button: browser print (css/print.css, media="print"). When a filter is
  // active it asks full vs filtered selection first. (js/pdf-export.js)
  initPdfExport();

  // a11y: bilingual skip-link label
  const skipLink = document.getElementById("skip-link");
  if (skipLink) {
    const setSkipText = (lang) => {
      skipLink.textContent = lang === "it" ? "Salta al contenuto" : "Skip to content";
    };
    setSkipText(get("lang"));
    subscribe("lang", setSkipText);
  }
}

function showFatalError(err) {
  console.error(err);
  const main = document.querySelector("main");
  const box = document.createElement("div");
  box.className = "fatal-error";
  box.setAttribute("role", "alert");
  box.innerHTML =
    "<h2>Something went wrong</h2>" +
    "<p>The CV data could not be loaded. Please refresh the page or contact " +
    '<a href="mailto:christina.debug@example.com">christina.debug@example.com</a>.</p>';
  main.prepend(box);
}

/**
 * Fade out the #page-loader overlay, then remove it from the layer stack.
 * Safe to call multiple times (no-ops after first call).
 */
let _loaderHidden = false;
function hideLoader() {
  if (_loaderHidden) return;
  _loaderHidden = true;
  const el = document.getElementById("page-loader");
  if (!el) return;
  el.classList.add("page-loader--hidden");
  // After the 0.5s CSS transition, pull the element out of the layer stack so
  // it no longer intercepts pointer events or compositing.
  el.addEventListener("transitionend", () => {
    el.style.display = "none";
  }, { once: true });
  // Belt-and-suspenders: if transitionend never fires (e.g. reduced-motion
  // collapses the transition to 0.15 s and the event fires before we attach),
  // ensure the element is hidden within a reasonable time.
  setTimeout(() => { el.style.display = "none"; }, 700);
}

async function boot() {
  try {
    const data = await loadData();
    set({
      lang: data._meta.default_language || "en",
      filterView: pickDefaultView(data)
    });

    initI18n();
    initTheme(data);
    initRenderer(data);
    initCounters(data);
    initHeaderControls();
    initHeaderBars(data);
    initPageChrome(data);

    // F4: Three.js particle background (shared renderer + render loop).
    // Any failure (CDN down, no WebGL, context creation error) degrades to
    // a static page: html.no-3d + threeCtx = null.
    let threeCtx = null;
    try {
      threeCtx = (await import("./three-scene.js")).initScene(data);
    } catch (err) {
      console.warn("[main] 3D background unavailable — continuing without it", err);
      document.documentElement.classList.add("no-3d");
    }

    // F5: filter mode (FAB + overlay). ALWAYS initialized: without 3D the
    // FAB opens the accessible chip panel instead of the views.
    try {
      (await import("./filter-scene.js")).initFilterScene(data, threeCtx);
    } catch (err) {
      console.warn("[main] filter scene failed — CV remains usable without it", err);
    }

    // P1B1 "Il Continuum": hero deflagration choreography + scroll melt on the
    // shared particle system. MUST run before the inline orbit so the matter
    // settles onto the same node positions. Self-guards: no-op without WebGL,
    // with prefers-reduced-motion, or on the low (morph-disabled) tier — in
    // which case the DOM hero name stays visible.
    //
    // Block 1 (Velo): initHeroDeflagration now returns { play, dispose, whenReady }.
    // The timeline is PAUSED — play() is called below, after the loader fades.
    //
    // The deflagration runs on mobile too; its own internal guards handle
    // WebGL/reduced-motion/low-tier. mobile-particles.js arms itself via the
    // evolvedcv:intro-done event and hands off gracefully when WebGL ran.
    let deflagration = null;
    try {
      deflagration = (await import("./hero-deflagration.js")).initHeroDeflagration(data, threeCtx);
    } catch (err) {
      console.warn("[main] hero deflagration unavailable — continuing without it", err);
    }

    // F6a: scrollytelling (GSAP ScrollTrigger). No-op without GSAP or with
    // prefers-reduced-motion; the page is fully readable either way.
    let scrollStoryApi = null;
    try {
      const ss = await import("./scroll-story.js");
      ss.initScrollStory();
      // Expose the disableScrollDriving helper for scene-nav
      scrollStoryApi = { disableScrollDriving: ss.disableScrollDriving };
    } catch (err) {
      console.warn("[main] scroll story failed — continuing without scroll effects", err);
    }

    // P1B2: magnetic cursor. No-op without GSAP, with prefers-reduced-motion,
    // or on coarse-pointer devices (touch). If the import or init fails the
    // native cursor is unaffected (body class never added).
    try {
      (await import("./magnetic-cursor.js")).initMagneticCursor();
    } catch (err) {
      console.warn("[main] magnetic cursor unavailable — continuing with native cursor", err);
    }

    // B6: 3D card tilt on .exp-card. No-op on touch / reduced-motion.
    // Uses event delegation so it survives language-change re-renders.
    try {
      (await import("./card-tilt.js")).initCardTilt();
    } catch (err) {
      console.warn("[main] card tilt unavailable — continuing without tilt", err);
    }

    // Blocco C: accordion expand/collapse for .exp-card with GSAP Flip.
    // Fallback: works without GSAP Flip (no crash, no animation).
    try {
      (await import("./card-expand.js")).initCardExpand();
    } catch (err) {
      console.warn("[main] card expand unavailable — continuing without it", err);
    }

    // Real WebGL glass for the Experience cards: a LAYER in the shared #bg3d
    // renderer whose transmission slabs refract a particle field (the slabs +
    // field live in the same scene). Tracks each card/project rect so tilt,
    // scroll and expand/collapse are followed. Self-guards: no-op on
    // reduced-motion / no shared WebGL ctx → cards keep their CSS glass.
    try {
      (await import("./experience-glass.js")).initExperienceGlass();
    } catch (err) {
      console.warn("[main] experience glass unavailable — cards keep CSS look", err);
    }

    // Expertise particle halo (desktop): per-domain particles that gather to a
    // card's border on hover. No-op on mobile / reduced-motion (guarded inside).
    try {
      (await import("./expertise-particles.js")).initExpertiseParticles(threeCtx, data);
    } catch (err) {
      console.warn("[main] expertise particles unavailable — continuing without it", err);
    }

    // Per-scene particle morphing: each scene gathers the shared cloud into a
    // distinct silhouette (name / frame / edges / planet / initials). Returns
    // null on the morph-disabled tiers so scene-nav keeps its legacy melt.
    let shapesApi = null;
    try {
      shapesApi = (await import("./particle-shapes.js")).initParticleShapes(data, threeCtx) || null;
    } catch (err) {
      console.warn("[main] particle shapes unavailable — scenes keep the ambient field", err);
    }

    // Scene stepper: full-page step-scroll navigation. Must run AFTER all other
    // scroll modules so it can kill their conflicting ScrollTriggers. Self-guards:
    // no-op without GSAP or with prefers-reduced-motion (both checked internally).
    // Passes the deflagration API so transitions can drive the melt imperatively
    // instead of relying on scroll-position scrubs.
    try {
      (await import("./scene-nav.js")).initSceneNav(
        data,
        threeCtx,
        null,           // (was orbitApi — pills scene removed)
        deflagration,   // { play, dispose, whenReady, setMelt, disableScrollDriving }
        scrollStoryApi, // { disableScrollDriving }
        shapesApi       // { beginScene, refresh, dispose } | null
      );
    } catch (err) {
      console.warn("[main] scene-nav unavailable — continuing with free scroll", err);
    }

    // MOBILE physics layer (Option A): on phones, a Canvas-2D physics cloud takes
    // over from the WebGL morph at the first scroll. Self-guards to mobile width +
    // canvas2d + not reduced-motion; on desktop it does nothing. Keeps the
    // expertise (domain) colours. Desktop morph stays exactly as-is.
    try {
      (await import("./mobile-particles.js")).initMobileParticles(data, threeCtx);
    } catch (err) {
      console.warn("[main] mobile particles unavailable — mobile keeps the WebGL cloud", err);
    }

    // Footbar (desktop only): fixed bottom expskill filter bar, visible only
    // in the Experience scene. Reuses toggleTag() and subscribe() from state.js.
    // On mobile returns null without doing anything.
    try {
      (await import("./footbar.js")).initFootbar(data, threeCtx);
    } catch (err) {
      console.warn("[main] footbar unavailable — continuing without it", err);
    }

    // Experience Levels (desktop): L0 selezione card quando il cursore entra
    // nella footbar. Dipende dalla footbar (usa i suoi eventi custom) → init dopo.
    try {
      (await import("./experience-levels.js")).initExperienceLevels();
    } catch (err) {
      console.warn("[main] experience-levels unavailable — continuing without it", err);
    }

    if (DEBUG) {
      console.assert(data.experience.length === 8, "expected 8 experiences");
      console.assert(data.tag_taxonomy.domains.length === 4, "expected 4 domains");
      console.assert(data._units.length > 14, "units should expand projects");
      console.log("[debug] sanity checks done", { units: data._units.length });
    }

    // ---- Block 1: unified reveal gate ----
    // Determine whether the deflagration intro is actually active. Guards inside
    // initHeroDeflagration already checked WebGL/GSAP/tier/reducedMotion; the
    // surest signal is whether body.deflagration-active was added.
    const deflagrationActive =
      deflagration &&
      document.body.classList.contains("deflagration-active");

    // ?preview=1 composes the name's FINAL state (no timeline), so it must take
    // the reveal path below — which emits "evolvedcv:intro-done" once, AFTER
    // scene-nav has attached its listener — not the timeline-driven path.
    const previewMode = new URLSearchParams(location.search).get("preview") === "1";

    if (deflagrationActive && !previewMode) {
      // Build the readiness promise: fonts loaded + name targets sampled.
      const fontsReady = document.fonts
        ? document.fonts.ready.catch(() => {})
        : Promise.resolve();
      const readinessPromise = Promise.all([fontsReady, deflagration.whenReady]);

      // Race readiness against a 3500 ms safety timeout so the user is never
      // stuck on the loader if something takes too long.
      const timeout = new Promise((resolve) => setTimeout(resolve, 3500));
      await Promise.race([readinessPromise, timeout]);

      // Reveal: fade loader, then kick the intro on the next animation frame
      // so the WebGL canvas has had at least one render tick under the loader.
      hideLoader();
      document.body.classList.add("is-ready");
      requestAnimationFrame(() => {
        deflagration.play();
      });
    } else {
      // No intro active (no-3d / reduced-motion / low tier / GSAP missing).
      // Reveal the static CV. Use a short fence so fonts have a chance to
      // apply before the overlay disappears (avoids FOUT on the hero text).
      const fontsReady = document.fonts
        ? document.fonts.ready.catch(() => {})
        : Promise.resolve();
      const timeout = new Promise((resolve) => setTimeout(resolve, 3500));
      await Promise.race([fontsReady, timeout]);
      hideLoader();
      document.body.classList.add("is-ready");
      // Dispatch intro-done immediately in the no-intro path so scene-nav
      // (if active) unlocks scroll right away. Dispatched exactly once here.
      window.dispatchEvent(new CustomEvent("evolvedcv:intro-done"));
    }
  } catch (err) {
    // Even on a fatal boot error, always remove the loader so the user can
    // read the error message.
    hideLoader();
    showFatalError(err);
  }
}

boot();

// Part A: toggle body.in-experience while #experience occupies the viewport
// centre. CSS uses this only on mobile (≤767px); harmless on desktop.
(function initExperienceWatcher() {
  const expSec = document.getElementById("experience");
  if (!expSec || !("IntersectionObserver" in window)) return;
  new IntersectionObserver(
    (entries) => document.body.classList.toggle("in-experience", entries[0].isIntersecting),
    { rootMargin: "-45% 0px -45% 0px" }  // fires when #experience crosses the viewport middle
  ).observe(expSec);
}());
