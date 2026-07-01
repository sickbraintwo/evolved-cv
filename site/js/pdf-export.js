/**
 * pdf-export.js — wires the header "PDF" button to window.print().
 *
 * Default: prints the FULL CV (print.css undoes the filter's .is-hidden marks).
 * If a filter is ACTIVE when the button is clicked, a small dialog asks whether
 * to export the whole CV or only the filtered selection. "Filtered" adds
 * body.print-filtered so print.css keeps the non-matching experience hidden.
 *
 * Self-contained: builds its own accessible dialog (no HTML/markup needed) and
 * is bilingual via state.lang. No dependencies beyond the state store.
 */
import { get } from "./state.js";

const TXT = {
  it: {
    title: "Esporta PDF",
    msg: "Hai un filtro attivo. Vuoi il CV completo o solo la selezione filtrata?",
    full: "CV completo",
    filtered: "Solo selezione filtrata",
    cancel: "Annulla"
  },
  en: {
    title: "Export PDF",
    msg: "A filter is active. Export the full CV or only the filtered selection?",
    full: "Full CV",
    filtered: "Filtered selection only",
    cancel: "Cancel"
  }
};

/** Trigger the browser print dialog, optionally in filtered mode. */
function printWith(filtered) {
  const CLS = "print-filtered";
  if (filtered) {
    document.body.classList.add(CLS);
    const cleanup = () => document.body.classList.remove(CLS);
    // afterprint fires once the print dialog closes; the timeout is a fallback
    // for browsers that don't dispatch it reliably.
    window.addEventListener("afterprint", cleanup, { once: true });
    setTimeout(cleanup, 2000);
  }
  window.print();
}

/** Build + show the full/filtered chooser. Calls onChoose(filtered:boolean). */
function openDialog(onChoose) {
  const x = TXT[get("lang") === "it" ? "it" : "en"];

  const backdrop = document.createElement("div");
  backdrop.className = "pdf-dialog-backdrop";
  backdrop.innerHTML =
    '<div class="pdf-dialog" role="dialog" aria-modal="true" aria-labelledby="pdf-dlg-title">' +
      `<h2 id="pdf-dlg-title" class="pdf-dialog__title">${x.title}</h2>` +
      `<p class="pdf-dialog__msg">${x.msg}</p>` +
      '<div class="pdf-dialog__actions">' +
        `<button type="button" class="pdf-dialog__btn" data-choice="full">${x.full}</button>` +
        `<button type="button" class="pdf-dialog__btn" data-choice="filtered">${x.filtered}</button>` +
      "</div>" +
      `<button type="button" class="pdf-dialog__cancel" data-choice="cancel">${x.cancel}</button>` +
    "</div>";

  const prevFocus = document.activeElement;
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) { close(); return; }   // click outside the card
    const choice = e.target && e.target.dataset ? e.target.dataset.choice : null;
    if (!choice) return;
    close();
    if (choice === "cancel") return;
    onChoose(choice === "filtered");
  });

  document.addEventListener("keydown", onKey);
  document.body.appendChild(backdrop);
  const firstBtn = backdrop.querySelector(".pdf-dialog__btn");
  if (firstBtn) firstBtn.focus();
}

export function initPdfExport() {
  const btn = document.getElementById("pdf-button");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const active = get("activeTags");
    const hasFilter = active && active.size > 0;
    if (!hasFilter) { printWith(false); return; }
    openDialog((filtered) => {
      // Let the dialog leave the DOM before the (blocking) print dialog opens.
      requestAnimationFrame(() => printWith(filtered));
    });
  });
}
