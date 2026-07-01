/**
 * page-chrome.js — makes the page "shell" data-driven so editing cv_data.json
 * is reflected everywhere outside the main content sections:
 *   - the brand name in the header (profile.name)
 *   - the footer line (profile.name + site_config.footer_tagline)
 *   - <head> SEO: <title>, meta description, Open Graph / Twitter, JSON-LD
 *     (profile.name / headline / summary / location / contact / links)
 *   - the language-toggle button visibility (site_config.language_toggle)
 *
 * Brand name is language-independent; footer tagline and SEO copy follow the
 * active language, so those refresh on every `lang` change.
 *
 * Note: the <noscript> block stays static by necessity — it is shown only when
 * JavaScript is disabled, so it cannot be populated from the JSON at runtime.
 */
import { get, subscribe } from "./state.js";
import { t } from "./i18n.js";

let data = null;

function setBrandName() {
  const el = document.querySelector(".brand__name");
  if (el && data.profile?.name) el.textContent = data.profile.name;
}

function renderFooter() {
  const foot = document.querySelector(".site-footer");
  if (!foot) return;
  const year = new Date().getFullYear();
  const name = data.profile?.name || "";
  const tagline = t(data.site_config?.footer_tagline) || "";
  foot.innerHTML = "";
  const p = document.createElement("p");
  p.textContent = tagline ? `© ${year} ${name} — ${tagline}` : `© ${year} ${name}`;
  foot.appendChild(p);
}

function truncate(str, n) {
  const s = String(str || "").trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

function updateSEO() {
  const p = data.profile;
  if (!p) return;
  const headline = t(p.headline) || "";
  const title = headline ? `${p.name} — ${headline}` : p.name;
  const desc = truncate(t(p.summary), 160);

  document.title = title;
  const setMeta = (sel, val) => {
    const m = document.querySelector(sel);
    if (m && val) m.setAttribute("content", val);
  };
  setMeta('meta[name="description"]', desc);
  setMeta('meta[property="og:title"]', title);
  setMeta('meta[property="og:description"]', desc);
  setMeta('meta[name="twitter:title"]', title);
  setMeta('meta[name="twitter:description"]', desc);

  // JSON-LD Person — rebuilt from the data so it always matches the JSON.
  const ld = document.querySelector('script[type="application/ld+json"]');
  if (ld) {
    const loc = String(p.location || "").split(",");
    const sameAs = (p.contact_links || [])
      .filter((l) => String(l.href).startsWith("http"))
      .map((l) => l.href);
    const json = {
      "@context": "https://schema.org",
      "@type": "Person",
      name: p.name,
      jobTitle: headline,
      ...(p.contact?.email ? { email: `mailto:${p.contact.email}` } : {}),
      ...(p.contact?.phone ? { telephone: p.contact.phone } : {}),
      address: {
        "@type": "PostalAddress",
        addressLocality: (loc[0] || "").trim(),
        addressCountry: (loc[1] || "").trim()
      },
      sameAs
    };
    ld.textContent = JSON.stringify(json, null, 2);
  }
}

export function initPageChrome(cvData) {
  data = cvData;

  // language toggle can be hidden via the JSON
  if (data.site_config?.language_toggle === false) {
    const lt = document.getElementById("lang-toggle");
    if (lt) lt.style.display = "none";
  }

  setBrandName();
  renderFooter();
  updateSEO();

  subscribe("lang", () => {
    renderFooter();
    updateSEO();
  });
}
