/**
 * glyph.js — shared per-character "text assembly" effect.
 *
 * One source of truth for the glyph reveal used across the site:
 *   - scroll-story.js : section titles, About, card titles, project names,
 *     contact buttons — assembled when scrolled into view (re-triggers).
 *   - hero-deflagration.js : the hero headline/sub/meta assemble right after
 *     the particle name lands (intro-synced, one-shot).
 *   - header-bars.js / counters.js (B8) : glyphSwap() retires the old text and
 *     assembles the new one when a tag changes the subbar headline/counter.
 *
 * Accessibility: splitIntoGlyphs keeps the full text as the element's
 * aria-label and marks every glyph span aria-hidden, so screen readers read
 * the word, never the scattered characters.
 */

/**
 * Split an element's text into per-character <span class="glyph"> nodes.
 * Idempotent (dataset.split flag). Returns the character glyphs (space glyphs
 * excluded — they hold word width but never scatter).
 */
export function splitIntoGlyphs(el) {
  const text = el.textContent.trim();
  if (!text) return [];
  if (el.dataset.split === "1") {
    return Array.from(el.querySelectorAll(".glyph:not(.glyph--space)"));
  }
  el.dataset.split = "1";
  el.setAttribute("aria-label", text);

  // Walk the existing inline markup (not just textContent) so any per-word
  // colour spans survive the split — e.g. the About paragraph's .about-hl spans
  // (style="--hl:var(--c-domain-…)"). Each character inherits the colour of the
  // inline element it came from, carried onto its own .glyph. Plain text (every
  // other glyph-reveal target: titles, names, …) has no inner spans, so `tint`
  // stays null and the behaviour is byte-for-byte the previous one.
  const chars = []; // [{ ch, tint:{hl?, color?}|null }]
  const walk = (node, tint) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        for (const ch of child.textContent) chars.push({ ch, tint });
      } else if (child.nodeType === 1) {
        // accumulate this element's inline colour onto the inherited tint
        let next = tint;
        const hl = child.style && child.style.getPropertyValue("--hl");
        const col = child.style && child.style.color;
        if (hl || col) next = { hl: hl || (tint && tint.hl), color: col || (tint && tint.color) };
        walk(child, next);
      }
    }
  };
  walk(el, null);
  // trim leading/trailing spaces so we don't emit empty edge words
  while (chars.length && chars[0].ch === " ") chars.shift();
  while (chars.length && chars[chars.length - 1].ch === " ") chars.pop();

  const fragment = document.createDocumentFragment();
  // Wrap each word's character glyphs in a nowrap inline-block: this is the only
  // thing that keeps inline-block glyphs of one word from breaking across lines.
  // Line breaks happen solely at the inter-word space glyphs.
  let wordWrap = null;
  const openWord = () => {
    wordWrap = document.createElement("span");
    wordWrap.className = "glyph-word";
    wordWrap.setAttribute("aria-hidden", "true");
    fragment.appendChild(wordWrap);
  };
  openWord();
  for (const { ch, tint } of chars) {
    if (ch === " ") {
      // preserve inter-word spaces so wrapping survives, then start a new word
      const spaceSpan = document.createElement("span");
      spaceSpan.className = "glyph glyph--space";
      spaceSpan.setAttribute("aria-hidden", "true");
      spaceSpan.textContent = " ";
      fragment.appendChild(spaceSpan);
      openWord();
      continue;
    }
    const span = document.createElement("span");
    span.className = "glyph" + (tint ? " about-hl" : "");
    span.setAttribute("aria-hidden", "true");
    if (tint && tint.hl) span.style.setProperty("--hl", tint.hl);
    if (tint && tint.color) span.style.color = tint.color;
    span.textContent = ch;
    wordWrap.appendChild(span);
  }
  el.innerHTML = "";
  el.appendChild(fragment);
  return Array.from(el.querySelectorAll(".glyph:not(.glyph--space)"));
}

/** Scatter glyphs to random offsets at zero opacity (the "hidden" state). */
export function glyphScatter(gsap, glyphs) {
  gsap.set(glyphs, {
    opacity: 0,
    x: () => gsap.utils.random(-40, 40),
    y: () => gsap.utils.random(-30, 30),
    rotation: () => gsap.utils.random(-40, 40)
  });
}

// When true, glyph (re)assembly snaps instantly (duration 0, no stagger). Set
// during a filter reflow so titles sliding into view below the experience grid
// never show the slow scatter→assemble (which read as the page "breaking").
// Scatter is already instant (gsap.set), so only assembly needs the flag.
let instant = false;
export function setGlyphInstant(on) { instant = !!on; }

/**
 * Assemble glyphs into place. Always returns a tween (safe for timeline.add).
 * The amount-based stagger keeps total assembly time bounded even for long text
 * (e.g. the About paragraph). Honours setGlyphInstant() for filter reflows.
 */
export function glyphAssemble(gsap, glyphs, opts = {}) {
  return gsap.to(glyphs, {
    opacity: 1,
    x: 0,
    y: 0,
    rotation: 0,
    duration: instant ? 0 : (opts.duration ?? 0.55),
    ease: opts.ease ?? "back.out(1.7)",
    stagger: instant ? 0 : (opts.stagger ?? { amount: 0.7, from: "random" }),
    overwrite: true,
    ...(opts.onComplete ? { onComplete: opts.onComplete } : {})
  });
}

/**
 * Glyph-swap (req 6): retire the element's current text glyph-by-glyph, then
 * assemble the NEW text in their place. Used when a tag selection changes the
 * subbar headline / counter — the old job title scatters out, the new one
 * assembles in. Idempotent re-split: the dataset flag is cleared so the new
 * text is freshly split. With no prior glyphs (first call) it just assembles.
 */
export function glyphSwap(gsap, el, newText, opts = {}) {
  const apply = () => {
    el.dataset.split = "";          // force a fresh split of the new text
    el.textContent = newText;
    const glyphs = splitIntoGlyphs(el);
    glyphScatter(gsap, glyphs);
    glyphAssemble(gsap, glyphs, opts);
  };

  const current = Array.from(el.querySelectorAll(".glyph:not(.glyph--space)"));
  if (!current.length) { apply(); return; }
  if (el.textContent.trim() === String(newText).trim()) return; // no change

  gsap.to(current, {
    opacity: 0,
    y: () => gsap.utils.random(-26, 26),
    rotation: () => gsap.utils.random(-30, 30),
    duration: opts.outDuration ?? 0.3,
    ease: "power2.in",
    stagger: { amount: 0.22, from: "random" },
    overwrite: true,
    onComplete: apply
  });
}

/**
 * Split an element and drive an IntersectionObserver that ASSEMBLES its glyphs
 * every time it enters the viewport and re-scatters them once it leaves — so the
 * effect replays on every appearance.
 *
 * (An earlier ScrollTrigger-based glyphReveal was removed: ScrollTrigger caches
 * each trigger's pixel position and only
 * recomputes on refresh(); when an element moves due to a LAYOUT SHIFT (e.g. an
 * experience card expanding pushes the cards below it by hundreds of px) the
 * cached positions go stale and titles get stuck scattered/invisible. An
 * IntersectionObserver always reports the element's REAL current geometry and
 * re-fires whenever intersection changes for ANY reason — including layout
 * shifts — so it stays correct without any manual refresh.)
 *
 * Replays in both directions (assemble on enter, scatter on leave). Returns the
 * observer so the caller can disconnect it (e.g. before a language re-render
 * rebuilds the DOM). No-op if no glyphs.
 *
 * @returns {IntersectionObserver|null}
 */
export function glyphRevealIO(el) {
  const gsap = window.gsap;
  const glyphs = splitIntoGlyphs(el);
  if (!glyphs.length) return null;

  glyphScatter(gsap, glyphs);
  // rootMargin EXTENDS the root 18% below the fold so a title starts assembling
  // BEFORE it scrolls fully into view — otherwise scrolling briskly to a section
  // (esp. the last one, Contact) lands on a still-scattered title that reads as
  // "missing". The assemble is also kept snappy (≈0.7s) for the same reason. The
  // callback fires once right after observe() with the current state, so initial
  // in-view elements assemble immediately and out-of-view ones stay scattered.
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) glyphAssemble(gsap, glyphs, { duration: 0.45, stagger: { amount: 0.3, from: "random" } });
      else                  glyphScatter(gsap, glyphs);
    }
  }, { threshold: 0, rootMargin: "0px 0px 18% 0px" });

  io.observe(el);
  // expose the element + its glyphs so callers (scroll-story.resyncGlyphReveals)
  // can snap in-view titles to assembled after a non-scroll layout shift (filter)
  io._el = el;
  io._glyphs = glyphs;
  return io;
}
