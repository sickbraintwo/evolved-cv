/**
 * experience-glass.js — REAL WebGL glass for the Experience cards, rendered as
 * a LAYER inside the ONE shared renderer/canvas (#bg3d), not a second context.
 *
 * Why a layer: MeshPhysicalMaterial `transmission` only refracts objects that
 * live in the SAME scene as the glass. So this layer owns its own scene that
 * contains BOTH (a) a rich particle backdrop field and (b) the glass slabs —
 * the slabs genuinely refract that field (ior + thickness + dispersion). The
 * backdrop is sized to cover the #experience section, so within the section the
 * particle field is continuous (gaps between cards show particles, not a box),
 * and it occludes the global galaxy only while the section is on screen.
 *
 * DOM sync: an OrthographicCamera maps 1:1 to viewport pixels; every visible
 * .exp-card (outer slab) and .project (nested second slab) gets a RoundedBox
 * glass mesh whose position/size track the element's getBoundingClientRect each
 * frame — so scroll, tilt and the expand/collapse Flip are followed for free.
 * The card HTML (text + reflective plates) stays on top; the DOM card itself
 * goes transparent via the `exp-glass-on` class.
 *
 * Guards: reduced-motion or no shared WebGL context → returns null and the
 * cards keep their CSS liquid-glass look (the fallback in css/main.css).
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { getSceneContext } from "./three-scene.js";
import { getData } from "./data-loader.js";
import { subscribe } from "./state.js";
import { watchVisibility } from "./dom-utils.js";

/* Defaults if cv_ui.json → glass is absent or partial (keys merge over these). */
const GLASS_DEFAULTS = {
  card: {
    transmission: 1, ior: 1.5, thickness: 30, roughness: 1, centerBlur: true, centerBlurSize: 0.62,
    clearcoat: 0.45, clearcoatRoughness: 0.28, dispersion: 0.02,
    attenuationColor: "#b9a9ff", attenuationDistance: 320,
    envMapIntensity: 0.5, specularIntensity: 0.6, depth: 42, radius: 20, seg: 6
  },
  project: {
    transmission: 1, ior: 1.5, thickness: 18, roughness: 0.08, centerBlur: false, centerBlurSize: 0.62,
    clearcoat: 0.5, clearcoatRoughness: 0.2, dispersion: 0.015,
    attenuationColor: "#a06bff", attenuationDistance: 180,
    envMapIntensity: 0.6, specularIntensity: 0.6, depth: 26, radius: 13, seg: 5
  }
};

/* ----------------------------------------------------------------- textures */
/** Equirect gradient env map → soft reflections + specular on the glass. */
function envTexture() {
  const w = 512, h = 256, c = document.createElement("canvas"); c.width = w; c.height = h;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#9c93c4"); g.addColorStop(.4, "#3a2d6b");
  g.addColorStop(.75, "#12132a"); g.addColorStop(1, "#06050c");
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}

/** Radial roughness map: faint frost toward the centre, crisp at the edges.
 *  `size` (default 0.62) is the radius of the frosted disc as a fraction of the
 *  texture — larger = the frost reaches further out (more of the card softened). */
function centerBlurTexture(size = 0.62) {
  const s = 256, c = document.createElement("canvas"); c.width = c.height = s;
  const x = c.getContext("2d");
  const r = s * Math.max(0.05, size);
  const g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, r);
  g.addColorStop(0, "#2b2b2b"); g.addColorStop(.55, "#161616"); g.addColorStop(1, "#070707");
  x.fillStyle = g; x.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

/* ----------------------------------------------------------------- geometry */
// Built at REAL pixel size so the corner bevel is a uniform radius (no
// scaled-ellipse corners). depth/radius/seg come from cv_ui.json → glass.
function buildGeo(w, h, cfg) {
  const r = Math.max(2, Math.min(cfg.radius, w / 2 - 1, h / 2 - 1, cfg.depth / 2 - 1));
  return new RoundedBoxGeometry(Math.max(2, w), Math.max(2, h), cfg.depth, cfg.seg, r);
}

/** Build a glass material from a cv_ui glass params object. */
function makeGlassMat(p) {
  const cbt = p.centerBlur ? centerBlurTexture(p.centerBlurSize) : null;
  const mat = new THREE.MeshPhysicalMaterial({
    transmission: p.transmission, ior: p.ior, thickness: p.thickness,
    roughness: p.centerBlur ? 1 : p.roughness,
    roughnessMap: cbt,
    metalness: 0,
    clearcoat: p.clearcoat, clearcoatRoughness: p.clearcoatRoughness,
    attenuationColor: new THREE.Color(p.attenuationColor),
    attenuationDistance: p.attenuationDistance,
    envMapIntensity: p.envMapIntensity, specularIntensity: p.specularIntensity
  });
  if ("dispersion" in mat) mat.dispersion = p.dispersion ?? 0;
  if (cbt) { mat.userData._cbt = cbt; mat.userData._cbtSize = p.centerBlurSize ?? 0.62; } // cached; size tracked so the editor can regen on change
  return mat;
}

/* --------------------------------------------------------------------- init */
export function initExperienceGlass() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  // MOBILE (≤767px): the WebGL true-glass is desktop-only. On mobile the shared
  // #bg3d particle field is hidden (the Canvas-2D layer owns the visuals), so the
  // refracting slab would render against nothing — and adding `exp-glass-on`
  // strips the CSS card (transparent border + no fill), leaving the Experience
  // cards INVISIBLE. Bail here so the CSS glass fallback (tinted pane + border +
  // bevel) stays in place. See the main.css mobile block.
  if (matchMedia("(max-width: 767px)").matches) return null;
  const ctx = getSceneContext();
  if (!ctx || !ctx.renderer) return null; // no WebGL → CSS fallback stays
  const section = document.getElementById("experience");
  if (!section) return null;

  section.classList.add("exp-glass-on");

  // glass params from cv_ui.json (merged over defaults so partial configs work)
  const gcfg = getData()?.glass || {};
  const CARD = { ...GLASS_DEFAULTS.card, ...(gcfg.card || {}) };
  const PROJ = { ...GLASS_DEFAULTS.project, ...(gcfg.project || {}) };

  const scene = new THREE.Scene();
  scene.environment = envTexture();

  // Orthographic camera in CSS-pixel space (1:1 with getBoundingClientRect).
  // Bounds are refreshed each frame from innerWidth/innerHeight.
  const camera = new THREE.OrthographicCamera(0, innerWidth, 0, -innerHeight, -4000, 4000);
  camera.position.z = 1000;

  // Backdrop = the REAL galaxy. Each frame we render the live #bg3d particle
  // scene into an offscreen target (ctx.renderToTarget) and map it onto a
  // full-viewport quad behind the slabs. The transmission pre-pass then samples
  // this quad → the glass refracts the actual particles (no synthetic field).
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ depthWrite: true })
  );
  backdrop.position.z = -260;
  scene.add(backdrop);

  // The backdrop galaxy is seen THROUGH frosted/refracting glass, so it doesn't
  // need full resolution — render it at 0.7× to cut the per-frame RT render cost
  // (and the one-time allocation) without a visible difference.
  const RT_SCALE = 0.7;
  let rt = null, rtW = 0, rtH = 0;
  const _dbs = new THREE.Vector2();
  function ensureRT() {
    ctx.renderer.getDrawingBufferSize(_dbs);
    const w = Math.max(2, Math.floor(_dbs.x * RT_SCALE)), h = Math.max(2, Math.floor(_dbs.y * RT_SCALE));
    if (rt && w === rtW && h === rtH) return;
    rt?.dispose();
    rt = new THREE.WebGLRenderTarget(w, h);
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    rtW = w; rtH = h;
    backdrop.material.map = rt.texture;
    backdrop.material.needsUpdate = true;
  }

  scene.add(new THREE.AmbientLight(0x4a4070, 0.8));
  const dir = new THREE.DirectionalLight(0xffffff, 1.35);
  dir.position.set(-1, 2, 3); scene.add(dir);

  const cardMat = makeGlassMat(CARD);
  const projMat = makeGlassMat(PROJ);

  /** el -> { mesh, cfg, mat, w, h } */
  const meshes = new Map();

  function ensureMesh(el, cfg, mat) {
    if (meshes.has(el)) return;
    const mesh = new THREE.Mesh(buildGeo(2, 2, cfg), mat);
    mesh.visible = false;
    scene.add(mesh);
    meshes.set(el, { mesh, cfg, mat, w: 0, h: 0 });
  }

  function buildMeshes() {
    // prune disconnected
    for (const [el, rec] of meshes) {
      if (!el.isConnected) { scene.remove(rec.mesh); rec.mesh.geometry.dispose(); meshes.delete(el); }
    }
    section.querySelectorAll(".exp-card").forEach((c) => ensureMesh(c, CARD, cardMat));
    section.querySelectorAll(".exp-card .project").forEach((p) => ensureMesh(p, PROJ, projMat));
  }
  buildMeshes();

  /* ---- live editor hook ----------------------------------------------------
   * Update the EXISTING materials + geometry config in place from a fresh
   * cv_ui glass object, so the local editor reflects glass edits WITHOUT a
   * preview reload (mirrors theme.js's evolvedcvApplyTheme for CSS tokens).
   * Material props are hot-set; centerBlur swaps the roughness MAP (cached on
   * the material so toggling it back and forth doesn't leak textures); geometry
   * keys (depth/radius/seg) take effect by forcing a rebuild next frame. */
  function updateMat(mat, p) {
    mat.transmission = p.transmission;
    mat.ior = p.ior;
    mat.thickness = p.thickness;
    mat.clearcoat = p.clearcoat;
    mat.clearcoatRoughness = p.clearcoatRoughness;
    mat.attenuationColor.set(p.attenuationColor);
    mat.attenuationDistance = p.attenuationDistance;
    mat.envMapIntensity = p.envMapIntensity;
    mat.specularIntensity = p.specularIntensity;
    if ("dispersion" in mat) mat.dispersion = p.dispersion ?? 0;
    if (p.centerBlur) {
      mat.roughness = 1;
      const sz = p.centerBlurSize ?? 0.62;
      // regenerate the frost map when its radius changed (live editor tuning)
      if (!mat.userData._cbt || mat.userData._cbtSize !== sz) {
        if (mat.userData._cbt) mat.userData._cbt.dispose();
        mat.userData._cbt = centerBlurTexture(sz);
        mat.userData._cbtSize = sz;
      }
      mat.roughnessMap = mat.userData._cbt;
    } else {
      mat.roughness = p.roughness;
      mat.roughnessMap = null;
    }
    mat.needsUpdate = true;
  }

  function applyGlassLive(glass) {
    const g = glass || {};
    // mutate CARD/PROJ in place: rec.cfg holds the SAME object reference, so the
    // per-mesh geometry rebuild below picks up depth/radius/seg changes too.
    Object.assign(CARD, GLASS_DEFAULTS.card, g.card || {});
    Object.assign(PROJ, GLASS_DEFAULTS.project, g.project || {});
    updateMat(cardMat, CARD);
    updateMat(projMat, PROJ);
    for (const [, rec] of meshes) { rec.w = 0; rec.h = 0; } // force geo rebuild
  }
  window.evolvedcvApplyGlass = applyGlassLive;

  function update(dt) {
    // refresh ortho bounds (handles window resize without a listener)
    camera.right = innerWidth; camera.bottom = -innerHeight;
    camera.updateProjectionMatrix();

    // capture the live galaxy into the RT, then stretch the backdrop quad over
    // the whole viewport so it reproduces #bg3d 1:1 (seamless with the gaps)
    // and gives the transmission slabs the real particles to refract.
    ensureRT();
    ctx.renderToTarget(rt);
    backdrop.scale.set(innerWidth, innerHeight, 1);
    backdrop.position.set(innerWidth / 2, -innerHeight / 2, -260);

    for (const [el, rec] of meshes) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || el.classList.contains("is-hidden")) { rec.mesh.visible = false; continue; }
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < -200 || r.top > innerHeight + 200) {
        rec.mesh.visible = false; continue;
      }
      if (Math.abs(r.width - rec.w) > 0.5 || Math.abs(r.height - rec.h) > 0.5) {
        rec.mesh.geometry.dispose();
        rec.mesh.geometry = buildGeo(r.width, r.height, rec.cfg);
        rec.w = r.width; rec.h = r.height;
      }
      rec.mesh.visible = true;
      // nested project slabs sit slightly in front of the card slab
      rec.mesh.position.set(r.left + r.width / 2, -(r.top + r.height / 2), rec.cfg === PROJ ? 30 : 0);
    }
  }

  const layer = { scene, camera, visible: false, update };
  const handle = ctx.addLayer(layer);

  // Pre-warm during load so the first ON-SCREEN frame — right as you scroll from
  // the pills into Experience — doesn't hitch for ~1s. compile() builds the
  // shader programs, but MeshPhysicalMaterial.transmission ALSO sets up an
  // internal render pass on its FIRST real render; so we additionally do one
  // OFF-SCREEN render that genuinely exercises a transmissive slab. Rendered
  // into a throwaway target so nothing flashes on the visible canvas.
  ensureRT();
  try {
    ctx.renderer.compile(scene, camera);
    const warmRT = new THREE.WebGLRenderTarget(16, 16);
    const warmMesh = new THREE.Mesh(buildGeo(220, 130, CARD), cardMat);
    scene.add(warmMesh);
    ctx.renderToTarget(rt); // fill the backdrop texture so transmission samples it
    backdrop.scale.set(innerWidth, innerHeight, 1);
    backdrop.position.set(innerWidth / 2, -innerHeight / 2, -260);
    const prev = ctx.renderer.getRenderTarget();
    ctx.renderer.setRenderTarget(warmRT);
    ctx.renderer.render(scene, camera); // exercises the transmission pre-pass
    ctx.renderer.setRenderTarget(prev);
    scene.remove(warmMesh);
    warmMesh.geometry.dispose();
    warmRT.dispose();
  } catch { /* warm-up is best-effort */ }

  // Render only when #experience actually occupies the centre of the viewport.
  // The backdrop is a FULL-VIEWPORT galaxy quad, so it must NOT light up while
  // the section merely peeks from below an adjacent scene (e.g. the pills scene
  // right above it) — otherwise the quad would overdraw that scene. The negative
  // top/bottom margins require the section to cover the central band of the view.
  // Editor-only: simulate a no-WebGL device so the CSS liquid-glass fallback is
  // visible in the preview (on desktop the WebGL glass otherwise always wins).
  let forceCss = false;

  const vis = watchVisibility(section, { rootMargin: "-35% 0px -35% 0px" }, (visible) => {
    handle.setVisible(!forceCss && visible);
  });

  // useCss=true → hide the WebGL layer + drop exp-glass-on so the cards render
  // their CSS fallback; false → restore WebGL (re-observe to re-evaluate visibility).
  const setGlassMode = (useCss) => {
    forceCss = !!useCss;
    section.classList.toggle("exp-glass-on", !forceCss);
    if (forceCss) handle.setVisible(false);
    else { vis.unobserve(section); vis.observe(section); }
  };
  window.evolvedcvSetGlassMode = setGlassMode;

  // cards/projects are recreated on language change; the filter adds/removes
  // project nodes — rebuild the mesh map on both.
  const unsub = subscribe("lang", () => setTimeout(buildMeshes, 0));
  const mo = new MutationObserver(() => buildMeshes());
  mo.observe(section, { childList: true, subtree: true });

  return {
    dispose() {
      vis.disconnect(); mo.disconnect();
      if (typeof unsub === "function") unsub();
      if (window.evolvedcvApplyGlass === applyGlassLive) delete window.evolvedcvApplyGlass;
      if (window.evolvedcvSetGlassMode === setGlassMode) delete window.evolvedcvSetGlassMode;
      handle.setVisible(false);
      for (const [, rec] of meshes) { scene.remove(rec.mesh); rec.mesh.geometry.dispose(); }
      meshes.clear();
      backdrop.geometry.dispose(); backdrop.material.dispose(); rt?.dispose();
      cardMat.userData._cbt?.dispose(); projMat.userData._cbt?.dispose();
      cardMat.dispose(); projMat.dispose();
      section.classList.remove("exp-glass-on");
    }
  };
}
