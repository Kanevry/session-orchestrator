/**
 * own-wave.mjs — the wave (and its role) of THIS session's wave-scope manifest,
 * for stamping per-agent telemetry records (#2218: Session → Wave → Agent tree).
 *
 * Ownership is the same lookup `on-stop.mjs` `readWaveNumber()` uses
 * (`findOwnScopeFile` over the `.pi` > `.cursor` > `.codex` > `.claude`
 * precedence with the process-local id set), but STRICTER on the verdict: the
 * found manifest must classify as `own`. `findOwnScopeFile` also returns an
 * `unknown` manifest (unbound, or no own id resolvable); for a value written
 * onto a record "cannot tell" must not become "stamp it anyway" — the same
 * doctrine `scripts/lib/events.mjs` `waveForRecord()` follows.
 *
 * Omit, never fabricate (HR-105): an unknown wave is `null`, never `0`, so a
 * caller OMITS the key — an invented `wave: 0` would read as a real wave in
 * every later query (`hooks/pre-task-scope-disjoint.mjs` `waveNumberOf()`).
 *
 * Root limit: the root is `resolveSessionRoot(cwd)`. That lifts a harness agent
 * worktree under `<repo>/.claude/worktrees/<agent>` to `<repo>`, so its wave is
 * found there; a checkout elsewhere (a sibling worktree) resolves to itself and
 * finds no coordinator manifest → `null`. Revisit when a coordinator-root
 * witness reaches telemetry (`scope-gate.mjs` `resolveScopeContext` does the
 * cross-worktree adoption for the guards).
 *
 * Sync, fs-only, never throws, no process spawns.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveSessionRoot } from '../../scripts/lib/platform.mjs';
import {
  classifyManifestSession,
  readProcessLocalSessionIds,
} from '../../scripts/lib/session-identity/own-session.mjs';

/** Same order as the scope gate's manifest lookup (scripts/lib/scope-gate.mjs). */
const OWN_WAVE_DIRS = Object.freeze(['.pi', '.cursor', '.codex', '.claude']);

/**
 * Wave roles are short labels (`Discovery`, `Impl-Core`, `Quality`, …). The
 * record travels into the ledger and over the optional Clank webhook, and the
 * manifest is a shared working-copy file, so the role is charset+length clamped
 * like `agent_type_meta` in on-stop.mjs. A mismatch omits the role — never a
 * truncation that would look measured.
 */
export const WAVE_ROLE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Read the own-session wave manifest.
 *
 * @param {object|null} input  hook payload (`session_id` / `cwd` are used)
 * @param {{root?: string}} [opts]  `root` overrides `resolveSessionRoot(input.cwd)`
 * @returns {{wave: number, role?: string}|null}  `null` when no own manifest or
 *   no positive integer wave; `role` absent when missing or failing the clamp.
 */
export function readOwnWave(input, opts = {}) {
  try {
    const root = typeof opts.root === 'string' && opts.root !== ''
      ? opts.root
      : resolveSessionRoot(input?.cwd);
    const ownIds = new Set(readProcessLocalSessionIds({ hookInput: input }));
    if (ownIds.size === 0) return null;
    // Telemetry only: take the first manifest provably bound to THIS session, in
    // harness order. findOwnScopeFile (scripts/lib/scope-gate.mjs) deliberately
    // keeps an unbound manifest as the decider for the scope GUARDS (ENFORCE);
    // for the wave label that rule hid our own bound manifest behind a stale
    // unbound one from another harness (#2222 point 2), so it is not reused here.
    let scope = null;
    for (const dir of OWN_WAVE_DIRS) {
      const candidate = path.join(root, dir, 'wave-scope.json');
      if (!existsSync(candidate)) continue;
      let parsed;
      try { parsed = JSON.parse(readFileSync(candidate, 'utf8')); } catch { continue; }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      if (classifyManifestSession(parsed, ownIds).verdict === 'own') { scope = parsed; break; }
    }
    if (scope === null) return null;
    if (scope.wave === null || scope.wave === '') return null;
    const wave = Number(scope.wave);
    if (!Number.isSafeInteger(wave) || wave <= 0) return null;
    const role = typeof scope.role === 'string' ? scope.role.trim() : '';
    return WAVE_ROLE_RE.test(role) ? { wave, role } : { wave };
  } catch {
    return null; // unreadable / corrupt manifest or resolution failure — no wave known
  }
}

/**
 * The record fields for a known wave: `{wave, wave_role?}`, or `{}`.
 *
 * @param {object|null} input
 * @param {{root?: string}} [opts]
 * @returns {{wave?: number, wave_role?: string}}
 */
export function ownWaveFields(input, opts = {}) {
  const own = readOwnWave(input, opts);
  if (own === null) return {};
  return own.role !== undefined ? { wave: own.wave, wave_role: own.role } : { wave: own.wave };
}
