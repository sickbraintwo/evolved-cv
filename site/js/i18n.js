/**
 * i18n.js — tiny bilingual helper. Reads current language from the store.
 */
import { get, subscribe } from "./state.js";

/**
 * Resolve a bilingual object { en, it } to the active language,
 * falling back to English, then to the value itself if it is a string.
 */
export function t(obj) {
  if (obj == null) return "";
  if (typeof obj === "string") return obj;
  const lang = get("lang");
  return obj[lang] ?? obj.en ?? "";
}

/** Keep <html lang> in sync with the store. Call once at bootstrap. */
export function initI18n() {
  document.documentElement.lang = get("lang");
  subscribe("lang", (lang) => {
    document.documentElement.lang = lang;
  });
}
