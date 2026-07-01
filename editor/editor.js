/**
 * editor.js — local editor UI controller.
 * Loads the two JSONs via the dev-server API, renders thematic tabs, and on
 * Save writes them back (server validates + runs sync) then reloads the
 * live preview iframe. Iteration 1: "Profilo" tab functional end-to-end;
 * the other tabs are scaffolded placeholders.
 */

const api = {
  async get(key) {
    const r = await fetch(`/api/${key}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`GET ${key} -> ${r.status}`);
    return r.json();
  },
  async put(key, obj) {
    const r = await fetch(`/api/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(obj, null, 2)
    });
    const out = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body: out };
  }
};

const store = {
  data: null, ui: null,
  dirty: { data: false, ui: false }
};

/* ----------------------------------------------------------- dom helpers */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** Pick a display string from an {en,it} object (or a plain string). */
function txt(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.en || v.it || "";
}

/** Normalize any picker output to an uppercase #RRGGBB string. */
function toHex6(s) {
  const m = String(s).match(/#?([0-9a-fA-F]{6})/);
  return m ? "#" + m[1].toUpperCase() : "#000000";
}

// Auto-save: every edit funnels through markDirty(). When auto-save is ON
// (default) it debounce-persists to disk after 700ms; the toggle next to Save
// switches to manual-only saving. The choice is remembered across reloads.
const AUTOSAVE_KEY = "evolvedcv.editor.autosave";
let autoSaveEnabled = (() => {
  try { return localStorage.getItem(AUTOSAVE_KEY) !== "0"; } catch { return true; }
})();

// Most content (which:"data") edits need a preview RELOAD to show (the site
// re-renders from the saved JSON). A few data edits are instead mirrored LIVE
// via a site hook (e.g. the About highlights) and must NOT trigger a reload —
// that would flash the whole 3D scene. dataDirtyNoReload stays true only while
// every pending data edit is one of those live-mirrored ones.
let dataDirtyNoReload = true;

function markDirty(which) {
  store.dirty[which] = true;
  if (which === "data") dataDirtyNoReload = false; // a plain data edit → needs reload
  document.getElementById("btn-save").disabled = false;
  setStatus("Unsaved changes", "");
  // UI/colour edits reflect LIVE in the preview instantly (no reload needed).
  if (which === "ui") scheduleLivePreview();
  // Auto-save to disk after a short pause; content edits then reload the preview
  // so the page re-renders (git commits stay manual). Skipped when the user has
  // turned auto-save off — then only the Save button persists.
  if (autoSaveEnabled) scheduleAutoSave();
}

// Mark a data edit that's already mirrored live in the preview (About
// highlights): persist it on auto-save but skip the reload, and push the live
// hooks now so the change shows in real time.
function markDataLive() {
  if (!store.dirty.data) dataDirtyNoReload = true; // first pending data edit & it's live
  store.dirty.data = true;
  document.getElementById("btn-save").disabled = false;
  setStatus("Unsaved changes", "");
  scheduleLivePreview();
  if (autoSaveEnabled) scheduleAutoSave();
}

// Debounced auto-save: persists whatever is dirty ~0.7s after the last edit.
let autoSaveTimer = null;
function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => persistDirty({ silent: true }), 700);
}

// Some UI edits change the page STRUCTURE (e.g. page order in the Pages tab),
// which the live theme apply can't reflect — they need a preview reload on save.
let pendingPreviewReload = false;
function markUiReload() { pendingPreviewReload = true; markDirty("ui"); }

/** Make a <textarea> grow/shrink to fit its content (no manual resize handle).
 *  Stores the resize fn on the element so showTab can re-fit it once visible
 *  (a hidden textarea has scrollHeight 0 at creation). */
function autoGrow(ta) {
  const resize = () => { ta.style.height = "auto"; ta.style.height = (ta.scrollHeight + 2) + "px"; };
  ta.addEventListener("input", resize);
  ta._autoGrow = resize;
  requestAnimationFrame(resize);
}

/** Single labeled input bound to obj[key]. type: "text"|"number"|"textarea". */
function field(parent, label, obj, key, { multiline = false, which = "data", type = "text" } = {}) {
  const wrap = el("div", "field");
  wrap.appendChild(el("label", "field__label", label));
  const input = multiline ? el("textarea", "field__area") : el("input", "field__input");
  if (!multiline) input.type = type === "number" ? "number" : "text";
  input.value = obj[key] ?? "";
  input.addEventListener("input", () => {
    obj[key] = type === "number" ? (input.value === "" ? 0 : Number(input.value)) : input.value;
    markDirty(which);
  });
  if (multiline) autoGrow(input);
  wrap.appendChild(input);
  parent.appendChild(wrap);
  return input;
}

/** Checkbox bound to obj[key] (boolean). */
function boolField(parent, label, obj, key, { which = "data" } = {}) {
  const wrap = el("div", "field field--inline");
  const cb = el("input");
  cb.type = "checkbox";
  cb.checked = !!obj[key];
  cb.addEventListener("change", () => { obj[key] = cb.checked; markDirty(which); });
  const lab = el("label", "field__label field__label--inline", label);
  lab.prepend(cb);
  wrap.appendChild(lab);
  parent.appendChild(wrap);
}

/** HTML5 drag-reorder: each list child needs a .drag-handle. Reorders arr. */
function enableDrag(listEl, arr, redraw, which = "data") {
  let from = null;
  Array.from(listEl.children).forEach((card, idx) => {
    const handle = card.querySelector(".drag-handle");
    if (handle) {
      handle.draggable = true;
      handle.addEventListener("dragstart", (e) => {
        from = idx; e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(idx));
        card.classList.add("dragging");
      });
      handle.addEventListener("dragend", () => card.classList.remove("dragging"));
    }
    card.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      if (from === null || from === idx) return;
      const [moved] = arr.splice(from, 1);
      arr.splice(idx, 0, moved);
      from = null; markDirty(which); redraw();
    });
  });
}

/** Collapsible card with a drag handle, a title, and a remove button. */
function itemCard(parent, title, onRemove) {
  const card = el("div", "item-card");
  const head = el("div", "item-card__head");
  head.appendChild(el("span", "drag-handle", "⠿"));
  const t = el("span", "item-card__title", title);
  head.appendChild(t);
  const rm = el("button", "btn btn--danger item-card__rm", "Remove");
  rm.type = "button";
  rm.addEventListener("click", (e) => { e.stopPropagation(); onRemove(); });
  head.appendChild(rm);
  const body = el("div", "item-card__body");
  head.addEventListener("click", () => card.classList.toggle("is-open"));
  card.appendChild(head);
  card.appendChild(body);
  parent.appendChild(card);
  return body;
}

/** Editable list of strings (add/remove/edit), mutating arr in place. */
function arrayEditor(parent, label, arr, { which = "data", placeholder = "" } = {}) {
  const wrap = el("div", "field");
  wrap.appendChild(el("label", "field__label", label));
  const list = el("div", "arr-list");
  const draw = () => {
    list.innerHTML = "";
    arr.forEach((val, idx) => {
      const row = el("div", "arr-row");
      const input = el("input", "field__input");
      input.type = "text"; input.value = val; input.placeholder = placeholder;
      input.addEventListener("input", () => { arr[idx] = input.value; markDirty(which); });
      const rm = el("button", "arr-rm", "×"); rm.type = "button"; rm.title = "Remove";
      rm.addEventListener("click", () => { arr.splice(idx, 1); markDirty(which); draw(); });
      row.appendChild(input); row.appendChild(rm); list.appendChild(row);
    });
    const add = el("button", "btn arr-add", "+ Add"); add.type = "button";
    add.addEventListener("click", () => {
      arr.push(""); markDirty(which); draw();
      const inputs = list.querySelectorAll(".arr-row input");
      inputs[inputs.length - 1]?.focus();
    });
    list.appendChild(add);
  };
  draw();
  wrap.appendChild(list);
  parent.appendChild(wrap);
}

/** Labeled <select> bound to obj[key]. opts: [{value,label}] or [string].
 *  reload:true → the change needs a preview reload (structural/particle edits). */
function selectField(parent, label, obj, key, opts, { which = "data", reload = false } = {}) {
  const wrap = el("div", "field");
  wrap.appendChild(el("label", "field__label", label));
  const sel = el("select", "field__input");
  for (const o of opts) {
    const v = typeof o === "string" ? o : o.value;
    const lbl = typeof o === "string" ? o : o.label;
    const opt = el("option", null, lbl); opt.value = v;
    if (obj[key] === v) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => { obj[key] = sel.value; if (reload) markUiReload(); else markDirty(which); });
  wrap.appendChild(sel);
  parent.appendChild(wrap);
}

/** Range slider + live numeric readout bound to obj[key] (number).
 *  reload:true → the change needs a preview reload (particle pos/scale). */
function rangeField(parent, label, obj, key, { min = 0, max = 5, step = 0.1, which = "data", unit = "", reload = false } = {}) {
  const wrap = el("div", "field");
  const head = el("div", "range-head");
  head.appendChild(el("label", "field__label", label));
  const out = el("span", "range-out", (obj[key] ?? 0) + unit);
  head.appendChild(out);
  wrap.appendChild(head);
  const input = el("input", "range-input");
  input.type = "range"; input.min = min; input.max = max; input.step = step;
  input.value = obj[key] ?? min;
  input.addEventListener("input", () => {
    obj[key] = Number(input.value);
    out.textContent = input.value + unit;
    if (reload) { markUiReload(); return; }
    markDirty(which);
  });
  wrap.appendChild(input);
  parent.appendChild(wrap);
}

/** Bilingual {en,it} pair bound to obj (obj.en / obj.it). */
function bilingual(parent, label, obj, { multiline = false, which = "data", onInput = null } = {}) {
  const wrap = el("div", "field");
  wrap.appendChild(el("label", "field__label", label));
  const grid = el("div", "pair");
  for (const lang of ["en", "it"]) {
    const col = el("div");
    col.appendChild(el("span", "lang-tag", lang.toUpperCase()));
    const input = multiline ? el("textarea", "field__area") : el("input", "field__input");
    if (!multiline) input.type = "text";
    input.value = obj?.[lang] ?? "";
    input.addEventListener("input", () => { obj[lang] = input.value; markDirty(which); if (onInput) onInput(); });
    if (multiline) autoGrow(input);
    col.appendChild(input);
    grid.appendChild(col);
  }
  wrap.appendChild(grid);
  parent.appendChild(wrap);
}

/* ------------------------------------------------------------------ tabs */
function renderProfile(pane) {
  pane.innerHTML = "";
  const p = store.data.profile;
  pane.appendChild(el("h2", "section-title", "Profile"));
  field(pane, "Name", p, "name");
  field(pane, "Location", p, "location");
  bilingual(pane, "Headline", p.headline);
  bilingual(pane, "Subtitle", p.subheadline);
  bilingual(pane, "Summary (bio)", p.summary, { multiline: true });
}

function renderPlaceholder(pane, title, note) {
  pane.innerHTML = "";
  pane.appendChild(el("h2", "section-title", title));
  const box = el("div", "placeholder");
  box.textContent = note;
  pane.appendChild(box);
}

/** Compact "chips/bricks" editor: each value is a small tag (editable text + ×),
 *  they wrap on the same rows; a trailing input adds new ones (Enter). Best for
 *  short tokens (aliases, items) — not for long sentences. Mutates arr in place. */
function chipEditor(parent, label, arr, { which = "data", placeholder = "add…", reorder = false } = {}) {
  const wrap = el("div", "field");
  wrap.appendChild(el("label", "field__label", label));
  const box = el("div", "chips");
  const focusInput = () => box.querySelector(".chips__input")?.focus();
  let dragFrom = null;
  const draw = () => {
    box.innerHTML = "";
    arr.forEach((val, idx) => {
      const chip = el("span", "chip");
      if (reorder) {
        const grip = el("span", "chip__grip", "⠿");
        grip.title = "Drag to reorder";
        grip.draggable = true;
        grip.addEventListener("dragstart", (e) => {
          dragFrom = idx; e.dataTransfer.effectAllowed = "move";
          // custom mime (NOT text/plain) so nothing gets inserted if the drop
          // lands over a contenteditable chip or the text input.
          e.dataTransfer.setData("application/x-chip-reorder", String(idx));
          chip.classList.add("dragging");
        });
        grip.addEventListener("dragend", () => { chip.classList.remove("dragging"); dragFrom = null; });
        chip.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
        chip.addEventListener("drop", (e) => {
          e.preventDefault(); e.stopPropagation();
          if (dragFrom === null || dragFrom === idx) return;
          const [moved] = arr.splice(dragFrom, 1);
          arr.splice(idx, 0, moved);
          dragFrom = null; markDirty(which); draw();
        });
        chip.appendChild(grip);
      }
      const t = el("span", "chip__txt", val);
      t.contentEditable = "true";
      t.spellcheck = false;
      t.addEventListener("input", () => { arr[idx] = t.textContent; markDirty(which); });
      t.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); t.blur(); } });
      t.addEventListener("blur", () => { if (!t.textContent.trim()) { arr.splice(idx, 1); markDirty(which); draw(); } });
      const x = el("button", "chip__x", "×");
      x.type = "button"; x.title = "Remove";
      x.addEventListener("click", () => { arr.splice(idx, 1); markDirty(which); draw(); });
      chip.appendChild(t); chip.appendChild(x);
      box.appendChild(chip);
    });
    const input = el("input", "chips__input");
    input.type = "text"; input.placeholder = placeholder;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) {
        e.preventDefault(); arr.push(input.value.trim()); markDirty(which); draw(); focusInput();
      } else if (e.key === "Backspace" && !input.value && arr.length) {
        arr.pop(); markDirty(which); draw(); focusInput();
      }
    });
    box.appendChild(input);
  };
  draw();
  if (reorder) {
    // Catch-all on the container: a drop on empty padding or on the trailing
    // text input would otherwise let the browser insert the dragged payload.
    // Cancel the default everywhere; an off-chip drop sends the item to the end.
    box.addEventListener("dragover", (e) => {
      if (dragFrom !== null) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }
    });
    box.addEventListener("drop", (e) => {
      if (dragFrom === null) return;
      e.preventDefault();
      if (dragFrom !== arr.length - 1) {
        const [moved] = arr.splice(dragFrom, 1);
        arr.push(moved); markDirty(which); draw();
      }
      dragFrom = null;
    });
  }
  wrap.appendChild(box);
  parent.appendChild(wrap);
}

/* ------------------------------------------------------------- colors tab */
// Pickr (minimal) on every row + persistent "favourite" swatches in localStorage,
// shared across all rows. ★ saves the current colour. Native input is the
// offline fallback if Pickr's CDN failed to load.
const SWATCH_KEY = "evolvedcv.editor.swatches";
let savedSwatches = loadSwatches();
const pickrInstances = [];

function loadSwatches() {
  try { const v = JSON.parse(localStorage.getItem(SWATCH_KEY)); return Array.isArray(v) ? v.map(toHex6) : []; }
  catch { return []; }
}
function persistSwatches() {
  try { localStorage.setItem(SWATCH_KEY, JSON.stringify(savedSwatches)); } catch { /* private mode */ }
}
/** Add a colour to the shared favourites (deduped) and push it to every Pickr. */
function addFavorite(raw) {
  const hex = toHex6(raw);
  if (savedSwatches.some((s) => toHex6(s) === hex)) return false;
  savedSwatches.push(hex);
  persistSwatches();
  pickrInstances.forEach((pk) => { try { pk.addSwatch(hex); } catch { /* noop */ } });
  return true;
}

/** Pickr colour -> string: hex when opaque, rgba(...) only when alpha < 1. */
function pickrColorString(c, alpha) {
  const rgba = c.toRGBA();
  if (!alpha || Number(rgba[3]) >= 1) return toHex6(c.toHEXA().toString());
  return c.toRGBA().toString(3);
}

/** Shared Pickr + ★ on a control element. getVal()/apply(raw) bridge the data.
 *  alpha:true enables the opacity slider (so rgba values are editable). */
function attachPickr(ctl, getVal, apply, { alpha = false } = {}) {
  if (window.Pickr) {
    const btn = el("button");
    btn.type = "button";
    ctl.appendChild(btn);
    const pickr = window.Pickr.create({
      el: btn, theme: "nano", default: getVal() || "#888888",
      swatches: savedSwatches.slice(),
      components: { preview: true, opacity: alpha, hue: true, interaction: { input: true, save: false, clear: false } }
    });
    pickr.on("change", (c) => apply(pickrColorString(c, alpha)));
    // while the picker is open, don't let the preview iframe eat drag events
    pickr.on("show", () => setPreviewInteractive(false));
    pickr.on("hide", () => setPreviewInteractive(true));
    pickrInstances.push(pickr);
    const star = el("button", "fav-btn", "★");
    star.type = "button";
    star.title = "Save to favorites";
    star.addEventListener("click", () => {
      if (addFavorite(getVal())) {
        star.classList.add("is-saved");
        setTimeout(() => star.classList.remove("is-saved"), 900);
      }
    });
    ctl.appendChild(star);
  } else {
    const input = el("input");           // offline fallback: native, no favourites
    input.type = "color";
    input.value = toHex6(getVal());
    input.addEventListener("input", () => apply(input.value));
    ctl.appendChild(input);
  }
}

/** A colour row (swatch + Pickr + ★) bound to obj[key]. alpha:true allows rgba. */
function colorField(parent, label, obj, key, { which = "ui", alpha = false } = {}) {
  if (!alpha) obj[key] = toHex6(obj[key] || "#888888");
  else if (obj[key] == null || obj[key] === "") obj[key] = "#888888";
  const row = el("div", "color-row");
  const swatch = el("div", "color-row__swatch");
  swatch.style.background = obj[key];
  const meta = el("div", "color-row__meta");
  meta.appendChild(el("div", "color-row__name", label));
  const out = el("code", "color-row__hex", obj[key]);
  meta.appendChild(out);
  const ctl = el("div", "color-row__ctl");
  const apply = (raw) => {
    obj[key] = raw; swatch.style.background = raw; out.textContent = raw; markDirty(which);
  };
  attachPickr(ctl, () => obj[key], apply, { alpha });
  row.appendChild(swatch); row.appendChild(meta); row.appendChild(ctl);
  parent.appendChild(row);
}

/** Pick a control automatically from the value's type (colours -> Pickr). */
function autoField(parent, label, obj, key, { which = "ui" } = {}) {
  const v = obj[key];
  if (typeof v === "boolean") boolField(parent, label, obj, key, { which });
  else if (typeof v === "number") field(parent, label, obj, key, { type: "number", which });
  else if (typeof v === "string" && /^\s*(#|rgb|hsl)/i.test(v)) colorField(parent, label, obj, key, { which, alpha: true });
  else field(parent, label, obj, key, { which });
}

/** Collapsible titled section; returns its body element. */
function collapsibleSection(parent, title, open = false) {
  const card = el("div", "sec");
  if (open) card.classList.add("is-open");
  const head = el("div", "sec__head");
  head.appendChild(el("span", "sec__chev", "▸"));
  head.appendChild(el("span", "sec__title", title));
  const body = el("div", "sec__body");
  head.addEventListener("click", () => card.classList.toggle("is-open"));
  card.appendChild(head); card.appendChild(body); parent.appendChild(card);
  return body;
}

function renderColors(pane) {
  pane.innerHTML = "";
  pane.appendChild(el("h2", "section-title", "UI"));
  pane.appendChild(el("p", "hint",
    "All visual settings for the site (cv_ui.json). ★ saves a color to favorites (shared across all pickers). Changes appear in the preview after Save."));
  pickrInstances.length = 0;
  const sc = store.ui.site_config || (store.ui.site_config = {});

  // --- Theme ---
  let s = collapsibleSection(pane, "Theme — colors & fonts", true);
  const th = sc.theme || (sc.theme = {});
  colorField(s, "Primary color", th, "primary_color");
  colorField(s, "Accent color", th, "accent_color");
  colorField(s, "Particle hover", th, "particle_hover_color");
  colorField(s, "Background", th, "background_color");
  colorField(s, "Buttons — fill", th, "button_surface");
  colorField(s, "Buttons — border", th, "button_border");
  colorField(s, "Text", th, "text_color");
  field(s, "Heading font", th, "font_heading", { which: "ui" });
  field(s, "Body font", th, "font_body", { which: "ui" });

  // --- Family colours ---
  s = collapsibleSection(pane, "Domain colors", true);
  if (!store.ui.domain_colors) store.ui.domain_colors = {};
  store.data.tag_taxonomy.domains.forEach((fam) =>
    colorField(s, txt(fam.expertise_label) || txt(fam.label) || fam.id, store.ui.domain_colors, fam.id));

  // --- Appearance ---
  s = collapsibleSection(pane, "Appearance", false);
  boolField(s, "Show timeline", sc, "show_timeline", { which: "ui" });
  boolField(s, "Language toggle in header", sc, "language_toggle", { which: "ui" });
  field(s, "Particle effect (id)", sc, "particle_effect", { which: "ui" });

  // --- Footer & PDF ---
  s = collapsibleSection(pane, "Footer & PDF", false);
  if (!sc.footer_tagline) sc.footer_tagline = { en: "", it: "" };
  bilingual(s, "Footer tagline", sc.footer_tagline, { which: "ui" });
  if (!sc.pdf) sc.pdf = { format: "A4", footer_note: { en: "", it: "" } };
  field(s, "PDF format", sc.pdf, "format", { which: "ui" });
  if (!sc.pdf.footer_note) sc.pdf.footer_note = { en: "", it: "" };
  bilingual(s, "PDF footer note", sc.pdf.footer_note, { which: "ui" });

  // --- Filter views --- (page/section order now lives in the "Pages" tab)
  s = collapsibleSection(pane, "Filter views", false);
  if (!Array.isArray(sc.filter_views)) sc.filter_views = [];
  chipEditor(s, "Filter views (id)", sc.filter_views, { which: "ui", placeholder: "+ view" });
  field(s, "Default desktop view", sc, "default_view_desktop", { which: "ui" });
  field(s, "Default mobile view", sc, "default_view_mobile", { which: "ui" });

  // --- Experience glass (advanced) ---
  if (store.ui.glass) {
    s = collapsibleSection(pane, "Experience glass (advanced)", false);
    for (const slab of ["card", "project"]) {
      if (!store.ui.glass[slab]) continue;
      s.appendChild(el("div", "subhead", slab === "card" ? "Outer pane (card)" : "Project pane"));
      for (const k of Object.keys(store.ui.glass[slab])) {
        if (k.startsWith("_")) continue;
        autoField(s, k, store.ui.glass[slab], k, { which: "ui" });
      }
    }
  }

  // --- Cromature interfaccia (avanzato) ---
  if (store.ui.ui_elements) {
    s = collapsibleSection(pane, "Interface colors (advanced)", false);
    for (const k of Object.keys(store.ui.ui_elements)) {
      if (k.startsWith("_")) continue;
      colorField(s, k, store.ui.ui_elements, k, { which: "ui", alpha: true });
    }
  }

  // --- Experience typography (advanced) ---
  if (store.ui.experience_typography) {
    s = collapsibleSection(pane, "Experience typography (advanced)", false);
    for (const role of Object.keys(store.ui.experience_typography)) {
      if (role.startsWith("_")) continue;
      const t3 = store.ui.experience_typography[role];
      s.appendChild(el("div", "subhead", role));
      field(s, "Font", t3, "font", { which: "ui" });
      colorField(s, "Color", t3, "color", { which: "ui", alpha: true });
      field(s, "Size", t3, "size", { which: "ui" });
    }
  }

  // --- Contact ---
  if (store.ui.contact_form) {
    s = collapsibleSection(pane, "Contact", false);
    field(s, "Endpoint form", store.ui.contact_form, "endpoint", { which: "ui" });
  }
}

/* ------------------------------------------------- expertise & skills tab */
/** headline_rules that reference a given tag id (guard-rail). */
function rulesUsingTag(tagId) {
  return (store.data.headline_rules || []).filter((r) => (r.match || []).includes(tagId));
}
/** All tag ids currently in the taxonomy. */
function allTagIds() {
  const out = new Set();
  for (const d of store.data.tag_taxonomy.domains) for (const t of d.tags) out.add(t.id);
  return out;
}
function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "id";
}
function uniqueId(base, taken) {
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

/** Single text field for a {en,it} object edited as ONE value (mirrors en/it).
 *  Used for the exp Name (= short label, shown the same in both languages). */
function singleNameField(parent, label, obj, { which = "data" } = {}) {
  const wrap = el("div", "field");
  wrap.appendChild(el("label", "field__label", label));
  const input = el("input", "field__input");
  input.type = "text";
  input.value = obj.en ?? obj.it ?? "";
  input.addEventListener("input", () => { obj.en = input.value; obj.it = input.value; markDirty(which); });
  wrap.appendChild(input);
  parent.appendChild(wrap);
}

// Referential integrity: experiences reference expskills by id, so a rename or
// removal of an expskill must cascade into every experience.expskills — else
// the ref dangles and sync-data.mjs rejects the save ("unknown expskill ids").
function remapExpskillId(oldId, newId) {
  if (oldId === newId) return;
  for (const exp of store.data.experience || []) {
    if (Array.isArray(exp.expskills)) exp.expskills = exp.expskills.map((id) => (id === oldId ? newId : id));
  }
}
function dropExpskillIds(ids) {
  const set = ids instanceof Set ? ids : new Set([ids]);
  for (const exp of store.data.experience || []) {
    if (Array.isArray(exp.expskills)) exp.expskills = exp.expskills.filter((id) => !set.has(id));
  }
}

// An "expskill" = a filter that belongs to an exp (was the old "tag"). Its id is
// hidden/stable (only the code uses it); the user edits only its name/skills.
function buildTagBlock(parent, fam, tag, redrawTags, openByDefault = false) {
  const block = el("div", "tag-block");
  if (openByDefault) block.classList.add("is-open");
  const head = el("div", "tag-block__head");

  const title = el("div", "tag-block__title");
  const nameSpan = el("span", "tag-block__name", txt(tag.label) || tag.id);
  const idSpan = el("span", "tag-block__id", "id: " + tag.id);
  title.appendChild(el("span", "tag-block__chev", "▸"));
  title.appendChild(nameSpan);
  title.appendChild(idSpan);
  const usedBy = rulesUsingTag(tag.id);
  if (usedBy.length) {
    const warn = el("span", "tag-warn");
    warn.appendChild(el("span", "tag-warn__ico", "⚠"));
    warn.appendChild(el("span", "tag-warn__txt", ` used by the dynamic title (${usedBy.length})`));
    warn.title = `Used by ${usedBy.length} dynamic title rule(s)`;
    title.appendChild(warn);
  }
  head.addEventListener("click", () => block.classList.toggle("is-open"));

  const rm = el("button", "btn btn--danger tag-block__rm", "Remove expskill");
  rm.type = "button";
  rm.addEventListener("click", (e) => {
    e.stopPropagation();
    const refs = rulesUsingTag(tag.id);
    let go = true;
    if (refs.length) {
      go = confirm(
        `This expskill ("${txt(tag.label) || tag.id}") is used by ${refs.length} dynamic title rule(s):\n` +
        refs.map((r) => "• " + r.match.join(" + ") + " → " + txt(r.headline)).join("\n") +
        `\n\nRemoving it will disable those rules. Remove anyway?`
      );
    }
    if (!go) return;
    const i = fam.tags.indexOf(tag);
    if (i >= 0) fam.tags.splice(i, 1);
    dropExpskillIds(tag.id); // remove the deleted expskill from every experience
    markDirty("data");
    redrawTags();
  });
  head.appendChild(title);
  head.appendChild(rm);
  block.appendChild(head);

  // Keep the head live (no refresh needed) and derive a sensible id from the
  // name — but ONLY while this expskill isn't referenced by the dynamic-title
  // rules. Once referenced (⚠), its id is frozen so those rules keep matching.
  const syncHead = () => {
    if (rulesUsingTag(tag.id).length === 0) {
      const name = txt(tag.label).trim();
      if (name) {
        const taken = allTagIds(); taken.delete(tag.id);
        const oldId = tag.id;
        const newId = uniqueId(slugify(name), taken);
        if (newId !== oldId) {
          tag.id = newId;
          remapExpskillId(oldId, newId); // keep experience.expskills pointing at it
        }
      }
    }
    nameSpan.textContent = txt(tag.label) || tag.id;
    idSpan.textContent = "id: " + tag.id;
  };

  const body = el("div", "tag-block__body");
  bilingual(body, "Name (en / it)", tag.label, { onInput: syncHead });
  if (!tag.headline_fragment) tag.headline_fragment = { en: "", it: "" };
  bilingual(body, "Role (dynamic title fragment)", tag.headline_fragment);
  block.appendChild(body);

  parent.appendChild(block);
}

// An "exp" = an area of expertise (was the old "family"/"domain"). Has a colour.
function buildFamilyCard(parent, fam, redrawFams) {
  const card = el("div", "fam-card");
  const head = el("div", "fam-card__head");
  const title = el("div", "fam-card__title", txt(fam.label) || fam.id);
  title.appendChild(el("span", "fam-card__id", "exp · id: " + fam.id));
  const rm = el("button", "btn btn--danger", "Remove exp");
  rm.type = "button";
  rm.addEventListener("click", () => {
    const refd = fam.tags.flatMap((t) => rulesUsingTag(t.id));
    const name = txt(fam.label) || fam.id;
    let go = true;
    if (refd.length) {
      go = confirm(
        `This exp ("${name}") contains expskills used by the dynamic title (${refd.length} rule(s)). ` +
        `Removing it will disable those rules. Remove anyway?`
      );
    } else {
      go = confirm(`Remove the exp "${name}" and its ${fam.tags.length} expskill(s)?`);
    }
    if (!go) return;
    const removed = new Set(fam.tags.map((t) => t.id));
    const i = store.data.tag_taxonomy.domains.indexOf(fam);
    if (i >= 0) store.data.tag_taxonomy.domains.splice(i, 1);
    dropExpskillIds(removed); // remove all of this exp's expskills from experiences
    markDirty("data");
    redrawFams();
  });
  head.appendChild(title);
  head.appendChild(rm);
  card.appendChild(head);

  // exp fields (no more icon/level)
  singleNameField(card, "Name (exp)", fam.label);
  if (!fam.expertise_label) fam.expertise_label = { en: "", it: "" };
  bilingual(card, "Title (Expertise section heading)", fam.expertise_label);
  if (!fam.role_fallback) fam.role_fallback = { en: "", it: "" };
  bilingual(card, "Role (dynamic title fragment)", fam.role_fallback);
  if (!Array.isArray(fam.items)) fam.items = [];
  chipEditor(card, "Skills shown on the card", fam.items, { placeholder: "+ skill", reorder: true });

  // expskills
  card.appendChild(el("div", "subhead", "expskill (filters for this exp)"));
  const tagsWrap = el("div", "tags-wrap");
  let openTagId = null; // expskill to render expanded after a redraw (the just-added one)
  const drawTags = () => {
    tagsWrap.innerHTML = "";
    fam.tags.forEach((tag) => buildTagBlock(tagsWrap, fam, tag, drawTags, tag.id === openTagId));
    openTagId = null;
    const addTag = el("button", "btn arr-add tags-add", "+ Add expskill");
    addTag.type = "button";
    addTag.addEventListener("click", () => {
      const id = uniqueId("expskill", allTagIds());
      fam.tags.push({ id, label: { en: "", it: "" }, headline_fragment: { en: "", it: "" } });
      openTagId = id;
      markDirty("data");
      drawTags();
    });
    tagsWrap.appendChild(addTag);
  };
  drawTags();
  card.appendChild(tagsWrap);

  parent.appendChild(card);
}

function renderExpertiseTab(pane) {
  pane.innerHTML = "";
  pane.appendChild(el("h2", "section-title", "Skills"));
  pane.appendChild(el("p", "hint",
    "exp = an area of expertise (has a color). expskill = a filter that belongs to an exp and inherits its color. " +
    "skill = the concrete words inside an expskill: they appear AND link your experiences (an experience containing a skill \"activates\" that expskill). " +
    "⚠ = expskill used by the dynamic title."));
  const famsWrap = el("div");
  const drawFams = () => {
    famsWrap.innerHTML = "";
    store.data.tag_taxonomy.domains.forEach((fam) => buildFamilyCard(famsWrap, fam, drawFams));
  };
  drawFams();
  pane.appendChild(famsWrap);

  const addFam = el("button", "btn btn--primary", "+ Add exp");
  addFam.type = "button";
  addFam.addEventListener("click", () => {
    const ids = new Set(store.data.tag_taxonomy.domains.map((d) => d.id));
    const id = uniqueId("exp", ids);
    store.data.tag_taxonomy.domains.push({
      id, label: { en: "New", it: "New" },
      expertise_label: { en: "New exp", it: "Nuova exp" },
      role_fallback: { en: "Specialist", it: "Specialista" }, items: [], tags: []
    });
    if (!store.ui.domain_colors) store.ui.domain_colors = {};
    store.ui.domain_colors[id] = "#9AA0BD"; // neutral default until edited in UI
    markDirty("data"); markDirty("ui");
    drawFams();
  });
  pane.appendChild(addFam);
}

/* ------------------------------------------------------------- about tab */
// Auto-highlight: assign words of the About summary to an Exp colour. One text
// bar per Exp; words separated by ", "; a word that differs between languages is
// written "english/italiano" (e.g. "agents/agenti"). The site finds each word in
// the About text (current language) and tints it with that Exp's colour.
function renderAboutTab(pane) {
  pane.innerHTML = "";
  pane.appendChild(el("h2", "section-title", "About"));
  pane.appendChild(el("p", "hint",
    "For each Exp, type the words to highlight in the About text, separated by \", \". " +
    "If a word differs between English and Italian write it as \"english/italian\" " +
    "(e.g. \"agents/agenti\"). The site finds them in the text and tints them with the Exp's color."));

  const p = store.data.profile;
  // Read-only reference: the current About text in both languages.
  if (p.summary) {
    const ref = collapsibleSection(pane, "About text (reference)", false);
    for (const lang of ["it", "en"]) {
      ref.appendChild(el("div", "subhead", lang.toUpperCase()));
      ref.appendChild(el("p", "hint", p.summary[lang] || ""));
    }
  }

  if (!p.about_highlights || typeof p.about_highlights !== "object") p.about_highlights = {};
  const hl = p.about_highlights;
  const colors = (store.ui && store.ui.domain_colors) || {};

  store.data.tag_taxonomy.domains.forEach((fam) => {
    if (hl[fam.id] == null) hl[fam.id] = "";
    const row = el("div", "about-hl-row");
    const head = el("div", "about-hl-row__head");
    const dot = el("span", "about-hl-row__dot");
    dot.style.background = colors[fam.id] || "#8a8aa0";
    head.appendChild(dot);
    head.appendChild(el("span", "about-hl-row__name", txt(fam.label) || fam.id));
    row.appendChild(head);
    const input = el("input", "field__input");
    input.type = "text";
    input.placeholder = "word1, word2, english/italian";
    input.value = hl[fam.id];
    input.addEventListener("input", () => { hl[fam.id] = input.value; markDataLive(); });
    row.appendChild(input);
    pane.appendChild(row);
  });
}

/* --------------------------------------------------------------- contenuti */
function buildProjectCard(parent, projects, proj, redraw) {
  const body = itemCard(parent, proj.name || "(unnamed project)", () => {
    if (!confirm(`Remove the project "${proj.name || "(unnamed)"}"?`)) return;
    const i = projects.indexOf(proj); if (i >= 0) projects.splice(i, 1);
    markDirty("data"); redraw();
  });
  field(body, "Project name", proj, "name");
  if (!proj.period) proj.period = { en: "", it: "" };
  bilingual(body, "Period (label)", proj.period);
  if (!proj.bullets) proj.bullets = { en: [], it: [] };
  if (!Array.isArray(proj.bullets.en)) proj.bullets.en = [];
  if (!Array.isArray(proj.bullets.it)) proj.bullets.it = [];
  arrayEditor(body, "Bullet — EN", proj.bullets.en);
  arrayEditor(body, "Bullet — IT", proj.bullets.it);
}

function buildExperienceCard(parent, exp, redraw) {
  const titleOf = (e) => [e.company, txt(e.role)].filter(Boolean).join(" — ") || e.id || "(experience)";
  const body = itemCard(parent, titleOf(exp), () => {
    if (!confirm(`Remove the experience "${titleOf(exp)}"?`)) return;
    const i = store.data.experience.indexOf(exp); if (i >= 0) store.data.experience.splice(i, 1);
    markDirty("data"); redraw();
  });

  field(body, "Company", exp, "company");
  field(body, "Company location", exp, "company_location");
  if (!exp.role) exp.role = { en: "", it: "" };
  bilingual(body, "Role", exp.role);
  field(body, "Type (e.g. full-time)", exp, "type");
  boolField(body, "Remote", exp, "remote");

  // period: start / end / label{en,it}
  if (!exp.period) exp.period = { start: "", end: "", label: { en: "", it: "" } };
  const pr = el("div", "row-2");
  field(pr, "Start (YYYY-MM)", exp.period, "start");
  field(pr, "End (YYYY-MM)", exp.period, "end");
  body.appendChild(pr);
  if (!exp.period.label) exp.period.label = { en: "", it: "" };
  bilingual(body, "Period (visible label)", exp.period.label);

  if (!exp.hook) exp.hook = { en: "", it: "" };
  bilingual(body, "Hook (summary)", exp.hook, { multiline: true });

  if (!exp.bullets) exp.bullets = { en: [], it: [] };
  if (!Array.isArray(exp.bullets.en)) exp.bullets.en = [];
  if (!Array.isArray(exp.bullets.it)) exp.bullets.it = [];
  body.appendChild(el("div", "subhead", "Experience bullets"));
  arrayEditor(body, "Bullet — EN", exp.bullets.en);
  arrayEditor(body, "Bullet — IT", exp.bullets.it);

  expskillPicker(body, exp);

  // nested projects (both bullets AND projects allowed)
  body.appendChild(el("div", "subhead", "Projects (optional, in addition to bullets)"));
  if (!Array.isArray(exp.projects)) exp.projects = [];
  const projWrap = el("div", "nested");
  const drawProjects = () => {
    projWrap.innerHTML = "";
    exp.projects.forEach((proj) => buildProjectCard(projWrap, exp.projects, proj, drawProjects));
    enableDrag(projWrap, exp.projects, drawProjects);
    const add = el("button", "btn arr-add", "+ Add project");
    add.type = "button";
    add.addEventListener("click", () => {
      exp.projects.push({ name: "", period: { en: "", it: "" }, bullets: { en: [], it: [] } });
      markDirty("data"); drawProjects();
    });
    projWrap.appendChild(add);
  };
  drawProjects();
  body.appendChild(projWrap);
}

// Expskill picker for an experience: toggle which taxonomy expskills this
// experience has (experience-grain). Replaces the old free-text "skills" +
// "tag extra" fields. Chips are coloured by their domain (cv_ui domain_colors).
function expskillPicker(parent, exp, noun = "experience") {
  if (!Array.isArray(exp.expskills)) exp.expskills = [];
  parent.appendChild(el("div", "subhead", `Expskills (click to attach to this ${noun})`));
  const wrap = el("div", "expskill-picker");
  const colors = (store.ui && store.ui.domain_colors) || {};
  const draw = () => {
    wrap.innerHTML = "";
    for (const dom of store.data.tag_taxonomy.domains) {
      if (!Array.isArray(dom.tags) || !dom.tags.length) continue;
      const group = el("div", "expskill-group");
      group.appendChild(el("span", "expskill-group__dom", txt(dom.label) || dom.id));
      for (const tag of dom.tags) {
        const on = exp.expskills.includes(tag.id);
        const chip = el("button", "expskill-chip" + (on ? " is-on" : ""), txt(tag.label) || tag.id);
        chip.type = "button";
        chip.style.setProperty("--ec", colors[dom.id] || "#8a8aa0");
        chip.addEventListener("click", () => {
          const i = exp.expskills.indexOf(tag.id);
          if (i >= 0) exp.expskills.splice(i, 1); else exp.expskills.push(tag.id);
          markDirty("data");
          draw();
        });
        group.appendChild(chip);
      }
      wrap.appendChild(group);
    }
  };
  draw();
  parent.appendChild(wrap);
}

function buildEducationCard(parent, edu, redraw) {
  const titleOf = (e) => [e.institution, txt(e.title)].filter(Boolean).join(" — ") || e.id || "(education)";
  const body = itemCard(parent, titleOf(edu), () => {
    if (!confirm(`Remove "${titleOf(edu)}"?`)) return;
    const i = store.data.education.indexOf(edu); if (i >= 0) store.data.education.splice(i, 1);
    markDirty("data"); redraw();
  });
  field(body, "Institution", edu, "institution");
  if (!edu.title) edu.title = { en: "", it: "" };
  bilingual(body, "Title", edu.title);
  const r = el("div", "row-2");
  field(r, "Year", edu, "year", { type: "number" });
  field(r, "Type (e.g. certification)", edu, "type");
  body.appendChild(r);
  if (!Array.isArray(edu.tags)) edu.tags = [];
  chipEditor(body, "Tag", edu.tags, { placeholder: "+ tag" });
  expskillPicker(body, edu, "education");
}

function renderExperienceTab(pane) {
  pane.innerHTML = "";
  pane.appendChild(el("h2", "section-title", "Experience"));
  pane.appendChild(el("p", "hint",
    "Drag the ⠿ handle to reorder. Experiences can have their own bullets AND projects. Click the header to expand."));

  const expWrap = el("div", "list list--exp");
  const drawExp = () => {
    expWrap.innerHTML = "";
    store.data.experience.forEach((exp) => buildExperienceCard(expWrap, exp, drawExp));
    enableDrag(expWrap, store.data.experience, drawExp);
  };
  drawExp();
  pane.appendChild(expWrap);
  const addExp = el("button", "btn btn--primary", "+ Add experience");
  addExp.type = "button";
  addExp.addEventListener("click", () => {
    const id = uniqueId("new-experience", new Set(store.data.experience.map((e) => e.id)));
    store.data.experience.push({
      id, company: "", company_location: "", role: { en: "", it: "" }, type: "", remote: false,
      period: { start: "", end: "", label: { en: "", it: "" } },
      hook: { en: "", it: "" }, bullets: { en: [], it: [] }, skills: [], tags: []
    });
    markDirty("data"); drawExp();
  });
  pane.appendChild(addExp);
}

function renderEducationTab(pane) {
  pane.innerHTML = "";
  pane.appendChild(el("h2", "section-title", "Education"));
  pane.appendChild(el("p", "hint", "Drag the ⠿ handle to reorder. Click the header to expand."));

  const eduWrap = el("div", "list list--edu");
  const drawEdu = () => {
    eduWrap.innerHTML = "";
    store.data.education.forEach((edu) => buildEducationCard(eduWrap, edu, drawEdu));
    enableDrag(eduWrap, store.data.education, drawEdu);
  };
  drawEdu();
  pane.appendChild(eduWrap);
  const addEdu = el("button", "btn btn--primary", "+ Add education");
  addEdu.type = "button";
  addEdu.addEventListener("click", () => {
    const id = uniqueId("new-education", new Set(store.data.education.map((e) => e.id)));
    store.data.education.push({ id, institution: "", title: { en: "", it: "" }, year: new Date().getFullYear(), type: "", tags: [] });
    markDirty("data"); drawEdu();
  });
  pane.appendChild(addEdu);
}

/* -------------------------------------------------------------------- intro */
function renderIntroTab(pane) {
  pane.innerHTML = "";
  pane.appendChild(el("h2", "section-title", "Animation"));
  const sc = store.ui.site_config || (store.ui.site_config = {});

  // Everything about the opening intro lives inside one "banner" (collapsible
  // box). Only "Particles" stays outside — it's shared with the per-page
  // particle conformations below.
  const banner = collapsibleSection(pane, "Intro", true);
  banner.appendChild(el("p", "hint",
    "Adjust the opening animation, then press Play to see it in the preview. " +
    "Other tabs show the last frame (intro skipped)."));

  // Play / Replay — switch the preview to play the REAL intro (no preview flag)
  const bar = el("div", "intro-actions");
  const play = el("button", "btn btn--primary", "▶ Play intro");
  play.type = "button";
  play.addEventListener("click", () => { previewIntro = true; reloadPreview(); });
  const replay = el("button", "btn", "↻ Replay");
  replay.type = "button";
  replay.addEventListener("click", () => { previewIntro = true; reloadPreview(); });
  bar.appendChild(play);
  bar.appendChild(replay);
  banner.appendChild(bar);
  banner.appendChild(el("p", "hint", "Tip: save first, then Play. (Saving while on this tab already reloads the intro.)"));

  // explosion
  banner.appendChild(el("div", "subhead", "Explosion"));
  selectField(banner, "Explosion type", sc, "intro_explosion", [
    { value: "fireworks", label: "Fireworks" },
    { value: "supernova", label: "Supernova" },
    { value: "vortex", label: "Vortex" },
    { value: "implosion", label: "Implosion + bounce" }
  ], { which: "ui" });

  // timings
  banner.appendChild(el("div", "subhead", "Timings (seconds)"));
  if (!sc.intro_timing) sc.intro_timing = {};
  const T = sc.intro_timing;
  const labels = {
    apparition: "Apparition", explosion: "Explosion", composition_name: "Name composition",
    breath: "Breath", show_text: "Text fade-in", counter_fade: "Counter fade-in", language: "Language banner"
  };
  for (const k of ["apparition", "explosion", "composition_name", "breath", "show_text", "counter_fade", "language"]) {
    if (T[k] == null) T[k] = 0;
    rangeField(banner, labels[k], T, k, { min: 0, max: 6, step: 0.1, which: "ui", unit: " s" });
  }
}

/* ---------------------------------------------------------------- particles */
// The particle system: global count + per-page conformations. Split out of the
// Animation tab so that tab holds ONLY the opening intro.
function renderParticlesTab(pane) {
  pane.innerHTML = "";
  pane.appendChild(el("h2", "section-title", "Particles"));
  const sc = store.ui.site_config || (store.ui.site_config = {});

  // Global particle count (rebuilds the whole buffer → preview reload on save).
  pane.appendChild(el("div", "subhead", "General"));
  rangeField(pane, "Particle count", sc, "particle_count", { min: 1000, max: 30000, step: 500, which: "ui", reload: true });

  // per-page particle conformations (desktop; mobile uses the WIP physics)
  pane.appendChild(el("p", "hint",
    "Particle conformation per page (desktop). The page sub-tabs stay in sync with the Pages tab."));
  const ppWrap = el("div", "particle-pages");
  renderParticlePages(ppWrap);
  pane.appendChild(ppWrap);
}

/* ------------------------------------------------------------- PDF tab */
// Boolean knobs that shape the printed CV (window.print()). Stored in
// cv_ui.json site_config.pdf; the site reads them at render time and toggles
// body classes so print.css shows/hides the matching bits.
function renderPdfTab(pane) {
  pane.innerHTML = "";
  pane.appendChild(el("h2", "section-title", "PDF"));
  const sc = store.ui.site_config || (store.ui.site_config = {});
  const pdf = sc.pdf || (sc.pdf = {});
  // seed today's defaults so the checkboxes reflect the current behaviour
  if (pdf.email == null) pdf.email = true;
  if (pdf.phone == null) pdf.phone = false;
  if (pdf.link == null) pdf.link = true;

  pane.appendChild(el("div", "subhead", "Contact info"));
  boolField(pane, "Email — show in PDF contact info", pdf, "email", { which: "ui" });
  boolField(pane, "Phone — show in PDF contact info", pdf, "phone", { which: "ui" });
  pane.appendChild(el("div", "subhead", "Addresses"));
  boolField(pane, "Link — show URL addresses next to social links", pdf, "link", { which: "ui" });
  pane.appendChild(el("p", "hint",
    "These options only affect the printed PDF (site PDF button), not the on-screen page."));
}

// Friendly names for the known section ids (cv_ui.json site_config.sections_order).
const PAGE_LABELS = { hero: "Home", about: "About", expertise: "Expertise", experience: "Experience", education: "Education", contact: "Contact" };
const pageLabel = (id) => PAGE_LABELS[id] || (id.charAt(0).toUpperCase() + id.slice(1));

/* --------- per-page particle conformations (Animation tab, desktop) --------- */
// Existing particle silhouettes (match the generators in site/js/particle-shapes.js).
const PARTICLE_SHAPES = [
  { value: "name", label: "Name" },
  { value: "initials", label: "Initials (from name)" },
  { value: "frame", label: "Frame (About)" },
  { value: "cardsframe", label: "Card frame (Expertise)" },
  { value: "edges", label: "Edges" },
  { value: "floor", label: "Floor" },
  { value: "galaxy", label: "Galaxy (field)" }
];
// Current default shape per known page (so the seeded config matches today's site).
const DEFAULT_PAGE_SHAPE = { hero: "name", about: "frame", expertise: "cardsframe", experience: "galaxy", education: "floor", contact: "initials" };
// Coherent colouring schemes for the text scenes (Home name / Contact initials).
const PARTICLE_COLOR_MODES = [
  { value: "palette", label: "Palette gradient (by hue)" },
  { value: "palette-loop", label: "Gradient loop (Exp color)" },
  { value: "duotone", label: "Duotone gradient (primary→accent)" },
  { value: "single", label: "Solid color (accent)" },
  { value: "random", label: "Random" }
];

/** Read (lazily seeding) the particle config for a page → {shape,x,y,scaleX,scaleY}.
 *  Desktop-only: mobile particles are handled separately (physics, WIP). */
function particleCfg(pageId) {
  const pp = store.ui.particle_pages || (store.ui.particle_pages = {});
  if (!pp[pageId]) {
    const shape = pageId === "hero" ? "name" : (DEFAULT_PAGE_SHAPE[pageId] || "galaxy");
    pp[pageId] = { shape, x: 0, y: 0, scaleX: 1, scaleY: 1 };
  }
  // Home shape is locked to the name (kept consistent with the intro).
  if (pageId === "hero") pp[pageId].shape = "name";
  // Coherent particle colouring for the text scenes (default = palette gradient).
  if (pageId === "hero" || pageId === "contact") {
    if (pp[pageId].color_mode == null) pp[pageId].color_mode = "palette";
    if (pp[pageId].color_loops == null) pp[pageId].color_loops = 1;
  }
  // Page-specific extra knobs exposed in the Animation tab — seeded if missing so
  // the sliders always have a value (mirror site defaults).
  if (pageId === "about") {
    const c = pp[pageId];
    if (c.frame_thickness == null) c.frame_thickness = 0.016;
    // migrate the old single frame_offset → per-axis x/y
    if (c.frame_offset_x == null) c.frame_offset_x = c.frame_offset != null ? c.frame_offset : 0.05;
    if (c.frame_offset_y == null) c.frame_offset_y = c.frame_offset != null ? c.frame_offset : 0.05;
    delete c.frame_offset;
    if (c.frame_corner == null) c.frame_corner = 0.7;
  } else if (pageId === "expertise") {
    const c = pp[pageId];
    if (c.field_reach == null) c.field_reach = 0.9;
    if (c.field_conc == null) c.field_conc = 1.0;
    if (c.field_outbias == null) c.field_outbias = 0.85;
    if (c.field_depth == null) c.field_depth = 0.7;
    if (c.field_jitter == null) c.field_jitter = 0.01;
    if (c.field_visibility == null) c.field_visibility = 0.12;
    if (c.field_spread == null) c.field_spread = 170;
    if (c.field_homePull == null) c.field_homePull = 0.0008;
    if (c.field_chaos == null) c.field_chaos = 0.16;
  } else if (pageId === "contact") {
    const c = pp[pageId];
    if (c.fontFrac == null) c.fontFrac = 0.14;
    if (c.xFrac == null) c.xFrac = 0.5;
    if (c.yFrac == null) c.yFrac = 0.80;
    if (c.initials_frac == null) c.initials_frac = 0.25;
    if (c.line_frac == null) c.line_frac = 0.4;
    if (c.scatter_spread == null) c.scatter_spread = 0.5;
    if (c.scatter_conc == null) c.scatter_conc = 1.0;
    if (c.line_offset == null) c.line_offset = 0;
    delete c.scatter_flatten; delete c.plane_depth;
  }
  return pp[pageId];
}

/** One tab per page (auto from sections_order). Config is per-page (desktop). */
function renderParticlePages(container) {
  container.innerHTML = "";
  const sc = store.ui.site_config || {};
  const pages = Array.isArray(sc.sections_order) ? sc.sections_order : [];
  if (!pages.length) { container.appendChild(el("p", "hint", "Add pages first in the Pages tab.")); return; }

  let activePage = pages[0];
  const pageBar = el("div", "subtabs");
  const panel = el("div", "subtab-panel");

  const drawPanel = () => {
    panel.innerHTML = "";
    const cfg = particleCfg(activePage);
    if (activePage === "hero") {
      const f = el("div", "field");
      f.appendChild(el("label", "field__label", "Particle configuration"));
      f.appendChild(el("div", "field__ro", "Name — fixed for Home (consistent with intro)"));
      panel.appendChild(f);
      selectField(panel, "Particle color", cfg, "color_mode", PARTICLE_COLOR_MODES, { which: "ui" });
      rangeField(panel, "Gradient loops (Gradient loop only)", cfg, "color_loops", { min: 1, max: 100, step: 1, which: "ui" });
    } else {
      selectField(panel, "Particle configuration", cfg, "shape", PARTICLE_SHAPES, { which: "ui", reload: true });
    }
    // Live (which:"ui"): a window hook in particle-shapes.js re-fills the active
    // silhouette on every drag — no preview reload, so the move is visible at once.
    rangeField(panel, "Position X", cfg, "x", { min: -1, max: 1, step: 0.01, which: "ui" });
    rangeField(panel, "Position Y", cfg, "y", { min: -1, max: 1, step: 0.01, which: "ui" });
    rangeField(panel, "Scale X", cfg, "scaleX", { min: 0.2, max: 3, step: 0.05, which: "ui", unit: "×" });
    rangeField(panel, "Scale Y", cfg, "scaleY", { min: 0.2, max: 3, step: 0.05, which: "ui", unit: "×" });
    // Page-specific particle knobs (data-driven; live via the same hook).
    if (activePage === "about") {
      panel.appendChild(el("div", "subhead", "Particle frame"));
      rangeField(panel, "Frame thickness", cfg, "frame_thickness", { min: 0, max: 0.08, step: 0.002, which: "ui" });
      rangeField(panel, "Distance from text — X", cfg, "frame_offset_x", { min: 0, max: 0.2, step: 0.005, which: "ui" });
      rangeField(panel, "Distance from text — Y", cfg, "frame_offset_y", { min: 0, max: 0.2, step: 0.005, which: "ui" });
      rangeField(panel, "Corner radius", cfg, "frame_corner", { min: 0, max: 1, step: 0.05, which: "ui" });
    } else if (activePage === "expertise") {
      panel.appendChild(el("div", "subhead", "WebGL particles (galaxy)"));
      rangeField(panel, "Reach to edges", cfg, "field_reach", { min: 0.05, max: 2.5, step: 0.05, which: "ui" });
      rangeField(panel, "Concentration on cards", cfg, "field_conc", { min: 0.4, max: 3, step: 0.05, which: "ui" });
      rangeField(panel, "Outward push", cfg, "field_outbias", { min: 0.5, max: 1, step: 0.01, which: "ui" });
      rangeField(panel, "Depth (Z)", cfg, "field_depth", { min: 0, max: 2.5, step: 0.05, which: "ui" });
      rangeField(panel, "Jitter", cfg, "field_jitter", { min: 0, max: 0.08, step: 0.005, which: "ui" });
      panel.appendChild(el("div", "subhead", "Canvas 2D particles (hover halo)"));
      rangeField(panel, "Visibility", cfg, "field_visibility", { min: 0, max: 0.4, step: 0.01, which: "ui" });
      rangeField(panel, "Spread", cfg, "field_spread", { min: 40, max: 400, step: 10, which: "ui" });
      rangeField(panel, "Pull to cards", cfg, "field_homePull", { min: 0, max: 0.004, step: 0.0001, which: "ui" });
      rangeField(panel, "Chaos", cfg, "field_chaos", { min: 0, max: 0.5, step: 0.01, which: "ui" });
    } else if (activePage === "contact") {
      selectField(panel, "Particle color", cfg, "color_mode", PARTICLE_COLOR_MODES, { which: "ui" });
      rangeField(panel, "Gradient loops (Gradient loop only)", cfg, "color_loops", { min: 1, max: 100, step: 1, which: "ui" });
      panel.appendChild(el("div", "subhead", "Initials (from name)"));
      rangeField(panel, "Size", cfg, "fontFrac", { min: 0.05, max: 0.4, step: 0.01, which: "ui" });
      rangeField(panel, "Horizontal position", cfg, "xFrac", { min: 0, max: 1, step: 0.01, which: "ui" });
      rangeField(panel, "Vertical position", cfg, "yFrac", { min: 0, max: 1, step: 0.01, which: "ui" });
      panel.appendChild(el("div", "subhead", "Scatter: line + arc"));
      rangeField(panel, "Initials fraction", cfg, "initials_frac", { min: 0.05, max: 1, step: 0.05, which: "ui" });
      rangeField(panel, "Line share (vs arc)", cfg, "line_frac", { min: 0, max: 1, step: 0.05, which: "ui" });
      rangeField(panel, "Horizontal spread", cfg, "scatter_spread", { min: 0, max: 2, step: 0.05, which: "ui" });
      rangeField(panel, "Near concentration", cfg, "scatter_conc", { min: 0.4, max: 3, step: 0.05, which: "ui" });
      rangeField(panel, "Line offset (Y)", cfg, "line_offset", { min: -0.3, max: 0.3, step: 0.005, which: "ui" });
    }
  };
  const drawPages = () => {
    pageBar.innerHTML = "";
    pages.forEach((pid) => {
      const btn = el("button", "subtab" + (pid === activePage ? " is-active" : ""), pageLabel(pid));
      btn.type = "button";
      btn.addEventListener("click", () => { activePage = pid; drawPages(); drawPanel(); });
      pageBar.appendChild(btn);
    });
  };
  drawPages();
  drawPanel();
  container.appendChild(pageBar);
  container.appendChild(panel);
}

function renderPagesTab(pane) {
  pane.innerHTML = "";
  pane.appendChild(el("h2", "section-title", "Pages"));
  pane.appendChild(el("p", "hint",
    "The site's pages/sections, in the order they appear. Drag ⠿ to reorder, × to remove. Saved in cv_ui.json."));
  const sc = store.ui.site_config || (store.ui.site_config = {});
  if (!Array.isArray(sc.sections_order)) sc.sections_order = [];

  const listWrap = el("div", "list");
  const draw = () => {
    listWrap.innerHTML = "";
    sc.sections_order.forEach((id, idx) => {
      const row = el("div", "page-row");
      row.appendChild(el("span", "drag-handle", "⠿"));
      row.appendChild(el("span", "page-row__name", pageLabel(id)));
      row.appendChild(el("span", "page-row__id", "id: " + id));
      const rm = el("button", "btn btn--danger page-row__rm", "×");
      rm.type = "button"; rm.title = "Remove page";
      rm.addEventListener("click", () => { sc.sections_order.splice(idx, 1); markUiReload(); draw(); });
      row.appendChild(rm);
      listWrap.appendChild(row);
    });
    enableDrag(listWrap, sc.sections_order, () => { markUiReload(); draw(); }, "ui");
  };
  draw();
  pane.appendChild(listWrap);

  const add = el("button", "btn btn--primary", "+ Add page");
  add.type = "button";
  add.addEventListener("click", () => {
    const name = prompt("Name of the new page:");
    if (!name || !name.trim()) return;
    const id = uniqueId(slugify(name), new Set(sc.sections_order));
    sc.sections_order.push(id);
    markUiReload(); draw();
  });
  pane.appendChild(add);
}

const RENDERERS = {
  profile: (pane) => renderProfile(pane),
  pages: (pane) => renderPagesTab(pane),
  intro: (pane) => renderIntroTab(pane),
  particles: (pane) => renderParticlesTab(pane),
  expertise: (pane) => renderExpertiseTab(pane),
  about: (pane) => renderAboutTab(pane),
  experience: (pane) => renderExperienceTab(pane),
  education: (pane) => renderEducationTab(pane),
  colors: (pane) => renderColors(pane),
  pdf: (pane) => renderPdfTab(pane)
};

let renderedTabs = new Set();
let currentTab = "profile";
function showTab(name) {
  // leaving the Intro tab: go back to the skipped-intro "last frame" preview
  if (currentTab === "intro" && name !== "intro" && previewIntro) {
    previewIntro = false;
    reloadPreview();
  }
  currentTab = name;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("is-active", p.dataset.pane === name));
  const pane = document.querySelector(`.pane[data-pane="${name}"]`);
  // Particles re-renders every time so its per-page sub-tabs stay in sync with
  // the Pages tab (a new page → a new sub-tab here automatically). Intro too, so
  // the Play button rebinds against the current preview state.
  if (name === "intro" || name === "particles" || name === "about" || !renderedTabs.has(name)) {
    RENDERERS[name]?.(pane);
    renderedTabs.add(name);
  }
  // Fit every textarea now that the pane is visible (scrollHeight is 0 while hidden).
  requestAnimationFrame(() => pane?.querySelectorAll("textarea").forEach((t) => t._autoGrow && t._autoGrow()));
}

/* --------------------------------------------------------------- preview */
const frame = () => document.getElementById("preview-frame");
// Most tabs preview the "last frame" (intro skipped via ?preview=1). The Intro
// tab can switch the preview to play the real intro (no preview flag).
let previewIntro = false;
function reloadPreview() {
  frame().src = (previewIntro ? "/?" : "/?preview=1&") + "t=" + Date.now();
}

/** Disable mouse on the iframe while a picker drags, so the iframe doesn't
 *  swallow the mousemove/mouseup (which made Pickr feel stuck/laggy). */
function setPreviewInteractive(on) {
  frame().style.pointerEvents = on ? "" : "none";
}

/** Live preview: push the in-memory cv_ui (colours/theme/typography) into the
 *  preview iframe so edits show up BEFORE saving. Debounced; safe if the site
 *  isn't ready (the hook is exposed by site/js/theme.js). */
let liveTimer = null;
function scheduleLivePreview() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(applyLivePreview, 90);
}
function applyLivePreview() {
  try {
    const w = frame().contentWindow;
    if (w && typeof w.evolvedcvApplyTheme === "function") w.evolvedcvApplyTheme(store.ui);
    // After the CSS tokens are injected, push the fresh palette into the WebGL
    // particle field too, so its colours stay in lock-step with the Exp colours.
    if (w && typeof w.evolvedcvApplySceneColors === "function") w.evolvedcvApplySceneColors();
    // Glass material is a Three.js layer, not CSS tokens: a dedicated hook hot-
    // updates the live materials so glass edits show without a preview reload.
    if (w && typeof w.evolvedcvApplyGlass === "function") w.evolvedcvApplyGlass(store.ui.glass);
    // Particle knobs (Expertise 2D field + Contact initials): dedicated hooks hot-
    // update them so the Animation sliders tune live, without a preview reload.
    const pp = store.ui.particle_pages || {};
    if (w && typeof w.evolvedcvApplyExpertiseField === "function") w.evolvedcvApplyExpertiseField(pp.expertise);
    if (w && typeof w.evolvedcvApplyExpertiseShape === "function") w.evolvedcvApplyExpertiseShape(pp.expertise);
    if (w && typeof w.evolvedcvApplyInitials === "function") w.evolvedcvApplyInitials(pp.contact);
    // Per-page transform (x / y / scale) + About frame knobs: re-fill the active
    // silhouette so position/scale sliders tune live, without a preview reload.
    if (w && typeof w.evolvedcvApplyParticlePages === "function") w.evolvedcvApplyParticlePages(pp);
    // PDF toggles (email / phone / link): print-only, so they don't change the
    // on-screen preview, but pushing them keeps the body classes (and thus the
    // next print) in sync with the editor without a reload.
    if (w && typeof w.evolvedcvApplyPdfToggles === "function") {
      w.evolvedcvApplyPdfToggles(store.ui.site_config && store.ui.site_config.pdf);
    }
    // About highlight words (content edit, but mirrored live without a reload):
    // re-render the About paragraph with the fresh Exp tints.
    if (w && typeof w.evolvedcvApplyAboutHighlights === "function") {
      w.evolvedcvApplyAboutHighlights(store.data.profile && store.data.profile.about_highlights);
    }
  } catch { /* iframe not ready / navigating */ }
}

// Editor-only preview aid: flip the iframe between the WebGL glass and the CSS
// liquid-glass fallback, so fallback-only knobs (cssBlur + the attenuationColor
// tint) are actually visible while editing. NOT persisted to JSON — it's a pure
// preview simulation. Reapplied after every (re)load since the site boots on
// WebGL by default; retries because the hook appears only once glass init runs.
let glassCssMode = false;
function applyGlassMode(retries = 20) {
  try {
    const w = frame().contentWindow;
    if (w && typeof w.evolvedcvSetGlassMode === "function") { w.evolvedcvSetGlassMode(glassCssMode); return; }
  } catch { /* iframe navigating */ }
  if (retries > 0) setTimeout(() => applyGlassMode(retries - 1), 150);
}
function initGlassModeToggle() {
  const btn = document.getElementById("prev-glass-mode");
  if (!btn) return;
  const sync = () => {
    btn.classList.toggle("is-active", glassCssMode);
    btn.textContent = glassCssMode ? "Glass: CSS (no WebGL)" : "Glass: WebGL";
    btn.title = glassCssMode
      ? "Preview using CSS fallback (phones without WebGL). Click to return to WebGL glass."
      : "Preview using WebGL glass. Click to simulate a phone without WebGL (CSS fallback)";
  };
  btn.addEventListener("click", () => { glassCssMode = !glassCssMode; sync(); applyGlassMode(); });
  frame().addEventListener("load", () => applyGlassMode());
  sync();
}

// Two independent controls: the slider sets the preview WIDTH (resolution, in
// px → drives the responsive layout); the dropdown sets the ASPECT RATIO, which
// derives the height from that width. "free" lets the height fill the stage.
const PREV_WIDTH_DEFAULT = { desktop: 1280, mobile: 390 };
const PREV_WIDTH_RANGE = { desktop: [360, 1920], mobile: [300, 600] };
function initPreviewControls() {
  const stage = document.querySelector(".preview__stage");
  const wrap = document.getElementById("frame-wrap");
  const dBtn = document.getElementById("prev-desktop");
  const mBtn = document.getElementById("prev-mobile");
  const dSel = document.getElementById("fmt-desktop");
  const mSel = document.getElementById("fmt-mobile");
  const range = document.getElementById("prev-width");
  const lbl = document.getElementById("prev-width-label");
  let mode = "desktop";
  const widthByMode = { ...PREV_WIDTH_DEFAULT };

  // Persist the preview choices so a reload restores them. We set the <select>
  // values explicitly here too, which also defeats the browser's own form-state
  // restoration that could otherwise leave the dropdown and the rendered size
  // out of sync (e.g. dropdown "16:9" but preview still showing "Free").
  const PREV_PREFS_KEY = "evolvedcv.editor.preview";
  const persist = () => {
    try {
      localStorage.setItem(PREV_PREFS_KEY, JSON.stringify(
        { mode, widthByMode, ratioDesktop: dSel.value, ratioMobile: mSel.value }));
    } catch { /* private mode */ }
  };
  try {
    const saved = JSON.parse(localStorage.getItem(PREV_PREFS_KEY) || "null");
    if (saved) {
      if (saved.mode === "desktop" || saved.mode === "mobile") mode = saved.mode;
      if (saved.widthByMode) Object.assign(widthByMode, saved.widthByMode);
      if (saved.ratioDesktop && [...dSel.options].some((o) => o.value === saved.ratioDesktop)) dSel.value = saved.ratioDesktop;
      if (saved.ratioMobile && [...mSel.options].some((o) => o.value === saved.ratioMobile)) mSel.value = saved.ratioMobile;
    }
  } catch { /* ignore corrupt prefs */ }

  const avail = () => {
    const cs = getComputedStyle(stage);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    return { W: Math.max(160, stage.clientWidth - padX), H: Math.max(160, stage.clientHeight - padY) };
  };
  const syncRange = () => {
    const [mn, mx] = PREV_WIDTH_RANGE[mode];
    range.min = mn; range.max = mx;
    widthByMode[mode] = Math.min(mx, Math.max(mn, widthByMode[mode]));
    range.value = widthByMode[mode];
  };
  // Zoom-to-fit: the slider is the LOGICAL resolution (the iframe really renders
  // at that width, so the responsive layout reacts to it); we then scale the
  // whole frame down so it's always fully visible — never overflowing/clipping.
  const apply = () => {
    const lw = widthByMode[mode]; // logical width (resolution)
    const ratio = (mode === "mobile" ? mSel : dSel).value;
    const { W, H } = avail();
    let lh, scale;
    if (ratio === "free") {
      // fill the available area; only shrink if the resolution is wider than it
      scale = Math.min(1, W / lw);
      lh = H / scale; // so the scaled height fills H exactly
    } else {
      const [rw, rh] = ratio.split(":").map(Number);
      lh = (lw * rh) / rw;
      scale = Math.min(1, W / lw, H / lh); // largest scale that fits both axes
    }
    const iframe = frame();
    iframe.style.width = Math.round(lw) + "px";
    iframe.style.height = Math.round(lh) + "px";
    iframe.style.transform = `scale(${scale})`;
    wrap.style.width = Math.round(lw * scale) + "px";
    wrap.style.height = Math.round(lh * scale) + "px";
    const pct = Math.round(scale * 100);
    lbl.textContent = Math.round(lw) + "px" + (pct < 100 ? ` · ${pct}%` : "");
    dBtn.classList.toggle("is-active", mode === "desktop");
    mBtn.classList.toggle("is-active", mode === "mobile");
  };
  const setMode = (m) => { mode = m; syncRange(); apply(); persist(); };

  range.addEventListener("input", () => { widthByMode[mode] = Number(range.value); apply(); persist(); });
  dBtn.addEventListener("click", () => setMode("desktop"));
  mBtn.addEventListener("click", () => setMode("mobile"));
  dSel.addEventListener("change", () => setMode("desktop"));
  mSel.addEventListener("change", () => setMode("mobile"));
  document.getElementById("prev-reload").addEventListener("click", reloadPreview);
  if (window.ResizeObserver) new ResizeObserver(apply).observe(stage);
  window.addEventListener("resize", apply);
  syncRange();
  apply();
}

/* ---------------------------------------------------------------- status */
function setStatus(msg, kind) {
  const s = document.getElementById("save-status");
  s.textContent = msg;
  s.className = "save-status" + (kind ? " is-" + kind : "");
}

// Capture / restore the preview's scroll position across a reload so an
// auto-update while editing a deep section doesn't yank the preview to the top.
function capturePreviewScroll() {
  try { return frame().contentWindow.scrollY || 0; } catch { return 0; }
}
function restorePreviewScroll(sy) {
  if (!sy) return;
  const ifr = frame();
  ifr.addEventListener("load", () => {
    let done = false;
    const doRestore = () => { if (done) return; done = true; try { ifr.contentWindow.scrollTo(0, sy); } catch { /* navigating */ } };
    // restore just AFTER intro-done (scene-nav pins to the top on that event)
    try { ifr.contentWindow.addEventListener("evolvedcv:intro-done", () => setTimeout(doRestore, 60), { once: true }); } catch { /* cross-origin? */ }
    setTimeout(doRestore, 1500); // fallback if the event never arrives
  }, { once: true });
}

let isSaving = false;
async function persistDirty({ silent = false } = {}) {
  if (isSaving) { scheduleAutoSave(); return false; } // retry shortly if one is in flight
  if (!store.dirty.data && !store.dirty.ui) return true;
  const btn = document.getElementById("btn-save");
  // Content edits, or structural UI edits (pages), need a preview reload —
  // EXCEPT data edits already mirrored live (About highlights), which don't.
  const needReload = (store.dirty.data && !dataDirtyNoReload) || pendingPreviewReload;
  isSaving = true;
  btn.disabled = true;
  if (!silent) setStatus("Saving…", "");
  try {
    for (const key of ["data", "ui"]) {
      if (!store.dirty[key]) continue;
      const res = await api.put(key, store[key]);
      if (!res.ok) {
        setStatus(`Error (${key}): ${res.body.error || res.status}`, "err");
        return false;
      }
      store.dirty[key] = false;
    }
    if (needReload) { const sy = capturePreviewScroll(); reloadPreview(); restorePreviewScroll(sy); }
    setStatus(needReload ? "Saved ✓ — preview updated" : "Saved ✓", "ok");
    return true;
  } catch (e) {
    setStatus("Network error: " + e.message, "err");
    return false;
  } finally {
    isSaving = false;
    pendingPreviewReload = false;
    dataDirtyNoReload = true; // reset: next batch is "live-only" until a plain edit proves otherwise
    btn.disabled = !(store.dirty.data || store.dirty.ui);
  }
}
function save() { return persistDirty({ silent: false }); }

function initAutoSaveToggle() {
  const cb = document.getElementById("autosave-toggle");
  if (!cb) return;
  cb.checked = autoSaveEnabled;
  cb.addEventListener("change", () => {
    autoSaveEnabled = cb.checked;
    try { localStorage.setItem(AUTOSAVE_KEY, autoSaveEnabled ? "1" : "0"); } catch { /* private mode */ }
    setStatus(autoSaveEnabled ? "Auto-save on" : "Auto-save off — use the Save button", "");
    // re-enabling flushes whatever is already pending
    if (autoSaveEnabled && (store.dirty.data || store.dirty.ui)) scheduleAutoSave();
  });
}

/* ------------------------------------------------------------------ init */
async function init() {
  document.getElementById("tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (t) showTab(t.dataset.tab);
  });
  document.getElementById("btn-save").addEventListener("click", save);
  initPreviewControls();
  initGlassModeToggle();
  initAutoSaveToggle();

  try {
    const [data, ui] = await Promise.all([api.get("data"), api.get("ui")]);
    store.data = data;
    store.ui = ui;
    showTab("profile");
    setStatus("Ready", "");
  } catch (e) {
    setStatus("Failed to load data: " + e.message, "err");
  }
}

init();
