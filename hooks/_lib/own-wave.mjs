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

import { readFileSync } from 'node:fs';
import { resolveSessionRoot } from '../../scripts/lib/platform.mjs';
import { findOwnScopeFile } from '../../scripts/lib/scope-gate.mjs';
import {
  classifyManifestSession,
  readProcessLocalSessionIds,
} from '../../scripts/lib/session-identity/own-session.mjs';

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
    const { path: scopePath } = findOwnScopeFile(root, ownIds, classifyManifestSession);
    if (scopePath === null) return null;
    const scope = JSON.parse(readFileSync(scopePath, 'utf8'));
    if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return null;
    if (classifyManifestSession(scope, ownIds).verdict !== 'own') return null;
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
