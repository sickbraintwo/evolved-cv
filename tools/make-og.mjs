/**
 * make-og.mjs — generates assets/og-image.svg (1200x630) and
 * assets/favicon.svg from the design tokens in css/tokens.css, so the
 * social card / favicon never drift from the site palette.
 *
 * No dependencies. Run: node tools/make-og.mjs
 *
 * Note: og:image as SVG is a placeholder — most social crawlers prefer
 * PNG/JPG. Swap in a raster export of this file before going live.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokensCss = readFileSync(join(root, "site", "css", "tokens.css"), "utf8");

/** Read a token literal (hex / rgba) from tokens.css. */
function token(name) {
  const m = tokensCss.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`token ${name} not found in tokens.css`);
  return m[1].trim();
}

const c = {
  bg: token("--c-bg"),
  surface: token("--c-surface"),
  text: token("--c-text"),
  dim: token("--c-text-dim"),
  faint: token("--c-text-faint"),
  ai: token("--c-accent-1"),
  xr: token("--c-accent-2"),
  media: token("--c-accent-3"),
  dev: token("--c-accent-4")
};

const SANS = "'Space Grotesk','Inter',system-ui,sans-serif";

/* ------------------------------------------------------------- og image */

const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${c.ai}"/>
      <stop offset="1" stop-color="${c.xr}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.85" cy="0.2" r="0.9">
      <stop offset="0" stop-color="${c.xr}" stop-opacity="0.35"/>
      <stop offset="0.5" stop-color="${c.ai}" stop-opacity="0.10"/>
      <stop offset="1" stop-color="${c.bg}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="1200" height="630" fill="${c.bg}"/>
  <rect width="1200" height="630" fill="url(#glow)"/>

  <!-- particle hints (domain colors) -->
  <g>
    <circle cx="980" cy="120" r="5" fill="${c.ai}" opacity="0.9"/>
    <circle cx="1060" cy="210" r="3" fill="${c.xr}" opacity="0.8"/>
    <circle cx="900" cy="300" r="4" fill="${c.media}" opacity="0.7"/>
    <circle cx="1100" cy="380" r="3" fill="${c.dev}" opacity="0.8"/>
    <circle cx="1010" cy="470" r="5" fill="${c.ai}" opacity="0.5"/>
    <circle cx="870" cy="180" r="2.5" fill="${c.dev}" opacity="0.6"/>
    <circle cx="1130" cy="90" r="2.5" fill="${c.media}" opacity="0.6"/>
    <circle cx="940" cy="540" r="3" fill="${c.xr}" opacity="0.6"/>
    <line x1="980" y1="120" x2="1060" y2="210" stroke="${c.ai}" stroke-opacity="0.25"/>
    <line x1="1060" y1="210" x2="900" y2="300" stroke="${c.xr}" stroke-opacity="0.2"/>
    <line x1="900" y1="300" x2="1100" y2="380" stroke="${c.media}" stroke-opacity="0.2"/>
    <line x1="1100" y1="380" x2="1010" y2="470" stroke="${c.dev}" stroke-opacity="0.25"/>
  </g>

  <!-- diamond mark (matches the filter FAB icon) -->
  <g transform="translate(96 96) rotate(45 28 28)">
    <rect x="0" y="0" width="56" height="56" rx="10" fill="none" stroke="url(#brand)" stroke-width="6"/>
  </g>

  <text x="96" y="300" font-family="${SANS}" font-size="44" font-weight="700" fill="url(#brand)">EvolvedCV</text>
  <text x="96" y="382" font-family="${SANS}" font-size="64" font-weight="700" fill="${c.text}">Christina Debug</text>
  <text x="96" y="438" font-family="${SANS}" font-size="30" fill="${c.dim}">Computational Biologist &amp; Digital Health Researcher</text>
  <text x="96" y="510" font-family="${SANS}" font-size="24" fill="${c.faint}">An interactive, filterable CV — pick the skills, watch it reshape itself.</text>

  <rect x="96" y="548" width="160" height="4" rx="2" fill="url(#brand)"/>
</svg>
`;

/* -------------------------------------------------------------- favicon */

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="b" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c.ai}"/>
      <stop offset="1" stop-color="${c.xr}"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="${c.bg}"/>
  <rect x="17" y="17" width="30" height="30" rx="6" fill="none" stroke="url(#b)" stroke-width="5" transform="rotate(45 32 32)"/>
</svg>
`;

mkdirSync(join(root, "site", "assets"), { recursive: true });
writeFileSync(join(root, "site", "assets", "og-image.svg"), og);
writeFileSync(join(root, "site", "assets", "favicon.svg"), favicon);
console.log("written: assets/og-image.svg, assets/favicon.svg");
console.log("palette:", c);
