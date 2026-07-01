/**
 * filter-scene.js — filter mode orchestrator.
 *
 * Filter mode is a LIVE menu of rounded tag buttons that expands under the
 * Filters FAB (a bottom sheet on mobile). The CV is NOT blurred: toggling a
 * chip reflows the cards in place (ui-renderer subscribes to activeTags), so
 * results update beside the menu.
 *
 * No three.js here. Owns: the FAB (+ active-count badge), the menu overlay
 * (live counters/headline, the per-domain chip groups, active chips, Reset),
 * focus trap, ESC, and the open/close transition.
 */
import { t } from "./i18n.js";
import { get, set, subscribe, toggleTag, resetTags } from "./state.js";
import { filterUnits, countProjects, totalDuration, computeHeadline } from "./filter-engine.js";
import { getDomainColor } from "./theme.js";
import { stickyBarHeight } from "./dom-utils.js";

const isMobile = () => matchMedia("(max-width: 767px)").matches;

const ONLY_VIEW = "tagfield";

let data = null;
let isOpen = false;
let lastFocus = null;
let els = {};
let drilled = null;   // null = domain row shown; <domainId> = drilled into a domain
let committedTags = new Set();  // the APPLIED filter snapshot — selections are a
                                // preview until Apply; ×/leave reverts to this
let suppressAutoClose = false;  // true from open until the first real user scroll,
                                // so the open's own fitMobilePanel scroll can't
                                // self-trigger the leave-Experience auto-close (#2)
let leaveTimer = null;
let openScrollBaseline = 0;     // scrollY captured AFTER fitMobilePanel settles —
                                // the auto-close only arms once the user scrolls
let scrollWatchArmed = false;   // far enough from this baseline (not tap-jitter)

/* ------------------------------------------------------------------ DOM */

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function buildDom() {
  const it = () => get("lang") === "it";

  // FAB
  const fab = el("button", "filter-fab");
  fab.type = "button";
  fab.id = "filter-fab";
  fab.setAttribute("aria-haspopup", "dialog");
  fab.innerHTML = `<span class="filter-fab__icon" aria-hidden="true">◈</span><span class="filter-fab__label"></span><span class="filter-fab__badge" aria-hidden="true" hidden></span>`;
  fab.addEventListener("click", () => (isOpen ? exitFilterMode() : enterFilterMode()));
  document.body.appendChild(fab);

  // Overlay
  const overlay = el("div", "filter-overlay");
  overlay.id = "filter-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Filters");
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="filter-overlay__top">
      <div class="filter-live">
        <span id="filter-headline" class="filter-headline" aria-live="polite"></span>
        <span id="filter-counters" class="filter-counters" aria-live="polite"></span>
      </div>
      <button type="button" id="filter-close" class="filter-btn filter-btn--ghost" aria-label="Close (Esc)">✕</button>
    </div>
    <div id="filter-chip-panel" class="filter-chip-panel"></div>
    <div class="filter-overlay__bottom">
      <div id="filter-active-chips" class="filter-active-chips" aria-live="polite"></div>
      <div class="filter-actions">
        <button type="button" id="filter-reset" class="filter-btn filter-btn--ghost"></button>
        <button type="button" id="filter-apply" class="filter-btn filter-btn--primary"></button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  els = {
    fab,
    overlay,
    badge: fab.querySelector(".filter-fab__badge"),
    headline: overlay.querySelector("#filter-headline"),
    counters: overlay.querySelector("#filter-counters"),
    chipPanel: overlay.querySelector("#filter-chip-panel"),
    activeChips: overlay.querySelector("#filter-active-chips"),
    reset: overlay.querySelector("#filter-reset"),
    apply: overlay.querySelector("#filter-apply"),
    close: overlay.querySelector("#filter-close")
  };

  // Reset: clear the selection AND apply+close in one go (req 2026-06-25) — an
  // empty filter committed, panel closed. (resetTags() empties activeTags; the
  // subsequent commit-exit snapshots that empty set as the applied filter.)
  els.reset.addEventListener("click", () => { resetTags(); exitFilterMode(true); });
  els.apply.addEventListener("click", () => exitFilterMode(true));   // commit
  els.close.addEventListener("click", () => exitFilterMode(false));  // cancel

  document.addEventListener("keydown", onKeydown);

  // The Filters button only lives in the Experience scene (body.in-experience,
  // toggled by main.js's IntersectionObserver). If the panel is open and the user
  // scrolls OUT of Experience, close it — the open panel shouldn't linger over
  // other sections; coming back to Experience shows the "Filters" button again.
  //
  // GATED BY A REAL USER GESTURE: opening runs fitMobilePanel(), which scrolls to
  // align the L0 grid. That programmatic scroll (esp. once the grid is compacted
  // to L0 and short) can drop `in-experience` and would auto-close the panel the
  // instant it opened — the "first click does nothing" bug. So we ARM the
  // auto-close only after the user actually touches/wheels the page; until then
  // any in-experience drop is layout-induced and ignored. (suppressAutoClose is
  // set true in enterFilterMode and released on the first user scroll gesture.)
  new MutationObserver(scheduleLeaveClose)
    .observe(document.body, { attributes: true, attributeFilter: ["class"] });

  relabel();
  updateBadge();
  subscribe("lang", relabel);
  subscribe("activeTags", () => {
    updateLive();
    renderActiveChips();
    updateBadge();
    // full re-render so domain badges + dead-end grey-out refresh, not just pressed
    if (els.chipPanel && !els.chipPanel.hidden) renderChipPanel();
  });

  function relabel() {
    fab.querySelector(".filter-fab__label").textContent = it() ? "Filtri" : "Filters";
    fab.setAttribute("aria-label", it() ? "Apri filtri" : "Open filters");
    els.reset.textContent = "Reset";
    els.apply.textContent = it() ? "Applica" : "Apply";
    updateLive();
    renderActiveChips();
  }
}

/** FAB badge: number of active filters (hidden when none). */
function updateBadge() {
  if (!els.badge) return;
  const n = get("activeTags").size;
  els.badge.textContent = String(n);
  els.badge.hidden = n === 0;
  els.fab.classList.toggle("has-active", n > 0);
}

/* ------------------------------------------------------------------ live UI */

function updateLive() {
  if (!els.counters) return;
  const active = get("activeTags");
  const units = filterUnits(data._units, active, data.tag_taxonomy);
  const n = countProjects(units);
  const { totalMonths } = totalDuration(units);
  const yrs = Math.floor(totalMonths / 12);
  const mo = totalMonths % 12;
  const it = get("lang") === "it";
  const proj = it ? `${n} ${n === 1 ? "progetto" : "progetti"}` : `${n} ${n === 1 ? "project" : "projects"}`;
  const dur = [yrs > 0 ? (it ? `${yrs} anni` : `${yrs} yrs`) : "", mo > 0 || yrs === 0 ? (it ? `${mo} mesi` : `${mo} mo`) : ""]
    .filter(Boolean).join(" ");
  els.counters.textContent = `${proj} · ${dur}`;
  // On mobile the top bar is a plain panel TITLE ("Filtri") — NOT the marketing
  // headline, which duplicated the home title. Desktop keeps the morphing headline.
  // The live counter shows ONLY when a filter is active (so opening with nothing
  // selected doesn't echo the home's full count); `has-filters` gates it in CSS.
  els.headline.textContent = isMobile()
    ? (it ? "Filtri" : "Filters")
    : computeHeadline(active, data.headline_rules, data.tag_taxonomy, get("lang"), t(data.profile.headline));
  // Show the active-chips + Reset/Apply bar when there's a selection OR (while
  // open) a pending change vs the applied snapshot — so you can also Apply a clear.
  if (els.overlay) {
    els.overlay.classList.toggle("has-filters", active.size > 0 || (isOpen && committedTags.size > 0));
  }
}

function tagInfo(tagId) {
  for (const d of data.tag_taxonomy.domains) {
    const tag = d.tags.find((x) => x.id === tagId);
    if (tag) return { tag, domain: d };
  }
  return null;
}

function renderActiveChips() {
  if (!els.activeChips) return;
  els.activeChips.innerHTML = "";
  const it = get("lang") === "it";
  const active = get("activeTags");
  if (active.size === 0) {
    els.activeChips.appendChild(
      el("span", "filter-active-chips__empty", it ? "Nessun filtro attivo — tocca un tag" : "No active filters — tap a tag")
    );
    return;
  }
  for (const id of active) {
    const info = tagInfo(id);
    if (!info) continue;
    const chip = el("button", `filter-active-chip filter-active-chip--${info.domain.id}`);
    chip.type = "button";
    chip.dataset.tagId = id;
    chip.style.setProperty("--chip-c", getDomainColor(info.domain.id));
    chip.innerHTML = `${t(info.tag.label)} <span aria-hidden="true">✕</span>`;
    chip.setAttribute("aria-label", (it ? "Rimuovi filtro " : "Remove filter ") + t(info.tag.label));
    chip.addEventListener("click", () => toggleTag(id));
    els.activeChips.appendChild(chip);
  }
}

/* --------------------------------------------------------- chip menu (drill) */

/** Domains that actually carry expskills (skip empty ones, e.g. consulting). */
function activeDomains() {
  return data.tag_taxonomy.domains.filter((d) => d.tags && d.tags.length);
}

/** How many of a domain's expskills are currently selected. */
function domainSelectedCount(domainId) {
  const active = get("activeTags");
  const dom = data.tag_taxonomy.domains.find((d) => d.id === domainId);
  let n = 0;
  if (dom) for (const tag of dom.tags) if (active.has(tag.id)) n++;
  return n;
}

/** Would adding `tagId` to the current selection drop the results to zero?
 *  (Used to grey out dead-end expskills — semantics: pure OR across all tags,
 *  so this only ever fires for a tag with no units while nothing else is on.) */
function tagWouldZero(tagId) {
  const active = get("activeTags");
  if (active.has(tagId)) return false; // already on → removing it can't zero
  const trial = new Set(active);
  trial.add(tagId);
  return countProjects(filterUnits(data._units, trial, data.tag_taxonomy)) === 0;
}

/** Reflect the live selection onto the rendered expskill chips: pressed state +
 *  grey-out (disable) the ones that would zero the results. */
function syncChipPanel() {
  if (!els.chipPanel) return;
  const active = get("activeTags");
  for (const b of els.chipPanel.querySelectorAll("[data-tag-id]")) {
    const id = b.dataset.tagId;
    const on = active.has(id);
    b.setAttribute("aria-pressed", String(on));
    b.classList.toggle("is-active", on);
    const dead = !on && tagWouldZero(id);
    b.classList.toggle("is-dead", dead);
    b.disabled = dead;
  }
}

/** Render the panel content. Two states:
 *  - drilled == null → a row of DOMAIN chips (each with a selected-count badge);
 *  - drilled == <id> → a "‹ back" header + that domain's expskill chips.
 *  Tapping a domain drills in (replaces the row, doesn't stack — keeps the 1/3
 *  panel compact); tapping an expskill toggles it (accumulates across domains). */
function renderChipPanel() {
  els.chipPanel.hidden = false;
  els.chipPanel.innerHTML = "";
  const it = get("lang") === "it";

  if (drilled == null) {
    const row = el("div", "filter-domains");
    for (const domain of activeDomains()) {
      const n = domainSelectedCount(domain.id);
      const chip = el("button", "filter-domain-chip");
      chip.type = "button";
      chip.style.setProperty("--chip-c", getDomainColor(domain.id));
      chip.classList.toggle("has-active", n > 0);
      chip.innerHTML = `<span>${t(domain.label)}</span>` +
        (n > 0 ? `<span class="filter-domain-chip__badge" aria-hidden="true">${n}</span>` : "");
      chip.setAttribute("aria-label", `${t(domain.label)}${n > 0 ? ` (${n})` : ""}`);
      chip.addEventListener("click", () => { drilled = domain.id; renderChipPanel(); });
      row.appendChild(chip);
    }
    els.chipPanel.appendChild(row);
  } else {
    const domain = data.tag_taxonomy.domains.find((d) => d.id === drilled);
    if (!domain) { drilled = null; return renderChipPanel(); }
    const head = el("div", "filter-drill-head");
    head.style.setProperty("--chip-c", getDomainColor(domain.id));
    const back = el("button", "filter-drill-back");
    back.type = "button";
    back.innerHTML = `<span aria-hidden="true">‹</span> ${t(domain.label)}`;
    back.setAttribute("aria-label", it ? "Torna ai domini" : "Back to domains");
    back.addEventListener("click", () => { drilled = null; renderChipPanel(); });
    head.appendChild(back);
    els.chipPanel.appendChild(head);

    const wrap = el("div", "filter-drill-chips");
    for (const tag of domain.tags) {
      const b = el("button", "filter-active-chip", t(tag.label));
      b.type = "button";
      b.dataset.tagId = tag.id;
      b.style.setProperty("--chip-c", getDomainColor(domain.id));
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => { if (!b.disabled) toggleTag(tag.id); });
      wrap.appendChild(b);
    }
    els.chipPanel.appendChild(wrap);
  }
  syncChipPanel();
}

/* ----------------------------------------------- mobile L0 + panel placement */

/**
 * MOBILE only. With the Experiences compressed to L0, pull the cards up so the
 * grid's TOP sits just under the header (otherwise the first rows scroll off the
 * top and you "lose" them), then size the bottom filter panel to start right
 * below the LAST L0 row — so header · all-experiences · panel are all on screen.
 */
function fitMobilePanel() {
  if (!isMobile() || !els.overlay) return;
  const exp = document.getElementById("experience");
  const grid = exp && exp.querySelector(".experience-grid");
  if (!grid) return;

  const headerH = stickyBarHeight(8);                       // header + small gap
  const gr = grid.getBoundingClientRect();
  const gridDocTop = gr.top + window.scrollY;
  const gridH = gr.height;
  // The panel keeps its size (≈ a 1/3 FabBar) — it never starts above this line.
  const panelFloor = Math.round(window.innerHeight * 0.72);

  // Default: grid TOP just under the header. But if a tall grid would then reach
  // BELOW the panel floor (so the panel would cover/cut the last rows), shift the
  // grid UP instead — its bottom lands just above the panel, the cards appear a
  // touch higher, and the FabBar keeps its space.
  let scroll = gridDocTop - headerH;
  const gridBottomTopAligned = headerH + gridH;
  if (gridBottomTopAligned > panelFloor - 8) {
    scroll += gridBottomTopAligned - (panelFloor - 8);
  }
  // Drop the whole L0 block L0_DROP px lower, applied to the FINAL scroll so it
  // lands in BOTH branches (req 2026-06-25). It must be here, not folded into the
  // top alignment: in the tall-grid branch the bottom-alignment correction would
  // otherwise cancel a top-side offset exactly, so an 8px nudge on the short
  // phones (where the grid hits that branch) showed no change at all.
  const L0_DROP = 13;
  scroll -= L0_DROP;
  window.scrollTo({ top: Math.max(0, Math.round(scroll)), behavior: "instant" });

  // next frame: place the panel just below the (settled) grid bottom, but never
  // above the floor — so it sits right under the last row without shrinking.
  requestAnimationFrame(() => {
    const gb = grid.getBoundingClientRect().bottom;
    const top = Math.min(gb + 8, panelFloor);
    // FIXED px height (not dvh / not top+bottom:auto): the panel stays pinned to
    // the bottom (CSS bottom:0) and NEVER resizes when the address bar later
    // reappears — it keeps the full height it was given. top:auto so bottom+height
    // define the box. (We can't stop the bar reappearing, but we can keep our own
    // panel rock-steady — req 2026-06-25.)
    els.overlay.style.top = "auto";
    // -5px: panel sits a touch lower (it's pinned to the bottom, so a shorter
    // height drops its top edge by 5px) — req 2026-06-25.
    els.overlay.style.height = Math.round(window.innerHeight - top - 5) + "px";
    // The programmatic open scroll has now settled: baseline it and ARM the
    // auto-close, so only a genuine user scroll past the threshold trips it (#2).
    openScrollBaseline = window.scrollY || 0;
    scrollWatchArmed = true;
  });
}

function clearMobilePanel() {
  if (!els.overlay) return;
  els.overlay.style.top = "";
  els.overlay.style.height = "";
}

/**
 * MOBILE only. Land cleanly at the START of a neighbouring section after the
 * open filter closes from a scroll-away. exitFilterMode() drops exp-l0
 * synchronously, so the L0 grid re-expands to full L1 height — that growth
 * pushes #education down and would otherwise leave the user mid re-expansion
 * (the "ghost / misaligned cards" feel). Read the SETTLED layout next frame and
 * align the target just under the header. (req 2026-06-25: scroll down out of
 * the open FB → start of Education.)
 */
function snapToSection(id) {
  if (!isMobile()) return;
  const sec = document.getElementById(id);
  if (!sec) return;
  requestAnimationFrame(() => {
    const top = sec.getBoundingClientRect().top + window.scrollY - stickyBarHeight(8);
    window.scrollTo({ top: Math.max(0, Math.round(top)), behavior: "instant" });
  });
}

/* --------------------------------------------------- auto-close on leave */

/** Close the open panel once the user has scrolled OUT of Experience. Gated by
 *  suppressAutoClose so the open's own fitMobilePanel scroll never fires it.
 *  Debounced 400ms to ride out any transient in-experience flicker. */
function scheduleLeaveClose() {
  if (!isOpen || suppressAutoClose) return;
  if (document.body.classList.contains("in-experience")) {
    clearTimeout(leaveTimer); leaveTimer = null;
    return;
  }
  if (!leaveTimer) {
    leaveTimer = setTimeout(() => {
      leaveTimer = null;
      if (!(isOpen && !suppressAutoClose && !document.body.classList.contains("in-experience"))) return;
      // Which way did the user leave? Read the (still-L0) Experience geometry:
      // above the viewport centre → scrolled DOWN → snap to Education; below →
      // scrolled UP → snap to Expertise. Capture BEFORE exit re-expands the grid.
      const exp = document.getElementById("experience");
      const r = exp ? exp.getBoundingClientRect() : null;
      const mid = window.innerHeight / 2;
      const target = r && r.bottom < mid ? "education" : (r && r.top > mid ? "expertise" : null);
      exitFilterMode();
      if (target) snapToSection(target);
    }, 400);
  }
}

/** Release the auto-close suppression on a REAL user scroll AWAY from the open
 *  position, then re-check. Why distance-from-baseline and not "first touchmove":
 *  opening runs fitMobilePanel(), a big programmatic scroll that aligns the L0
 *  grid under the header. The old gesture release fired on any touchmove/wheel —
 *  so a hair of finger-jitter on the opening tap (or the momentum tail of the
 *  scroll that preceded the tap) released suppression while fitMobilePanel had
 *  just pushed Experience out of the in-view band → the panel auto-closed and
 *  snapped the instant it opened ("first tap: button pops back up, Experiences
 *  jump to the header", #2). Instead we baseline scrollY AFTER fitMobilePanel
 *  settles (scrollWatchArmed) and only treat movement past a threshold as the
 *  user leaving — programmatic scroll and tap-jitter are both below it. */
function onUserScroll() {
  if (!isOpen || !suppressAutoClose || !scrollWatchArmed) return;
  if (Math.abs((window.scrollY || 0) - openScrollBaseline) < 48) return;
  suppressAutoClose = false;
  removeUserScrollListeners();
  scheduleLeaveClose();
}
function addUserScrollListeners() {
  window.addEventListener("scroll", onUserScroll, { passive: true });
}
function removeUserScrollListeners() {
  window.removeEventListener("scroll", onUserScroll);
}

/** Collapse any expanded Experience card before the filter compresses the grid
 *  to L0. Desktop does this inside experience-levels.js's flipToggle; the mobile
 *  path toggles exp-l0 directly, so without this an expanded card rode through
 *  the filter — its detail's per-glyph project title would scatter on the open's
 *  scroll (IntersectionObserver) and stay scattered/faint = the "semi-transparent,
 *  misaligned" ghost cards (#6, screenshot 2026-06-25). Mirrors card-expand's
 *  collapse(): drop the class, reset aria + any stale tilt transform. */
function collapseExpandedCards() {
  for (const card of document.querySelectorAll("#experience .exp-card.is-expanded")) {
    card.classList.remove("is-expanded");
    card.setAttribute("aria-expanded", "false");
    card.style.transform = "";
  }
}

/* ------------------------------------------------------------- enter/exit */

function onKeydown(e) {
  if (!isOpen) return;
  if (e.key === "Escape") {
    e.preventDefault();
    exitFilterMode();
    return;
  }
  if (e.key === "Tab") {
    // light focus trap
    const focusables = els.overlay.querySelectorAll("button, select, [tabindex]:not([tabindex='-1'])");
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

function enterFilterMode() {
  if (isOpen) return;
  isOpen = true;
  lastFocus = document.activeElement;
  committedTags = new Set(get("activeTags"));   // snapshot to revert to on cancel
  // Don't let the open's own fitMobilePanel scroll auto-close us (#2): suppress
  // the leave-Experience close until the user actually scrolls.
  suppressAutoClose = true;
  scrollWatchArmed = false;                      // armed only after fitMobilePanel settles
  openScrollBaseline = window.scrollY || 0;
  clearTimeout(leaveTimer); leaveTimer = null;
  addUserScrollListeners();
  set({ mode: "filter" });
  document.body.classList.add("mode-filter");
  // Enter the filter from a clean grid: collapse any expanded card first (#6).
  collapseExpandedCards();
  // Compress the Experiences to L0 (header-only grid) so they sit in the area
  // ABOVE the bottom filter panel and act as a live preview: with a filter active,
  // L0 keeps every card visible and DIMS the non-matching ones (experience-levels
  // .css) instead of removing them. (Desktop drives L0 via the footbar; this is
  // the mobile path, where the FAB/panel is the only entry — see filter-overlay.css.)
  document.body.classList.add("exp-l0");
  // hide the inline hero tag-field if it is still around (one field at a time)
  dispatchEvent(new CustomEvent("evolvedcv:overlay", { detail: { open: true } }));
  els.overlay.hidden = false;
  els.fab.classList.add("is-open");

  // The filter UI is a live menu of rounded tag buttons under the FAB. The CV
  // is NOT blurred: toggling a chip reflows the cards in place (ui-renderer
  // already subscribes to activeTags), so results update beside the menu.
  drilled = null;            // always open on the domain row
  renderChipPanel();
  updateLive();
  renderActiveChips();

  const g = window.gsap;
  // Kill any in-flight close tween (rapid close→reopen): otherwise its opacity→0
  // keeps animating against this fade-in, and its onComplete would hide us.
  if (g) { g.killTweensOf(els.overlay); g.fromTo(els.overlay, { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.4, ease: "expo.out" }); }

  // mobile: align L0 grid under the header + size the panel below the last row
  requestAnimationFrame(fitMobilePanel);

  (els.chipPanel.querySelector("button") || els.close).focus();
}

/**
 * Close the panel. `commit` true (Apply) keeps the current selection; false (×,
 * re-tap, Esc, leaving Experience) REVERTS to the snapshot taken on open — the
 * selection was only a preview.
 */
function exitFilterMode(commit = false) {
  if (!isOpen) return;
  isOpen = false;
  suppressAutoClose = false;
  scrollWatchArmed = false;
  clearTimeout(leaveTimer); leaveTimer = null;
  removeUserScrollListeners();
  if (!commit) {
    // discard the preview → restore the applied filter
    set({ activeTags: new Set(committedTags), mode: committedTags.size > 0 ? "filter" : "cv" });
  } else {
    set({ mode: get("activeTags").size > 0 ? "filter" : "cv" });
  }
  els.fab.classList.remove("is-open");
  dispatchEvent(new CustomEvent("evolvedcv:overlay", { detail: { open: false } }));

  // SYNCHRONOUS state cleanup (#6): drop exp-l0 / mode-filter and the JS-placed
  // panel sizing NOW, not after the 0.28s overlay fade. Deferring left a window
  // where the page was scrolled and the overlay fading while the cards were still
  // in L0 — exiting L0 off-screen left ghost (dimmed, misaligned) cards behind.
  // Only the overlay element's fade-out stays animated.
  document.body.classList.remove("mode-filter");
  document.body.classList.remove("exp-l0");   // Experiences re-expand to L1
  clearMobilePanel();                          // reset the JS-placed panel top/height

  const g = window.gsap;
  if (g) g.to(els.overlay, { opacity: 0, y: -10, duration: 0.28, ease: "expo.in", onComplete: () => { if (!isOpen) els.overlay.hidden = true; } });
  else els.overlay.hidden = true;

  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

/* ------------------------------------------------------------------ init */

export function initFilterScene(cvData) {
  data = cvData;
  set({ filterView: ONLY_VIEW });
  buildDom();
}
