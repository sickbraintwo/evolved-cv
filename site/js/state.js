/**
 * state.js — minimal pub/sub store. No dependencies.
 * Keys: lang ('en'|'it'), activeTags (Set<string>), mode ('cv'|'filter'),
 * filterView ('constellation' — only view after Blocco 1).
 */

const state = {
  lang: "en",
  activeTags: new Set(),
  mode: "cv",
  filterView: "constellation"
};

/** key -> Set<fn>. Special key "*" fires on any change. */
const listeners = new Map();

export function get(key) {
  return state[key];
}

/**
 * Subscribe to changes of a single key (or "*" for all).
 * Returns an unsubscribe function.
 */
export function subscribe(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => listeners.get(key).delete(fn);
}

function emit(key, value) {
  for (const fn of listeners.get(key) || []) fn(value, state);
  for (const fn of listeners.get("*") || []) fn(key, value, state);
}

/**
 * Patch the store. Only changed keys emit events (granular).
 * Sets are compared by content; a new Set instance is always stored.
 */
export function set(patch) {
  for (const [key, value] of Object.entries(patch)) {
    const prev = state[key];
    if (value instanceof Set) {
      const same =
        prev instanceof Set &&
        prev.size === value.size &&
        [...value].every((v) => prev.has(v));
      if (same) continue;
      state[key] = new Set(value);
    } else {
      if (prev === value) continue;
      state[key] = value;
    }
    emit(key, state[key]);
  }
}

/** Toggle a single tag in activeTags (convenience for chip-bar). */
export function toggleTag(tagId) {
  const next = new Set(state.activeTags);
  if (next.has(tagId)) next.delete(tagId);
  else next.add(tagId);
  set({ activeTags: next, mode: next.size > 0 ? "filter" : "cv" });
}

export function resetTags() {
  set({ activeTags: new Set(), mode: "cv" });
}
