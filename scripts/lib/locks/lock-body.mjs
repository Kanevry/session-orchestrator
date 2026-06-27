/**
 * locks/lock-body.mjs — shared leaf helpers for the short-lived lock protocols
 * (STATE.md write-lock + staging-fence commit-mutex) split out of
 * session-lock.mjs in #630 (A1 barrel-preserving split).
 *
 * This is a PURE leaf: it imports NOTHING (Node stdlib only used inline). Both
 * scripts/lib/locks/state-md-lock.mjs and staging-fence-lock.mjs import these
 * three helpers so the previously-shared `nowIso` / `delay` / `parseLockBody`
 * live in exactly one place instead of being duplicated across the two modules.
 *
 * It does NOT import session-lock.mjs (which re-exports the two protocol
 * modules) — the dependency edge points locks/* → lock-body, never the reverse,
 * so there is no import cycle.
 */

/**
 * Return the current time as an ISO-8601 string.
 * @returns {string}
 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * Sleep helper for the acquire poll-loop. Promise-returning, so the loop is
 * async without blocking the event loop.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a lock-file body shared by the state-lock and staging-fence-lock.
 * Both locks use identical { pid, host, acquiredAt, holder } shape so a single
 * parser serves both. Returns null on any malformed input.
 *
 * Moved verbatim from session-lock.mjs in #630 — behaviour preserved exactly
 * (renamed from parseStateLock in #558 M4 because it serves both locks).
 *
 * @param {string} raw
 * @returns {{ pid: number, host: string, acquiredAt: string, holder: string }|null}
 */
export function parseLockBody(raw) {
  try {
    const obj = JSON.parse(raw);
    if (
      typeof obj === 'object' &&
      obj !== null &&
      typeof obj.pid === 'number' &&
      typeof obj.host === 'string' &&
      typeof obj.acquiredAt === 'string' &&
      typeof obj.holder === 'string'
    ) {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}
