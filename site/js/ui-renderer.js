/**
 * ui-renderer.js — renders every section from the (normalized) cv data.
 * Full re-render on language change; partial update (is-hidden classes,
 * headline) on filter change.
 */
import { t } from "./i18n.js";
import { get, subscribe } from "./state.js";
import { filterUnits, computeHeadline } from "./filter-engine.js";
import { resyncGlyphReveals } from "./scroll-story.js";
import { setGlyphInstant } from "./glyph.js";
import { socialIcon } from "./icons.js";
import { glassReflow } from "./glass-motion.js";

let data = null;

/* ------------------------------------------------------------- helpers */

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

function esc(str) {
  return String(str).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

/**
 * Period label markup: "<date> · <duration>" split into spans so each half can
 * carry its own font/color/size (cv_ui.json experience_typography.date /
 * .duration). The middot is the separator; with no middot the whole string is
 * treated as the date. textContent stays identical to the source label.
 */
function periodHTML(labelText) {
  const text = String(labelText ?? "");
  const idx = text.indexOf("·"); // ·
  if (idx === -1) return `<span class="period__date">${esc(text.trim())}</span>`;
  const date = esc(text.slice(0, idx).trim());
  const dur = esc(text.slice(idx + 1).trim());
  return `<span class="period__date">${date}</span> ` +
    `<span class="period__sep">·</span> ` +
    `<span class="period__dur">${dur}</span>`;
}

/** Small colored pill for an L1 tag. Color via domain class (tokens.css). */
function tagPills(tagIds) {
  const wrap = el("div", "tag-pills");
  for (const id of tagIds) {
    const domain = data._tagDomain.get(id);
    const tagDef = findTag(id);
    const pill = el("span", `pill pill--${domain}`, esc(t(tagDef?.label) || id));
    wrap.appendChild(pill);
  }
  return wrap;
}

function findTag(tagId) {
  for (const domain of data.tag_taxonomy.domains) {
    const tag = domain.tags.find((x) => x.id === tagId);
    if (tag) return tag;
  }
  return null;
}

/**
 * Dominant expertise (domain) for a set of expskills — drives an Education
 * card's colour. Rule: the domain owning the MOST of the assigned expskills
 * wins; ties break to the domain of the FIRST expskill in array order.
 * Returns a domain id, or null if none of the expskills map to a known domain.
 */
function dominantDomain(expskills) {
  const order = []; // domains in first-seen order → encodes the tie-break
  const count = new Map();
  for (const id of expskills || []) {
    const dom = data._tagDomain.get(id);
    if (!dom) continue;
    if (!count.has(dom)) { count.set(dom, 0); order.push(dom); }
    count.set(dom, count.get(dom) + 1);
  }
  let best = null, bestN = -1;
  for (const dom of order) {
    if (count.get(dom) > bestN) { bestN = count.get(dom); best = dom; }
  }
  return best;
}

/* ------------------------------------------------------------- sections */

function renderHero() {
  const root = document.getElementById("hero");
  root.innerHTML = "";
  const inner = el("div", "hero__inner");
  // text column
  const text = el("div", "hero__text");
  text.appendChild(el("p", "hero__kicker", esc(data.profile.name)));
  text.appendChild(el("h1", "hero__headline", esc(currentHeadline())));
  text.appendChild(el("p", "hero__sub", esc(t(data.profile.subheadline))));
  // location + remote, in spans so the PDF can drop the address (print.css)
  // while keeping the "remote available" signal.
  const meta = el("p", "hero__meta",
    `<span class="hero__meta-loc">${esc(data.profile.location)}</span>` +
    `<span class="hero__meta-sep"> · </span>` +
    `<span class="hero__meta-remote">${get("lang") === "it" ? "Disponibile da remoto" : "Remote available"}</span>`);
  text.appendChild(meta);
  // live counters (filled and animated by counters.js via .js-counters)
  const counters = el("p", "hero__counters",
    `<span id="counters" class="counters js-counters" aria-live="polite"></span>`);
  text.appendChild(counters);
  inner.appendChild(text);
  // aside slot to the right of the text — the intro injects the LANGUAGE banner
  // here (hero-deflagration step 7); empty otherwise.
  inner.appendChild(el("div", "hero__aside"));
  root.appendChild(inner);
}

function currentHeadline() {
  return computeHeadline(
    get("activeTags"),
    data.headline_rules,
    data.tag_taxonomy,
    get("lang"),
    t(data.profile.headline)
  );
}

function renderAbout() {
  const root = document.getElementById("about");
  root.innerHTML = "";
  root.appendChild(sectionTitle(get("lang") === "it" ? "Profilo" : "About"));
  const html = aboutHighlightHTML(t(data.profile.summary), data.profile.about_highlights, get("lang"));
  root.appendChild(el("p", "about__summary", html));
}

// Build the About paragraph as HTML with chosen words tinted by their Exp colour.
// `highlights` maps a domain id -> a ", "-separated list of words; a word with an
// en/it variant is written "en/it". Words match in the CURRENT language, case-
// insensitively, on whole-word boundaries; everything else is HTML-escaped.
// Earlier domains win when two claim the same word; longer words win over shorter.
function aboutHighlightHTML(text, highlights, lang) {
  const src = String(text ?? "");
  if (!highlights || typeof highlights !== "object") return esc(src);

  const termToDomain = new Map();
  for (const fam of data.tag_taxonomy.domains) {
    const raw = highlights[fam.id];
    if (!raw) continue;
    for (const token of String(raw).split(",")) {
      const term = pickAboutVariant(token.trim(), lang);
      if (!term) continue;
      const key = term.toLowerCase();
      if (!termToDomain.has(key)) termToDomain.set(key, { dom: fam.id, term });
    }
  }
  if (!termToDomain.size) return esc(src);

  const terms = [...termToDomain.values()].sort((a, b) => b.term.length - a.term.length);
  const alt = terms.map((x) => escapeRegExpAbout(x.term)).join("|");
  let re;
  try {
    // whole-word via unicode-aware lookarounds (handles accented letters)
    re = new RegExp("(?<![\\p{L}\\p{N}])(" + alt + ")(?![\\p{L}\\p{N}])", "giu");
  } catch {
    re = new RegExp("\\b(" + alt + ")\\b", "gi"); // older engines: ASCII boundaries
  }

  let out = "", last = 0, m;
  while ((m = re.exec(src)) !== null) {
    out += esc(src.slice(last, m.index));
    const info = termToDomain.get(m[0].toLowerCase());
    out += info
      ? `<span class="about-hl" style="--hl:var(--c-domain-${info.dom})">${esc(m[0])}</span>`
      : esc(m[0]);
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++; // guard against any zero-width match
  }
  out += esc(src.slice(last));
  return out;
}

// One token "en/it" -> the word for the active language (fallback: the other side).
function pickAboutVariant(token, lang) {
  if (!token) return "";
  if (!token.includes("/")) return token;
  const [en, it] = token.split("/").map((s) => s.trim());
  return (lang === "it" ? (it || en) : (en || it)) || "";
}

function escapeRegExpAbout(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderExpertise() {
  const root = document.getElementById("expertise");
  root.innerHTML = "";
  root.appendChild(sectionTitle(get("lang") === "it" ? "Competenze" : "Expertise"));
  const grid = el("div", "expertise-grid");
  // Single source of truth: each taxonomy domain IS an expertise family
  // (label = short filter label, expertise_label = rich card title).
  for (const fam of data.tag_taxonomy.domains) {
    if (!fam.items || !fam.items.length) continue; // skip empty families (e.g. consulting until populated)
    const title = t(fam.expertise_label || fam.label);
    const card = el("article", "card expertise-card");
    // Per-family colour: expose the domain colour as --exp-c so the CSS can tint
    // the border/glow/veil. Data-driven — any domain id with a --c-domain-<id>
    // token (theme.js) colours itself, including consulting once populated.
    card.dataset.domain = fam.id;
    card.style.setProperty("--exp-c", `var(--c-domain-${fam.id})`);
    card.appendChild(el("h3", "expertise-card__title", esc(title)));
    card.appendChild(el("p", "expertise-card__items", esc(fam.items.join(" · "))));
    card.appendChild(tagPills(fam.tags.map((tg) => tg.id)));
    grid.appendChild(card);
  }
  root.appendChild(grid);
}

function renderExperience() {
  const root = document.getElementById("experience");
  root.innerHTML = "";
  root.appendChild(sectionTitle(get("lang") === "it" ? "Esperienza (Gioca con la mia)" : "Experience (Play with my)"));
  const grid = el("div", "experience-grid");

  // Sort by period.start descending (most recent first)
  const sorted = [...data.experience].sort((a, b) =>
    a.period.start < b.period.start ? 1 : -1
  );
  for (const exp of sorted) {
    grid.appendChild(renderExpCard(exp));
  }
  root.appendChild(grid);
  applyFilterVisibility();
}

function renderExpCard(exp) {
  const card = el("article", "card exp-card");
  card.dataset.expId = exp.id;
  // Blocco C: keyboard accessibility
  card.setAttribute("tabindex", "0");
  card.setAttribute("role", "button");
  card.setAttribute("aria-expanded", "false");

  // --- FRONT (always visible) ---
  const front = el("div", "exp-card__front");

  // Company header (reuse company-card__head classes for glyph-assembly compat)
  const head = el("header", "company-card__head");
  head.appendChild(el("h3", "company-card__name", esc(exp.company)));
  head.appendChild(el("p", "company-card__location", esc(exp.company_location || "")));
  front.appendChild(head);

  // Role header
  const roleHead = el("header", "role__head");
  roleHead.appendChild(el("h4", "role__title", esc(t(exp.role))));
  roleHead.appendChild(el("p", "role__period", periodHTML(t(exp.period.label))));
  front.appendChild(roleHead);

  // Hook
  front.appendChild(el("p", "role__hook", esc(t(exp.hook))));

  // Aggregated tags
  front.appendChild(tagPills(exp._tags));

  card.appendChild(front);

  // --- DETAIL (hidden in this block, display:none via CSS) ---
  const detail = el("div", "exp-card__detail");

  if (Array.isArray(exp.projects) && exp.projects.length > 0) {
    const list = el("div", "projects");
    exp.projects.forEach((project, i) => {
      const unit = exp._units[i];
      const item = el("div", "project");
      item.dataset.unitId = unit.id;
      const phead = el("header", "project__head");
      phead.appendChild(el("h5", "project__name", esc(project.name)));
      if (project.period) {
        phead.appendChild(el("span", "project__period", periodHTML(t(project.period))));
      }
      item.appendChild(phead);
      const ul = el("ul", "bullets");
      for (const b of t(project.bullets) || []) ul.appendChild(el("li", null, esc(b)));
      item.appendChild(ul);
      if (project.links?.length) item.appendChild(renderLinks(project.links));
      item.appendChild(tagPills(unit.tags));
      list.appendChild(item);
    });
    detail.appendChild(list);
  } else {
    // No projects: bullets+links on the card itself, data-unit-id on the card
    card.dataset.unitId = exp.id;
    const ul = el("ul", "bullets");
    for (const b of t(exp.bullets) || []) ul.appendChild(el("li", null, esc(b)));
    detail.appendChild(ul);
    if (exp.links?.length) detail.appendChild(renderLinks(exp.links));
  }

  card.appendChild(detail);
  return card;
}

/** @deprecated — kept so external callers (if any) don't crash; use renderExpCard */
function renderRole(exp) {
  return renderExpCard(exp);
}

function renderLinks(links) {
  const wrap = el("p", "links");
  for (const link of links) {
    const a = el("a", "link", esc(link.label));
    a.href = link.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    wrap.appendChild(a);
  }
  return wrap;
}

function renderEducation() {
  const root = document.getElementById("education");
  root.innerHTML = "";
  root.appendChild(sectionTitle(get("lang") === "it" ? "Formazione" : "Education"));
  const list = el("div", "education-list");
  for (const ed of data.education) {
    const item = el("article", "card education-card");
    // Per-card colour: the dominant expertise of its expskills (same --exp-c
    // tinting as Expertise cards; falls back to neutral when no expskill maps).
    const dom = dominantDomain(ed.expskills);
    if (dom) {
      item.dataset.domain = dom;
      item.style.setProperty("--exp-c", `var(--c-domain-${dom})`);
    }
    item.appendChild(el("h3", "education-card__title", esc(t(ed.title))));
    item.appendChild(el("p", "education-card__meta", `${esc(t(ed.institution))} · ${ed.year}`));
    if (Array.isArray(ed.expskills) && ed.expskills.length) {
      item.appendChild(tagPills(ed.expskills)); // decorative (no filtering)
    }
    list.appendChild(item);
  }
  root.appendChild(list);

  // Languages inline under education
  const langs = el("p", "education-langs",
    data.languages.map((l) => `${esc(t(l.language))} — ${esc(t(l.level))}`).join(" · "));
  root.appendChild(langs);
}

/** Map a link href to a known social icon id (or null for email/phone/other). */
function socialIdFor(href) {
  try {
    const host = new URL(href).hostname.replace(/^www\./, "");
    if (host.includes("linkedin")) return "linkedin";
    if (host.includes("artstation")) return "artstation";
    if (host.includes("github")) return "github";
  } catch { /* mailto: / tel: / relative → not a social URL */ }
  return null;
}

/**
 * Build the contact form. The owner's email is NOT in the page: the form POSTs
 * { email, message } as JSON to a configurable endpoint (cv_ui.json
 * contact_form.endpoint), which a small server-side handler relays to the inbox.
 * A honeypot field + client validation guard against trivial spam. On success
 * the fields collapse to a confirmation message.
 */
function buildContactForm(it) {
  const endpoint = (data.contact_form && data.contact_form.endpoint) || "/api/contact";
  // Anti-spam: stamp when the form was built so the server can apply a
  // "filled-too-fast = bot" time-trap (we send the elapsed ms on submit), plus a
  // basic email-format gate — the form is novalidate so the browser's own check
  // is off; we validate here AND again server-side (never trust the client).
  const builtAt = Date.now();
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const form = el("form", "contact-form");
  form.setAttribute("novalidate", "");
  form.innerHTML =
    `<div class="contact-form__field">
       <label for="cf-email">${it ? "La tua email" : "Your email"}</label>
       <input id="cf-email" name="email" type="email" autocomplete="email" required
              placeholder="${it ? "nome@esempio.com" : "name@example.com"}">
     </div>
     <div class="contact-form__field">
       <label for="cf-message">${it ? "Messaggio" : "Message"}</label>
       <textarea id="cf-message" name="message" rows="4" required
                 placeholder="${it ? "Scrivi qui il tuo messaggio…" : "Write your message here…"}"></textarea>
     </div>
     <input class="contact-form__hp" type="text" name="company" tabindex="-1" autocomplete="off" aria-hidden="true">
     <button type="submit" class="contact-form__submit" aria-label="${it ? "Invia messaggio" : "Send message"}"><span class="contact-form__submit-label" aria-hidden="true">${it ? "Invia messaggio" : "Send message"}</span></button>
     <p class="contact-form__status" role="status" aria-live="polite"></p>`;

  const status = form.querySelector(".contact-form__status");
  const submit = form.querySelector(".contact-form__submit");
  wireSubmitTeaser(submit, it);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (form.company.value) return; // honeypot tripped → silently ignore (bot)
    const email = form.email.value.trim();
    const message = form.message.value.trim();
    if (!email || !message) {
      status.className = "contact-form__status is-error";
      status.textContent = it ? "Inserisci email e messaggio." : "Please fill in email and message.";
      return;
    }
    if (!EMAIL_RE.test(email)) {
      status.className = "contact-form__status is-error";
      status.textContent = it ? "Inserisci un'email valida." : "Please enter a valid email.";
      return;
    }
    submit.disabled = true;
    status.className = "contact-form__status is-pending";
    status.textContent = it ? "Invio in corso…" : "Sending…";
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, message, company: form.company.value, elapsed: Date.now() - builtAt })
      });
      if (!res.ok) {
        // The server rejects user-fixable problems with a real 4xx + { error }
        // (never a false "sent"). Carry that reason to the catch for a targeted
        // message; bot drops (honeypot/too_fast) return 200 and never land here.
        let reason = "";
        try { reason = ((await res.json()) || {}).error || ""; } catch { /* no JSON body */ }
        throw reason;
      }
      form.classList.add("is-sent"); // CSS collapses the fields
      status.className = "contact-form__status is-success";
      status.textContent = it
        ? "Messaggio inviato — grazie! Ti risponderò al più presto."
        : "Message sent — thank you! I'll get back to you soon.";
    } catch (reason) {
      submit.disabled = false;
      status.className = "contact-form__status is-error";
      // Targeted, localized message per the server's reason; generic fallback for
      // network errors (reason is the thrown Error object, not a known key).
      const messages = {
        bad_email:      it ? "Inserisci un'email valida." : "Please enter a valid email.",
        empty:          it ? "Scrivi un messaggio." : "Please write a message.",
        too_long:       it ? "Messaggio troppo lungo." : "Your message is too long.",
        too_many_links: it ? "Troppi link nel messaggio." : "Too many links in your message."
      };
      status.textContent = messages[reason] || (it
        ? "Invio non riuscito. Riprova più tardi."
        : "Couldn't send right now. Please try again later.");
    }
  });
  return form;
}

/**
 * "Blur teaser" on the submit button. The visible label starts blurred and
 * unreadable; the accessible name (button aria-label) stays "Send message" so
 * SR/forms are unaffected. The reveal RE-ARMS every time the button (re)enters
 * the viewport (IntersectionObserver), per scene:
 *   - hover devices: stays blurred until mouseover (reveals "What R U waiting
 *     for?!" / "Cosa aspetti?!"); on mouseout it settles to the real label.
 *   - touch devices (no hover): timed auto-play — blurred 2s → unblur → teaser
 *     3s → real label.
 * prefers-reduced-motion: no blur game, just the plain label.
 */
function wireSubmitTeaser(button, it) {
  const label = button.querySelector(".contact-form__submit-label");
  if (!label) return;
  const teaser = it ? "Cosa aspetti?!" : "What R U waiting for?!";
  const finalText = it ? "Invia messaggio" : "Send message";

  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    label.textContent = finalText;
    button.dataset.state = "final"; // green: shows the real label, no blur game
    return;
  }

  const canHover = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const MIN_READ = 3000;   // ms the teaser stays readable once revealed (web)
  let timers = [];
  let settled = false;
  let revealStart = 0;     // perf time when the teaser was first unblurred
  let pendingLeave = false;
  const clear = () => { timers.forEach(clearTimeout); timers = []; };
  const settle = () => {
    label.textContent = finalText;
    label.classList.remove("is-blurred");
    button.dataset.state = "final"; // green
    settled = true;
  };

  function arm() {
    clear();
    settled = false;
    revealStart = 0;
    pendingLeave = false;
    label.textContent = teaser;
    label.classList.add("is-blurred");
    button.dataset.state = "blurred"; // red
    if (!canHover) {
      // touch: timed auto-reveal (blurred 2s → unblur → teaser 3s → real label)
      timers.push(setTimeout(() => {
        label.classList.remove("is-blurred");
        button.dataset.state = "teaser"; // amber
      }, 2000));
      timers.push(setTimeout(settle, 5000));
    }
  }

  if (canHover) {
    button.addEventListener("mouseenter", () => {
      if (settled) return;
      clear();                                  // cancel a pending settle (re-entered in time)
      pendingLeave = false;
      if (!revealStart) revealStart = performance.now();
      label.classList.remove("is-blurred");     // reveal the teaser
      button.dataset.state = "teaser";          // amber
    });
    button.addEventListener("mouseleave", () => {
      if (settled) return;
      // Keep the teaser readable for >= MIN_READ from when it was revealed: a
      // quick hover-in-out still leaves it long enough to read; holding the mouse
      // just keeps it. The change to "Send message" only fires after that window.
      pendingLeave = true;
      const elapsed = revealStart ? performance.now() - revealStart : 0;
      timers.push(setTimeout(() => { if (!settled && pendingLeave) settle(); },
                             Math.max(0, MIN_READ - elapsed)));
    });
  }

  // re-arm on every (re)appearance in the viewport / Contact scene
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) arm();
      else clear();
    }
  }, { threshold: 0.6 });
  io.observe(button);
}

function renderContact() {
  const root = document.getElementById("contact");
  root.innerHTML = "";
  const it = get("lang") === "it";
  root.appendChild(sectionTitle(it ? "Contatti" : "Contact"));

  const layout = el("div", "contact-layout");

  // Left: the contact form (replaces the exposed email; phone is dropped).
  layout.appendChild(buildContactForm(it));

  // Direct contacts (email / phone): the interactive form deliberately keeps the
  // email off-screen (anti-scraping), but the DOWNLOADED PDF is the CV the owner
  // hands out, so it must be reachable. This block is hidden on screen
  // (css/main.css) and revealed only in print (css/print.css), built from the
  // mailto:/tel: entries the social list skips.
  const direct = el("div", "contact-direct");
  for (const link of data.profile.contact_links || []) {
    const href = link.href || "";
    const isEmail = /^mailto:/i.test(href);
    const isPhone = /^tel:/i.test(href);
    if (!isEmail && !isPhone) continue;
    const value = href.replace(/^mailto:/i, "").replace(/^tel:/i, "");
    // modifier class lets the PDF toggles (site_config.pdf.email/phone) drop a row
    const mod = isEmail ? " contact-direct__row--email" : " contact-direct__row--phone";
    const row = el("p", "contact-direct__row" + mod,
      `<span class="contact-direct__label">${esc(link.label)}</span>` +
      `<a class="contact-direct__value" href="${esc(href)}">${esc(value)}</a>`);
    direct.appendChild(row);
  }
  if (direct.children.length) layout.appendChild(direct);

  // PDF toggles (print-only): reflect site_config.pdf into body classes that
  // print.css reads to show/hide the email/phone rows and the URL addresses.
  applyPdfToggles();

  // Right: social links as white icons + full name (no URL shown). Driven by
  // profile.contact_links; email/phone (mailto:/tel:) are skipped automatically.
  const socials = el("div", "contact-socials");
  for (const link of data.profile.contact_links || []) {
    const id = socialIdFor(link.href);
    if (!id) continue;
    const a = el("a", "social-link");
    a.href = link.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.setAttribute("aria-label", link.label);
    a.innerHTML =
      `<span class="social-link__icon">${socialIcon(id)}</span>` +
      `<span class="social-link__name">${esc(link.label)}</span>`;
    socials.appendChild(a);
  }
  if (socials.children.length) layout.appendChild(socials);

  root.appendChild(layout);
}

function sectionTitle(text) {
  return el("h2", "section-title", esc(text));
}

/* --------------------------------------------------- filter visibility */

/** Toggle the .is-hidden classes for the active filter (no animation). */
function setFilterClasses() {
  const matching = new Set(
    filterUnits(data._units, get("activeTags"), data.tag_taxonomy).map((u) => u.id)
  );
  // Per-unit visibility (covers .project[data-unit-id] and exp-cards without projects)
  for (const node of document.querySelectorAll("[data-unit-id]")) {
    node.classList.toggle("is-hidden", !matching.has(node.dataset.unitId));
  }
  // An exp-card with projects: hide the card when all its projects are hidden.
  // An exp-card without projects has data-unit-id on itself (handled above).
  for (const card of document.querySelectorAll(".exp-card")) {
    if (card.dataset.unitId) continue; // already handled by per-unit loop
    const visible = card.querySelectorAll(".project:not(.is-hidden)").length;
    card.classList.toggle("is-hidden", visible === 0);
  }
}

/**
 * Apply the active filter to the experience grid. With `animate`, the surviving
 * cards glide to re-pack the grid (GSAP Flip): filtered-out cards leave the
 * flow (.exp-card.is-hidden → display:none) and fade/scale out, the remaining
 * cards slide into the gaps, and newly matching cards fade/scale in. Falls back
 * to an instant toggle without GSAP/Flip or under prefers-reduced-motion.
 */
function applyFilterVisibility(animate = false) {
  const grid = document.querySelector("#experience .experience-grid");
  const cards = grid ? [...grid.querySelectorAll(".exp-card")] : [];
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const useFlip = animate && grid && cards.length &&
    window.gsap && window.Flip && !reducedMotion;

  if (!useFlip) { setFilterClasses(); return; }

  const gsap = window.gsap;
  const scrollY0 = window.scrollY;
  // Document Y of the grid's top (stable: it sits below the unchanged sections
  // above). If the viewport starts BELOW it, the user is looking at content
  // below the grid — we keep that content visually anchored so the page doesn't
  // lurch as the grid (above) changes height.
  const gridDocTop = grid.getBoundingClientRect().top + scrollY0;
  const anchorBelow = scrollY0 > gridDocTop + 4;

  // Glyph titles below (Education, Contact, …) must not run their slow
  // scatter→assemble while the grid reflows: snap them, and keep assembly
  // instant for the whole operation (plus a tail for async IO callbacks).
  setGlyphInstant(true);

  // Route through the shared glass choreographer so the re-pack reflow is one
  // synchronized motion (Flip + height + anchor-scroll on one timeline/ease).
  glassReflow(grid, setFilterClasses, {
    scale: true, // cards leave/enter → fade+scale reads well
    // Keep the content below the grid pinned as the grid (above) resizes — same
    // relationship every frame, on the height tween's clock.
    scrollAnchor: anchorBelow ? (curH, beforeH) => scrollY0 + (curH - beforeH) : null,
    onEnter: (els) => gsap.fromTo(els,
      { opacity: 0, scale: 0.82 }, { opacity: 1, scale: 1, duration: 0.45, ease: "power2.out" }),
    onLeave: (els) => gsap.to(els,
      { opacity: 0, scale: 0.82, duration: 0.3, ease: "power2.in" }),
    // Snap the below-grid glyph titles every frame (they're in instant mode) so
    // they don't scatter mid-reflow — a child ticker on the SAME timeline.
    build: (tl, ctx) => { if (tl) tl.to({}, { duration: ctx.duration, onUpdate: resyncGlyphReveals }, 0); },
    onSettle: () => {
      resyncGlyphReveals();
      // hold "instant" a touch longer so trailing (async) IntersectionObserver
      // callbacks from the reflow also snap, then restore normal scroll reveals
      setTimeout(() => { setGlyphInstant(false); resyncGlyphReveals(); }, 150);
    },
    reducedMotion,
  });
  resyncGlyphReveals();
}

function updateHeadline() {
  const node = document.querySelector(".hero__headline");
  if (node) node.textContent = currentHeadline();
}

/* ------------------------------------------------------------- public */

function renderAll(cvData) {
  data = cvData;
  renderHero();
  renderAbout();
  renderExpertise();
  renderExperience();
  renderEducation();
  renderContact();
}

/** Reflect site_config.pdf booleans into body classes that print.css reads to
 *  shape the PRINTED CV. Defaults match today's behaviour: email on, phone off,
 *  link (URL addresses) on. Exposed as window.evolvedcvApplyPdfToggles so the
 *  editor can push live edits onto the preview without a reload. */
function applyPdfToggles(pdf) {
  const p = pdf || (data && data.site_config && data.site_config.pdf) || {};
  const b = document.body;
  b.classList.toggle("pdf-no-email", p.email === false);
  b.classList.toggle("pdf-no-phone", p.phone !== true);
  b.classList.toggle("pdf-no-link", p.link === false);
}

export function initRenderer(cvData) {
  renderAll(cvData);
  subscribe("lang", () => renderAll(data));
  subscribe("activeTags", () => {
    applyFilterVisibility(true);
    updateHeadline();
  });
  window.evolvedcvApplyPdfToggles = applyPdfToggles;
  // Editor live preview: push fresh About highlight words and re-render the
  // About paragraph (with their Exp tints) WITHOUT a full iframe reload. The
  // freshly-rendered paragraph is plain-visible (not glyph-scattered); the next
  // real reload re-applies the scroll reveal normally.
  window.evolvedcvApplyAboutHighlights = (highlights) => {
    if (highlights && typeof highlights === "object") data.profile.about_highlights = highlights;
    renderAbout();
  };
}
