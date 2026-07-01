/**
 * theme.js — reads design tokens from CSS custom properties so that
 * css/tokens.css stays the single source of truth for colors.
 * JS (including the future Three.js scene) must use getToken/getDomainColor
 * instead of hardcoding values.
 */

let cache = new Map();

/** Read a token (e.g. "--c-accent-1") with caching. */
export function getToken(name) {
  if (cache.has(name)) return cache.get(name);
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  cache.set(name, value);
  return value;
}

/** Color for a taxonomy domain id ("ai" -> --c-domain-ai). */
export function getDomainColor(domainId) {
  return getToken(`--c-domain-${domainId}`);
}

/**
 * Apply the 4 data-driven domain colors (cv_ui.json → domain_colors map, keyed
 * by domain id) onto the --c-domain-* custom properties. These single tokens
 * then drive, in one shot: the particle field (three-scene uDomainColors), the
 * constellation orbit nodes, and the tag-family pills/chips. Change a color in
 * cv_ui.json → it propagates here.
 */
function applyDomainColors(data) {
  const colors = data?.domain_colors;
  if (!colors || typeof colors !== "object") return;
  const root = document.documentElement;
  for (const [id, color] of Object.entries(colors)) {
    if (id && typeof color === "string" && color.trim()) {
      root.style.setProperty(`--c-domain-${id}`, color.trim());
    }
  }
}

/**
 * Apply site_config.theme onto the core token variables so that editing the
 * JSON re-themes the site: accent/background/text colors and the heading/body
 * font families. These override the defaults in tokens.css via inline custom
 * properties on :root. The font families are also (re)loaded from Google Fonts
 * so a changed font name actually fetches the new face.
 */
function setVarOn(root, name, val) {
  if (val && String(val).trim()) root.style.setProperty(name, String(val).trim());
}

function applyThemeTokens(data) {
  const th = data?.site_config?.theme;
  if (!th) return;
  const root = document.documentElement;
  const setVar = (name, val) => setVarOn(root, name, val);
  setVar("--c-accent-1", th.primary_color);
  setVar("--c-accent-2", th.accent_color);
  setVar("--c-bg", th.background_color);
  setVar("--c-text", th.text_color);
  // particle "hot" colour (what particles morph toward under the cursor):
  // dedicated knob via particle_hover_color, falling back to the primary.
  setVar("--c-particle-hot", th.particle_hover_color || th.primary_color);
  // button base colour (interior + border) — one knob for the chrome buttons;
  // absent keys fall back to the Contact-grey default in tokens.css.
  setVar("--ui-button-surface", th.button_surface);
  setVar("--ui-button-border", th.button_border);
  if (th.font_heading) setVar("--font-heading", `"${th.font_heading}", system-ui, sans-serif`);
  if (th.font_body) setVar("--font-body", `"${th.font_body}", system-ui, sans-serif`);
}

/**
 * Apply ui_elements (single-color knobs) onto the --ui-* tokens. Each key maps
 * to one token; absent keys fall back to the tokens.css defaults. See
 * cv_ui.json for the meaning of each.
 */
function applyUiElementColors(data) {
  const ui = data?.ui_elements;
  if (!ui || typeof ui !== "object") return;
  const root = document.documentElement;
  const map = {
    pdf_button_border: "--ui-pdf-border",
    pdf_button_border_hover: "--ui-pdf-border-hover",
    pdf_button_text: "--ui-pdf-text",
    pdf_button_text_hover: "--ui-pdf-text-hover",
    filter_button_border_hover: "--ui-filter-border-hover",
    counter_text: "--ui-counter-text",
    counter_text_recalc: "--ui-counter-text-recalc",
    social_button_border_hover: "--ui-social-border-hover",
    social_button_surface_hover: "--ui-social-surface-hover",
    cursor_ring_over_button: "--ui-cursor-ring-button",
    cursor_ring_over_link: "--ui-cursor-ring-link"
  };
  for (const [key, token] of Object.entries(map)) setVarOn(root, token, ui[key]);
}

/**
 * Apply experience_typography (font/color/size per text role) onto the --exp-*
 * tokens. Returns the set of font-family names used, so initTheme can ensure
 * they are loaded. Sizes are raw CSS lengths; fonts are bare family names
 * wrapped with a fallback stack.
 */
function applyExperienceTypography(data) {
  const fonts = new Set();
  const ty = data?.experience_typography;
  if (!ty || typeof ty !== "object") return fonts;
  const root = document.documentElement;
  const map = {
    company: "company",
    company_location: "loc",
    role: "role",
    date: "date",
    duration: "dur",
    description: "desc",
    project: "proj",
    bullets: "bullet"
  };
  for (const [key, slug] of Object.entries(map)) {
    const cfg = ty[key];
    if (!cfg || typeof cfg !== "object") continue;
    if (cfg.font && String(cfg.font).trim()) {
      const fam = String(cfg.font).trim();
      setVarOn(root, `--exp-${slug}-font`, `"${fam}", system-ui, sans-serif`);
      fonts.add(fam);
    }
    setVarOn(root, `--exp-${slug}-color`, cfg.color);
    setVarOn(root, `--exp-${slug}-size`, cfg.size);
  }
  return fonts;
}

/** "#b9a9ff" -> "185,169,255" (for rgba(var(--token), a) usage). null if invalid. */
function hexToRgbTriplet(hex) {
  const m = String(hex || "").trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

/**
 * Apply glass.card knobs onto the CSS tokens used by the liquid-glass FALLBACK
 * (css/main.css, shown on no-WebGL / reduced-motion devices). The WebGL glass
 * reads the same cv_ui.json keys directly (experience-glass.js); this keeps the
 * CSS fallback in sync so editing the glass colour/blur moves BOTH. Absent keys
 * leave the tokens unset and main.css keeps its baked-in defaults (look unchanged).
 *   attenuationColor -> --exp-glass-tint-rgb (gradient top stop, border, inner glow)
 *   cssBlur (number, px) -> --exp-glass-blur (backdrop-filter blur radius)
 *   radius (number, px)  -> --exp-glass-radius (card corner = WebGL slab corner)
 */
function applyGlassTokens(data) {
  const g = data?.glass?.card;
  if (!g || typeof g !== "object") return;
  const root = document.documentElement;
  const rgb = hexToRgbTriplet(g.attenuationColor);
  if (rgb) setVarOn(root, "--exp-glass-tint-rgb", rgb);
  if (g.cssBlur != null && g.cssBlur !== "") {
    const b = parseFloat(g.cssBlur);
    if (!Number.isNaN(b)) setVarOn(root, "--exp-glass-blur", `${b}px`);
  }
  // corner radius (px): keeps the DOM card border-radius (and so the skill-lit
  // glow, which follows it) tied to the WebGL slab's corner (glass.card.radius).
  if (g.radius != null && g.radius !== "") {
    const r = parseFloat(g.radius);
    if (!Number.isNaN(r)) setVarOn(root, "--exp-glass-radius", `${r}px`);
  }
}

/**
 * (Re)build a Google Fonts <link> for the given family names (heading, body,
 * and any experience-typography fonts). Families already present in the page's
 * static <link> are harmless to re-request; deduped so each is fetched once.
 */
function ensureFontLink(families) {
  const seen = new Set();
  const fams = [];
  for (const f of families) {
    if (!f) continue;
    const name = String(f).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    fams.push(`family=${encodeURIComponent(name).replace(/%20/g, "+")}:wght@400;500;600;700`);
  }
  if (!fams.length) return;
  const href = `https://fonts.googleapis.com/css2?${fams.join("&")}&display=swap`;
  let link = document.getElementById("dyn-fonts");
  if (!link) {
    link = document.createElement("link");
    link.id = "dyn-fonts";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  if (link.href !== href) link.href = href;
}

/**
 * Re-apply ALL ui tokens (domain colors, theme, ui_elements, typography) from a
 * data object. Used at boot AND, live, by the local editor's preview iframe.
 * Safe to call repeatedly (no listeners registered here).
 * Not exported: reached at boot via initTheme and live via window.evolvedcvApplyTheme.
 */
function reapplyTheme(data) {
  applyDomainColors(data);
  applyThemeTokens(data);
  applyUiElementColors(data);
  applyGlassTokens(data);
  const expFonts = applyExperienceTypography(data);
  const th = data?.site_config?.theme || {};
  ensureFontLink([th.font_heading, th.font_body, ...expFonts]);
  cache = new Map(); // ensure first reads pick up the injected colors
}

/** Invalidate the cache (listen for future theme switching). */
export function initTheme(data) {
  reapplyTheme(data);
  window.addEventListener("theme-change", () => {
    cache = new Map();
  });
  // Live re-theme hook for the local editor: the editor calls this on the
  // preview iframe to reflect colour/typography edits before they are saved.
  window.evolvedcvApplyTheme = reapplyTheme;
}
