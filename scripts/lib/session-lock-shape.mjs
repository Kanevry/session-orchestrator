/**
 * session-lock-shape.mjs — the ONE predicate that decides whether a parsed
 * JSON value is a `.orchestrator/session.lock` record (#1153 P7).
 *
 * **Zero imports on purpose.** One of the two consumers is
 * `scripts/lib/session-identity/own-session.mjs`, which the live
 * `hooks/enforce-scope.mjs` loads on EVERY Edit/Write; anything this module
 * imported would join that hook's static closure. It therefore holds six
 * `typeof` checks and nothing else.
 *
 * **The two consumers, and why they must not drift apart:**
 *
 *   - `scripts/lib/session-lock.mjs` `parseLock()` — the lock manager's own
 *     reader; a value that fails this predicate is `null` there.
 *   - `scripts/lib/session-identity/own-session.mjs` `readLockIds()` — the
 *     dependency-free stand-in that reads the same two ids out of the same
 *     file without dragging the lock manager into a hook.
 *
 * The drift direction is FAIL-OPEN, which is why the predicate is shared
 * rather than repeated: if `parseLock` relaxed the shape and `readLockIds` did
 * not, the lock tier of {@link readOwnSessionIds} would stop contributing its
 * ids, this session's own manifest would classify `foreign`, and
 * `hooks/enforce-scope.mjs` would silently skip enforcement for the whole wave.
 *
 * @param {unknown} obj — a value already parsed from JSON.
 * @returns {boolean} true when `obj` carries all six required lock fields with
 *   the right primitive types. `semantic_session_id` and `last_heartbeat` are
 *   deliberately NOT required — both are optional by schema (v1 locks predate
 *   `last_heartbeat`, and `semantic_session_id` is absent on harnesses that
 *   resolve no semantic id).
 */
export function isLockShape(obj) {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof obj.session_id === 'string' &&
    typeof obj.started_at === 'string' &&
    typeof obj.mode === 'string' &&
    typeof obj.pid === 'number' &&
    typeof obj.host === 'string' &&
    typeof obj.ttl_hours === 'number'
  );
}
