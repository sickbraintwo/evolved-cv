/**
 * math-utils.js — tiny shared numeric helpers.
 */

/**
 * Frame-rate-independent exponential damping: move `cur` toward `target` by a
 * fraction that scales with the elapsed time `dt` (seconds) and a `speed`
 * constant, clamped so a long frame can never overshoot. Returns the new value.
 *
 *   next = cur + (target - cur) * min(1, dt * speed)
 *
 * Equivalent to the `x += (target - x) * Math.min(1, dt * k)` idiom that was
 * inlined across footbar.js and expertise-particles.js. Keep the `speed`
 * constant at the call site so each animation stays independently tunable.
 *
 * @param {number} cur
 * @param {number} target
 * @param {number} dt     elapsed time in seconds
 * @param {number} speed  damping rate (larger = snappier)
 * @returns {number}
 */
export function expSmooth(cur, target, dt, speed) {
  return cur + (target - cur) * Math.min(1, dt * speed);
}
