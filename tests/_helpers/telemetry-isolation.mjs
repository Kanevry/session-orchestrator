/**
 * tests/_helpers/telemetry-isolation.mjs
 *
 * Fail-closed telemetry isolation for any test that SPAWNS a hook which may
 * flush telemetry (#1138).
 *
 * ── Why this exists (a real incident, measured 2026-08-23) ───────────────────
 * Wiring `flush()` into `hooks/on-session-end.mjs` turned every test that
 * spawns that hook into a potential telemetry SENDER, because the usual spawn
 * helper does `env: { ...process.env, … }` and therefore inherits:
 *
 *   - the developer's real `HOME`, hence their real
 *     `~/.config/session-orchestrator/telemetry.json` (consent + anon_id) and
 *     the real offline queue, and
 *   - no `SO_TELEMETRY_ENDPOINT`, hence the PRODUCTION ingest endpoint.
 *
 * On the author's machine (`consent: "granted"`) a single suite run stamped
 * `last_flush_at` on the real record — i.e. the test suite performed a real
 * production send and cleared the operator's 50-entry send queue. Verified by
 * md5: the queue file changed across a run of the hook suite alone.
 *
 * ── The contract ─────────────────────────────────────────────────────────────
 * `telemetryIsolationEnv()` returns an env block that is fail-closed on THREE
 * independent axes, so no single mistake re-opens the path:
 *
 *   1. `HOME` → a throwaway dir, so `os.homedir()` (and with it every
 *      `~/.config/session-orchestrator/*` path) resolves away from the operator.
 *   2. `SO_TELEMETRY_DISABLED=1` + `DO_NOT_TRACK=1` → `resolveConsent()` returns
 *      `send: false` before any batch is built, whatever HOME contains.
 *   3. `SO_TELEMETRY_ENDPOINT` → the discard port (9), never listened on, so
 *      even a bug that defeats 1 and 2 cannot reach the real server.
 *
 * Spread it FIRST in a spawn env so a test that deliberately exercises the send
 * path (a local collector, a seeded fake HOME) can override any of it:
 *
 *   env: { ...process.env, ...telemetryIsolationEnv(), ...testSpecificEnv }
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * One throwaway HOME per test PROCESS. Created lazily so importing this module
 * costs nothing, and reused across calls because its only job is to be a place
 * the operator's real config is not.
 * @type {string|null}
 */
let sharedHome = null;

/** @returns {string} the process-wide throwaway HOME (created on first use). */
export function isolatedHome() {
  if (sharedHome === null) {
    sharedHome = mkdtempSync(join(tmpdir(), 'so-telemetry-isolation-'));
  }
  return sharedHome;
}

/**
 * The fail-closed env block described above.
 *
 * @param {object} [opts]
 * @param {string} [opts.home]  Override the throwaway HOME (a test that seeds a
 *                              consent record passes its own fake home here).
 * @returns {Record<string, string>}
 */
export function telemetryIsolationEnv({ home } = {}) {
  return {
    HOME: home ?? isolatedHome(),
    SO_TELEMETRY: '',
    SO_TELEMETRY_DISABLED: '1',
    DO_NOT_TRACK: '1',
    // Port 9 is the discard service and is not listened on; any send that got
    // this far fails fast instead of leaving the machine.
    SO_TELEMETRY_ENDPOINT: 'http://127.0.0.1:9/',
  };
}
