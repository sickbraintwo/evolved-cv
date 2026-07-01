/**
 * icons.js — inline single-colour SVG marks for the social links.
 *
 * Each path uses `fill="currentColor"` so the colour is driven by CSS (white on
 * the site, so it reads on any coloured background). 24×24 viewBox.
 */
const ICONS = {
  linkedin:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.07 2.07 0 1 1 0-4.14 2.07 2.07 0 0 1 0 4.14zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.8 0 0 .77 0 1.73v20.54C0 23.23.8 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z"/></svg>',
  github:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.04-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.31-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.87.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.81 1.1.81 2.22 0 1.61-.01 2.9-.01 3.29 0 .32.21.69.82.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z"/></svg>',
  artstation:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M0 17.72l2.03 3.5a2.42 2.42 0 0 0 2.16 1.34h13.46l-2.8-4.84H0zM24 17.75c0-.48-.14-.93-.39-1.31L15.73 2.73A2.42 2.42 0 0 0 13.59 1.44H9.42L21.6 22.54l1.92-3.33c.38-.64.48-.92.48-1.46zM12.87 14.29L7.43 4.86l-5.45 9.43h10.89z"/></svg>'
};

/** Return the inline SVG markup for a social id, or "" if unknown. */
export function socialIcon(id) {
  return ICONS[id] || "";
}

/* Coloured flag marks for the intro language banner. "en" is a single flag
   split down the middle: left half Union Jack, right half Stars & Stripes
   (English = UK + US). "it" is the tricolore. Simplified for a small icon. */
const FLAGS = {
  it:
    '<svg class="hero-lang__flag" viewBox="0 0 3 2" aria-hidden="true">' +
    '<rect width="1" height="2" fill="#009246"/><rect x="1" width="1" height="2" fill="#fff"/>' +
    '<rect x="2" width="1" height="2" fill="#ce2b37"/></svg>',
  en:
    '<svg class="hero-lang__flag hero-lang__flag--en" viewBox="0 0 4 2" aria-hidden="true">' +
    '<defs><clipPath id="enUkHalf"><rect x="0" y="0" width="2" height="2"/></clipPath></defs>' +
    '<g clip-path="url(#enUkHalf)">' +
    '<rect width="2" height="2" fill="#012169"/>' +
    '<path d="M0,0 2,2 M2,0 0,2" stroke="#fff" stroke-width="0.4"/>' +
    '<path d="M0,0 2,2 M2,0 0,2" stroke="#C8102E" stroke-width="0.16"/>' +
    '<path d="M1,0 V2 M0,1 H2" stroke="#fff" stroke-width="0.6"/>' +
    '<path d="M1,0 V2 M0,1 H2" stroke="#C8102E" stroke-width="0.34"/>' +
    '</g>' +
    '<g transform="translate(2,0)">' +
    '<rect width="2" height="2" fill="#fff"/>' +
    '<g fill="#B22234"><rect y="0" width="2" height="0.286"/><rect y="0.571" width="2" height="0.286"/>' +
    '<rect y="1.143" width="2" height="0.286"/><rect y="1.714" width="2" height="0.286"/></g>' +
    '<rect width="0.9" height="1" fill="#3C3B6E"/>' +
    '<g fill="#fff"><circle cx="0.2" cy="0.22" r="0.07"/><circle cx="0.45" cy="0.22" r="0.07"/><circle cx="0.7" cy="0.22" r="0.07"/>' +
    '<circle cx="0.33" cy="0.5" r="0.07"/><circle cx="0.58" cy="0.5" r="0.07"/>' +
    '<circle cx="0.2" cy="0.78" r="0.07"/><circle cx="0.45" cy="0.78" r="0.07"/><circle cx="0.7" cy="0.78" r="0.07"/></g>' +
    '</g></svg>'
};

/** Return the inline SVG markup for a language flag ("en" | "it"), or "" if unknown. */
export function flagIcon(id) {
  return FLAGS[id] || "";
}
